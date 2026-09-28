import { describe, expect, it } from "vitest";
import { evaluate, execute, holds, ScriptError, toJson } from "@harness/dialogue-standards";
import type { Value } from "@harness/dialogue-standards";
import { parse } from "../src/ecmascript.ts";

const scope = (): Record<string, Value> => ({ n: 3, s: "Ab", list: [1, "two"], obj: { a: { b: 5 } }, flag: false, none: null, nothing: undefined });

describe("the ECMAScript subset", () => {
  it("ES1.1 literals, arithmetic, comparison and logic are ECMAScript's, loose equality included", () => {
    const cases: [string, Value][] = [
      ["1 + 2 * 3", 7],
      ["(1 + 2) * 3", 9],
      ["7 % 4", 3],
      ["10 / 4", 2.5],
      ["5 - 7", -2],
      ["'a' + 1", "a1"],
      ["-n", -3],
      ["+'4'", 4],
      ["!flag", true],
      ["typeof s", "string"],
      ["typeof none", "object"],
      ["typeof nothing", "undefined"],
      ["'1' == 1", true],
      ["'1' != 1", false],
      ["'1' === 1", false],
      ["'1' !== 1", true],
      ["n < 4 && n <= 3 && n > 2 && n >= 3", true],
      ["n < 3 || n > 3", false],
      ["flag || 'fallback'", "fallback"],
      ["n && 'then'", "then"],
      ["flag && missing", false],
      ["n > 1 ? 'big' : 'small'", "big"],
      ["n > 5 ? 'big' : 'small'", "small"],
      ["[1, n]", [1, 3]],
      ["({ x: n, 'y': 2 })", { x: 3, y: 2 }],
      ["true", true],
      ["null", null],
      ["undefined", undefined],
    ];
    for (const [source, value] of cases) expect([source, evaluate(source, [scope()])]).toEqual([source, value]);
  });

  it("ES1.2 members of objects, arrays and strings, by name and by index; a missing one is undefined", () => {
    const cases: [string, Value][] = [
      ["obj.a.b", 5],
      ["obj['a']['b']", 5],
      ["obj.z", undefined],
      ["list[1]", "two"],
      ["list.length", 2],
      ["list.x", undefined],
      ["s.length", 2],
      ["s[0]", "A"],
      ["s.x", undefined],
      ["n.x", undefined],
    ];
    for (const [source, value] of cases) expect([source, evaluate(source, [scope()])]).toEqual([source, value]);
  });

  it("ES1.3 the built-ins: string, array and number methods, conversions and Math (not Math.random)", () => {
    const cases: [string, Value][] = [
      ["s.toUpperCase()", "AB"],
      ["s.toLowerCase()", "ab"],
      ["'  x '.trim()", "x"],
      ["'hello'.substring(1, 3)", "el"],
      ["'a,b'.split(',')", ["a", "b"]],
      ["'abc'.indexOf('c')", 2],
      ["list.join('-')", "1-two"],
      ["list.includes(1)", true],
      ["(2.345).toFixed(2)", "2.35"],
      ["Number('12')", 12],
      ["String(12)", "12"],
      ["Boolean('')", false],
      ["parseInt('42px')", 42],
      ["parseInt('ff', 16)", 255],
      ["parseFloat('2.5kg')", 2.5],
      ["isNaN('x')", true],
      ["Math.max(1, n, 2)", 3],
      ["Math.min(4, n)", 3],
      ["Math.floor(2.7) + Math.ceil(2.1) + Math.round(2.5) + Math.abs(-1)", 9],
    ];
    for (const [source, value] of cases) expect([source, evaluate(source, [scope()])]).toEqual([source, value]);
    expect(() => evaluate("Math.random()", [scope()])).toThrow(ScriptError);
  });

  it("ES1.4 assignments change the innermost scope that declares the name, or a plain object's member; statements run in order", () => {
    const inner: Record<string, Value> = { x: 1 };
    const outer: Record<string, Value> = { x: 10, y: 20, o: {} };
    execute("x = 2; y += 5; y -= 1; o.k = x + y; o['j'] = 'v'", [inner, outer]);
    expect([inner, outer]).toEqual([{ x: 2 }, { x: 10, y: 24, o: { k: 26, j: "v" } }]);
    expect(holds("x == 2", [inner])).toBe(true);
    expect(holds("''", [inner])).toBe(false);
  });

  it("ES1.5 what it cannot do it refuses: undeclared names, prototypes, host objects, functions it did not give, other syntax", () => {
    for (const source of [
      "missing",
      "missing = 1",
      "Math = 1",
      "Math.abs = 1",
      "obj.__proto__",
      "obj.constructor",
      "({ __proto__: 1 })",
      "obj['__proto__'] = 1",
      "s.constructor",
      "s.repeat(3)",
      "list.push(1)",
      "obj.a.b()",
      "n()",
      "this",
      "n.x.y",
      "none.x",
      "x ** 2",
      "n |= 1",
      "1 +",
      "~n",
      "n.x = 1",
      "(1)()",
      "f(1) = 2",
    ])
      expect(() => execute(source, [{ ...scope(), x: 1 }]), source).toThrow(ScriptError);
  });

  it("ES1.6 strings and arrays are capped, an object cannot hold itself, a built-in's own errors are ScriptErrors, and typeof of an undeclared name is undefined", () => {
    const big: Record<string, Value> = { s: "x".repeat(60_000) };
    expect(() => execute("s = s + s", [big]), "+").toThrow(ScriptError);
    expect(() => execute("s = s.concat(s)", [big]), "concat").toThrow(ScriptError);
    expect(() => evaluate("s.split('').concat(s.split(''))", [big]), "array concat").toThrow(ScriptError);
    expect(evaluate("s.length", [big])).toBe(60_000);
    for (const source of ["o.self = o", "o.a = { b: o }", "o.d = d"]) {
      const d: Record<string, Value> = { o: {} };
      expect(() => execute(source, [d, { d }]), source).toThrow(ScriptError);
    }
    const named: Record<string, Value> = { x: null };
    expect(() => execute("x = self", [named, { self: named }]), "x = self").toThrow(ScriptError);
    expect(() => evaluate("n.toFixed(500)", [scope()])).toThrow(ScriptError);
    expect(evaluate("typeof missing", [scope()])).toBe("undefined");
    expect(evaluate("typeof n", [scope()])).toBe("number");
    expect(evaluate("({ a: 1 }).toString", [scope()])).toBeUndefined();
  });

  it("ES1.7 a value's size counts a shared part each time it appears: doubling is stopped, an object grown past the cap is put back, and one grown inside another is not kept", () => {
    const vars: Record<string, Value> = { a: "x".repeat(1000) };
    let doubled = 0;
    try {
      for (; doubled < 40; doubled++) execute("a = [a, a]", [vars]);
    } catch (e) {
      expect(e).toBeInstanceOf(ScriptError);
    }
    expect(doubled).toBeLessThan(10);
    const o: Record<string, Value> = { o: {}, big: "y".repeat(60_000) };
    execute("o.l = big", [o]);
    expect(() => execute("o.r = big", [o])).toThrow(ScriptError);
    expect(Object.keys(o["o"] as object)).toEqual(["l"]);
    const shared: Record<string, Value> = { p: {}, q: null, big: "z".repeat(60_000) };
    execute("q = { a: p, b: p }; p.x = big", [shared]);
    expect(() => toJson(shared["p"]!)).not.toThrow();
    expect(() => toJson(shared["q"]!)).toThrow(ScriptError);
    expect(String(evaluate("({ a: 1 })", [scope()]))).toBe("[object Object]");
  });

  it("ES2.1 equality and ordering answer false as well as true", () => {
    const cases: [string, Value][] = [
      ["1 == 2", false],
      ["null == undefined", true],
      ["1 === 1", true],
      ["1 !== 1", false],
      ["4 <= 3", false],
      ["3 <= 3", true],
      ["2 >= 3", false],
      ["3 >= 3", true],
    ];
    for (const [source, value] of cases) expect([source, evaluate(source, [scope()])]).toEqual([source, value]);
  });

  it("ES2.2 syntax it does not support is refused, naming what", () => {
    const cases: [string, string][] = [
      ["1 | 2", "operator | is not supported"],
      ["~n", "operator ~ is not supported"],
      ["n *= 2", "operator *= is not supported"],
      ["n++", "UpdateExpression is not supported"],
      ["(1, 2)", "SequenceExpression is not supported"],
      ["this", "this is not supported"],
      ["f(1) = 2", "cannot assign to this"],
      ["1 +", 'cannot parse "1 +": Expected expression after + at character 3'],
    ];
    expect(cases.map(([source]) => [source, refusal(() => execute(source, [scope()]))])).toEqual(cases);
  });

  it("ES2.3 names and members it cannot reach are refused, saying which", () => {
    const cases: [string, string][] = [
      ["missing", "missing is not defined"],
      ["-missing", "missing is not defined"],
      ["typeof missing.x", "missing is not defined"],
      ["missing = 1", "missing is not declared"],
      ["Math = 1", "Math is not declared"],
      ["obj.__proto__", "no access to __proto__"],
      ["obj.prototype", "no access to prototype"],
      ["({ __proto__: 1 })", "no access to __proto__"],
      ["obj['constructor'] = 1", "no access to constructor"],
      ["none.x", "cannot read x of null"],
      ["none.length", "cannot read length of null"],
      ["nothing.length", "cannot read length of undefined"],
      ["list[0] = 5", "cannot set 0 here"],
      ["s.x = 1", "cannot set x here"],
      ["n.x = 1", "cannot set x here"],
      ["Math.abs.x = 1", "cannot set x here"],
      ["Math.pi = 3", "cannot set pi here"],
    ];
    expect(cases.map(([source]) => [source, refusal(() => execute(source, [scope()]))])).toEqual(cases);
  });

  it("ES2.4 a call of anything but a built-in, or of a method with arguments it does not take, is refused, saying which", () => {
    const cases: [string, string][] = [
      ["obj.nope()", "nope is not a function"],
      ["obj.a()", "a is not a function"],
      ["n.foo()", "foo is not a function"],
      ["s.toFixed(1)", "toFixed is not a function"],
      ["'a'.concat(obj)", "concat is not a function"],
      ["list.concat(1, obj)", "concat is not a function"],
      ["list.indexOf(obj)", "indexOf is not a function"],
      ["nothing()", "not a function"],
      ["n()", "not a function"],
      ["s['toUpperCase']()", "not a function"],
    ];
    expect(cases.map(([source]) => [source, refusal(() => execute(source, [scope()]))])).toEqual(cases);
    expect(refusal(() => evaluate("n.toFixed(500)", [scope()]))).toMatch(/^"n\.toFixed\(500\)": \S/);
  });

  it("ES2.5 every string and array method it lists works, with primitive arguments of every kind", () => {
    const cases: [string, Value][] = [
      ["'hello'.substr(1, 2)", "el"],
      ["'hello'.slice(-3)", "llo"],
      ["'a-b-a'.lastIndexOf('a')", 4],
      ["'hello'.charAt(1)", "e"],
      ["'a'.concat('b', 1, true, null)", "ab1truenull"],
      ["'hello'.startsWith('he')", true],
      ["'hello'.endsWith('lo')", true],
      ["'hello'.includes('ll')", true],
      ["'a-b'.replace('-', '+')", "a+b"],
      ["s.toString()", "Ab"],
      ["list.indexOf('two')", 1],
      ["list.slice(1)", ["two"]],
      ["list.concat([3], 4)", [1, "two", 3, 4]],
      ["(2).toFixed()", "2"],
      ["parseInt('0x1A')", 0],
      ["Math.abs.builtin", undefined],
    ];
    for (const [source, value] of cases) expect([source, evaluate(source, [scope()])]).toEqual([source, value]);
  });

  it("ES2.6 an index is digits only; a key that is neither string nor number reads nothing; literals make holes, computed and shorthand keys, and nulls", () => {
    const cases: [string, Value][] = [
      ["list[' 1']", undefined],
      ["list['1 ']", undefined],
      ["list['01']", "two"],
      ["[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10][10]", 10],
      ["s[' 1']", undefined],
      ["s['1 ']", undefined],
      ["'abcdefghijk'[10]", "k"],
      ["({ 'true': 1 })[true]", undefined],
      ["({ 'null': 1 })[none]", undefined],
      ["({ 1: 'one' })[1]", "one"],
      ["[1, , 2]", [1, undefined, 2]],
      ["({ [s]: 1 })", { Ab: 1 }],
      ["({ n })", { n: 3 }],
      ["[null, { a: null }]", [null, { a: null }]],
    ];
    for (const [source, value] of cases) expect([source, evaluate(source, [scope()])]).toEqual([source, value]);
  });

  it("ES2.7 a value of exactly MAX_LENGTH is made, and one past it is refused, saying so", () => {
    const vars: Record<string, Value> = { s: "x".repeat(99_999) };
    expect((evaluate("s + 'y'", [vars]) as string).length).toBe(100_000);
    expect(refusal(() => evaluate("s + 'yy'", [vars]))).toBe("a value larger than 100000 is not supported");
    expect((toJson("x".repeat(100_000)) as string).length).toBe(100_000);
    expect(refusal(() => toJson("x".repeat(100_001)))).toBe("a value larger than 100000 is not supported");
  });

  it("ES2.8 a member assignment may fill an object to exactly MAX_LENGTH; past it, the member is put back as it was, or removed", () => {
    const vars: Record<string, Value> = { o: {}, p: { k: "small" }, q: {}, fits: "x".repeat(99_998), over: "x".repeat(99_999) };
    execute("o.k = fits", [vars]);
    expect((vars["o"] as Record<string, string>)["k"]!.length).toBe(99_998);
    expect(refusal(() => execute("p.k = over", [vars]))).toBe("a value larger than 100000 is not supported");
    expect(refusal(() => execute("q.k = over", [vars]))).toBe("a value larger than 100000 is not supported");
    expect([vars["p"], vars["q"]]).toEqual([{ k: "small" }, {}]);
  });

  it("ES2.9 a compound assignment to a member starts from the member's value", () => {
    const vars: Record<string, Value> = { o: { k: 2 } };
    expect(evaluate("o.k += 3", [vars])).toBe(5);
    expect(evaluate("o.k -= 1", [vars])).toBe(4);
    expect(vars).toEqual({ o: { k: 4 } });
  });

  it("ES2.10 a value holding the object it is put into is refused wherever it holds it, saying which; one holding nulls is kept", () => {
    const d: Record<string, Value> = { o: {}, x: null };
    const cases: [string, string][] = [
      ["o.self = o", "cannot put self inside itself"],
      ["o.a = { b: o }", "cannot put a inside itself"],
      ["o.a = [1, o]", "cannot put a inside itself"],
      ["x = [1, d]", "cannot put x inside itself"],
    ];
    expect(cases.map(([source]) => [source, refusal(() => execute(source, [d, { d }]))])).toEqual(cases);
    expect(d).toEqual({ o: {}, x: null });
    execute("o.a = [null, { b: null }]", [d]);
    expect(d["o"]).toEqual({ a: [null, { b: null }] });
  });

  it("ES2.11 a value sharing a part sixty levels deep is sized and searched in time linear in its distinct parts", () => {
    let deep: Value = {};
    for (let i = 0; i < 60; i++) deep = [deep, deep];
    const vars: Record<string, Value> = { o: {}, deep };
    expect(refusal(() => evaluate("[deep]", [vars]))).toBe("a value larger than 100000 is not supported");
    expect(refusal(() => execute("o.d = deep", [vars]))).toBe("a value larger than 100000 is not supported");
    expect(refusal(() => toJson(deep))).toBe("a value larger than 100000 is not supported");
    expect(vars["o"]).toEqual({});
  });

  it("ES2.12 an expression is parsed once, and the cache holds at most 4096 of them", () => {
    const source = "'cached' + 0";
    let parsed = parse(source);
    expect(parse(source)).toBe(parsed);
    parse("'another' + 0");
    expect(parse(source)).toBe(parsed);
    // Fill the cache until it is cleared, which leaves in it the last filler and `source` parsed again.
    let filled = 0;
    for (; filled < 10_000; filled++) {
      parse(`'filler' + ${filled}`);
      const again = parse(source);
      if (again !== parsed) {
        parsed = again;
        break;
      }
    }
    expect(filled).toBeLessThan(10_000);
    for (let i = 0; i < 4094; i++) parse(`'more' + ${i}`);
    expect(parse(source)).toBe(parsed);
    parse("'one more' + 0");
    expect(parse(source)).not.toBe(parsed);
  });

  it("ES2.13 toJson of what JSON has no text for is null, and of what JSON cannot hold is a ScriptError", () => {
    expect(toJson((() => 1) as unknown as Value)).toBeNull();
    expect(refusal(() => toJson(BigInt(1) as unknown as Value))).toMatch(/^not a JSON value: \S/);
  });
});

/** The message of the ScriptError `f` throws. */
function refusal(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ScriptError);
    return (e as Error).message;
  }
  return "no error";
}

describe("values a host hands in", () => {
  it("ES2.14 a value that holds itself is refused as too large, not left to overflow", () => {
    const cyclic: Record<string, Value> = { a: 1 };
    cyclic["self"] = cyclic;
    expect(() => toJson(cyclic)).toThrow(ScriptError);
    expect(() => evaluate("[c]", [{ c: cyclic }])).toThrow(ScriptError);
  });
});
