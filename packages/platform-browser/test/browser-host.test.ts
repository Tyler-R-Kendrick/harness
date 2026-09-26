import { afterEach, describe, expect, it } from "vitest";
import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { daemonHarness, noSandbox } from "@harness/client";
import { BrowserHost, daemonPort, portStream } from "@harness/platform-browser";
import type { AcpPort, PortSource } from "@harness/platform-browser";
import { MemoryStorage } from "@harness/testkit";
import { profileLocks } from "./locks.ts";
import { EchoWorker } from "@harness/workers";

const ME = { principal: "me", kind: "human" } as const;
const hosts: BrowserHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

async function host(options: Partial<Parameters<typeof BrowserHost.start>[0]> = {}) {
  const h = await BrowserHost.start({ worker: new EchoWorker(), identity: ME, log: () => {}, ...options });
  hosts.push(h);
  return h;
}

/** An ACP client in a "tab": the official SDK's client connection over its end of a channel. */
function client(port: MessagePort, options: Parameters<typeof portStream>[1] = {}) {
  const updates: SessionNotification[] = [];
  const stream = portStream(port, options);
  const acp = new ClientSideConnection(
    () => ({ sessionUpdate: async (n) => void updates.push(n), requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) }),
    stream,
  );
  return { acp, updates, hangUp: stream.hangUp };
}

/** Open a session and run a turn on it, so this client holds its input lease. */
async function holdSession(c: ReturnType<typeof client>) {
  await c.acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const { sessionId } = await c.acp.newSession({ cwd: "/", mcpServers: [] });
  await c.acp.prompt({ sessionId, prompt: [{ type: "text", text: "mine" }] });
  return sessionId;
}

/** Whether another client can take over a session: load it and run a turn. */
async function takeOver(h: BrowserHost, sessionId: string) {
  const { port1, port2 } = new MessageChannel();
  h.accept(port2);
  const c = client(port1);
  await c.acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  await c.acp.loadSession({ sessionId, cwd: "/", mcpServers: [] });
  return c.acp.prompt({ sessionId, prompt: [{ type: "text", text: "mine now" }] }).then(
    (r) => r.stopReason,
    (e: Error) => e.message,
  ).finally(() => c.hangUp());
}

