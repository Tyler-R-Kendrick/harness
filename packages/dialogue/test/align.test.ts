import { describe, expect, it } from "vitest";
import { align, shapeSimilarity, tokens } from "@harness/dialogue";

describe("tokens", () => {
  it("TA1.1 splits text into words, whitespace runs and single punctuation, losing nothing", () => {
    const text = "Order ABC-123 costs $3.50, doesn't it?\n  Yes.";
    expect(tokens(text)).toEqual(["Order", " ", "ABC-123", " ", "costs", " ", "$", "3.50", ",", " ", "doesn't", " ", "it", "?", "\n  ", "Yes", "."]);
    expect(tokens(text).join("")).toBe(text);
  });

  it("TA1.2 an empty text has no tokens", () => {
    expect(tokens("")).toEqual([]);
  });
});

describe("align", () => {
  it("TA2.1 what every text shares is fixed and what differs is a gap, with each text's value", () => {
    const a = align(["Order 1234 is on its way.", "Order 99 is on its way."]);
    expect(a.segments).toEqual(["Order ", " is on its way."]);
    expect(a.values).toEqual([["1234"], ["99"]]);
  });

  it("TA2.2 a gap takes several words, and the whitespace around it stays fixed", () => {
    const a = align(["It arrives next Tuesday.", "It arrives Friday."]);
    expect(a.segments).toEqual(["It arrives ", "."]);
    expect(a.values).toEqual([["next Tuesday"], ["Friday"]]);
  });

  it("TA2.3 punctuation between two gaps keeps them apart", () => {
    const a = align(["See you Tuesday, 3pm.", "See you Friday, 5pm."]);
    expect(a.segments).toEqual(["See you ", ", ", "."]);
    expect(a.values).toEqual([
      ["Tuesday", "3pm"],
      ["Friday", "5pm"],
    ]);
  });

  it("TA2.4 gaps can open and close a text", () => {
    const a = align(["Alice, your table is ready", "Bob, your table is ready now"]);
    expect(a.segments).toEqual(["", ", your table is ready", ""]);
    expect(a.values).toEqual([
      ["Alice", ""],
      ["Bob", "now"],
    ]);
  });

  it("TA2.5 identical texts are all fixed", () => {
    const a = align(["Hello there.", "Hello there."]);
    expect(a.segments).toEqual(["Hello there."]);
    expect(a.values).toEqual([[], []]);
  });

  it("TA2.6 texts sharing nothing are one gap", () => {
    const a = align(["abc", "xyz"]);
    expect(a.segments).toEqual(["", ""]);
    expect(a.values).toEqual([["abc"], ["xyz"]]);
  });

  it("TA2.7 a gap only in whitespace is fixed as the first text has it", () => {
    const a = align(["Hi  there", "Hi there"]);
    expect(a.segments).toEqual(["Hi  there"]);
    expect(a.values).toEqual([[], []]);
  });

  it("TA2.8 ignoring case, words that differ only in case are shared, spelled as the first text has them", () => {
    const a = align(["Where is order 12", "where is order 7"], { ignoreCase: true });
    expect(a.segments).toEqual(["Where is order ", ""]);
    expect(a.values).toEqual([["12"], ["7"]]);
    expect(align(["Where is order 12", "where is order 7"]).segments).toEqual(["", " is order ", ""]);
  });

  it("TA2.9 three texts: fixed text is what all of them share", () => {
    const a = align(["Your order 1 ships today.", "Your order 2 ships soon.", "Your order 3 ships today."]);
    expect(a.segments).toEqual(["Your order ", " ships ", "."]);
    expect(a.values).toEqual([
      ["1", "today"],
      ["2", "soon"],
      ["3", "today"],
    ]);
  });

  it("TA2.10 a value that is empty in one text but not another keeps the gap", () => {
    const a = align(["Done, Alice.", "Done."]);
    expect(a.segments).toEqual(["Done", "."]);
    expect(a.values).toEqual([[", Alice"], [""]]);
  });

  it("TA2.11 one text aligns with itself, and no texts with nothing", () => {
    expect(align(["just one"])).toEqual({ segments: ["just one"], values: [[]] });
    expect(align([])).toEqual({ segments: [""], values: [] });
  });

  it("TA2.12 whitespace every value starts or ends with is fixed text, as much of it as they share", () => {
    expect(align(["Order 1 ships.", "Order 2  ships."])).toEqual({ segments: ["Order ", " ships."], values: [["1"], ["2"]] });
    expect(align(["Order 1 ships.", "Order  2 ships."])).toEqual({ segments: ["Order ", " ships."], values: [["1"], ["2"]] });
    expect(align(["Order  1 ships.", "Order 2 ships."])).toEqual({ segments: ["Order ", " ships."], values: [["1"], ["2"]] });
    expect(align(["Order 1  ships.", "Order 2 ships."])).toEqual({ segments: ["Order ", " ships."], values: [["1"], ["2"]] });
  });

  it("TA2.13 whitespace is not moved when some value is only whitespace", () => {
    expect(align(["go  now", "go x now"])).toEqual({ segments: ["go", "now"], values: [[""], ["x"]] });
  });

  it("TA2.14 gaps whitespace apart at the start are one gap too", () => {
    expect(align(["a b c", "d e c"])).toEqual({ segments: ["", " c"], values: [["a b"], ["d e"]] });
  });

  it("TA2.15 a shorter text aligns, ignoring case", () => {
    expect(align(["a b c", "A"], { ignoreCase: true })).toEqual({ segments: ["a", ""], values: [["b c"], [""]] });
  });

  it("TA2.16 when texts could share either of two words, they share the first text's later one, every time", () => {
    expect(align(["a x", "x a"])).toEqual({ segments: ["", "x", ""], values: [["a", ""], ["", "a"]] });
  });
});

describe("shapeSimilarity", () => {
  it("TA3.1 is the share of positions with the same word (Drain), ignoring case and whitespace", () => {
    expect(shapeSimilarity("where is order 12", "Where  is order 99")).toBe(0.75);
    expect(shapeSimilarity("a b", "a b")).toBe(1);
  });

  it("TA3.2 texts of different lengths are not alike", () => {
    expect(shapeSimilarity("where is order 12", "where is my order 12")).toBe(0);
  });

  it("TA3.4 case is folded to lower case: ß is not ss", () => {
    expect(shapeSimilarity("straße", "STRASSE")).toBe(0);
  });

  it("TA3.3 two empty texts are alike", () => {
    expect(shapeSimilarity("", " ")).toBe(1);
  });
});
