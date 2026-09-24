import { describe, expect } from "vitest";
import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { NdjsonDecoder, encodeFrame } from "@harness/protocol";

describe("framing properties", () => {
  test.prop([fc.array(fc.jsonValue(), { maxLength: 20 }), fc.array(fc.integer({ min: 1, max: 17 }), { minLength: 1, maxLength: 50 })])(
    "FR3.1 any chunking of an encoded stream decodes to exactly the original messages",
    (values, cuts) => {
      const stream = values.map(encodeFrame).join("");
      const d = new NdjsonDecoder();
      const out: unknown[] = [];
      let pos = 0;
      let i = 0;
      while (pos < stream.length) {
        const size = cuts[i++ % cuts.length]!;
        out.push(...d.push(stream.slice(pos, pos + size)));
        pos += size;
      }
      out.push(...d.end());
      // JSON cannot distinguish -0 from 0; compare after a JSON round trip.
      expect(out).toEqual(values.map((v) => ({ kind: "message", value: JSON.parse(JSON.stringify(v)) })));
    },
  );

  test.prop([fc.array(fc.string({ unit: "binary" }), { maxLength: 30 })])("FR3.2 arbitrary input never throws and yields only well-formed results", (chunks) => {
    const d = new NdjsonDecoder({ maxChars: 64 });
    const out = [...chunks.flatMap((c) => d.push(c)), ...d.end()];
    for (const r of out) expect(["message", "error"]).toContain(r.kind);
  });
});
