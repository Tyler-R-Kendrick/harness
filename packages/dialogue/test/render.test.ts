import { describe, expect, it } from "vitest";
import { exponential, fill, fits, parseScript, readHoles, valueAt } from "@harness/dialogue";

const orderStatus = parseScript({
  id: "order-status",
  intent: "where is my order",
  slots: { order_id: { pattern: "\\d+" } },
  reply: ["Let me look up order ", { slot: "order_id" }, "."],
});
const tracking = parseScript({
  id: "tracking",
  intent: "read back tracking",
  result: { tool: "track_order" },
  reply: ["Order ", { input: ["id"] }, " is ", { output: ["status"] }, " and arrives ", { output: ["eta", 0] }, "."],
});
const cancel = parseScript({
  id: "cancel",
  intent: "cancel an order",
  slots: { order_id: {} },
  reply: ["Order ", { slot: "order_id" }, " is cancelled: ", { generate: "reason", constraint: { type: "regex", pattern: "[a-z ]+" } }, "."],
});
const result = { tool: "track_order", input: { id: 1234 }, output: { status: "shipped", eta: ["Tuesday"], late: false } };

describe("fill", () => {
  it("RN1.1 a reply of fixed text and slots renders to text, with no generation", () => {
    expect(fill(orderStatus, { slots: { order_id: "1234" } })).toEqual({ kind: "text", text: "Let me look up order 1234." });
  });

  it("RN1.2 a result script reads the tool's input and output at paths, writing numbers and booleans as text", () => {
    expect(fill(tracking, { slots: {}, result })).toEqual({ kind: "text", text: "Order 1234 is shipped and arrives Tuesday." });
    expect(valueAt(result.output, ["late"])).toBe("false");
    expect(valueAt(result.output, ["eta", 0])).toBe("Tuesday");
  });

  it("RN1.3 a missing slot is named; a path to nothing, or to an object, has no value", () => {
    expect(fill(orderStatus, { slots: {} })).toEqual({ kind: "missing", slots: ["order_id"] });
    expect(fill(tracking, { slots: {} })).toEqual({ kind: "missing", slots: [] });
    expect(valueAt(result.output, ["eta"])).toBeUndefined();
    expect(valueAt(result.output, ["nope", "deeper"])).toBeUndefined();
    expect(valueAt(null, ["a"])).toBeUndefined();
    expect(valueAt({ a: null }, ["a"])).toBeUndefined();
    expect(fill(tracking, { slots: {}, result: { ...result, output: { status: { code: 1 } } } })).toEqual({ kind: "missing", slots: [] });
  });

  it("RN1.4 generated holes make a template: slot values are fixed text, holes keep their constraints", () => {
    expect(fill(cancel, { slots: { order_id: "9" } })).toEqual({
      kind: "template",
      template: { type: "template", parts: ["Order 9 is cancelled: ", { hole: "reason", constraint: { type: "regex", pattern: "[a-z ]+" } }, "."] },
    });
  });

  it("RN1.6 a generated hole without a constraint is a bare hole; slots missing alongside a missing value are named", () => {
    const script = parseScript({ id: "s1", intent: "x", slots: { a: {} }, reply: ["Say ", { slot: "a" }, ": ", { generate: "b" }, "."] });
    expect(fill(script, { slots: { a: "hi" } })).toEqual({ kind: "template", template: { type: "template", parts: ["Say hi: ", { hole: "b" }, "."] } });
    expect(fill(script, { slots: {} })).toEqual({ kind: "missing", slots: ["a"] });
  });

  it("RN1.5 an empty value adds no empty fixed text", () => {
    const script = parseScript({ id: "s1", intent: "x", slots: { a: {} }, reply: [{ slot: "a" }, " and ", { generate: "b" }] });
    expect(fill(script, { slots: { a: "" } })).toEqual({ kind: "template", template: { type: "template", parts: [" and ", { hole: "b" }] } });
  });
});

