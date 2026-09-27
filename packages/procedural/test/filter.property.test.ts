import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { editFilter } from "@harness/procedural";
import type { FilterCode } from "@harness/procedural";

const WORDS = ["retrieve", "the", "passages", "before", "answering", "check", "each", "claim", "against", "evidence", "then", "stop", "when", "done", "and", "or", "do", "not", "repeat", "a", "search", "compare", "results", "carefully", "extract", "bridge", "entity"] as const;
const word = fc.constantFrom(...WORDS);
const prose = fc.array(word, { maxLength: 12 }).map((w) => w.join(" "));
const codes = (text: string, observations: readonly string[] = []): FilterCode[] => editFilter([text], observations).map((f) => f.code);
/** A text with `inner` somewhere in plain prose. */
const around = (inner: fc.Arbitrary<string>) => fc.tuple(prose, inner, prose).map(([a, x, b]) => `${a} ${x} ${b}`.trim());

const alnum = fc.stringMatching(/^[a-z0-9]{1,8}$/);
const BASE64 = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"];
const HEX = [..."0123456789abcdef"];

describe("the edit filter", () => {
  test.prop([fc.array(fc.string(), { maxLength: 5 }), fc.array(word, { minLength: 8, maxLength: 20 }), fc.nat(), prose, prose])(
    "PG2.P6 any text sharing an 8-token run with an observation is flagged",
    (others, observed, start, before, after) => {
      const from = start % (observed.length - 7);
      const run = observed.slice(from, from + 8).join(" ");
      const observations = [...others, `Output: ${observed.join(" ")}.`];
      expect(codes(`${before} ${run.toUpperCase()}, ${after}`, observations)).toContain("shared-ngram");
    },
  );

  test.prop([fc.array(prose, { maxLength: 4 })])("PG2.P7 plain prose with no observations is never flagged", (texts) => {
    expect(editFilter(texts, [])).toEqual([]);
  });

  test.prop([around(fc.tuple(fc.constantFrom("http", "https", "ftp", "ssh", "git+ssh"), alnum, alnum).map(([s, h, p]) => `${s}://${h}.example/${p}`))])("PG2.P8 URLs are flagged", (text) => {
    expect(codes(text)).toContain("url");
  });

  test.prop([
    around(
      fc.oneof(
        fc.array(alnum, { minLength: 2, maxLength: 4 }).map((s) => `/${s.join("/")}`),
        fc.array(alnum, { minLength: 1, maxLength: 3 }).map((s) => `~/${s.join("/")}`),
        fc.tuple(fc.constantFrom("C", "D", "e"), fc.constantFrom("\\", "/"), fc.array(alnum, { minLength: 1, maxLength: 3 })).map(([d, sep, s]) => `${d}:${sep}${s.join(sep)}`),
        fc.tuple(alnum, alnum).map(([h, s]) => `\\\\${h}\\${s}`),
      ),
    ),
  ])("PG2.P9 absolute paths are flagged", (text) => {
    expect(codes(text)).toContain("absolute-path");
  });

  test.prop([
    around(
      fc.oneof(
        // At least 20 distinct base64 characters, one a digit and one a letter: over 4.3 bits each.
        fc.tuple(fc.shuffledSubarray(BASE64, { minLength: 18 }), fc.constantFrom(..."0123456789"), fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz")).map(([s, d, l]) => [...new Set([d, l, ...s])].join("")).filter((s) => s.length >= 20),
        // All 16 hex digits and at least 4 more: over 3.6 bits each.
        fc.tuple(fc.shuffledSubarray(HEX, { minLength: 16 }), fc.array(fc.constantFrom(...HEX), { minLength: 4, maxLength: 48 })).map(([all, more]) => [...all, ...more].join("")),
      ),
    ),
  ])("PG2.P10 high-entropy strings of at least 20 base64 or hex characters are flagged", (text) => {
    expect(codes(text)).toContain("high-entropy");
  });

  const upper = fc.stringMatching(/^[A-Z0-9]{16}$/);
  const token = (n: number) => fc.stringMatching(new RegExp(`^[A-Za-z0-9]{${n},${n + 10}}$`));
  test.prop([
    around(
      fc.oneof(
        fc.constantFrom("RSA ", "EC ", "OPENSSH ", "DSA ", "ENCRYPTED ", "").map((k) => `-----BEGIN ${k}PRIVATE KEY-----`),
        fc.tuple(fc.constantFrom("AKIA", "ASIA"), upper).map(([p, s]) => p + s),
        fc.tuple(fc.constantFrom("ghp_", "gho_", "ghs_"), token(36)).map(([p, s]) => p + s),
        token(20).map((s) => `sk-${s}`),
        token(10).map((s) => `xoxb-${s}`),
        token(16).map((s) => `sk_live_${s}`),
        fc.tuple(fc.constantFrom("password", "API_KEY", "secret", "auth_token"), token(8)).map(([k, v]) => `${k}=${v}`),
      ),
    ),
  ])("PG2.P11 common secret shapes are flagged", (text) => {
    expect(codes(text)).toContain("secret");
  });
});
