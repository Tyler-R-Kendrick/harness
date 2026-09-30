import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { askDaemon, openDaemon } from "@harness/cli-template";
import { NodeHost } from "@harness/platform-native";
import { EchoWorker } from "@harness/workers";

const hosts: NodeHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

function stream(host: NodeHost) {
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  host.attach(toHost, fromHost);
  return ndJsonStream(Writable.toWeb(toHost), Readable.toWeb(fromHost) as ReadableStream<Uint8Array>);
}

describe("the cli template talks to the daemon", () => {
  it("CT1.1 a prompt sent to the daemon comes back as the worker's reply", async () => {
    const host = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" } });
    hosts.push(host);
    expect(await askDaemon(stream(host), "hello")).toBe("echo: hello");
  });

  it("CT1.2 an empty prompt is refused before a session is opened", async () => {
    const host = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" } });
    hosts.push(host);
    await expect(askDaemon(stream(host), "  ")).rejects.toThrow(/prompt must be a string/);
    expect(host.daemon.snapshot().sessions).toEqual([]);
  });

  it("CT1.3 two prompts on one opened client share one daemon session", async () => {
    const host = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" } });
    hosts.push(host);
    const session = await openDaemon(stream(host));
    expect(await session.prompt("one")).toBe("echo: one");
    expect(await session.prompt("two")).toBe("echo: two");
    expect(host.daemon.snapshot().sessions).toHaveLength(1);
  });
});
