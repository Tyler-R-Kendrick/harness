import { createHash, randomUUID } from "node:crypto";
import { McpServer, ProtocolError, acceptedContent, createMcpHandler, inputRequired, requireScopes } from "@modelcontextprotocol/server";
import type { ServerContext, ServerNotifier, McpHttpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { APP_MIME_TYPE, EXTENSIONS, META, METHOD_NOT_FOUND } from "./constants.ts";
import { signWebhook } from "./webhooks.ts";

const Loose = z.looseObject({});

export interface TaskRecord {
  taskId: string;
  status: "working" | "input_required" | "completed" | "failed";
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs: number;
  result?: { content: { type: "text"; text: string }[] };
  inputRequests?: Record<string, unknown> | undefined;
}

export interface EventBody {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
  cursor: string;
}

interface WebhookSub {
  id: string;
  name: string;
  url: string;
  secret: string;
  arguments: Record<string, unknown>;
}

export interface SharedState {
  extra: boolean;
  tasks: Map<string, TaskRecord>;
  events: EventBody[];
  cursor: number;
  streams: Set<(event: EventBody) => void>;
  webhooks: Map<string, WebhookSub>;
  bridge: { notify?: ServerNotifier };
}

const SKILL_MD = `---
name: code-review
description: Review code using the team's checklist.
---
Follow the checklist.
`;

const CHECKLIST = "Check names.\n";

const APP_HTML = "<!doctype html><html><body><p>demo</p></body></html>";

const NOTE = "readme";

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export const SKILL_URI = "skill://code-review/SKILL.md";
export const CHECKLIST_URI = "skill://code-review/references/checklist.md";
export const APP_URI = "ui://demo/app.html";

export function createSharedState(): SharedState {
  return { extra: false, tasks: new Map(), events: [], cursor: 0, streams: new Set(), webhooks: new Map(), bridge: {} };
}

function extensionsOf(envelope: object | undefined): Record<string, unknown> {
  if (!envelope) return {};
  const record = envelope as Record<string, unknown>;
  const caps = record[META.clientCapabilities];
  if (!caps || typeof caps !== "object") return {};
  const extensions = "extensions" in caps ? caps.extensions : undefined;
  if (!extensions || typeof extensions !== "object") return {};
  return extensions as Record<string, unknown>;
}

function hasExtension(envelope: object | undefined, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(extensionsOf(envelope), id);
}

function taskView(task: TaskRecord): Record<string, unknown> {
  return {
    resultType: "complete",
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
    ...(task.result ? { result: task.result } : {}),
    ...(task.inputRequests ? { inputRequests: task.inputRequests } : {}),
  };
}

async function deliverWebhook(sub: WebhookSub, event: EventBody): Promise<void> {
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signWebhook(sub.secret, event.eventId, timestamp, body);
  await fetch(sub.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": event.eventId,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
      "x-mcp-subscription-id": sub.id,
    },
    body,
  });
}

export function publishEvent(state: SharedState, data: Record<string, unknown> = { n: state.cursor + 1 }): EventBody {
  state.cursor += 1;
  const event: EventBody = {
    eventId: `evt_${state.cursor}`,
    name: "demo.ping",
    timestamp: new Date().toISOString(),
    data,
    cursor: String(state.cursor),
  };
  state.events.push(event);
  for (const stream of state.streams) stream(event);
  for (const sub of state.webhooks.values()) {
    if (sub.name !== event.name) continue;
    void deliverWebhook(sub, event).catch(() => undefined);
  }
  return event;
}

function argumentKey(value: Record<string, unknown> | undefined): string {
  const source = value ?? {};
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) ordered[key] = source[key];
  return JSON.stringify(ordered);
}

function missing(): never {
  throw new ProtocolError(METHOD_NOT_FOUND, "Method not found");
}

function extraTool(): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: "extra" }] };
}

