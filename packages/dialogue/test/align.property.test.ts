import { describe, expect } from "vitest";
import { fc, test } from "@fast-check/vitest";
import { commonSubsequence } from "@harness/dialogue";

/** The length of a longest common subsequence, by plain recursion over prefixes (a reference). */
function reference(a: readonly string[], b: readonly string[]): number {
  const memo = new Map<string, number>();
  const go = (i: number, j: number): number => {
    if (i === 0 || j === 0) return 0;
    const key = `${i},${j}`;
    if (!memo.has(key)) memo.set(key, a[i - 1] === b[j - 1] ? go(i - 1, j - 1) + 1 : Math.max(go(i - 1, j), go(i, j - 1)));
    return memo.get(key)!;
  };
  return go(a.length, b.length);
}

const words = fc.array(fc.constantFrom("a", "b", "c", " "), { maxLength: 9 });
const same = (x: string, y: string) => x === y;

describe("commonSubsequence", () => {
  test.prop([words, words])("TA4.1 is a common subsequence (in order, of equal tokens) as long as the longest", (a, b) => {
    const pairs = commonSubsequence(a, b, same);
    expect(pairs).toHaveLength(reference(a, b));
    pairs.forEach(([i, j], n) => {
      expect(a[i]).toBe(b[j]);
      if (n > 0) {
        expect(i).toBeGreaterThan(pairs[n - 1]![0]);
        expect(j).toBeGreaterThan(pairs[n - 1]![1]);
      }
    });
  });
});
