import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { daemonHarness, noSandbox } from "@harness/client";
import { daemonSocket, NodeHost } from "@harness/platform-native";
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

  it("DL1.2 no daemon listening is an error, not a hang", async () => {
    await expect(daemonSocket(join(mkdtempSync(join(tmpdir(), "harness-")), "missing.sock"))).rejects.toThrow(/ENOENT/);
  });
});
