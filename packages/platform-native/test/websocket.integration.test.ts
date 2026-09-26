import { afterEach, describe, expect, it } from "vitest";
import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import { NodeHost } from "@harness/platform-native";
import { EchoWorker } from "@harness/workers";

const TOKEN = "t0ken-for-tests";
const hosts: NodeHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

async function host(options: { origins?: readonly string[] } = {}) {
  const h = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" } });
  hosts.push(h);
  const { url } = await h.listenWebSocket({ port: 0, token: TOKEN, ...options });
  return { h, url };
}

/** The official ACP client over the SDK's WebSocket stream (Node `ws`, so it can send headers). */
function client(url: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  const updates: SessionNotification[] = [];
  const acp = new ClientSideConnection(
    () => ({ sessionUpdate: async (n) => void updates.push(n), requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) }),
    createWebSocketStream(url, { WebSocket: WebSocket as never, headers }),
  );
  const said = () => updates.flatMap((n) => (n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text" ? [n.update.content.text] : [])).join("");
  return { acp, said };
}

/** Open a raw socket and report how the upgrade went. */
function upgrade(url: string, options: { headers?: Record<string, string>; protocols?: string[]; origin?: string } = {}) {
  return new Promise<{ status: number; protocol?: string; socket?: WebSocket }>((resolve) => {
    const socket = new WebSocket(url, options.protocols ?? [], { headers: options.headers ?? {}, ...(options.origin ? { origin: options.origin } : {}) });
    socket.once("open", () => resolve({ status: 101, protocol: socket.protocol, socket }));
    socket.once("unexpected-response", (_, res) => resolve({ status: res.statusCode ?? 0 }));
    socket.once("error", () => resolve({ status: 0 }));
  });
}
const next = (socket: WebSocket) => new Promise<unknown>((resolve) => socket.once("message", (data: Buffer) => resolve(JSON.parse(data.toString()))));

describe("NodeHost over WebSocket", () => {
  it("WS1.1 an ACP client on the SDK's WebSocket stream, with the token, opens a session and runs a turn", async () => {
    const { url } = await host();
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    const c = client(url);
    expect(await c.acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })).toMatchObject({ protocolVersion: PROTOCOL_VERSION });
    const { sessionId } = await c.acp.newSession({ cwd: "/", mcpServers: [] });
    expect(await c.acp.prompt({ sessionId, prompt: [{ type: "text", text: "over a socket" }] })).toEqual({ stopReason: "end_turn" });
    expect(c.said()).toBe("echo: over a socket");
  });

  it("WS1.2 a connection without the token, or with another, is refused before any ACP is spoken", async () => {
    const { url } = await host();
    expect((await upgrade(url)).status).toBe(401);
    expect((await upgrade(url, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await upgrade(url, { protocols: ["harness.token.wrong"] })).status).toBe(401);
    expect((await upgrade(url, { headers: { authorization: `Basic ${TOKEN}` } })).status).toBe(401);
  });

  it("WS1.3 a browser page is refused unless its origin is allowed; an allowed page sends the token as a subprotocol", async () => {
    const { url } = await host({ origins: ["chrome-extension://abc"] });
    expect((await upgrade(url, { origin: "https://evil.example", protocols: [`harness.token.${TOKEN}`] })).status).toBe(403);
    const ok = await upgrade(url, { origin: "chrome-extension://abc", protocols: ["acp", `harness.token.${TOKEN}`] });
    expect(ok).toMatchObject({ status: 101, protocol: `harness.token.${TOKEN}` });
    const reply = next(ok.socket!);
    ok.socket!.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }));
    expect(await reply).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
    ok.socket!.close();
  });

  it("WS1.4 a frame that is not JSON-RPC gets an error and the connection carries on; a binary frame is refused the same way", async () => {
    const { url } = await host();
    const { socket } = await upgrade(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    let reply = next(socket!);
    socket!.send("{nope");
    expect(await reply).toMatchObject({ id: null, error: { code: -32700 } });
    reply = next(socket!);
    socket!.send(Buffer.from([1, 2, 3]));
    expect(await reply).toMatchObject({ id: null, error: { code: -32600 } });
    reply = next(socket!);
    socket!.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: 1 } }));
    expect(await reply).toMatchObject({ id: 2, result: { protocolVersion: 1 } });
    socket!.close();
  });

  it("WS1.5 a socket that closes disconnects its connection: another client can take over the session", async () => {
    const { url } = await host();
    const { socket } = await upgrade(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    const call = async (id: number, method: string, params: unknown) => {
      const done = new Promise<{ id?: number; result?: { sessionId?: string } }>((resolve) => {
        const on = (data: Buffer) => {
          const m = JSON.parse(data.toString()) as { id?: number };
          if (m.id !== id) return;
          socket!.off("message", on);
          resolve(m);
        };
        socket!.on("message", on);
      });
      socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return done;
    };
    await call(1, "initialize", { protocolVersion: 1 });
    const sessionId = (await call(2, "session/new", { cwd: "/", mcpServers: [] })).result!.sessionId!;
    await call(3, "session/prompt", { sessionId, prompt: [{ type: "text", text: "mine" }] });
    const second = client(url);
    await second.acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await second.acp.loadSession({ sessionId, cwd: "/", mcpServers: [] });
    await expect(second.acp.prompt({ sessionId, prompt: [{ type: "text", text: "too soon" }] })).rejects.toMatchObject({ message: expect.stringMatching(/input lease is held/) });
    socket!.close();
    for (let i = 0; i < 50; i++) {
      const r = await second.acp.prompt({ sessionId, prompt: [{ type: "text", text: "mine now" }] }).then(() => "ok", (e: Error) => e.message);
      if (r === "ok") return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the session was never released");
  });

  it("WS1.6 closing the host closes its WebSocket connections and stops listening", async () => {
    const { h, url } = await host();
    const { socket } = await upgrade(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    const closed = new Promise<void>((resolve) => socket!.once("close", () => resolve()));
    await h.close();
    hosts.splice(hosts.indexOf(h), 1);
    await closed;
    expect((await upgrade(url, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(0);
  });
});