export function createHarnessServer(state: SharedState = createSharedState()): McpServer {
  const server = new McpServer(
    { name: "harness-mcp", version: "0.0.0" },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
        logging: {},
        extensions: {
          [EXTENSIONS.ui]: { mimeTypes: [APP_MIME_TYPE] },
          [EXTENSIONS.tasks]: {},
          [EXTENSIONS.skills]: {},
          [EXTENSIONS.events]: { listChanged: true },
        },
      },
      cacheHints: {
        "tools/list": { ttlMs: 60_000, cacheScope: "public" },
        "resources/list": { ttlMs: 60_000, cacheScope: "public" },
        "prompts/list": { ttlMs: 60_000, cacheScope: "public" },
        "server/discover": { ttlMs: 3_600_000, cacheScope: "public" },
        "resources/read": { ttlMs: 30_000, cacheScope: "private" },
      },
    },
  );

  server.registerTool(
    "echo",
    {
      description: "Return the given text.",
      inputSchema: z.object({ text: z.string() }),
    },
    async ({ text }) => ({ content: [{ type: "text" as const, text }] }),
  );

  server.registerTool(
    "progress",
    { description: "Report progress, then finish.", inputSchema: z.object({}) },
    async (_args, ctx: ServerContext) => {
      const token = ctx.mcpReq._meta?.progressToken;
      if (token !== undefined) {
        await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: 1, total: 1 } });
      }
      return { content: [{ type: "text" as const, text: "stepped" }] };
    },
  );

  server.registerTool(
    "ask",
    { description: "Ask for a name, then return it.", inputSchema: z.object({}) },
    async (_args, ctx: ServerContext) => {
      const content = acceptedContent(ctx.mcpReq.inputResponses, "who", z.object({ name: z.string() }));
      if (content) return { content: [{ type: "text" as const, text: content.name }] };
      return inputRequired({
        inputRequests: {
          who: inputRequired.elicit({ message: "Who?", requestedSchema: z.object({ name: z.string() }) }),
        },
      });
    },
  );

  server.registerTool(
    "logger",
    { description: "Log when the request set a log level.", inputSchema: z.object({}) },
    async (_args, ctx: ServerContext) => {
      const level = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.[META.logLevel];
      if (typeof level === "string") {
        await ctx.mcpReq.notify({ method: "notifications/message", params: { level, data: "heard", logger: "harness" } });
      }
      return { content: [{ type: "text" as const, text: "logged" }] };
    },
  );

  server.registerTool(
    "revise",
    { description: "Add the extra tool and announce the list change.", inputSchema: z.object({}) },
    async () => {
      if (!state.extra) {
        state.extra = true;
        server.registerTool("extra", { description: "Added after revise.", inputSchema: z.object({}) }, extraTool);
        server.sendToolListChanged();
        state.bridge.notify?.toolsChanged();
      }
      return { content: [{ type: "text" as const, text: "revised" }] };
    },
  );

  server.registerTool(
    "work",
    { description: "Finish now, or return a task handle when tasks are negotiated.", inputSchema: z.object({}) },
    async (_args, ctx: ServerContext) => {
      if (!hasExtension(ctx.mcpReq.envelope, EXTENSIONS.tasks)) {
        return { content: [{ type: "text" as const, text: "finished" }] };
      }
      const now = new Date().toISOString();
      const taskId = randomUUID();
      const task: TaskRecord = {
        taskId,
        status: "input_required",
        createdAt: now,
        lastUpdatedAt: now,
        ttlMs: 60_000,
        pollIntervalMs: 0,
        inputRequests: { note: { method: "elicitation/create", params: { message: "A note" } } },
      };
      state.tasks.set(taskId, task);
      return {
        content: [{ type: "text" as const, text: "task" }],
        structuredContent: { resultType: "task", taskId, status: task.status },
      };
    },
  );

  server.registerTool(
    "review",
    { description: "Review, as an ordinary tool result.", inputSchema: z.object({}) },
    async () => ({ content: [{ type: "text" as const, text: "reviewed" }] }),
  );

  server.registerTool(
    "show",
    {
      description: "Demo app. Ordinary result when the client has no UI extension.",
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: APP_URI } },
    },
    async () => ({ content: [{ type: "text" as const, text: "demo" }] }),
  );

  server.registerTool(
    "stamp",
    {
      description: "Requires the write scope.",
      inputSchema: z.object({}),
      scopeChallenge: requireScopes("write"),
    },
    async () => ({ content: [{ type: "text" as const, text: "stamped" }] }),
  );

  server.registerTool(
    "emit",
    { description: "Publish one demo.ping event.", inputSchema: z.object({}) },
    async () => {
      const event = publishEvent(state);
      return { content: [{ type: "text" as const, text: event.eventId }] };
    },
  );

  if (state.extra) {
    server.registerTool("extra", { description: "Added after revise.", inputSchema: z.object({}) }, extraTool);
  }

  server.registerResource("note", "note://readme", { mimeType: "text/plain", description: "A note" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: NOTE }],
  }));

  server.registerResource("app", APP_URI, { mimeType: APP_MIME_TYPE, description: "Demo app" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: APP_MIME_TYPE, text: APP_HTML }],
  }));

  server.registerResource("skill", SKILL_URI, { mimeType: "text/markdown", description: "Review skill" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: SKILL_MD }],
  }));

  server.registerResource(
    "checklist",
    CHECKLIST_URI,
    { mimeType: "text/markdown", description: "Review checklist" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: CHECKLIST }] }),
  );

  server.registerPrompt("hello", { description: "Say hello" }, async () => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text: "Hello" } }],
  }));

  const gate = (envelope: object | undefined, id: string): void => {
    if (!hasExtension(envelope, id)) missing();
  };

  server.server.setRequestHandler(
    "harness/tasks/get",
    { params: z.object({ taskId: z.string() }), result: Loose },
    async (params, ctx: ServerContext) => {
      gate(ctx.mcpReq.envelope, EXTENSIONS.tasks);
      const task = state.tasks.get(params.taskId);
      if (!task) throw new ProtocolError(-32602, "Unknown task");
      return taskView(task);
    },
  );

  server.server.setRequestHandler(
    "harness/tasks/update",
    {
      params: z.object({ taskId: z.string() }),
      result: Loose,
    },
    async (params, ctx: ServerContext) => {
      gate(ctx.mcpReq.envelope, EXTENSIONS.tasks);
      const task = state.tasks.get(params.taskId);
      if (!task) throw new ProtocolError(-32602, "Unknown task");
      if (!ctx.mcpReq.inputResponses) throw new ProtocolError(-32602, "Missing input responses");
      task.status = "completed";
      task.lastUpdatedAt = new Date().toISOString();
      delete task.inputRequests;
      task.result = { content: [{ type: "text", text: "noted" }] };
      return { resultType: "complete" };
    },
  );

  server.server.setRequestHandler(
    "skills/list",
    { params: Loose, result: Loose },
    async (_params, ctx: ServerContext) => {
      gate(ctx.mcpReq.envelope, EXTENSIONS.skills);
      return {
        resultType: "complete",
        skills: [
          {
            uri: SKILL_URI,
            frontmatter: { name: "code-review", description: "Review code using the team's checklist." },
            resources: [
              { uri: SKILL_URI, digest: sha256(SKILL_MD), size: Buffer.byteLength(SKILL_MD) },
              { uri: CHECKLIST_URI, digest: sha256(CHECKLIST), size: Buffer.byteLength(CHECKLIST) },
            ],
          },
        ],
      };
    },
  );

  server.server.setRequestHandler(
    "skills/get",
    { params: z.object({ uri: z.string() }), result: Loose },
    async (params, ctx: ServerContext) => {
      gate(ctx.mcpReq.envelope, EXTENSIONS.skills);
      if (params.uri !== SKILL_URI) throw new ProtocolError(-32002, "Skill not found");
      return {
        resultType: "complete",
        uri: SKILL_URI,
        frontmatter: { name: "code-review", description: "Review code using the team's checklist." },
        resources: [
          { uri: SKILL_URI, digest: sha256(SKILL_MD), size: Buffer.byteLength(SKILL_MD) },
          { uri: CHECKLIST_URI, digest: sha256(CHECKLIST), size: Buffer.byteLength(CHECKLIST) },
        ],
      };
    },
  );

  const eventDescriptor = {
    name: "demo.ping",
    description: "A demo event",
    inputSchema: { type: "object" },
    payloadSchema: { type: "object" },
    delivery: ["poll", "push", "webhook"],
  };

  server.server.setRequestHandler("events/list", { params: Loose, result: Loose }, async (_params, ctx: ServerContext) => {
    gate(ctx.mcpReq.envelope, EXTENSIONS.events);
    return { resultType: "complete", events: [eventDescriptor] };
  });

  server.server.setRequestHandler(
    "events/subscribe",
    {
      params: z
        .object({
          name: z.string(),
          arguments: z.record(z.string(), z.unknown()).optional(),
          delivery: z.object({ mode: z.string(), url: z.string().optional(), secret: z.string().optional() }),
          ttlMs: z.number().optional(),
        })
        .passthrough(),
      result: Loose,
    },
    async (params, ctx: ServerContext) => {
      gate(ctx.mcpReq.envelope, EXTENSIONS.events);
      if (params.delivery.mode !== "webhook" || !params.delivery.url || !params.delivery.secret) {
        throw new ProtocolError(-32602, "Webhook delivery needs a url and a secret");
      }
      const url = params.delivery.url;
      const secret = params.delivery.secret;
      const args = params.arguments ?? {};
      const key = argumentKey(args);
      const existing = [...state.webhooks.values()].find(
        (sub) => sub.name === params.name && sub.url === url && argumentKey(sub.arguments) === key,
      );
      if (existing) {
        existing.secret = secret;
        return { resultType: "complete", id: existing.id, refreshBefore: null, cursor: String(state.cursor) };
      }
      const id = `sub_${randomUUID()}`;
      state.webhooks.set(id, { id, name: params.name, url, secret, arguments: args });
      return { resultType: "complete", id, refreshBefore: null, cursor: String(state.cursor) };
    },
  );

  server.server.setRequestHandler(
    "events/unsubscribe",
    {
      params: z
        .object({
          id: z.string().optional(),
          name: z.string().optional(),
          arguments: z.record(z.string(), z.unknown()).optional(),
          delivery: z.object({ url: z.string().optional() }).optional(),
        })
        .passthrough(),
      result: Loose,
    },
    async (params, ctx: ServerContext) => {
      gate(ctx.mcpReq.envelope, EXTENSIONS.events);
      if (params.id) state.webhooks.delete(params.id);
      const url = params.delivery?.url;
      if (params.name && url) {
        const key = argumentKey(params.arguments);
        for (const [id, sub] of state.webhooks) {
          if (sub.name === params.name && sub.url === url && argumentKey(sub.arguments) === key) state.webhooks.delete(id);
        }
      }
      return { resultType: "complete" };
    },
  );

  server.server.setRequestHandler(
    "events/poll",
    { params: z.object({ name: z.string(), cursor: z.string().optional() }).passthrough(), result: Loose },
    async (params, ctx: ServerContext) => {
      gate(ctx.mcpReq.envelope, EXTENSIONS.events);
      const after = params.cursor ? Number(params.cursor) : 0;
      const events = state.events.filter((event) => event.name === params.name && Number(event.cursor) > after);
      return { resultType: "complete", events, cursor: String(state.cursor), nextPollMs: 0 };
    },
  );

  server.server.setRequestHandler(
    "events/stream",
    { params: z.object({ name: z.string() }).passthrough(), result: Loose },
    async (params, ctx: ServerContext) => {
      gate(ctx.mcpReq.envelope, EXTENSIONS.events);
      await new Promise<void>((resolve) => {
        const send = (event: EventBody): void => {
          if (event.name !== params.name) return;
          state.streams.delete(send);
          void ctx.mcpReq.notify({ method: "notifications/events/event", params: { ...event } }).then(
            () => resolve(),
            () => resolve(),
          );
        };
        state.streams.add(send);
        const pending = state.events.filter((event) => event.name === params.name);
        const latest = pending[pending.length - 1];
        if (latest) send(latest);
        ctx.mcpReq.signal.addEventListener("abort", () => {
          state.streams.delete(send);
          resolve();
        });
      });
      return { resultType: "complete", cursor: String(state.cursor) };
    },
  );

  return server;
}

export function createHandler(state: SharedState = createSharedState()): { state: SharedState; handler: McpHttpHandler } {
  const handler = createMcpHandler(() => createHarnessServer(state), { legacy: "reject" });
  state.bridge.notify = handler.notify;
  return { state, handler };
}
