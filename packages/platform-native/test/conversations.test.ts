import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import type { WorkerEvent } from "@harness/core";
import { conversationsFile, FileStorage } from "@harness/platform-native";
import { AgentWorker, sessionAgent, storedConversations } from "@harness/workers";

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
  it("NC1.1 an agent worker restarted on the same conversation file continues the session's conversation, an image included", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "harness-conv-")), "conversations.json");
    await turn(new AgentWorker({ agent: sessionAgent({ model: model() }), conversations: storedConversations(new FileStorage(file)) }), [{ type: "text", text: "look" }, { type: "image", data: "AQID", mimeType: "image/png" }], "t1");
    const after = model();
    await turn(new AgentWorker({ agent: sessionAgent({ model: after }), conversations: storedConversations(new FileStorage(file)) }), [{ type: "text", text: "and now?" }], "t2");
    const prompt = after.doStreamCalls[0]!.prompt;
    expect(prompt.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(prompt[0]!.content).toEqual([{ type: "text", text: "look" }, { type: "file", data: { type: "data", data: new Uint8Array([1, 2, 3]) }, mediaType: "image/png" }]);
  });

  it("NC1.2 conversations are kept beside the daemon's state unless a file is named; without state, nowhere", () => {
    expect(conversationsFile({ state: "/s/daemon.json" })).toBe("/s/daemon.conversations.json");
    expect(conversationsFile({ state: "/s/daemon" })).toBe("/s/daemon.conversations.json");
    expect(conversationsFile({ state: "/s/daemon.json", conversations: "/c.json" })).toBe("/c.json");
    expect(conversationsFile({ conversations: "/c.json" })).toBe("/c.json");
    expect(conversationsFile({})).toBeUndefined();
  });
});
