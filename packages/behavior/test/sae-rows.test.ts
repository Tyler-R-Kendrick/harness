import { describe, expect, it } from "vitest";
import { compilePack, parseSaeRows } from "@harness/behavior";
import { guide } from "./fixtures.ts";

const b64 = (xs: number[]) => {
  const bytes = new Uint8Array(Float32Array.from(xs).buffer);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unit = (i: number) => [0, 1, 2, 3].map((j) => (j === i ? 1 : 0));
const file = (features: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ format: "harness.sae-rows/v1", source: { repo: "org/sae" }, dims: 4, width: 16, features, ...extra });
const row = (i: number) => ({ encoder: b64(unit(i)), bias: 0, threshold: 0.25, decoder: b64(unit(i)) });

describe("SAE rows files", () => {
  it("SR1.1 a rows file feeds compilePack with exactly the rows it carries", () => {
    const rows = parseSaeRows(file({ 0: row(0), 1: row(1), 2: row(2), 3: row(3) }));
    expect(rows.dims).toBe(4);
    expect(rows.width).toBe(16);
    const pack = compilePack(guide, rows);
    expect(Array.from(pack.steering["calm"]!)).toEqual([0, 0, 2, 0]);
    expect(pack.sense[0]!.threshold).toBe(0.25);
  });

  it("SR1.2 a feature the file does not carry, or a malformed file, is refused", () => {
    expect(() => compilePack(guide, parseSaeRows(file({ 0: row(0), 1: row(1), 2: row(2) })))).toThrow(/feature 3 is not in the rows file/);
    expect(() => parseSaeRows("{")).toThrow(/JSON/);
    expect(() => parseSaeRows(file({}, { format: "other" }))).toThrow(/format/);
    expect(() => parseSaeRows(file({ 0: { ...row(0), encoder: b64([1, 2]) } }))).toThrow(/4/);
    expect(() => parseSaeRows(file({ 0: { ...row(0), bias: "x" } }))).toThrow(/bias/);
  });

  it("SR1.3 dims, width, the feature map, indexes and thresholds are each checked", () => {
    expect(() => parseSaeRows(file({}, { dims: 0 }))).toThrow(/dims must be a positive integer/);
    expect(() => parseSaeRows(file({}, { width: 1.5 }))).toThrow(/width must be a positive integer/);
    expect(() => parseSaeRows(file({}, { features: null }))).toThrow(/features must be an object/);
    expect(() => parseSaeRows(file({ 16: row(0) }))).toThrow(/feature 16 is not an index below the width 16/);
    expect(() => parseSaeRows(file({ "-1": row(0) }))).toThrow(/feature -1/);
    expect(() => parseSaeRows(file({ x: row(0) }))).toThrow(/feature x/);
    expect(() => parseSaeRows(file({ 0: { ...row(0), threshold: Infinity } }))).toThrow(/feature 0 threshold must be a finite number/);
    expect(() => parseSaeRows(file({ 0: { ...row(0), decoder: b64([1]) } }))).toThrow(/feature 0 decoder has 1 values, expected 4/);
    expect(() => parseSaeRows(file({ 0: { ...row(0), encoder: b64([1]) } }))).toThrow(/feature 0 encoder has 1 values/);
  });

  it("SR1.4 the encoder row carries the folded bias and threshold; the decoder row is the steering direction", () => {
    const rows = parseSaeRows(file({ 5: { encoder: b64([1, 2, 3, 4]), bias: -0.5, threshold: 1.5, decoder: b64([0, 0, 0, 9]) } }));
    const enc = rows.encoder(5);
    expect([Array.from(enc.weights), enc.bias, enc.threshold]).toEqual([[1, 2, 3, 4], -0.5, 1.5]);
    expect(Array.from(rows.decoder(5))).toEqual([0, 0, 0, 9]);
    expect(() => rows.decoder(4)).toThrow(/feature 4 is not in the rows file/);
  });
});
