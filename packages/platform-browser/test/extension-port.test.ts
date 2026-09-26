import { afterEach, describe, expect, it } from "vitest";
import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { BrowserHost, extensionPort, portStream } from "@harness/platform-browser";
import type { ExtensionPort } from "@harness/platform-browser";
import { EchoWorker } from "@harness/workers";

/** Two ends of a `chrome.runtime.Port`: messages arrive asynchronously; disconnecting one tells only the other. */
function portPair(name = "acp"): [ExtensionPort & { disconnected: boolean }, ExtensionPort & { disconnected: boolean }] {
  const make = () => {
    const onMessage: ((m: unknown) => void)[] = [];
    const onDisconnect: (() => void)[] = [];
    return { onMessage, onDisconnect };
  };
  const a = make();
  const b = make();
  const pair: { disconnected: boolean }[] = [];
  const end = (self: ReturnType<typeof make>, other: ReturnType<typeof make>) => {
    const otherEnd = () => pair.find((p) => p !== port)!;
    const port = {
      name,
      disconnected: false,
      postMessage: (m: unknown) => {
        if (port.disconnected) throw new Error("Attempting to use a disconnected port object");
        const copy = structuredClone(m);
        setTimeout(() => other.onMessage.forEach((l) => l(copy)), 0);
      },
      disconnect: () => {
        if (port.disconnected) return;
        // Chrome disconnects both ends; only the other end hears of it.
        port.disconnected = true;
        otherEnd().disconnected = true;
        setTimeout(() => other.onDisconnect.forEach((l) => l()), 0);
      },
      onMessage: { addListener: (l: (m: unknown) => void) => void self.onMessage.push(l) },
      onDisconnect: { addListener: (l: () => void) => void self.onDisconnect.push(l) },
    };
    pair.push(port);
    return port;
  };
  return [end(a, b), end(b, a)];
}

const ME = { principal: "me", kind: "human" } as const;
const hosts: BrowserHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

function client(port: ExtensionPort) {
  const updates: SessionNotification[] = [];
  const stream = portStream(extensionPort(port), { locks: undefined });
  const acp = new ClientSideConnection(() => ({ sessionUpdate: async (n) => void updates.push(n), requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) }), stream);
  const said = () => updates.flatMap((n) => (n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text" ? [n.update.content.text] : [])).join("");
  return { acp, said, hangUp: stream.hangUp };
}

describe("extension ports (chrome.runtime.Port)", () => {
  it("EP1.1 a runtime port is a port ACP travels over: its messages are message events, its other end disconnecting is a close", async () => {
    const [mine, theirs] = portPair();
    const port = extensionPort(mine);
    const got: unknown[] = [];
    port.addEventListener("message", (e) => got.push(e.data));
    let closed = 0;
    port.addEventListener("close", () => void closed++);
    port.start();
    port.postMessage({ hello: 1 });
    const back: unknown[] = [];
    theirs.onMessage.addListener((m) => back.push(m));
    theirs.postMessage({ hi: 2 });
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toEqual([{ hi: 2 }]);
    expect(back).toEqual([{ hello: 1 }]);
    theirs.disconnect();
    await new Promise((r) => setTimeout(r, 5));
    expect(closed).toBe(1);
    port.close();
    expect(mine.disconnected).toBe(true);
  });

  it("EP1.2 an extension's service worker serves every port named acp, including ports that connect while it starts, and ignores other ports", async () => {
    const connects: ((port: ExtensionPort) => void)[] = [];
    const onConnect = { addListener: (l: (port: ExtensionPort) => void) => void connects.push(l) };
    const [earlyClient, earlyHost] = portPair();
    const [otherClient, otherHost] = portPair("devtools");
    const starting = BrowserHost.serveExtension(onConnect, { worker: new EchoWorker(), identity: ME, log: () => {} });
    connects.forEach((l) => (l(earlyHost), l(otherHost)));
    const h = await starting;
    hosts.push(h);
    const [lateClient, lateHost] = portPair();
    connects.forEach((l) => l(lateHost));
    for (const port of [earlyClient, lateClient]) {
      const c = client(port);
      expect(await c.acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })).toMatchObject({ protocolVersion: PROTOCOL_VERSION });
      const { sessionId } = await c.acp.newSession({ cwd: "/", mcpServers: [] });
      expect(await c.acp.prompt({ sessionId, prompt: [{ type: "text", text: "from the popup" }] })).toEqual({ stopReason: "end_turn" });
      expect(c.said()).toBe("echo: from the popup");
      c.hangUp();
    }
    const heard: unknown[] = [];
    otherClient.onMessage.addListener((m) => heard.push(m));
    otherClient.postMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await new Promise((r) => setTimeout(r, 20));
    expect(heard).toEqual([]);
  });

  it("EP1.3 a page that goes away (its port disconnects) frees its session for another", async () => {
    const connects: ((port: ExtensionPort) => void)[] = [];
    const h = await BrowserHost.serveExtension({ addListener: (l) => void connects.push(l) }, { worker: new EchoWorker(), identity: ME, log: () => {}, locks: undefined });
    hosts.push(h);
    const [firstClient, firstHost] = portPair();
    connects.forEach((l) => l(firstHost));
    const first = client(firstClient);
    await first.acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await first.acp.newSession({ cwd: "/", mcpServers: [] });
    await first.acp.prompt({ sessionId, prompt: [{ type: "text", text: "mine" }] });
    // the page closes: Chrome disconnects its port, and the host's end hears it
    firstClient.disconnect();
    await new Promise((r) => setTimeout(r, 10));
    const [secondClient, secondHost] = portPair();
    connects.forEach((l) => l(secondHost));
    const second = client(secondClient);
    await second.acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await second.acp.loadSession({ sessionId, cwd: "/", mcpServers: [] });
    expect(await second.acp.prompt({ sessionId, prompt: [{ type: "text", text: "mine now" }] })).toEqual({ stopReason: "end_turn" });
    second.hangUp();
  });

  it("EP1.4 a message for a page whose port is gone is dropped, not thrown into the daemon", async () => {
    const [mine, theirs] = portPair();
    const port = extensionPort(mine);
    theirs.disconnect();
    expect(() => mine.postMessage({ late: true })).toThrow(/disconnected port/);
    expect(() => port.postMessage({ late: true })).not.toThrow();
  });
});
