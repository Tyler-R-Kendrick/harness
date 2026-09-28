import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import type { WorkerEvent } from "@harness/core";
import { conversationsDir, fileConversations } from "@harness/platform-native";
import { AgentWorker, sessionAgent } from "@harness/workers";

function model() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: "ok" },
        { type: "text-end", id: "0" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } } },
      ]),
    }),
  });
}

async function turn(worker: AgentWorker, prompt: unknown[], turnId: string) {
  const events: WorkerEvent[] = [];
  await worker.run({ type: "prompt", sessionId: "s1", turnId, prompt, cwd: "/" }, (e) => events.push(e));
  return events;
}

describe("the native host's conversations across restarts", () => {
  it("NC1.1 an agent worker restarted on the same conversations directory continues the session's conversation, an image included; each session has a file", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "harness-conv-")), "conversations");
    await turn(new AgentWorker({ agent: sessionAgent({ model: model() }), conversations: fileConversations(dir) }), [{ type: "text", text: "look" }, { type: "image", data: "AQID", mimeType: "image/png" }], "t1");
    expect(readdirSync(dir)).toEqual(["s1.json"]);
    const after = model();
    await turn(new AgentWorker({ agent: sessionAgent({ model: after }), conversations: fileConversations(dir) }), [{ type: "text", text: "and now?" }], "t2");
    const prompt = after.doStreamCalls[0]!.prompt;
    expect(prompt.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(prompt[0]!.content).toEqual([{ type: "text", text: "look" }, { type: "file", data: { type: "data", data: new Uint8Array([1, 2, 3]) }, mediaType: "image/png" }]);
  });

  it("NC1.2 conversations are kept beside the daemon's state unless a directory is named; without state, nowhere", () => {
    expect(conversationsDir({ state: "/s/daemon.json" })).toBe("/s/daemon.conversations");
    expect(conversationsDir({ state: "/s/daemon" })).toBe("/s/daemon.conversations");
    expect(conversationsDir({ state: "/s/daemon.json", conversations: "/c" })).toBe("/c");
    expect(conversationsDir({ conversations: "/c" })).toBe("/c");
    expect(conversationsDir({})).toBeUndefined();
  });

  it("NC1.3 a session id that is not a safe file name stays inside the directory", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "harness-conv-")), "conversations");
    const store = fileConversations(dir);
    await store.save("../escape/../x", [{ role: "user", content: "hi" }]);
    expect(readdirSync(dir)).toEqual(["..%2Fescape%2F..%2Fx.json"]);
    expect(await store.load("../escape/../x")).toEqual([{ role: "user", content: "hi" }]);
  });
});
