import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessV1, HarnessV1SandboxProvider } from "@ai-sdk/harness";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createACP } from "@ai-sdk/harness-acp";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodex } from "@ai-sdk/harness-codex";
import type { HarnessSkill } from "@harness/core";
import { AgentWorker, harnessSessions, harnessTurnTools } from "@harness/workers";
import type { HarnessStore, StepHook, ToolContext } from "@harness/workers";
import type { ToolSet } from "ai";
import { FileStorage } from "./file-storage.ts";
import { dockerSandbox } from "./docker-sandbox.ts";
import { hostSandbox } from "./host-sandbox.ts";

/** Any AI SDK harness adapter: each declares its own builtin tools, which the worker never reads. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyHarness = HarnessV1<any>;

/** Which harness runs sessions: an official adapter, or any ACP agent installed from npm. */
export type HarnessSpec =
  | { readonly kind: "claude-code" }
  | { readonly kind: "codex" }
  | { readonly kind: "acp"; readonly package: string; readonly version: string; readonly executable: string };

const ACP_SPEC = /^acp:((?:@[^/@:\s]+\/)?[^/@:\s]+)@([^@:\s]+):(\S+)$/;

/** Parse `claude-code`, `codex` or `acp:<package>@<version>:<executable>`. */
export function parseHarnessSpec(text: string): HarnessSpec {
  if (text === "claude-code" || text === "codex") return { kind: text };
  const acp = ACP_SPEC.exec(text);
  if (acp) return { kind: "acp", package: acp[1]!, version: acp[2]!, executable: acp[3]! };
  throw new Error(`unknown harness "${text}": use claude-code, codex or acp:<package>@<version>:<executable>`);
}

/** The official AI SDK adapter for a harness. */
/** Ids named by an OpenAI-compatible `{ data: [{ id }] }` catalog, or an Ollama `{ models: [{ name }] }` catalog. */
export function modelIdsFromCatalog(body: unknown): readonly string[] {
  const named = (items: unknown, key: "id" | "name"): readonly string[] =>
    Array.isArray(items)
      ? items.flatMap((item) => {
          if (typeof item !== "object" || item === null || !Object.prototype.hasOwnProperty.call(item, key)) return [];
          const value = (item as Record<string, unknown>)[key];
          return typeof value === "string" && value.length > 0 ? [value] : [];
        })
      : [];
  if (typeof body !== "object" || body === null) return [];
  const openai = named((body as Record<string, unknown>)["data"], "id");
  return openai.length > 0 ? openai : named((body as Record<string, unknown>)["models"], "name");
}

export async function probeModelIds(url: string): Promise<readonly string[] | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return undefined;
    const ids = modelIdsFromCatalog(await response.json());
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
}

function baseUrlFromSettings(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const env = (parsed as Record<string, unknown>)["env"];
  if (typeof env !== "object" || env === null) return undefined;
  const base = (env as Record<string, unknown>)["ANTHROPIC_BASE_URL"];
  return typeof base === "string" && base.length > 0 ? base : undefined;
}

function loopbackBase(baseUrl: string): URL | undefined {
  try {
    const url = new URL(baseUrl);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" ? url : undefined;
  } catch {
    return undefined;
  }
}

function modelListUrl(url: URL): string {
  const path = url.pathname.replace(/\/$/, "");
  const list = new URL(url.href);
  list.pathname = path.endsWith("/v1") ? `${path}/models` : `${path}/v1/models`;
  list.search = "";
  list.hash = "";
  return list.toString();
}

/**
 * Claude Code applies ~/.claude/settings.json after the process environment, so a dead
 * loopback base URL there wins. When that URL lists no models and its origin does, point
 * CLAUDE_CONFIG_DIR at a cache settings file whose model is the one the origin listed.
 * That overlay sets CLAUDE_CODE_SIMPLE so the local model answers the user and the next
 * turn sees the same session, instead of the coding-agent tool prompt. A public base
 * URL, and a loopback URL that already lists models, are left alone.
 */
export async function prepareLocalClaude(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly settingsText: string | undefined;
  readonly configDir: string;
  readonly probe: (url: string) => Promise<readonly string[] | undefined>;
}): Promise<Readonly<Record<string, string>> | undefined> {
  const base = loopbackBase(baseUrlFromSettings(options.settingsText) ?? options.env["ANTHROPIC_BASE_URL"] ?? "");
  if (base === undefined) return undefined;
  const atBase = modelListUrl(base);
  const atOrigin = `${base.origin}/v1/models`;
  const listedAtBase = await options.probe(atBase);
  if (listedAtBase !== undefined && listedAtBase.length > 0) return undefined;
  const originModels = atOrigin === atBase ? listedAtBase : await options.probe(atOrigin);
  const model = originModels?.find((id) => id.length > 0);
  if (model === undefined) return undefined;
  const settingsEnv = {
    ANTHROPIC_BASE_URL: base.origin,
    ANTHROPIC_API_KEY: "local",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "0",
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    CLAUDE_CODE_SIMPLE: "1",
  };
  await mkdir(options.configDir, { recursive: true });
  await writeFile(join(options.configDir, "settings.json"), `${JSON.stringify({ model, env: settingsEnv }, null, 2)}\n`);
  return { CLAUDE_CONFIG_DIR: options.configDir, ...settingsEnv };
}

