import { describe, expect, it } from "vitest";
import type { Entropy } from "@harness/core";
import { Uniform } from "../src/random.ts";

/** An entropy port that serves a fixed stream (cycling it), and records the lengths it was asked for. */
function fixed(stream: readonly number[]): Entropy & { readonly asked: number[] } {
  let at = 0;
  const asked: number[] = [];
  return {
    asked,
    bytes(length: number): Uint8Array {
      asked.push(length);
      return Uint8Array.from({ length }, () => stream[at++ % stream.length]!);
    },
  };
}

const cell = (word: number): number => (word + 0.5) / 2 ** 32;

describe("Uniform: exact draws from a known byte stream", () => {
  it("RS22.1 a draw is the big-endian 32-bit word of four consecutive bytes, at the middle of its cell", () => {
    const u = new Uniform(fixed([0x12, 0x34, 0x56, 0x78]));
    expect(u.next()).toBe(cell(0x12345678));
  });

  it("RS22.2 the second draw reads the next four bytes, each byte in its own position", () => {
    const u = new Uniform(fixed([1, 2, 3, 4, 0x80, 0x40, 0x20, 0x10]));
    expect(u.next()).toBe(cell(0x01020304));
    expect(u.next()).toBe(cell(0x80402010));
  });

  it("RS22.3 the lowest byte is the least significant and the highest bit is not read as a sign", () => {
    expect(new Uniform(fixed([0, 0, 0, 1])).next()).toBe(cell(1));
    expect(new Uniform(fixed([0, 0, 1, 0])).next()).toBe(cell(256));
    expect(new Uniform(fixed([0, 1, 0, 0])).next()).toBe(cell(65536));
    expect(new Uniform(fixed([1, 0, 0, 0])).next()).toBe(cell(2 ** 24));
    expect(new Uniform(fixed([0xff, 0xff, 0xff, 0xff])).next()).toBe(cell(2 ** 32 - 1));
    expect(new Uniform(fixed([0x80, 0, 0, 0])).next()).toBe(cell(2 ** 31));
  });

  it("RS22.4 a draw is the midpoint of its cell: all zeros is half a cell above 0, all ones half a cell below 1", () => {
    const low = new Uniform(fixed([0, 0, 0, 0])).next();
    const high = new Uniform(fixed([0xff, 0xff, 0xff, 0xff])).next();
    expect(low).toBe(0.5 / 2 ** 32);
    expect(low).toBeGreaterThan(0);
    expect(high).toBe(1 - 0.5 / 2 ** 32);
    expect(high).toBeLessThan(1);
  });

  it("RS22.5 index(n) is floor(draw n), taken from the same draw", () => {
    // 0xE6666666 / 2^32 is just over 0.9: index(10) is 9, index(3) is 2.
    const u = new Uniform(fixed([0xe6, 0x66, 0x66, 0x66, 0xe6, 0x66, 0x66, 0x66]));
    expect(u.index(10)).toBe(9);
    expect(u.index(3)).toBe(2);
  });

  it("RS22.6 entropy is asked for in blocks of 4096 bytes, once per 1024 draws, and the stream continues across blocks", () => {
    const port = fixed([0, 0, 0, 7]);
    const u = new Uniform(port);
    for (let i = 0; i < 1024; i++) expect(u.next()).toBe(cell(7));
    expect(port.asked).toEqual([4096]);
    expect(u.next()).toBe(cell(7));
    expect(port.asked).toEqual([4096, 4096]);
  });
});
