import { describe, expect, it } from "vitest";
import type { Entropy } from "@harness/core";
import { permute, prefixSize } from "@harness/evolution";

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

/** Each draw is the word (b, 0, 0, 0): a draw of b / 256. */
const draws = (...tops: number[]): number[] => tops.flatMap((t) => [t, 0, 0, 0]);

describe("futility: stage size and permutation, exactly", () => {
  it("RS22.10 a stage over no tasks is refused, naming the count", () => {
    expect(() => prefixSize(0.5, 0)).toThrow("a stage needs tasks, not 0");
    expect(() => prefixSize(0.5, -3)).toThrow("a stage needs tasks, not -3");
  });

  it("RS22.11 a permutation swaps position i with an index drawn in [0, i], from the end: high draws leave every item in place", () => {
    // Draws 0.9 and 0.9: i = 2 draws index(3) = 2 (itself), i = 1 draws index(2) = 1 (itself).
    expect(permute(["a", "b", "c"], fixed(draws(230, 230)))).toEqual(["a", "b", "c"]);
  });

  it("RS22.12 a permutation with zero draws moves each item to the front in turn", () => {
    // i = 2 swaps with 0: [c, b, a]; i = 1 swaps with 0: [b, c, a].
    expect(permute(["a", "b", "c"], fixed(draws(0, 0)))).toEqual(["b", "c", "a"]);
  });

  it("RS22.13 the draw at position i ranges over i + 1 values, so the last position can stay and a middle draw picks a middle item", () => {
    // i = 3 draws 0.5: index(4) = 2: [a, b, d, c]; i = 2 draws 0.5: index(3) = 1: [a, d, b, c]; i = 1 draws 0.5: index(2) = 1: itself.
    expect(permute(["a", "b", "c", "d"], fixed(draws(128, 128, 128)))).toEqual(["a", "d", "b", "c"]);
    // i = 1 draws 0.99: index(2) = 1 (itself, not index 0 or beyond).
    expect(permute(["a", "b"], fixed(draws(254)))).toEqual(["a", "b"]);
    expect(permute(["a", "b"], fixed(draws(0)))).toEqual(["b", "a"]);
  });

  it("RS22.14 a permutation of n items draws n - 1 times: position 0 draws nothing", () => {
    // 1025 items need 1024 draws, exactly one block of 4096 bytes; a draw for position 0 would ask for a second block.
    const port = fixed([0, 0, 0, 0]);
    const items = Array.from({ length: 1025 }, (_, i) => i);
    permute(items, port);
    expect(port.asked).toEqual([4096]);
  });

  it("RS22.15 a permutation leaves its input alone", () => {
    const items = ["a", "b", "c"];
    permute(items, fixed(draws(0, 0)));
    expect(items).toEqual(["a", "b", "c"]);
  });
});
