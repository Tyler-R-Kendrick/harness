import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@harness/procedural";

describe("canonical JSON and hashing", () => {
  it("PG1.1 canonicalJson sorts object keys at every depth, writes no whitespace and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: "x y" } })).toBe('{"a":{"c":"x y","d":[3,1,2]},"b":1}');
    expect(canonicalJson([{ z: 1, y: 2 }, "s"])).toBe('[{"y":2,"z":1},"s"]');
    // Keys sort by code unit, including keys that look like array indexes.
    expect(canonicalJson({ "10": 1, "2": 2, B: 3, a: 4 })).toBe('{"10":1,"2":2,"B":3,"a":4}');
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("PG1.2 canonicalJson writes scalars as JSON does, drops undefined fields and writes undefined or non-finite items as null", () => {
    expect(canonicalJson("é\"\n")).toBe(JSON.stringify("é\"\n"));
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(-1.5)).toBe("-1.5");
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson([undefined, Number.NaN, Number.POSITIVE_INFINITY])).toBe("[null,null,null]");
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
  });

  it("PG1.3 sha256Hex hashes the UTF-8 bytes of text to lowercase hex", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // UTF-8 bytes, not code units, and astral characters as one code point.
    for (const text of ["é", "→ 𝒢", "Start\nEnd"]) expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });
});
