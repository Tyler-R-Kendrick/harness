import type { Entropy } from "@harness/core";

const BLOCK = 4096;

/**
 * Uniform draws from the entropy port, 32 bits each, read in blocks so a bootstrap of
 * millions of draws does not ask the port for four bytes at a time. Reproducible from a
 * seeded port, which is what makes a round's decisions replayable.
 */
export class Uniform {
  readonly #entropy: Entropy;
  #bytes: Uint8Array = new Uint8Array(0);
  #at = 0;

  constructor(entropy: Entropy) {
    this.#entropy = entropy;
  }

  /** A draw strictly inside (0, 1): the midpoint of one of 2^32 equal cells, so inversions never meet log(0). */
  next(): number {
    if (this.#at === this.#bytes.length) {
      this.#bytes = this.#entropy.bytes(BLOCK);
      this.#at = 0;
    }
    const b = this.#bytes;
    const i = this.#at;
    this.#at += 4;
    const word = ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
    return (word + 0.5) / 2 ** 32;
  }

  /** An index in [0, n). */
  index(n: number): number {
    return Math.floor(this.next() * n);
  }
}

/** Laplace noise with scale `b` (mean 0, mean absolute deviation b), by inversion. */
export function laplace(u: Uniform, b: number): number {
  if (b === 0) return 0;
  const v = u.next() - 0.5;
  return -b * Math.sign(v) * Math.log(1 - 2 * Math.abs(v));
}
