import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { daemonHarness, noSandbox } from "@harness/client";
import { buildNativeEnsemble, daemonSocket, invokeDaemon, NodeHost } from "@harness/platform-native";
import { EchoWorker } from "@harness/workers";

const hosts: NodeHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

describe("the running daemon as an AI SDK harness, over its socket", () => {
  it("DL1.1 a HarnessAgent reaches the daemon on its Unix socket and runs a turn there", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "harness-")), "harness.sock");
    const host = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" } });
    hosts.push(host);
    await host.listen(path);
    const agent = new HarnessAgent({ harness: daemonHarness({ connect: () => daemonSocket(path) }) });
    const session = await agent.createSession({ sandboxSession: noSandbox() });
    expect(await (await agent.stream({ session, prompt: "over the socket" })).text).toBe("echo: over the socket");
    await session.destroy();
  });

  it("DL1.3 invokeDaemon runs one cognitive operation on the daemon at the socket and returns its result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-"));
    const path = join(dir, "harness.sock");
    const cognitive = buildNativeEnsemble({ cacheDir: join(dir, "cache"), allowHosted: false, catalog: { models: [], preferences: {} }, procedural: { dir: join(dir, "store") } });
    const host = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" }, cognitive: cognitive.ensemble });
    hosts.push(host);
    await host.listen(path);
    expect(await invokeDaemon(path, "procedural.import", { graph: "team/search" })).toMatchObject({ status: "head" });
    expect(await invokeDaemon(path, "procedural.history", { graph: "team/search" })).toMatchObject({ revisions: [{ origin: "import" }] });
    await cognitive.close();
  });

  it("DL1.4 a daemon's refusal is an error that carries its message, and so is no daemon", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "harness-")), "harness.sock");
    const host = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" } });
    hosts.push(host);
    await host.listen(path);
    await expect(invokeDaemon(path, "procedural.history", { graph: "g" })).rejects.toThrow(/no extension procedural is installed/);
    await expect(invokeDaemon(`${path}.missing`, "procedural.history", { graph: "g" })).rejects.toThrow(/ENOENT/);
  });

  it("DL1.2 no daemon listening is an error, not a hang", async () => {
    await expect(daemonSocket(join(mkdtempSync(join(tmpdir(), "harness-")), "missing.sock"))).rejects.toThrow(/ENOENT/);
  });
});
