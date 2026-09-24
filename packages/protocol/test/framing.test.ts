import { describe, expect, it } from "vitest";
import { NdjsonDecoder, encodeFrame } from "@harness/protocol";

describe("NdjsonDecoder", () => {
  it("FR1.1 decodes a complete line", () => {
    expect(new NdjsonDecoder().push('{"a":1}\n')).toEqual([{ kind: "message", value: { a: 1 } }]);
  });

  it("FR1.2 reassembles a message split across chunks", () => {
    const d = new NdjsonDecoder();
    expect(d.push('{"a"')).toEqual([]);
    expect(d.push(':1}')).toEqual([]);
    expect(d.push("\n")).toEqual([{ kind: "message", value: { a: 1 } }]);
  });

  it("FR1.3 decodes several messages from one chunk in order", () => {
    expect(new NdjsonDecoder().push("1\n2\n3\n")).toEqual([1, 2, 3].map((value) => ({ kind: "message", value })));
  });

  it("FR1.4 accepts CRLF line endings", () => {
    expect(new NdjsonDecoder().push('{"a":1}\r\n')).toEqual([{ kind: "message", value: { a: 1 } }]);
  });

  it("FR1.5 ignores blank and whitespace-only lines", () => {
    expect(new NdjsonDecoder().push("\n  \n\r\n5\n")).toEqual([{ kind: "message", value: 5 }]);
  });

  it("FR1.6 reports invalid JSON and keeps decoding", () => {
    expect(new NdjsonDecoder().push("{nope\n7\n")).toEqual([
      { kind: "error", code: "parse_error", detail: expect.any(String) },
      { kind: "message", value: 7 },
    ]);
  });

  it("FR1.7 rejects an oversized line once and resynchronises at the next newline", () => {
    const d = new NdjsonDecoder({ maxChars: 10 });
    expect(d.push("x".repeat(8))).toEqual([]);
    expect(d.push("y".repeat(8))).toEqual([{ kind: "error", code: "too_large", detail: expect.any(String) }]);
    expect(d.push("z".repeat(50))).toEqual([]);
    expect(d.push('\n"ok"\n')).toEqual([{ kind: "message", value: "ok" }]);
  });

  it("FR1.8 a line of exactly the limit is accepted", () => {
    const d = new NdjsonDecoder({ maxChars: 5 });
    expect(d.push('"abc"\n')).toEqual([{ kind: "message", value: "abc" }]);
    expect(d.push('"abcd"\n')).toEqual([{ kind: "error", code: "too_large", detail: expect.any(String) }]);
  });

  it("FR1.9 end() reports a truncated trailing message", () => {
    const d = new NdjsonDecoder();
    d.push('{"a":');
    expect(d.end()).toEqual([{ kind: "error", code: "truncated", detail: expect.any(String) }]);
    expect(d.end()).toEqual([]);
    expect(new NdjsonDecoder().end()).toEqual([]);
  });

  it("FR1.10 end() decodes a final message without a trailing newline", () => {
    const d = new NdjsonDecoder();
    d.push("42");
    expect(d.end()).toEqual([{ kind: "message", value: 42 }]);
  });

  it("FR1.11 the limit must be a positive integer", () => {
    expect(() => new NdjsonDecoder({ maxChars: 0 })).toThrow(/maxChars/);
  });

  it("FR2.1 encodeFrame writes one line and escapes embedded newlines", () => {
    const frame = encodeFrame({ text: "a\nb" });
    expect(frame.endsWith("\n")).toBe(true);
    expect(frame.slice(0, -1)).not.toContain("\n");
    expect(new NdjsonDecoder().push(frame)).toEqual([{ kind: "message", value: { text: "a\nb" } }]);
  });

  it("FR2.2 encodeFrame refuses values JSON cannot represent", () => {
    expect(() => encodeFrame(undefined)).toThrow(/serializ/);
    expect(() => encodeFrame(() => 1)).toThrow(/serializ/);
  });
});
