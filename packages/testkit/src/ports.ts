import type { Clock, Entropy } from "@harness/core";

/** Deterministic byte stream (splitmix32). Reproducible from its seed; not for secrets. */
export class SeededEntropy implements Entropy {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      this.#state = (this.#state + 0x9e3779b9) >>> 0;
      let z = this.#state;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      out[i] = (z ^ (z >>> 16)) & 0xff;
    }
    return out;
  }
}

/** A clock that only moves when a test moves it, and never backwards. */
export class ManualClock implements Clock {
  #now: number;

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error("clock cannot move backwards");
    this.#now += ms;
  }

  set(at: number): void {
    if (at < this.#now) throw new Error("clock cannot move backwards");
    this.#now = at;
  }
}
