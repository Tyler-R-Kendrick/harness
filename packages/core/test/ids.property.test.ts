import { describe, expect } from "vitest";
import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { newId, parseId } from "@harness/core";

const fixedEntropy = (bytes: Uint8Array) => ({ bytes: (n: number) => bytes.slice(0, n) });
const bytes16 = fc.uint8Array({ minLength: 16, maxLength: 16 });

describe("ids properties", () => {
  test.prop([bytes16])("ID3.1 every generated id parses back to itself", (bytes) => {
    const id = newId("effect", fixedEntropy(bytes));
    expect(parseId("effect", id)).toBe(id);
  });

  test.prop([bytes16, bytes16])("ID3.2 encoding is injective: distinct bytes give distinct ids", (a, b) => {
    fc.pre(a.some((x, i) => x !== b[i]));
    expect(newId("effect", fixedEntropy(a))).not.toBe(newId("effect", fixedEntropy(b)));
  });

  test.prop([fc.string()])("ID3.3 parseId never throws on arbitrary input", (raw) => {
    expect(() => parseId("session", raw)).not.toThrow();
  });
});
