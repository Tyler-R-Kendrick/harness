import { describe, expect } from "vitest";
import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { parseMessage } from "@harness/protocol";

describe("parseMessage fuzzing", () => {
  test.prop([fc.jsonValue()])("JR3.1 never throws on arbitrary JSON", (v) => {
    expect(() => parseMessage(v)).not.toThrow();
  });

  test.prop([fc.oneof(fc.string(), fc.integer()), fc.string({ minLength: 1 }), fc.dictionary(fc.string(), fc.jsonValue())])(
    "JR3.2 any well-formed request round-trips",
    (id, method, params) => {
      expect(parseMessage({ jsonrpc: "2.0", id, method, params })).toEqual({ ok: true, value: { kind: "request", id, method, params } });
    },
  );
});
