import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { createACP } from "@ai-sdk/harness-acp";
import { harnessWorker, NodeHost } from "@harness/platform-native";

// A real bridge-backed harness: the official ACP adapter installs its bridge (pnpm) and a
// small ACP agent into a host sandbox, and the daemon runs sessions on it.
const script = readFileSync(new URL("./fixtures/echo-acp-agent.mjs", import.meta.url), "utf8");
const echoAgent = () =>
  createACP({
    harnessId: "acp",
    source: { type: "install-command", command: `mkdir -p "$HOME/.local/bin" && cat > "$HOME/.local/bin/echo-agent" <<'AGENT'\n${script}\nAGENT\nchmod +x "$HOME/.local/bin/echo-agent"` },
    executable: "echo-agent",
    modelMapping: { type: "session-config-option", path: "model" },
  });

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function client(host: NodeHost) {
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  host.attach(toHost, fromHost);
  const updates: SessionNotification[] = [];
  const acp = new ClientSideConnection(
    () => ({ sessionUpdate: async (n) => void updates.push(n), requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) }),
    ndJsonStream(Writable.toWeb(toHost), Readable.toWeb(fromHost) as ReadableStream<Uint8Array>),
  );
  const text = () =>
    updates
      .flatMap((n) => (n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text" ? [n.update.content.text] : []))
      .join("");
  return { acp, text };
}

describe("daemon sessions on a bridge-backed AI SDK harness in host sandboxes", () => {
  it("HI1.1 a prompt to the daemon runs on the ACP harness in a host sandbox and streams its reply back", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-acp-"));
    const harness = harnessWorker({ harness: echoAgent(), sandboxRoot: join(root, "sandboxes"), stateFile: join(root, "harness-sessions.json") });
    const host = await NodeHost.start({ worker: harness.worker, identity: { principal: "me", kind: "human" } });
    closers.push(async () => {
      await host.close();
      await harness.close();
    });
    const c = client(host);
    await c.acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await c.acp.newSession({ cwd: "/", mcpServers: [] });
    expect(await c.acp.prompt({ sessionId, prompt: [{ type: "text", text: "through the bridge" }] })).toEqual({ stopReason: "end_turn" });
    const log = host.daemon.snapshot().sessions[0]!.log as { entries: { payload: unknown }[] };
    // On failure, the session log says what the harness turn produced instead.
    expect(c.text(), JSON.stringify(log.entries.map((e) => e.payload), null, 1)).toBe("echo: through the bridge");
  }, 180_000);
});
