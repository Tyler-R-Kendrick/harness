import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { Client, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { InputInterpreter } from "@harness/core";
import type { InputAction, ManagedHarnessSession, RegisteredTool } from "@harness/core";
import { writeDaemonSetting } from "./daemon-uri.ts";

type AcpStream = ConstructorParameters<typeof ClientSideConnection>[1];

/** What a conversation thread is doing. `idle` is between turns. */
export type ThreadState = "idle" | "thinking" | "responding" | "tool" | "permission" | "error";

/** One streamed piece of the active turn, for the session frame to draw. */
export type SessionFollow =
  | { readonly kind: "chunk"; readonly text: string }
  | { readonly kind: "error"; readonly text: string }
  | { readonly kind: "thought"; readonly text: string };

/** The active daemon session the prompt can drive: plain turns, slash commands, typeahead, session resume, and permission choices. */
export interface InteractiveClient {
  line(text: string): Promise<string>;
  complete(prefix: string): Promise<readonly string[]>;
  /** Resolves with the permission request once the daemon asks. Does not choose an option. */
  armPermission(): Promise<string>;
  cancel(): void;
  /** The daemon session in use, or "" once the client has left it. */
  sessionId(): string;
  /** Cancel the turn in progress. The next interrupt leaves the session. */
  interrupt(): void;
  /** Detach the active session and drop it from this client. */
  leave(): Promise<string>;
  /** Pieces of the turn that just finished. Error notices stay separate from assistant text. */
  turnParts(): readonly { readonly error: boolean; readonly text: string }[];
  /** Hear a thread's response state as it changes, including while a turn is still open. */
  watch(listener: (state: ThreadState, sessionId: string) => void): void;
  /** Hear streamed answer text, a failed notice, or a thought while the turn is still open. */
  follow(listener: (event: SessionFollow) => void): void;
  /** Resolves when the turn in progress is handed to the background. */
  backgrounded(): Promise<void>;
}

interface PendingPermission {
  readonly options: readonly { readonly optionId: string; readonly name: string }[];
  readonly resolve: (response: RequestPermissionResponse) => void;
}

const HELP = /^\s*\/(?:help)?\s*$/;

/** Open an ACP session and answer later lines on the active one. `/sessions` lists them. `/sessions new` starts another. `/sessions fork` copies one through a thread and/or message. `/sessions btw` asks about the active thread; `/sessions bg` hands the active turn to the background; `/sessions switch` inspects one. `/sessions resume` loads one back. `resume` loads that session instead of creating one. Permission waits for the next line. */
export async function openInteractive(
  stream: AcpStream,
  options?: {
    readonly resume?: string;
    readonly settingsFile?: string;
    readonly daemonSetting?: { readonly requested: string; readonly accepted?: string };
    readonly tools?: readonly RegisteredTool[];
  },
): Promise<InteractiveClient> {
  let parts: { error: boolean; text: string }[] = [];
  let inflight: Promise<string> | undefined;
  let busy = false;
  const states = new Map<string, ThreadState>();
  let listener: ((state: ThreadState, sessionId: string) => void) | undefined;
  let follower: ((event: SessionFollow) => void) | undefined;

  function setState(sessionId: string, state: ThreadState): void {
    if (sessionId.length === 0 || states.get(sessionId) === state) return;
    states.set(sessionId, state);
    listener?.(state, sessionId);
  }

  function stateOf(sessionId: string): ThreadState {
    return states.get(sessionId) ?? "idle";
  }

  const command = (value: string) => {
    const trimmed = value.trim();
    return trimmed.toLowerCase() === "help" || trimmed.startsWith("/");
  };
  let waiting: PendingPermission | undefined;
  let notice: string | undefined;
  let armed: ((text: string) => void) | undefined;
  let at = 0;
  let left = false;
  let active = "";
  let inspected = "";
  let backgroundId = "";
  let btwId = "";
  const replies = new Map<string, string>();
  const notes = new Map<string, Note[]>();
  let nextMessage = 0;
  let releaseHandoff: (() => void) | undefined;

  function freshNote(role: "user" | "assistant", text: string): Note {
    nextMessage += 1;
    return { id: `m${String(nextMessage)}`, role, text };
  }

  function note(id: string, role: "user" | "assistant", text: string): void {
    const list = notes.get(id) ?? [];
    list.push(freshNote(role, text));
    notes.set(id, list);
  }

  function transcript(id: string): string {
    const body = (notes.get(id) ?? []).map((item) => `${item.role}: ${item.text}`).join("\n");
    return body.length === 0 ? "(empty)" : body;
  }

  function report(id: string): string {
    const body = (notes.get(id) ?? []).map((item) => `${item.role} ${item.id}: ${item.text}`).join("\n");
    return body.length === 0 ? `session ${id}` : `session ${id}\n${body}`;
  }

  function copyNotes(source: readonly Note[], end: number): Note[] {
    return source.slice(0, end).map((item) => freshNote(item.role, item.text));
  }

  function locate(message: string, thread?: string): { thread: string; index: number } | undefined {
    const threads = thread === undefined ? [...notes.keys()] : [thread];
    let found: { thread: string; index: number } | undefined;
    for (const id of threads) {
      const index = (notes.get(id) ?? []).findIndex((item) => item.id === message);
      if (index === -1) continue;
      if (found !== undefined) return undefined;
      found = { thread: id, index };
    }
    return found;
  }

  const client: Client = {
    async sessionUpdate(params) {
      const id = params.sessionId;
      const update = params.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        setState(id, "responding");
        replies.set(id, (replies.get(id) ?? "") + update.content.text);
        if (id === active) {
          pushPart(update.content.text, false);
          follower?.({ kind: "chunk", text: update.content.text });
        }
      } else if (update.sessionUpdate === "agent_thought_chunk") {
        setState(id, "thinking");
        if (update.content.type === "text" && id === active) follower?.({ kind: "thought", text: update.content.text });
      } else if (update.sessionUpdate === "tool_call") setState(id, "tool");
      else if (update.sessionUpdate === "notice" && update.severity === "error") {
        setState(id, "error");
        const text = update.description == null || update.description.length === 0 ? update.title : `${update.title}: ${update.description}`;
        replies.set(id, (replies.get(id) ?? "") + text);
        if (id === active) {
          pushPart(text, true);
          follower?.({ kind: "error", text });
        }
      }
    },
    requestPermission(params) {
      const id = params.sessionId;
      setState(id, "permission");
      if (active.length > 0 && id !== active) return new Promise<RequestPermissionResponse>(() => {});
      notice = permissionText(params);
      const publish = armed;
      armed = undefined;
      publish?.(notice);
      return new Promise((resolve) => {
        waiting = {
          options: params.options.map((option) => ({ optionId: option.optionId, name: option.name })),
          resolve,
        };
      });
    },
  };
  const acp = new ClientSideConnection(() => client, stream);
  await acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const resume = options?.resume;
  const opened =
    resume === undefined
      ? await acp.newSession({ cwd: process.cwd(), mcpServers: [] })
      : await acp.loadSession({ sessionId: resume, cwd: process.cwd(), mcpServers: [] }).then(() => ({ sessionId: resume }));
  active = opened.sessionId;
  inspected = active;
  const sessions: ManagedHarnessSession[] = [];
  const track = (id: string) => {
    if (!states.has(id)) states.set(id, "idle");
    if (sessions.some((session) => session.name === id)) return;
    sessions.push({ name: id, harness: "daemon", state: { sessionId: id } });
  };
  track(active);
  const interpreter = new InputInterpreter(
    {
      tools: options?.tools ?? [],
      commands: [],
      settings: [{ key: "daemon", description: "Unix socket of the harness daemon.", fallback: "" }],
      ...(options?.daemonSetting === undefined
        ? {}
        : {
            settingState: {
              daemon:
                options.daemonSetting.accepted === undefined
                  ? { requested: options.daemonSetting.requested }
                  : { requested: options.daemonSetting.requested, accepted: options.daemonSetting.accepted },
            },
          }),
      harnesses: {
        sessions,
        writeFile: () => undefined,
        copy: () => undefined,
        resume: async (found) => {
          await acp.loadSession({ sessionId: found.name, cwd: process.cwd(), mcpServers: [] });
          active = found.name;
          inspected = active;
        },
      },
    },
    {
      decide: () => ({ choice: "message", complicated: true }),
      infer: () => ({ ok: false }),
    },
  );

  async function commands(prefix: string): Promise<readonly string[]> {
    const { completions } = await interpreter.complete(prefix, { turns: [] });
    return completions.map((item) => item.text);
  }

  function guide(): string {
    return interpreter.helpPage();
  }

  async function refresh(): Promise<void> {
    const listed = await acp.listSessions({});
    for (const session of listed.sessions) track(session.sessionId);
  }

  function pushPart(text: string, error: boolean): void {
    const last = parts.at(-1);
    if (last !== undefined && last.error === error) last.text += text;
    else parts.push({ error, text });
  }

  function send(message: string, sessionId = active, recorded?: string): Promise<string> {
    note(sessionId, "user", recorded ?? message);
    replies.set(sessionId, "");
    const presented = sessionId === active;
    if (presented) {
      parts = [];
      busy = true;
    }
    setState(sessionId, "responding");
    const turn = acp
      .prompt({ sessionId, prompt: [{ type: "text", text: message }] })
      .then(
        () => replies.get(sessionId) ?? "",
        (error: unknown) => {
          throw error;
        },
      )
      .finally(() => {
        const text = replies.get(sessionId) ?? "";
        note(sessionId, "assistant", text);
        if (sessionId === backgroundId && sessionId !== active) note(active, "assistant", text);
        if (inflight === turn) inflight = undefined;
        if (sessionId === active) busy = false;
        setState(sessionId, "idle");
      });
    if (presented) inflight = turn;
    return turn;
  }

  async function forkSession(): Promise<string> {
    if (btwId.length > 0) return btwId;
    const created = await acp.newSession({ cwd: process.cwd(), mcpServers: [] });
    track(created.sessionId);
    btwId = created.sessionId;
    return btwId;
  }

  return {
    async line(text: string): Promise<string> {
      if (left) throw new Error("session context cleared");
      if (waiting && !command(text)) {
        const pending = waiting;
        waiting = undefined;
        notice = undefined;
        const optionId = matchChoice(text, pending.options);
        const turn = inflight;
        inflight = undefined;
        if (optionId === undefined) {
          pending.resolve({ outcome: { outcome: "cancelled" } });
          await turn?.catch(() => undefined);
          return "unknown permission choice";
        }
        pending.resolve({ outcome: { outcome: "selected", optionId } });
        return (await turn) ?? "";
      }
      if (!busy) parts = [];
      if (text.trim().length === 0) throw new TypeError("prompt must be a string");
      if (text.trim().toLowerCase() === "help" || HELP.test(text)) return guide();
      const slash = text.replace(/^(\s*\/[A-Za-z][\w-]*)\s+help\s*$/, "$1 --help");
      if (slash.trimStart().startsWith("/")) {
        if (/^\s*\/sessions?\b/.test(slash)) await refresh();
        const { action } = await interpreter.submit(slash, { turns: [] }, at);
        at += 1;
        if (action.type === "settings" && (action.view === "set" || action.view === "unset") && options?.settingsFile !== undefined && action.entry.key === "daemon") {
          const requested = action.entry.requested;
          const accepted = action.entry.accepted;
          writeDaemonSetting(options.settingsFile, {
            ...(requested === undefined ? {} : { requested }),
            ...(accepted === undefined ? {} : { accepted }),
          });
        }
        if (action.type === "new-session") {
          const created = await acp.newSession({ cwd: process.cwd(), mcpServers: [] });
          track(created.sessionId);
          active = created.sessionId;
          inspected = active;
          return `session ${created.sessionId}`;
        }
        if (action.type === "session-btw") {
          const id = await forkSession();
          const prompt = `Main thread:\n${transcript(active)}\n\nQuestion: ${action.question}`;
          return send(prompt, id, action.question);
        }
        if (action.type === "session-bg") {
          if (inflight === undefined) return "usage: /sessions bg";
          const old = active;
          backgroundId = old;
          const created = await acp.newSession({ cwd: process.cwd(), mcpServers: [] });
          track(created.sessionId);
          const prior = notes.get(old) ?? [];
          notes.set(created.sessionId, copyNotes(prior, prior.length));
          active = created.sessionId;
          inspected = active;
          busy = false;
          waiting = undefined;
          notice = undefined;
          const release = releaseHandoff;
          releaseHandoff = undefined;
          release?.();
          return `background ${old}`;
        }
        if (action.type === "session-switch") {
          const id = action.session;
          if (!sessions.some((session) => session.name === id)) return `no session ${id}\n${report(inspected)}`;
          inspected = id;
          return report(id);
        }
        if (action.type === "session-fork") {
          const named = action.thread;
          if (named !== undefined && !sessions.some((session) => session.name === named)) return `no session ${named}`;
          const message = action.message;
          let source = named ?? active;
          let end = (notes.get(source) ?? []).length;
          if (message !== undefined) {
            const located = locate(message, named);
            if (located === undefined) return named === undefined ? `no message ${message}` : `no message ${message} on ${named}`;
            source = located.thread;
            end = located.index + 1;
          } else if (!sessions.some((session) => session.name === source)) return `no session ${source}`;
          const created = await acp.newSession({ cwd: process.cwd(), mcpServers: [] });
          track(created.sessionId);
          notes.set(created.sessionId, copyNotes(notes.get(source) ?? [], end));
          active = created.sessionId;
          inspected = active;
          return `session ${created.sessionId}`;
        }
        return action.type === "list-sessions"
          ? action.sessions.map((session) => `${session.harness} ${session.name} ${stateOf(session.name)}`).join("\n")
          : render(action);
      }
      return send(text);
    },
    complete: (prefix) => commands(prefix),
    armPermission() {
      if (notice !== undefined && waiting) return Promise.resolve(notice);
      return new Promise((resolve) => {
        armed = resolve;
      });
    },
    cancel() {
      if (!waiting) return;
      waiting.resolve({ outcome: { outcome: "cancelled" } });
      waiting = undefined;
      notice = undefined;
    },
    sessionId() {
      return active;
    },
    interrupt() {
      if (waiting) {
        waiting.resolve({ outcome: { outcome: "cancelled" } });
        waiting = undefined;
        notice = undefined;
      }
      if (active.length === 0) return;
      void Promise.resolve(acp.cancel({ sessionId: active })).catch(() => undefined);
    },
    turnParts() {
      return parts;
    },
    watch(fn) {
      listener = fn;
    },
    follow(fn) {
      follower = fn;
    },
    backgrounded() {
      return new Promise<void>((resolve) => {
        releaseHandoff = resolve;
      });
    },
    async leave() {
      const id = active;
      if (waiting) {
        waiting.resolve({ outcome: { outcome: "cancelled" } });
        waiting = undefined;
        notice = undefined;
      }
      if (id.length > 0) void Promise.resolve(acp.cancel({ sessionId: id })).catch(() => undefined);
      left = true;
      active = "";
      if (id.length > 0) await acp.extMethod("_harness/session/detach", { sessionId: id }).catch(() => undefined);
      return id;
    },
  };
}

