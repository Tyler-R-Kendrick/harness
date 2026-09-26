import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyMessage } from "@agentclientprotocol/sdk";
import { ambientLocks, daemonPort, PORT_CONTROL, portControl, portStream } from "@harness/platform-browser";
import { profileLocks } from "./locks.ts";

const closed = (port: MessagePort) => new Promise<void>((resolve) => port.addEventListener("close", () => resolve()));
const messages = (port: MessagePort) => {
  const got: unknown[] = [];
  port.addEventListener("message", (e) => got.push(e.data));
  port.start();
  return got;
};
const settle = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => vi.unstubAllGlobals());

describe("ACP over a MessagePort", () => {
  it("PS1.1 each message written is one structured message on the port, and each one posted is read back", async () => {
    const { port1, port2 } = new MessageChannel();
    const stream = portStream(port1, { locks: undefined });
    const got = messages(port2);
    await stream.writable.getWriter().write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await settle();
    expect(got).toEqual([{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }]);
    port2.postMessage({ jsonrpc: "2.0", id: 1, result: {} });
    expect(await stream.readable.getReader().read()).toEqual({ done: false, value: { jsonrpc: "2.0", id: 1, result: {} } });
    port2.close();
  });

  it("PS1.2 the other end closing its port ends the readable, and writing afterwards fails", async () => {
    const { port1, port2 } = new MessageChannel();
    const stream = portStream(port1, { locks: undefined });
    const reader = stream.readable.getReader();
    port2.close();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    await expect(stream.writable.getWriter().write({ jsonrpc: "2.0", method: "x" } as AnyMessage)).rejects.toThrow(/port is closed/);
  });

  it("PS1.3 the other end saying it hangs up ends the readable; later messages are dropped", async () => {
    const { port1, port2 } = new MessageChannel();
    const stream = portStream(port1, { locks: undefined });
    const reader = stream.readable.getReader();
    port2.postMessage({ [PORT_CONTROL]: "close" });
    port2.postMessage({ jsonrpc: "2.0", method: "late" });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    port2.close();
  });

  it("PS1.4 hanging up says so on the port, then closes it; hanging up again does nothing", async () => {
    const { port1, port2 } = new MessageChannel();
    const got = messages(port2);
    const other = closed(port2);
    const stream = portStream(port1, { locks: undefined });
    stream.hangUp();
    stream.hangUp();
    await other;
    expect(got).toEqual([{ [PORT_CONTROL]: "close" }]);
    expect(await stream.readable.getReader().read()).toEqual({ done: true, value: undefined });
  });

  it.each([
    ["closing the writable", (s: ReturnType<typeof portStream>) => s.writable.close()],
    ["aborting the writable", (s: ReturnType<typeof portStream>) => s.writable.abort(new Error("gone"))],
    ["cancelling the readable", (s: ReturnType<typeof portStream>) => s.readable.cancel()],
  ])("PS1.5 %s hangs up", async (_, end) => {
    const { port1, port2 } = new MessageChannel();
    const got = messages(port2);
    const other = closed(port2);
    await end(portStream(port1, { locks: undefined }));
    await other;
    expect(got).toEqual([{ [PORT_CONTROL]: "close" }]);
  });

  it("PS1.6 with Web Locks, a client holds a lock of its own for as long as it lives, names it to the host, and lets it go on hanging up", async () => {
    const { port1, port2 } = new MessageChannel();
    const got = messages(port2);
    const profile = profileLocks();
    const stream = portStream(port1, { locks: profile.locks });
    await settle();
    expect(profile.held()).toHaveLength(1);
    expect(got).toEqual([{ [PORT_CONTROL]: "alive", lock: profile.held()[0] }]);
    expect(profile.held()[0]).toMatch(/^harness-port-[0-9a-f]{32}$/);
    stream.hangUp();
    await settle();
    expect(profile.held()).toEqual([]);
  });

  it("PS1.7 a client that hangs up before its lock is granted lets it go at once, without naming it", async () => {
    const { port1, port2 } = new MessageChannel();
    const got = messages(port2);
    const profile = profileLocks();
    let grant = () => {};
    const slow = { request: (name: string, callback: () => Promise<unknown>) => new Promise<void>((r) => (grant = r)).then(() => profile.locks.request(name, callback)) };
    portStream(port1, { locks: slow }).hangUp();
    grant();
    await settle();
    expect(profile.held()).toEqual([]);
    expect(got).toEqual([{ [PORT_CONTROL]: "close" }]);
  });

  it("PS1.8 by default a stream uses the context's Web Locks", async () => {
    const profile = profileLocks();
    vi.stubGlobal("navigator", { locks: profile.locks });
    expect(ambientLocks()).toBe(profile.locks);
    const { port1, port2 } = new MessageChannel();
    const stream = portStream(port1);
    await settle();
    expect(profile.held()).toHaveLength(1);
    stream.hangUp();
    port2.close();
  });

  it("PS1.9 without Web Locks in the context, a stream simply has none", () => {
    vi.stubGlobal("navigator", undefined);
    expect(ambientLocks()).toBeUndefined();
    vi.stubGlobal("navigator", {});
    expect(ambientLocks()).toBeUndefined();
  });

  it("PS1.10 port control messages are recognized only in their exact shapes", () => {
    expect(portControl({ [PORT_CONTROL]: "close" })).toEqual({ [PORT_CONTROL]: "close" });
    expect(portControl({ [PORT_CONTROL]: "close", extra: 1 })).toEqual({ [PORT_CONTROL]: "close" });
    expect(portControl({ [PORT_CONTROL]: "alive", lock: "l1" })).toEqual({ [PORT_CONTROL]: "alive", lock: "l1" });
    for (const other of [{ [PORT_CONTROL]: "alive" }, { [PORT_CONTROL]: "alive", lock: 3 }, { [PORT_CONTROL]: "open" }, { jsonrpc: "2.0", method: "close" }, null, "close", 3]) expect(portControl(other)).toBeUndefined();
  });

  it("PS1.11 a daemon link over a port hangs up on close", async () => {
    const { port1, port2 } = new MessageChannel();
    const got = messages(port2);
    const other = closed(port2);
    const link = daemonPort(port1, { locks: undefined });
    expect(link.stream.readable).toBeInstanceOf(ReadableStream);
    await link.close();
    await other;
    expect(got).toEqual([{ [PORT_CONTROL]: "close" }]);
  });

  it("PS1.12 a daemon link uses the context's Web Locks by default", async () => {
    const profile = profileLocks();
    vi.stubGlobal("navigator", { locks: profile.locks });
    const { port1, port2 } = new MessageChannel();
    const link = daemonPort(port1);
    await settle();
    expect(profile.held()).toHaveLength(1);
    await link.close();
    port2.close();
  });
});