export function harnessAdapter(spec: HarnessSpec, claudeEnv?: Readonly<Record<string, string>>): AnyHarness {
  switch (spec.kind) {
    case "claude-code":
      return claudeEnv === undefined ? createClaudeCode() : createClaudeCode({ env: claudeEnv, auth: claudeEnv });
    case "codex":
      return createCodex();
    case "acp":
      return createACP({
        harnessId: "acp",
        source: { type: "npm-simple", packageName: spec.package, packageVersion: spec.version },
        executable: spec.executable,
        modelMapping: { type: "session-config-option", path: "model" },
      });
  }
}

/** Where harness sessions run: directories on this machine, or a Docker container each. */
export type SandboxSpec = { readonly kind: "host" } | { readonly kind: "docker"; readonly image: string };

/** Parse `host` or `docker:<image>`. */
export function parseSandboxSpec(text: string): SandboxSpec {
  if (text === "host") return { kind: "host" };
  const image = /^docker:(\S+)$/.exec(text)?.[1];
  if (image) return { kind: "docker", image };
  throw new Error(`unknown sandbox "${text}": use host or docker:<image>`);
}

/**
 * The sandbox provider for a spec. The host's keeps each session's directory under
 * `root`; a Docker container runs `setup` once when created and gets `env` in every command.
 */
export function sandboxProvider(spec: SandboxSpec, options: { readonly root: string; readonly setup?: string; readonly env?: Readonly<Record<string, string>> }): HarnessV1SandboxProvider {
  if (spec.kind === "host") return hostSandbox({ root: options.root });
  return dockerSandbox({ image: spec.image, ...(options.setup === undefined ? {} : { setup: options.setup }), ...(options.env === undefined ? {} : { env: options.env }) });
}

/** Parked harness sessions in one JSON file (written atomically), by daemon session id. */
export class FileHarnessStore implements HarnessStore {
  readonly #file: FileStorage;
  #parked: Promise<Record<string, unknown>> | undefined;

  constructor(path: string) {
    this.#file = new FileStorage(path);
  }

  #load(): Promise<Record<string, unknown>> {
    return (this.#parked ??= this.#file.load().then((saved) => ({ ...(saved as Record<string, unknown> | undefined) })));
  }

  async get(sessionId: string): Promise<unknown> {
    return (await this.#load())[sessionId];
  }

  async set(sessionId: string, state: unknown): Promise<void> {
    const parked = await this.#load();
    parked[sessionId] = state;
    await this.#file.save(parked);
  }

  async delete(sessionId: string): Promise<void> {
    const parked = await this.#load();
    if (!(sessionId in parked)) return;
    delete parked[sessionId];
    await this.#file.save(parked);
  }
}

/**
 * A session worker that runs every daemon session on a harness, each in a sandbox of its
 * own from `sandbox` (or a host sandbox under `sandboxRoot`). With a `stateFile`, closing
 * parks the harness sessions there and a daemon started later resumes them. `tools` are
 * host-executed tools each turn offers beside the harness's own (given once, or per turn,
 * such as composition's: the host's tools plus the workflows the session's pinned core binds).
 */
export function harnessWorker(
  options: {
    readonly harness: AnyHarness;
    readonly stateFile?: string;
    readonly instructions?: string;
    readonly skills?: readonly HarnessSkill[];
    readonly step?: StepHook;
    readonly tools?: ToolSet | ((turn: ToolContext) => ToolSet | Promise<ToolSet>);
    /** Host tools that wait for the session's approver. The next typed line answers. */
    readonly toolApproval?: Record<string, "user-approval">;
    /** Empty turns builtin tools off (allow-list of none). The loopback overlay does this so a local model answers instead of printing the tool catalog. */
    readonly activeTools?: readonly [];
  } & ({ readonly sandbox: HarnessV1SandboxProvider } | { readonly sandboxRoot: string }),
): { worker: AgentWorker; close(): Promise<void> } {
  const sandbox = "sandbox" in options ? options.sandbox : hostSandbox({ root: options.sandboxRoot });
  const agent = new HarnessAgent({ harness: options.harness, sandbox, prepareCall: harnessTurnTools, ...(options.instructions === undefined ? {} : { instructions: options.instructions }), ...(options.skills === undefined ? {} : { skills: options.skills }), ...(options.toolApproval === undefined ? {} : { toolApproval: options.toolApproval }), ...(options.activeTools === undefined ? {} : { activeTools: [] }) });
  // With a step hook (procedural graphs), each turn's prompt is prepended with its guidance.
  const sessions = harnessSessions(agent, {
    ...(options.stateFile === undefined ? {} : { store: new FileHarnessStore(options.stateFile) }),
    ...(options.step ? { step: options.step } : {}),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  });
  return { worker: new AgentWorker({ agent: sessions }), close: () => sessions.close() };
}
