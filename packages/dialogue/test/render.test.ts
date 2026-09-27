import { describe, expect, it } from "vitest";
import { fill, fits, parseScript, valueAt } from "@harness/dialogue";

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