interface Note {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

function permissionText(params: RequestPermissionRequest): string {
  const title = params.toolCall.title;
  const heading = typeof title === "string" && title.length > 0 ? title : "permission";
  return [heading, ...params.options.map((option) => `${option.optionId} ${option.name}`)].join("\n");
}

function matchChoice(text: string, options: PendingPermission["options"]): string | undefined {
  const typed = text.trim().toLowerCase();
  return options.find((option) => option.optionId.toLowerCase() === typed || option.name.toLowerCase() === typed)?.optionId;
}

function render(action: InputAction): string {
  switch (action.type) {
    case "help":
    case "command-usage":
      return action.message;
    case "unknown-command":
      return `unknown command /${action.name}`;
    case "unknown-tool":
      return `unknown tool ${action.name}`;
    case "list-sessions":
      return action.sessions.map((session) => `${session.harness} ${session.name}`).join("\n");
    case "new-session":
      return "session";
    case "session-btw":
      return action.question;
    case "session-bg":
      return "background";
    case "session-switch":
      return action.session;
    case "session-fork":
      return "session";
    case "list-tools":
      return action.tools.map((tool) => `${tool.kind} ${tool.name}: ${tool.description}`).join("\n");
    case "invoke-tool":
      return `${action.tool.kind} ${action.tool.name} ${action.argument}`.trim();
    case "harness-command":
      return `/${action.name} ${action.argument}`.trim();
    case "exported":
      return action.destination.type === "clipboard" ? "copied" : action.destination.filename;
    case "resumed":
      return `resumed ${action.harness} ${action.session}`;
    case "settings":
      if (action.view === "list") return action.entries.map((entry) => `${entry.key}=${entry.effective}`).join("\n");
      return `${action.entry.key}=${action.entry.effective}`;
    case "message":
      return action.text;
    case "elicit":
      return action.question;
    case "autopilot":
      if (action.view === "updates") return action.updates.map((update) => update.id).join("\n");
      if (action.view === "applied") return action.update.id;
      return action.view;
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}