const said = (updates: SessionNotification[]) => updates.flatMap((n) => (n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text" ? [n.update.content.text] : [])).join("");
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(check()).toBe(true);
};

describe("BrowserHost", () => {
  it("BH1.1 an ACP client on a MessagePort initializes, opens a session and runs a turn", async () => {
    const h = await host();
    const { port1, port2 } = new MessageChannel();
    h.accept(port2);
    const { acp, updates } = client(port1);
    expect(await acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })).toMatchObject({ protocolVersion: PROTOCOL_VERSION });
    const { sessionId } = await acp.newSession({ cwd: "/", mcpServers: [] });
    expect(await acp.prompt({ sessionId, prompt: [{ type: "text", text: "hello tab" }] })).toEqual({ stopReason: "end_turn" });
    expect(said(updates)).toBe("echo: hello tab");
    port1.close();
  });

  it("BH1.2 a client hanging up disconnects it: its input lease is released for another", async () => {
    const h = await host();
    const { port1, port2 } = new MessageChannel();
    h.accept(port2);
    const first = client(port1);
    const sessionId = await holdSession(first);
    expect(await takeOver(h, sessionId)).toMatch(/input lease is held/);
    first.hangUp();
    await until(() => h.daemon.snapshot().sessions[0] !== undefined);
    await new Promise((r) => setTimeout(r, 5));
    expect(await takeOver(h, sessionId)).toBe("end_turn");
  });

  it("BH1.9 a port that reports closing (as Node's do) disconnects its connection too", async () => {
    const h = await host();
    const { port1, port2 } = new MessageChannel();
    h.accept(port2);
    const sessionId = await holdSession(client(port1));
    port1.close();
    await new Promise((r) => setTimeout(r, 5));
    expect(await takeOver(h, sessionId)).toBe("end_turn");
  });

  it("BH1.10 a client whose context dies without hanging up is disconnected once its Web Lock is released", async () => {
    const profile = profileLocks();
    const h = await host({ locks: profile.locks });
    const { port1, port2 } = new MessageChannel();
    h.accept(port2);
    const sessionId = await holdSession(client(port1, { locks: profile.locks }));
    expect(await takeOver(h, sessionId)).toMatch(/input lease is held/);
    const [lock] = profile.held();
    profile.die(lock!);
    await new Promise((r) => setTimeout(r, 5));
    expect(await takeOver(h, sessionId)).toBe("end_turn");
  });

  it("BH1.11 a host without Web Locks ignores a client's lock and still serves it", async () => {
    const profile = profileLocks();
    const h = await host({ locks: undefined });
    const { port1, port2 } = new MessageChannel();
    h.accept(port2);
    const c = client(port1, { locks: profile.locks });
    expect(await holdSession(c)).toMatch(/^ses_/);
    c.hangUp();
  });

  it("BH1.12 closing the host tells its clients: their connections close", async () => {
    const h = await BrowserHost.start({ worker: new EchoWorker(), identity: ME, log: () => {} });
    const { port1, port2 } = new MessageChannel();
    h.accept(port2);
    const c = client(port1);
    await c.acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await h.close();
    await c.acp.closed;
    expect(c.acp.signal.aborted).toBe(true);
  });

  it("BH1.3 serving a source accepts every port its connect events carry, including ports that arrive while the host starts", async () => {
    let connect: (event: { ports: readonly AcpPort[] }) => void = () => {};
    const source: PortSource = { addEventListener: (_, listener) => (connect = listener) };
    const early = new MessageChannel();
    const starting = BrowserHost.serve(source, { worker: new EchoWorker(), identity: ME, log: () => {} });
    connect({ ports: [early.port2] });
    const h = await starting;
    hosts.push(h);
    const late = new MessageChannel();
    connect({ ports: [late.port2] });
    for (const port of [early.port1, late.port1]) {
      const { acp } = client(port);
      expect(await acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })).toMatchObject({ protocolVersion: PROTOCOL_VERSION });
      port.close();
    }
  });

  it("BH1.4 closing the host hangs up its ports and saves its sessions", async () => {
    const storage = new MemoryStorage();
    const h = await BrowserHost.start({ worker: new EchoWorker(), identity: ME, storage });
    const { port1, port2 } = new MessageChannel();
    const hungUp = new Promise<void>((resolve) => port1.addEventListener("close", () => resolve()));
    h.accept(port2);
    const { acp } = client(port1);
    await acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await acp.newSession({ cwd: "/", mcpServers: [] });
    await h.close();
    await hungUp;
    const later = await host({ storage: storage.reopen() });
    expect(later.daemon.snapshot().sessions.map((s) => s.id)).toEqual([sessionId]);
  });

  it("BH1.5 the daemon in the browser is an AI SDK harness too: a HarnessAgent drives it over a port", async () => {
    const h = await host();
    const agent = new HarnessAgent({
      harness: daemonHarness({
        connect: () => {
          const { port1, port2 } = new MessageChannel();
          h.accept(port2);
          return daemonPort(port1);
        },
      }),
    });
    const session = await agent.createSession({ sandboxSession: noSandbox() });
    const result = await agent.stream({ session, prompt: "hi from the agent" });
    expect(await result.text).toBe("echo: hi from the agent");
    await session.destroy();
  });

  it("BH1.6 ticks run on the host's timer: an unanswered permission request is cancelled once it times out", async () => {
    const h = await host({ permissionTimeoutMs: 20, tickMs: 5 });
    const { port1, port2 } = new MessageChannel();
    h.accept(port2);
    let asked = 0;
    const acp = new ClientSideConnection(
      () => ({ sessionUpdate: async () => {}, requestPermission: () => (asked++, new Promise(() => {})) }),
      portStream(port1),
    );
    await acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await acp.newSession({ cwd: "/", mcpServers: [] });
    // The echo worker asks for permission on "!permission" and ends its turn cancelled when refused.
    expect(await acp.prompt({ sessionId, prompt: [{ type: "text", text: "!permission please" }] })).toMatchObject({ stopReason: expect.any(String) });
    expect(asked).toBe(1);
    port1.close();
  });

  it("BH1.7 without a log, the host reports failures on the console", async () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (m: unknown) => void errors.push(m);
    try {
      const h = await BrowserHost.start({ worker: { run: async () => { throw new Error("boom"); }, cancel: () => {}, permission: () => {} }, identity: ME, agentInfo: { name: "tab", version: "1" }, flowCapacity: 4 });
      hosts.push(h);
      const { port1, port2 } = new MessageChannel();
      h.accept(port2);
      const { acp } = client(port1);
      expect(await acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })).toMatchObject({ agentInfo: { name: "tab" } });
      const { sessionId } = await acp.newSession({ cwd: "/", mcpServers: [] });
      expect(await acp.prompt({ sessionId, prompt: [] })).toEqual({ stopReason: "refusal" });
      expect(errors).toEqual([expect.stringMatching(/worker failed: Error: boom/)]);
      port1.close();
    } finally {
      console.error = original;
    }
  });

  it("BH1.8 without an ensemble, cognitive work is refused with how to enable it here", async () => {
    const h = await host();
    const { port1, port2 } = new MessageChannel();
    h.accept(port2);
    const { acp } = client(port1);
    await acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await expect(acp.extMethod("_harness/cognitive/status", {})).rejects.toMatchObject({ message: expect.stringMatching(/give the browser host an ensemble/) });
    port1.close();
  });
});
