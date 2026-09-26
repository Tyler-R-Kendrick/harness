import { describe, expect, it } from "vitest";
import { ID_KINDS, newId, parseId } from "@harness/core";
import { SeededEntropy } from "@harness/testkit";

describe("ids", () => {
  it("ID1.1 an id is <prefix>_<26 Crockford base32 chars>", () => {
    const id = newId("session", new SeededEntropy(1));
    expect(id).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("ID1.2 every kind has a distinct three-letter prefix", () => {
    const prefixes = Object.values(ID_KINDS);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const p of prefixes) expect(p).toMatch(/^[a-z]{3}$/);
  });

  it("ID1.3 the same entropy yields the same id", () => {
    expect(newId("effect", new SeededEntropy(5))).toBe(newId("effect", new SeededEntropy(5)));
  });

  it("ID1.4 all-zero and all-ones bytes encode to the extreme alphabets", () => {
    const zeros = { bytes: (n: number) => new Uint8Array(n) };
    const ones = { bytes: (n: number) => new Uint8Array(n).fill(255) };
    expect(newId("task", zeros)).toBe("tsk_" + "0".repeat(26));
    expect(newId("task", ones)).toBe("tsk_" + "Z".repeat(25) + "W");
  });

  it("ID2.1 parseId accepts a valid id of the right kind", () => {
    const id = newId("subagent", new SeededEntropy(3));
    expect(parseId("subagent", id)).toBe(id);
  });

  it("ID2.2 parseId rejects an id of another kind", () => {
    const id = newId("subagent", new SeededEntropy(3));
    expect(parseId("session", id)).toBeUndefined();
  });

  it("ID2.3 parseId rejects wrong length, bad characters and non-strings", () => {
    const good = newId("session", new SeededEntropy(3));
    expect(parseId("session", good.slice(0, -1))).toBeUndefined();
    expect(parseId("session", good + "0")).toBeUndefined();
    expect(parseId("session", "ses_" + "I".repeat(26))).toBeUndefined();
    expect(parseId("session", "ses_" + "o".repeat(26))).toBeUndefined();
    expect(parseId("session", "ses-" + good.slice(4))).toBeUndefined();
    expect(parseId("session", 42)).toBeUndefined();
    expect(parseId("session", undefined)).toBeUndefined();
  });

  it("ID2.4 parseId rejects a final character carrying nonzero padding bits", () => {
    // 128 bits need 26 base32 chars (130 bits); the last char may only encode 3 value bits.
    expect(parseId("session", "ses_" + "0".repeat(25) + "1")).toBeUndefined();
    expect(parseId("session", "ses_" + "0".repeat(25) + "4")).toBe("ses_" + "0".repeat(25) + "4");
  });
});
