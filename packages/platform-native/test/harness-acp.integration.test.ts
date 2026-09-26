import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { createACP } from "@ai-sdk/harness-acp";
import { dockerSandbox, harnessWorker, NodeHost } from "@harness/platform-native";

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

// Any image with node; the public ECR mirror of Docker's official images.
const IMAGE = "public.ecr.aws/docker/library/node:22-bookworm-slim";

/**
 * How a container reaches the npm registry (the bridge installs from it). Behind a proxy
 * on this machine's loopback, the container shares the host network and gets the proxy
 * and its CA; otherwise it has a network of its own.
 */
function egress(): Pick<Parameters<typeof dockerSandbox>[0], "network" | "env" | "mounts"> {
  const proxy = process.env["HTTPS_PROXY"] ?? process.env["https_proxy"];
  if (!proxy || !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(proxy)) return {};
  const ca = process.env["NODE_EXTRA_CA_CERTS"];
  const env: Record<string, string> = { HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy, NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" };
  if (!ca) return { network: "host", env };
  return { network: "host", env: { ...env, NODE_EXTRA_CA_CERTS: "/etc/harness-ca.crt", npm_config_cafile: "/etc/harness-ca.crt" }, mounts: [{ source: ca, target: "/etc/harness-ca.crt", readonly: true }] };
}

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

  it("HI1.2 a daemon restart parks the harness session, stopping its bridge, and the session's next turn resumes on a new one", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-acp-"));
    const options = { sandboxRoot: join(root, "sandboxes"), stateFile: join(root, "harness-sessions.json") };
    const start = async () => {
      const harness = harnessWorker({ harness: echoAgent(), ...options });
      const host = await NodeHost.start({ worker: harness.worker, identity: { principal: "me", kind: "human" }, statePath: join(root, "daemon.json") });
      const stop = async () => {
        await host.close();
        await harness.close();
      };
      closers.push(stop);
      return { host, stop };
    };
    const first = await start();
    const a = client(first.host);
    await a.acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await a.acp.newSession({ cwd: "/", mcpServers: [] });
    await a.acp.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] });
    await first.stop();
    closers.splice(closers.indexOf(first.stop), 1);
    expect(JSON.parse(readFileSync(options.stateFile, "utf8"))).toHaveProperty(sessionId);

    const second = await start();
    const b = client(second.host);
    await b.acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await b.acp.loadSession({ sessionId, cwd: "/", mcpServers: [] });
    expect(await b.acp.prompt({ sessionId, prompt: [{ type: "text", text: "two" }] })).toEqual({ stopReason: "end_turn" });
    const log = second.host.daemon.snapshot().sessions[0]!.log as { entries: { payload: unknown }[] };
    expect(b.text(), JSON.stringify(log.entries.map((e) => e.payload), null, 1)).toContain("echo again: two");
    expect(JSON.parse(readFileSync(options.stateFile, "utf8"))).not.toHaveProperty(sessionId);
  }, 240_000);

  it("HI1.3 in a Docker sandbox, the harness bridge and the agent run in a container of the session's own, and the reply comes back", async () => {
    const harness = harnessWorker({ harness: echoAgent(), sandbox: dockerSandbox({ image: IMAGE, setup: "npm install -g pnpm@10.33.0 >/dev/null", labels: { "harness.test": `hi${process.pid}` }, ...egress() }) });
    const host = await NodeHost.start({ worker: harness.worker, identity: { principal: "me", kind: "human" } });
    closers.push(async () => {
      await host.close();
      await harness.close();
      spawnSync("sh", ["-c", `docker rm -f $(docker ps -aq --filter label=harness.test=hi${process.pid}) 2>/dev/null`]);
    });
    const c = client(host);
    await c.acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await c.acp.newSession({ cwd: "/", mcpServers: [] });
    expect(await c.acp.prompt({ sessionId, prompt: [{ type: "text", text: "from a container" }] })).toEqual({ stopReason: "end_turn" });
    const log = host.daemon.snapshot().sessions[0]!.log as { entries: { payload: unknown }[] };
    expect(c.text(), JSON.stringify(log.entries.map((e) => e.payload), null, 1)).toBe("echo: from a container");
    // the agent runs as one of the container's processes
    const agents = spawnSync("sh", ["-c", `docker top $(docker ps -q --filter label=harness.test=hi${process.pid}) -eo pid,args | grep '[e]cho-agent'`], { encoding: "utf8" }).stdout;
    expect(agents).toMatch(/echo-agent/);
  }, 300_000);
});
