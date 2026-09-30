import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkerEvent } from "@harness/core";
import type { HarnessV1SandboxProvider } from "@ai-sdk/harness";
import { FileHarnessStore, harnessAdapter, harnessWorker, hostSandbox, modelIdsFromCatalog, parseHarnessSpec, parseSandboxSpec, prepareLocalClaude, sandboxProvider } from "@harness/platform-native";
import { scriptedHarness } from "@harness/testkit";

const dir = () => mkdtempSync(join(tmpdir(), "harness-host-"));

async function turn(worker: ReturnType<typeof harnessWorker>["worker"], text: string, sessionId = "s1", turnId = "t1") {
  const events: WorkerEvent[] = [];
  await worker.run({ type: "prompt", sessionId, turnId, prompt: [{ type: "text", text }], cwd: "/" }, (e) => events.push(e));
  return events.flatMap((e) => (e.type === "update" && e.update.sessionUpdate === "agent_message_chunk" && e.update.content.type === "text" ? [e.update.content.text] : [])).join("");
}

describe("harness sessions on the native host", () => {
  it("HH1.1 a harness is named on the command line: a known adapter, or an ACP agent by package, version and executable", () => {
    expect(parseHarnessSpec("claude-code")).toEqual({ kind: "claude-code" });
    expect(parseHarnessSpec("codex")).toEqual({ kind: "codex" });
    expect(parseHarnessSpec("acp:@agentclientprotocol/codex-acp@1.1.4:codex-acp")).toEqual({ kind: "acp", package: "@agentclientprotocol/codex-acp", version: "1.1.4", executable: "codex-acp" });
    expect(parseHarnessSpec("acp:gemini-acp@2.0.0:gemini")).toEqual({ kind: "acp", package: "gemini-acp", version: "2.0.0", executable: "gemini" });
    for (const bad of ["", "claude", "acp:", "acp:pkg:bin", "acp:pkg@1.0.0", "acp:@scope/pkg:bin"]) expect(() => parseHarnessSpec(bad), bad).toThrow(/harness/);
  });

  it("HH1.2 each kind of harness is the official AI SDK adapter for it", () => {
    expect(harnessAdapter({ kind: "claude-code" }).harnessId).toBe("claude-code");
    expect(harnessAdapter({ kind: "codex" }).harnessId).toBe("codex");
    expect(harnessAdapter({ kind: "acp", package: "gemini-acp", version: "2.0.0", executable: "gemini" }).harnessId).toBe("acp");
  });

  it("HH1.8 a dead loopback Claude base URL is replaced by the model its origin lists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-local-"));
    const probed: string[] = [];
    const launch = await prepareLocalClaude({
      env: { ANTHROPIC_BASE_URL: "https://api.example.test" },
      settingsText: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9/coding-agent" } }),
      configDir: dir,
      probe: async (url) => {
        probed.push(url);
        return url === "http://127.0.0.1:9/v1/models" ? ["local-model"] : undefined;
      },
    });
    expect(probed).toEqual(["http://127.0.0.1:9/coding-agent/v1/models", "http://127.0.0.1:9/v1/models"]);
    expect(launch?.["CLAUDE_CONFIG_DIR"]).toBe(dir);
    expect(launch?.["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:9");
    expect(launch?.["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"]).toBe("0");
    expect(launch?.["CLAUDE_CODE_SIMPLE"]).toBe("1");
    const written = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as {
      model: string;
      env: { ANTHROPIC_BASE_URL: string; CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: string; CLAUDE_CODE_SIMPLE: string };
    };
    expect(written.model).toBe("local-model");
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9");
    expect(written.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT).toBe("1");
    expect(written.env.CLAUDE_CODE_SIMPLE).toBe("1");

    const publicCloud = await prepareLocalClaude({
      env: {},
      settingsText: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.example.test" } }),
      configDir: dir,
      probe: async () => ["should-not-be-used"],
    });
    expect(publicCloud).toBeUndefined();

    const healthy = await prepareLocalClaude({
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" },
      settingsText: undefined,
      configDir: dir,
      probe: async (url) => (url === "http://127.0.0.1:9/v1/models" ? ["kept"] : undefined),
    });
    expect(healthy).toBeUndefined();
  });

  it("HH1.9 a model catalog is the ids an OpenAI or Ollama list names", () => {
    expect(modelIdsFromCatalog({ data: [{ id: "a" }, { id: "" }, { name: "nope" }, null] })).toEqual(["a"]);
    expect(modelIdsFromCatalog({ models: [{ name: "b" }, { model: "c" }] })).toEqual(["b"]);
    expect(modelIdsFromCatalog({ data: "nope" })).toEqual([]);
    expect(modelIdsFromCatalog(null)).toEqual([]);
  });

  it("HH1.3 parked harness sessions are kept in a file, so a restarted daemon finds them", async () => {
    const path = join(dir(), "harness-sessions.json");
    const store = new FileHarnessStore(path);
    expect(await store.get("s1")).toBeUndefined();
    await store.set("s1", { parked: 1 });
    await store.set("s2", { parked: 2 });
    await store.delete("s2");
    await store.delete("missing");
    const reopened = new FileHarnessStore(path);
    expect(await reopened.get("s1")).toEqual({ parked: 1 });
    expect(await reopened.get("s2")).toBeUndefined();
  });

  it("HH1.4 the worker runs turns on the harness in host sandboxes; closing parks sessions and a new worker resumes them", async () => {
    const root = dir();
    const harness = scriptedHarness((p) => `got ${p}`);
    const first = harnessWorker({ harness, sandboxRoot: join(root, "sandboxes"), stateFile: join(root, "harness-sessions.json"), instructions: "Be brief." });
    expect(await turn(first.worker, "one")).toBe("got one");
    expect(harness.log.turns[0]).toMatchObject({ instructions: "Be brief." });
    await first.close();
    const second = harnessWorker({ harness, sandboxRoot: join(root, "sandboxes"), stateFile: join(root, "harness-sessions.json") });
    expect(await turn(second.worker, "two", "s1", "t2")).toBe("got two");
    expect(harness.log.resumed).toEqual(["s1"]);
    await second.close();
  });

  it("HH1.5 a sandbox is named on the command line: this machine's, or a Docker image", () => {
    expect(parseSandboxSpec("host")).toEqual({ kind: "host" });
    expect(parseSandboxSpec("docker:public.ecr.aws/docker/library/node:22-bookworm-slim")).toEqual({ kind: "docker", image: "public.ecr.aws/docker/library/node:22-bookworm-slim" });
    expect(parseSandboxSpec("docker:node@sha256:abc")).toEqual({ kind: "docker", image: "node@sha256:abc" });
    for (const bad of ["", "docker", "docker:", "docker: x", "vm:x"]) expect(() => parseSandboxSpec(bad), bad).toThrow(/sandbox/);
  });

  it("HH1.6 each kind of sandbox is its provider", () => {
    expect(sandboxProvider({ kind: "host" }, { root: dir() }).providerId).toBe("host");
    expect(sandboxProvider({ kind: "docker", image: "any" }, { root: dir(), setup: "true", env: { A: "1" } }).providerId).toBe("docker");
  });

  it("HH1.7 the worker runs its sessions in the sandbox provider it is given", async () => {
    const created: string[] = [];
    const host = hostSandbox({ root: dir() });
    const provider: HarnessV1SandboxProvider = { ...host, createSession: async (o = {}) => (created.push(o.sessionId ?? "?"), host.createSession(o)) };
    const worker = harnessWorker({ harness: scriptedHarness((p) => `got ${p}`), sandbox: provider });
    expect(await turn(worker.worker, "one")).toBe("got one");
    expect(created).toEqual(["s1"]);
    await worker.close();
  });

  it("HD3.1 skills given to the worker are the skills of the turn", async () => {
    const harness = scriptedHarness((p) => `got ${p}`);
    const worker = harnessWorker({
      harness,
      sandboxRoot: join(dir(), "sandboxes"),
      skills: [{ name: "ship-it", description: "Ship the branch.", content: "Run it.\n", files: [] }],
    });
    expect(await turn(worker.worker, "one")).toBe("got one");
    expect(harness.log.turns[0]?.skills).toEqual(["ship-it"]);
    await worker.close();
  });
});
