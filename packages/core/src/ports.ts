/** Milliseconds since the Unix epoch. Hosts supply real time; tests supply a manual clock. */
export interface Clock {
  now(): number;
}

/** Source of randomness. Hosts use a CSPRNG; tests use a seeded stream. */
export interface Entropy {
  bytes(length: number): Uint8Array;
}
