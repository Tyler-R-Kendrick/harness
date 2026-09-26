import { describe, expect, it } from "vitest";
import type { WorkerEvent } from "@harness/core";
import { EchoWorker } from "@harness/workers";

const cmd = (text: string, turnId = "t1") => ({ type: "prompt" as const, sessionId: "s1", turnId, cwd: "/", prompt: [{ type: "text", text }] });

function collect() {
  const events: WorkerEvent[] = [];
  return { events, emit: (e: WorkerEvent) => void events.push(e) };
}

describe("EchoWorker", () => {
  it("WK1.1 echoes the prompt text as agent message chunks and ends the turn", async () => {
    const w = new EchoWorker();
    const { events, emit } = collect();
    await w.run(cmd("hello world"), emit);
    const chunks = events.filter((e) => e.type === "update").map((e) => (e.update as { content: { text: string } }).content.text);
    expect(chunks.join("")).toBe("echo: hello world");
    expect(chunks.length).toBeGreaterThan(1);
    expect(events.at(-1)).toEqual({ type: "end", sessionId: "s1", turnId: "t1", stopReason: "end_turn" });
  });

  it("WK1.2 ignores non-text blocks", async () => {
    const w = new EchoWorker();
    const { events, emit } = collect();
    await w.run({ ...cmd("x"), prompt: [{ type: "image", data: "..." }, { type: "text", text: "hi" }] }, emit);
    const text = events.filter((e) => e.type === "update").map((e) => (e.update as { content: { text: string } }).content.text).join("");
    expect(text).toBe("echo: hi");
  });

  it("WK1.3 asks for permission when the prompt contains !permission and continues when allowed", async () => {
    const w = new EchoWorker();
    const { events, emit } = collect();
    const done = w.run(cmd("do it !permission"), emit);
    await Promise.resolve();
    const ask = events.find((e) => e.type === "permission");
    expect(ask).toMatchObject({ type: "permission", requestId: "t1:permission", options: [{ optionId: "allow" }, { optionId: "deny" }] });
    w.permission({ type: "permission", sessionId: "s1", turnId: "t1", requestId: "t1:permission", outcome: { outcome: "selected", optionId: "allow" } });
    await done;
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "end_turn" });
    expect(events.some((e) => e.type === "update" && (e.update as { content: { text: string } }).content.text.includes("echo"))).toBe(true);
  });

  it("WK1.4 a denied permission ends the turn without echoing", async () => {
    const w = new EchoWorker();
    const { events, emit } = collect();
    const done = w.run(cmd("!permission"), emit);
    await Promise.resolve();
    w.permission({ type: "permission", sessionId: "s1", turnId: "t1", requestId: "t1:permission", outcome: { outcome: "selected", optionId: "deny" } });
    await done;
    const texts = events.filter((e) => e.type === "update").map((e) => (e.update as { content: { text: string } }).content.text);
    expect(texts).toEqual(["permission denied"]);
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "end_turn" });
  });

  it("WK1.5 cancelling a turn waiting for permission ends it as cancelled", async () => {
    const w = new EchoWorker();
    const { events, emit } = collect();
    const done = w.run(cmd("!permission"), emit);
    await Promise.resolve();
    w.cancel("s1", "t1");
    await done;
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "cancelled" });
  });

  it("WK1.6 cancelling mid-echo stops further chunks", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = new EchoWorker({ pause: () => gate });
    const { events, emit } = collect();
    const done = w.run(cmd("one two three four"), emit);
    await Promise.resolve();
    w.cancel("s1", "t1");
    release();
    await done;
    expect(events.filter((e) => e.type === "update").length).toBeLessThan(4);
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "cancelled" });
  });

  it("WK1.7 commands for unknown turns are ignored", () => {
    const w = new EchoWorker();
    expect(() => w.cancel("s1", "nope")).not.toThrow();
    expect(() => w.permission({ type: "permission", sessionId: "s1", turnId: "nope", requestId: "r", outcome: { outcome: "cancelled" } })).not.toThrow();
  });
});
