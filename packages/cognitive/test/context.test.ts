import { describe, expect, it } from "vitest";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { compactContext } from "@harness/cognitive";

/** A stand-in for the catalog compressor: tokens are whitespace-separated words, and a rate below 1 keeps that fraction from the front. */
function compressing(calls: { text: string; rate: number }[]) {
  return async (request: { text: string; rate: number }) => {
    calls.push({ text: request.text, rate: request.rate });
    const all = request.text.split(/\s+/).filter((word) => word.length > 0);
    const kept = request.rate >= 1 ? all : all.slice(0, Math.floor(all.length * request.rate));
    return { text: kept.join(" "), originalTokens: all.length, compressedTokens: kept.length };
  };
}

const system = (content: string): LanguageModelV4Prompt[number] => ({ role: "system", content });
const user = (text: string): LanguageModelV4Prompt[number] => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): LanguageModelV4Prompt[number] => ({ role: "assistant", content: [{ type: "text", text }] });

const MIDDLE = "alpha bravo charlie delta echo foxtrot golf hotel";

describe("cache-optimized context", () => {
  it("CX1.1 context over the budget compacts only the middle, leaving the system prefix and the current turn byte-identical", async () => {
    const calls: { text: string; rate: number }[] = [];
    const prefix = system("STABLE ____");
    const history = user(MIDDLE);
    const latest = user("LATEST ____");
    const follow = assistant("partial");
    const prompt: LanguageModelV4Prompt = [prefix, history, latest, follow];
    const fitted = await compactContext(prompt, 7, compressing(calls));
    expect(fitted[0]).toBe(prefix);
    expect(fitted.at(-2)).toBe(latest);
    expect(fitted.at(-1)).toBe(follow);
    expect(fitted).toHaveLength(4);
    expect(fitted[1]).toMatchObject({ role: "user", content: [{ type: "text", text: "alpha bravo" }] });
    expect(JSON.stringify(fitted)).not.toContain("foxtrot");
    expect(calls.some((call) => call.rate < 1 && call.text === MIDDLE)).toBe(true);
  });

  it("CX1.2 a template already longer than the budget stays whole and only the middle is dropped", async () => {
    const calls: { text: string; rate: number }[] = [];
    const template = system(`____ ${Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ")}`);
    const history = user(MIDDLE);
    const latest = user("LATEST ____");
    const prompt: LanguageModelV4Prompt = [template, history, latest];
    const fitted = await compactContext(prompt, 10, compressing(calls));
    expect(fitted).toEqual([template, latest]);
    expect(fitted[0]).toBe(template);
    expect(fitted[1]).toBe(latest);
    expect(calls.every((call) => call.rate === 1)).toBe(true);
  });

  it("CX1.3 a prompt inside the budget is returned as the same messages and the compressor is not called", async () => {
    const calls: { text: string; rate: number }[] = [];
    const prompt: LanguageModelV4Prompt = [system("STABLE ____"), user("LATEST ____")];
    const fitted = await compactContext(prompt, 16384, compressing(calls));
    expect(fitted).toBe(prompt);
    expect(calls).toEqual([]);
  });

  it("CX1.4 characters past the budget with compressor tokens inside it leave the prompt unchanged", async () => {
    const calls: { text: string; rate: number }[] = [];
    const prefix = system("abcdef");
    const history = user("ghijklmn");
    const latest = user("op");
    const prompt: LanguageModelV4Prompt = [prefix, history, latest];
    const fitted = await compactContext(prompt, 5, compressing(calls));
    expect(fitted).toBe(prompt);
    expect(calls.every((call) => call.rate === 1)).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });
});
