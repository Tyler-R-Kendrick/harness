import { describe, expect, it } from "vitest";
import { lineLimit } from "../src/line-limit.ts";

async function run(max: number, chunks: string[]) {
  let overflows = 0;
  const t = lineLimit(max, () => overflows++);
  const out: string[] = [];
  const reading = (async () => {
    for await (const line of t.readable) out.push(new TextDecoder().decode(line));
  })();
  const w = t.writable.getWriter();
  for (const c of chunks) await w.write(new TextEncoder().encode(c));
  await w.close();
  await reading;
  return { out, overflows };
}

describe("lineLimit: bounded NDJSON lines before the ACP SDK's reader", () => {
  it("LL1.1 complete lines pass through whole, however they were split", async () => {
    expect(await run(16, ["ab", "c\nde", "f\n\n", "g\nh"])).toEqual({ out: ["abc\n", "def\n", "\n", "g\n", "h\n"], overflows: 0 });
  });

  it("LL1.2 a line over the limit is dropped up to its newline, once, and the next line passes", async () => {
    expect(await run(4, ["abc", "de", "fgh\nok\n"])).toEqual({ out: ["ok\n"], overflows: 1 });
    // exactly the limit passes
    expect(await run(4, ["abcd\n"])).toEqual({ out: ["abcd\n"], overflows: 0 });
    // an unterminated oversized line at the end is dropped too
    expect(await run(2, ["ok\n", "toolong"])).toEqual({ out: ["ok\n"], overflows: 1 });
  });

  it("LL1.3 the limit must be a positive whole number of bytes", () => {
    for (const bad of [0, -1, 1.5]) expect(() => lineLimit(bad, () => {})).toThrow(/maxBytes/);
  });
});
