import { describe, expect, it } from "vitest";
import { ManualClock, SeededEntropy } from "@harness/testkit";

describe("SeededEntropy", () => {
  it("TK1.1 the same seed yields the same byte stream", () => {
    const a = new SeededEntropy(42);
    const b = new SeededEntropy(42);
    expect(a.bytes(32)).toEqual(b.bytes(32));
    expect(a.bytes(7)).toEqual(b.bytes(7));
  });

  it("TK1.2 different seeds yield different streams", () => {
    expect(new SeededEntropy(1).bytes(16)).not.toEqual(new SeededEntropy(2).bytes(16));
  });

  it("TK1.3 returns exactly the requested number of bytes in range", () => {
    const bytes = new SeededEntropy(7).bytes(1000);
    expect(bytes).toHaveLength(1000);
    expect(bytes.every((b) => b >= 0 && b <= 255)).toBe(true);
    expect(new Set(bytes).size).toBeGreaterThan(200);
  });

  it("TK1.4 consecutive calls continue the stream instead of repeating it", () => {
    const e = new SeededEntropy(9);
    expect(e.bytes(16)).not.toEqual(e.bytes(16));
  });
});

describe("ManualClock", () => {
  it("TK2.1 starts at the given time and only moves when advanced", () => {
    const clock = new ManualClock(1000);
    expect(clock.now()).toBe(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(250);
    expect(clock.now()).toBe(1250);
  });

  it("TK2.2 refuses to move backwards", () => {
    const clock = new ManualClock(10);
    expect(() => clock.advance(-1)).toThrow(/backwards/);
    expect(clock.now()).toBe(10);
  });

  it("TK2.3 set() jumps forward but never backwards", () => {
    const clock = new ManualClock(10);
    clock.set(20);
    expect(clock.now()).toBe(20);
    expect(() => clock.set(19)).toThrow(/backwards/);
  });
});
