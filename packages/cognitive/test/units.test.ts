import { describe, expect, expectTypeOf, it } from "vitest";
import { bytes, commitSha, dimensions, probability, sha256, sumBytes } from "@harness/cognitive";
import type { Bytes, Dimensions, Probability } from "@harness/cognitive";

describe("refined values", () => {
  it("UN1.1 each is made only by parsing: in range, it is the value; out of range, a RangeError that says why", () => {
    expect(probability(0)).toBe(0);
    expect(probability(1)).toBe(1);
    expect(() => probability(1.01)).toThrow(RangeError);
    expect(() => probability(Number.NaN)).toThrow(/probability/);
    expect(bytes(0)).toBe(0);
    expect(() => bytes(-1)).toThrow(/bytes/);
    expect(() => bytes(1.5)).toThrow(/bytes/);
    expect(dimensions(768)).toBe(768);
    expect(() => dimensions(0)).toThrow(/dimensions/);
    expect(sha256("a".repeat(64))).toHaveLength(64);
    expect(() => sha256("A".repeat(64))).toThrow(/sha256/);
    expect(commitSha("0".repeat(40))).toHaveLength(40);
    expect(() => commitSha("main")).toThrow(/pinned commit/);
  });

  it("UN1.2 units do not mix: bytes add to bytes, and no plain number or other unit stands in for one", () => {
    expect(sumBytes([bytes(2), bytes(3)])).toBe(5);
    expect(sumBytes([])).toBe(0);
    expectTypeOf(sumBytes([bytes(1)])).toEqualTypeOf<Bytes>();
    expectTypeOf<number>().not.toMatchTypeOf<Probability>();
    expectTypeOf<Dimensions>().not.toMatchTypeOf<Bytes>();
    expectTypeOf<Probability>().toMatchTypeOf<number>();
  });

  it("UN1.3 similarities span [-1, 1]; a file's bytes are never zero, and are still Bytes", async () => {
    const { similarity, PositiveBytesSchema } = await import("@harness/cognitive");
    expect(similarity(-1)).toBe(-1);
    expect(() => similarity(1.5)).toThrow(/similarity/);
    expect(PositiveBytesSchema.safeParse(0).success).toBe(false);
    expectTypeOf(PositiveBytesSchema.parse(1)).toEqualTypeOf<Bytes>();
  });
});

