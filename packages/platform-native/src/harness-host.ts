import type { HarnessV1, HarnessV1SandboxProvider } from "@ai-sdk/harness";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createACP } from "@ai-sdk/harness-acp";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodex } from "@ai-sdk/harness-codex";
import { AgentWorker, harnessSessions } from "@harness/workers";
import type { HarnessStore } from "@harness/workers";
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
export function harnessAdapter(spec: HarnessSpec): AnyHarness {
  switch (spec.kind) {
    case "claude-code":
      return createClaudeCode();
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
 * parks the harness sessions there and a daemon started later resumes them.
 */
export function harnessWorker(
  options: { readonly harness: AnyHarness; readonly stateFile?: string; readonly instructions?: string } & ({ readonly sandbox: HarnessV1SandboxProvider } | { readonly sandboxRoot: string }),
): { worker: AgentWorker; close(): Promise<void> } {
  const sandbox = "sandbox" in options ? options.sandbox : hostSandbox({ root: options.sandboxRoot });
  const agent = new HarnessAgent({ harness: options.harness, sandbox, ...(options.instructions === undefined ? {} : { instructions: options.instructions }) });
  const sessions = harnessSessions(agent, options.stateFile === undefined ? {} : { store: new FileHarnessStore(options.stateFile) });
  return { worker: new AgentWorker({ agent: sessions }), close: () => sessions.close() };
}
