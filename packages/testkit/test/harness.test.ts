import { describe, expect, it } from "vitest";
import { nullSandbox, scriptedHarness } from "@harness/testkit";

const turn = { skills: [], tools: [] };
const start = (h: ReturnType<typeof scriptedHarness>) => h.doStart({ sessionId: "s", sandboxSession: nullSandbox(), sessionWorkDir: "/sandbox/s" });

describe("scripted harness and null sandbox (test doubles for AI SDK harnesses)", () => {
  it("TH1.1 a session's lifecycle ends are logged; parking returns resumable state", async () => {
    const h = scriptedHarness(() => "ok");
    const state = { type: "resume-session", specificationVersion: "harness-v1", harnessId: "scripted", data: {} };
    expect(await (await start(h)).doDetach()).toEqual(state);
    expect(await (await start(h)).doStop()).toEqual(state);
    await (await start(h)).doDestroy();
    expect(h.log.started).toEqual(["s", "s", "s"]);
    expect(h.log.ended).toEqual(["s", "s", "s"]);
  });

  it("TH1.2 there is no turn to continue before one starts, and turns are never suspended", async () => {
    const s = await start(scriptedHarness(() => "ok"));
    await expect(s.doContinueTurn({ ...turn, emit: () => {} })).rejects.toThrow(/no turn to continue/);
    await expect(s.doSuspendTurn()).rejects.toThrow(/does not suspend/);
    await expect(s.doCompact()).resolves.toBeUndefined();
  });

  it("TH1.3 a turn replies to a plain-text prompt; an aborted turn fails", async () => {
    const s = await start(scriptedHarness((p) => `echo ${p}`));
    const parts: unknown[] = [];
    await (await s.doPromptTurn({ ...turn, prompt: "hi", emit: (p) => parts.push(p) })).done;
    expect(parts).toContainEqual({ type: "text-delta", id: "t", delta: "echo hi" });
    // a turn waiting on a host tool is the one that can be aborted
    const waiting = await start(scriptedHarness(() => ({ text: "t", tool: { name: "x", input: {} } })));
    const abort = new AbortController();
    const control = await waiting.doPromptTurn({ ...turn, prompt: "x", abortSignal: abort.signal, emit: () => {} });
    abort.abort();
    await expect(control.done).rejects.toThrow(/aborted/);
  });

  it("TH1.4 the null sandbox stores nothing and runs no processes", async () => {
    const box = nullSandbox();
    await box.writeFile({ path: "a", content: new ReadableStream() });
    await box.writeBinaryFile({ path: "a", content: new Uint8Array() });
    await box.writeTextFile({ path: "a", content: "x" });
    expect([await box.readFile({ path: "a" }), await box.readBinaryFile({ path: "a" }), await box.readTextFile({ path: "a" })]).toEqual([null, null, null]);
    expect(await box.run({ command: "pwd" })).toEqual({ exitCode: 0, stdout: "/sandbox\n", stderr: "" });
    expect(await box.run({ command: "ls" })).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    await expect(box.spawn({ command: "ls" })).rejects.toThrow(/runs no processes/);
  });
});