describe("fits", () => {
  it("RN2.1 the model's reply fits a script when it is the script's rendering, whitespace around it aside", () => {
    expect(fits(orderStatus, "  Let me look up order 1234.\n", { slots: { order_id: "1234" } })).toBe(true);
    expect(fits(orderStatus, "Let me look up order 1235.", { slots: { order_id: "1234" } })).toBe(false);
    expect(fits(tracking, "Order 1234 is shipped and arrives Tuesday.", { slots: {}, result })).toBe(true);
  });

  it("RN2.2 a generated hole takes any text its constraint allows", () => {
    expect(fits(cancel, "Order 9 is cancelled: you asked.", { slots: { order_id: "9" } })).toBe(true);
    expect(fits(cancel, "Order 9 is cancelled: You asked!.", { slots: { order_id: "9" } })).toBe(false);
  });

  it("RN2.3 a slot not yet known fits only a value the user said", () => {
    expect(fits(orderStatus, "Let me look up order 77.", { slots: {}, utterance: "where is ORDER 77?" })).toBe(true);
    expect(fits(orderStatus, "Let me look up order 78.", { slots: {}, utterance: "where is order 77?" })).toBe(false);
    expect(fits(orderStatus, "Let me look up order .", { slots: {}, utterance: "where is order 77?" })).toBe(false);
    expect(fits(orderStatus, "Let me look up order 77.", { slots: {} })).toBe(false);
  });

  it("RN2.4 a result script whose values are not in the result does not fit", () => {
    expect(fits(tracking, "Order 1234 is shipped and arrives Tuesday.", { slots: {} })).toBe(false);
  });
});

describe("reading a reply's holes", () => {
  it("RN3.1 a flow's script has no template: no reply is read as it, whatever the fillers", () => {
    const flow = parseScript({ id: "f", intent: "f", reply: [{ flow: "some-flow" }] });
    expect(readHoles(flow, "anything", { slots: {}, result })).toBeUndefined();
  });

  it("RN3.2 a reply that does not follow the template is not read, even with a slot still unknown", () => {
    expect(readHoles(cancel, "Something else entirely.", { slots: {}, utterance: "cancel 7" })).toBeUndefined();
  });
});

describe("patterns that could take exponential time", () => {
  it("RN4.1 a group that may repeat around a repetition or alternatives is refused, bounded or not; an optional group, and anything escaped or in a class, is not", () => {
    const risky = ["(a+)+", "(a|aa)+", "(a*)*", "(\\w+\\s?)+", "((a)+)+", "(a|b)*", "(a{2,})+", "(?:a+){2,}", "([a-z]+)*", "((a){3})+", "((a){12})+", "(a+){12,}", "([)]+)+", "([\\]a]+)+", "(a+){1,10}x(b+)+", "(a+){2}", "(a+){12}", "(a+){1,3}", "(a+){0,2}", "(a|aa){30}", "(a|b){3}", "\\d+(?:\\s+\\d+){0,7}?"];
    const safe = ["a+", "(a)+", "(ab)+", "(ab)c+", "(a+){1}", "(a+){0,1}", "(a+){0}", "(a+)?", "(a+)", "[(]+", "\\(a+\\)+", "(a|b)", "(a|b)?", "[a+]+", "(?<n>\\d+)", "\\d+(?:\\s\\d)?", "a|b+", "(ab){3}"];
    expect(risky.filter((p) => !exponential(p))).toEqual([]);
    expect(safe.filter((p) => exponential(p))).toEqual([]);
  });

  it("RN4.2 three repeated atoms in a row that can trade characters are refused; one the previous cannot match fixes the boundary, and group syntax is no atom", () => {
    const risky = ["\\d*\\d*\\d*\\d*\\d*x", ".*a.*a.*x", "\\w+\\w*\\d+", "\\d+(?<n>\\d+)\\d+", "a*a*a*", "(?:ab)+(?:cd)+(?:ef)+", "\\s*\\s*\\s*$", "[^,]+\\S+\\w+"];
    const safe = ["\\d+-\\d+-\\d+", "\\d+\\s+\\d+\\s+\\d+", "\\w+\\d+", "(?<a>\\d+)\\s(?<b>\\w+)\\s(?<c>\\d+)", "\\w+day", "a+b+c+", "[a-c]+[d-f]+[g-i]+", "\\d+(?:\\.\\d+)?", "a+|a+|a+"];
    expect(risky.filter((p) => !exponential(p))).toEqual([]);
    expect(safe.filter((p) => exponential(p))).toEqual([]);
  });
});
