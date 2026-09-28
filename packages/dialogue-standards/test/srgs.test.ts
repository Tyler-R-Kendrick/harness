import { describe, expect, it } from "vitest";
import { checkRefs, DocumentError, matchSrgs, parseSrgs, ScriptError, wordsOf } from "@harness/dialogue-standards";
import type { Grammar } from "@harness/dialogue-standards";

const grxml = (rules: string, attrs = 'root="main"') => `<?xml version="1.0"?><grammar xmlns="http://www.w3.org/2001/06/grammar" version="1.0" mode="voice" ${attrs.includes("tag-format") ? "" : 'tag-format="semantics/1.0" '}${attrs}>${rules}</grammar>`;
const one = (text: string, file = "g.grxml") => {
  const g = parseSrgs(text, file);
  const all = new Map<string, Grammar>([[file, g]]);
  return (u: string) => matchSrgs(g, all, u);
};

describe("SRGS in XML", () => {
  it("SG1.1 a grammar accepts exactly the utterances its root rule derives, ignoring case and punctuation", () => {
    const m = one(grxml(`<rule id="main">i want <one-of><item>a pizza</item><item>pasta</item></one-of></rule>`));
    expect(m("I want a pizza!")).toEqual({ value: "i want a pizza", text: "i want a pizza" });
    expect(m("i want pasta")).toMatchObject({ value: "i want pasta" });
    expect(m("i want")).toBeUndefined();
    expect(m("i want a pizza now")).toBeUndefined();
  });

  it("SG1.2 items repeat as their repeat says: optional, exact, ranges and open ranges", () => {
    const m = one(grxml(`<rule id="main"><item repeat="0-1">please</item> <item repeat="2">very</item> <item repeat="1-">big</item> <item repeat="0-2">red</item> ball</rule>`));
    expect(m("very very big ball")).toBeDefined();
    expect(m("please very very big big big red red ball")).toBeDefined();
    expect(m("very big ball")).toBeUndefined();
    expect(m("very very ball")).toBeUndefined();
    expect(m("very very big red red red ball")).toBeUndefined();
  });

  it("SG1.3 rules refer to rules, here and in other files; NULL matches nothing, VOID never matches, GARBAGE matches anything", () => {
    const sizes = parseSrgs(grxml(`<rule id="size"><one-of><item>small</item><item>large</item></one-of></rule>`, 'root="size"'), "sizes.grxml");
    const main = parseSrgs(
      grxml(
        `<rule id="main"><one-of><item><ruleref uri="#order"/></item><item><ruleref special="VOID"/> never</item><item><ruleref special="GARBAGE"/> thanks</item></one-of></rule>
         <rule id="order"><ruleref uri="sizes.grxml"/> <ruleref special="NULL"/> <ruleref uri="sizes.grxml#size"/></rule>`,
      ),
      "main.grxml",
    );
    const all = new Map([
      ["sizes.grxml", sizes],
      ["main.grxml", main],
    ]);
    expect(matchSrgs(main, all, "small large")).toBeDefined();
    expect(matchSrgs(main, all, "never")).toBeUndefined();
    expect(matchSrgs(main, all, "well um thanks")).toBeDefined();
    expect(matchSrgs(main, all, "thanks")).toBeDefined();
    checkRefs(main, all);
    expect(() => checkRefs(main, new Map([["main.grxml", main]]))).toThrow("rule sizes.grxml# is not defined");
  });

  it("SG1.4 alternatives are tried heaviest first, and tokens and ignored elements behave", () => {
    const m = one(
      grxml(
        `<meta name="x" content="y"/><rule id="main"><example>new york</example><one-of><item weight="0.1">new <tag>out = "light"</tag></item><item weight="5"><token>new york</token><tag>out = "heavy"</tag></item><item><token>  </token>x</item></one-of> <item repeat="0-1">york</item></rule>`,
      ),
    );
    expect(m("new york")).toMatchObject({ value: "heavy" });
    expect(m("new")).toMatchObject({ value: "light" });
    expect(m("x")).toMatchObject({ value: "x" });
  });

  it("SG1.5 SISR: tags set out; a rule's value is out, or its words without tags; rules.x, rules.latest() and meta read subrules", () => {
    const m = one(
      grxml(`<rule id="main"><ruleref uri="#size"/> <ruleref uri="#topping"/><tag>out.size = rules.size; out.topping = rules.latest(); out.said = meta.current().text; out.t = meta.topping.text;</tag></rule>
      <rule id="size"><one-of><item>small<tag>out = "S"</tag></item><item>large<tag>out = "L"</tag></item></one-of></rule>
      <rule id="topping"><one-of><item>ham</item><item>extra cheese</item></one-of></rule>`),
    );
    expect(m("large extra cheese")).toEqual({ value: { size: "L", topping: "extra cheese", said: "large extra cheese", t: "extra cheese" }, text: "large extra cheese" });
  });

  it("SG1.6 semantics/1.0-literals: a tag is the rule's value as text", () => {
    const m = one(grxml(`<rule id="main"><one-of><item>yes<tag>Y</tag></item><item>no<tag> N </tag></item></one-of></rule>`, 'root="main" tag-format="semantics/1.0-literals"'));
    expect(m("no")).toMatchObject({ value: "N" });
  });

  it("SG1.7 a grammar without a root starts at its first rule; one that is wrong is refused, saying why", () => {
    expect(one(grxml(`<rule id="first">a</rule><rule id="second">b</rule>`, ""))("a")).toBeDefined();
    const bad: [string, string][] = [
      [`<vxml/>`, "root is <grammar>"],
      [grxml("", ""), "has no rules"],
      [grxml(`<rule>a</rule>`), "needs an id"],
      [grxml(`<rule id="x">a</rule>`), "root rule main is not defined"],
      [grxml(`<rule id="main"><item repeat="x">a</item></rule>`), 'repeat "x"'],
      [grxml(`<rule id="main"><item repeat="3-1">a</item></rule>`), "is empty"],
      [grxml(`<rule id="main"><item repeat="0">a</item></rule>`), "is empty"],
      [grxml(`<rule id="main"><one-of><item weight="-1">a</item></one-of></rule>`), "weight"],
      [grxml(`<rule id="main"><ruleref/></rule>`), "needs a uri"],
      [grxml(`<rule id="main"><bogus/></rule>`), "not an SRGS rule element"],
      [grxml(`<rule id="main">a</rule>`, 'root="main" tag-format="swi-semantics/1.0"'), "tag-format"],
      [`<grammar`, "g.grxml"],
    ];
    for (const [text, message] of bad) expect(() => parseSrgs(text, "g.grxml"), message).toThrow(message);
    expect(() => parseSrgs("<grammar", "g.grxml")).toThrow(DocumentError);
  });

  it("SG1.8 a grammar that would take too long, or recurses on the left, does not match; a failing tag is a script error", () => {
    const left = one(grxml(`<rule id="main"><one-of><item><ruleref uri="#main"/> a</item><item>a</item></one-of></rule>`));
    expect(left("a a")).toBeUndefined();
    const slow = parseSrgs(grxml(`<rule id="main"><item repeat="0-"><item repeat="0-">a</item></item> b</rule>`), "s.grxml");
    expect(matchSrgs(slow, new Map([["s.grxml", slow]]), `${"a ".repeat(30)}c`, 500)).toBeUndefined();
    const broken = one(grxml(`<rule id="main">a<tag>out = missing.x</tag></rule>`));
    expect(() => broken("a")).toThrow(ScriptError);
    expect(() => broken("a")).toThrow("tag {out = missing.x}");
  });
});

describe("SRGS in ABNF", () => {
  const abnf = (body: string) => `#ABNF 1.0 UTF-8;\nlanguage en-US;\nmode voice;\ntag-format <semantics/1.0>;\n${body}`;

  it("SG2.1 rules, alternatives with weights, optionals, groups, repeats, quoted tokens and specials", () => {
    const m = one(
      abnf(`root $order;
      // an order
      public $order = [please] $size ("pizza" | pasta) <0-1> {out.size = rules.size} [$NULL] thanks<0-> ;
      /* sizes */
      private $size = /2/ small {out = "S"} | /1/ (large | big) {out = "L"} | $VOID;`),
      "o.gram",
    );
    expect(m("please large pizza")).toMatchObject({ value: { size: "L" } });
    expect(m("small")).toMatchObject({ value: { size: "S" } });
    expect(m("big pasta thanks thanks")).toMatchObject({ value: { size: "L" } });
    expect(m("medium pizza")).toBeUndefined();
  });

  it("SG2.2 language attachments, external references, header tags and literals, and the first rule as root", () => {
    const sizes = parseSrgs(`#ABNF 1.0;\n$size = small | large;`, "sizes.gram");
    const main = parseSrgs(`#ABNF 1.0;\n{! header !};\nmeta "author" is "me";\n$main = hello!en-US $<sizes.gram> $<sizes.gram#size> {!{ out = "ok" }!};`, "main.gram");
    const all = new Map([
      ["sizes.gram", sizes],
      ["main.gram", main],
    ]);
    expect(matchSrgs(main, all, "hello small large")).toMatchObject({ value: "ok" });
    expect(parseSrgs(`#ABNF 1.0;\ntag-format <semantics/1.0-literals>;\n$a = x {X};`, "l.gram").literals).toBe(true);
  });

  it("SG2.3 an ABNF grammar that is wrong is refused, saying where", () => {
    const bad: [string, string][] = [
      ["$a = b;", 'starts with "#ABNF 1.0;"'],
      ["#ABNF 1.0;\n$a = b", "expected ;"],
      ["#ABNF 1.0;\n$a = ;", "an empty expansion"],
      ["#ABNF 1.0;\n$a = (b;", "expected )"],
      ["#ABNF 1.0;\n$a = [b;", "expected ]"],
      ["#ABNF 1.0;\n$a = b /* never closed", "an unclosed comment"],
      ["#ABNF 1.0;\n$a = $<x.gram;", "an unclosed rule reference"],
      ["#ABNF 1.0;\n$a = b <1-;", "an unclosed <"],
      ["#ABNF 1.0;\n$a = /x/ b;", "a weight expected"],
      ["#ABNF 1.0;\n$a = b {x;", "an unclosed tag"],
      ["#ABNF 1.0;\n$a = b {!{x;", "an unclosed tag"],
      ['#ABNF 1.0;\n$a = "b;', "an unclosed quote"],
      ["#ABNF 1.0;\n$a = $ b;", "a rule name expected"],
      ["#ABNF 1.0;\n$a = b <x>;", 'repeat "x"'],
      ["#ABNF 1.0;\nroot $z;\n$a = b;", "root rule z is not defined"],
      ["#ABNF 1.0;\nlanguage en;", "has no rules"],
      ["#ABNF 1.0;\n= b;", "unexpected"],
      ["#ABNF 1.0;\n$a = b; >", "unexpected"],
    ];
    for (const [text, message] of bad) expect(() => parseSrgs(text, "g.gram"), message).toThrow(message);
  });
});

describe("words", () => {
  it("SG3.1 an utterance's words are lower case, without punctuation around them", () => {
    expect(wordsOf("  Hello, World!  It's 7:30 -- ok? ")).toEqual(["hello", "world", "it's", "7:30", "ok"]);
    expect(wordsOf("«𐌰bc» ¡sí!")).toEqual(["𐌰bc", "sí"]);
  });

  it("SG3.2 words are found in time linear in the utterance, however it is punctuated", () => {
    const started = performance.now();
    expect(wordsOf("!".repeat(50_000) + "a" + "!".repeat(50_000))).toEqual(["a"]);
    expect(wordsOf("!".repeat(100_000))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("more SISR and references", () => {
  it("SG3.3 a rule without tags takes the value of the last rule it referred to; with no reference, its words", () => {
    const m = one(
      grxml(`<rule id="main">i want <ruleref uri="#size"/> please</rule>
      <rule id="size"><one-of><item>small<tag>out = "S"</tag></item><item>large<tag>out = "L"</tag></item></one-of></rule>`),
    );
    expect(m("i want large please")).toMatchObject({ value: "L" });
    expect(one(grxml(`<rule id="main">just words</rule>`))("just words")).toMatchObject({ value: "just words" });
  });

  it("SG3.4 a reference to another file is relative to the referring file's folder", () => {
    const sizes = parseSrgs(grxml(`<rule id="size"><one-of><item>small</item><item>large</item></one-of></rule>`, 'root="size"'), "grammars/common/sizes.grxml");
    const main = parseSrgs(grxml(`<rule id="main"><ruleref uri="common/sizes.grxml#size"/> <ruleref uri="./common/sizes.grxml"/> <ruleref uri="../grammars/common/sizes.grxml"/></rule>`), "grammars/main.grxml");
    const all = new Map([
      ["grammars/common/sizes.grxml", sizes],
      ["grammars/main.grxml", main],
    ]);
    checkRefs(main, all);
    expect(matchSrgs(main, all, "small large small")).toBeDefined();
    const abnf = parseSrgs("#ABNF 1.0; root $main; $main = $<common/sizes.grxml#size>;", "grammars/main.gram");
    expect(matchSrgs(abnf, new Map([...all, ["grammars/main.gram", abnf]]), "large")).toBeDefined();
  });
});

describe("parses, exactly", () => {
  const rulesOf = (text: string, file = "g.grxml") => parseSrgs(text, file).rules;
  const words = (...w: string[]) => ({ type: "words", words: w });

  it("SG4.1 the XML form parses to the expansions it says: empty rules are NULL, blank text and tokens are nothing, one item is itself, specials, repeats, weights and references", () => {
    const cases: [string, unknown][] = [
      [`<rule id="main"/>`, { type: "null" }],
      [`<rule id="main"> <ruleref special="NULL"/> </rule>`, { type: "null" }],
      [`<rule id="main"><ruleref special="VOID"/></rule>`, { type: "void" }],
      [`<rule id="main"><ruleref special="GARBAGE"/></rule>`, { type: "garbage" }],
      [`<rule id="main"><token> </token>a<meta/><metadata/><lexicon/><example>b</example></rule>`, words("a")],
      [`<rule id="main"><item repeat="10">a</item></rule>`, { type: "repeat", item: words("a"), min: 10, max: 10 }],
      [`<rule id="main"><item repeat=" 2 - 3 ">a</item></rule>`, { type: "repeat", item: words("a"), min: 2, max: 3 }],
      [`<rule id="main"><item repeat="2-">a</item></rule>`, { type: "repeat", item: words("a"), min: 2, max: Number.POSITIVE_INFINITY }],
      [`<rule id="main"><one-of><item weight="0">a</item><item>b</item></one-of></rule>`, { type: "alt", items: [words("b"), words("a")] }],
      [`<rule id="main"><ruleref uri="other.grxml#size"/> <ruleref uri="other.grxml"/> <ruleref uri="#main"/></rule>`, { type: "seq", items: [{ type: "ref", rule: "other.grxml#size" }, { type: "ref", rule: "other.grxml#" }, { type: "ref", rule: "g.grxml#main" }] }],
    ];
    expect(cases.map(([rule]) => [rule, rulesOf(grxml(rule))["g.grxml#main"]])).toEqual(cases);
  });

  it("SG4.2 an XML repeat or weight that is wrong is refused, saying where and what", () => {
    const cases: [string, string][] = [
      [`<rule id="main"><item repeat="x2">a</item></rule>`, 'g.grxml <item>: repeat "x2" is not n, n-m or n-'],
      [`<rule id="main"><item repeat="2x">a</item></rule>`, 'g.grxml <item>: repeat "2x" is not n, n-m or n-'],
      [`<rule id="main"><one-of><item weight="-1">a</item></one-of></rule>`, 'g.grxml <item>: weight "-1" is not a non-negative number'],
    ];
    expect(cases.map(([rule]) => [rule, failure(() => parseSrgs(grxml(rule), "g.grxml"))])).toEqual(cases);
  });

  it("SG4.3 tag formats: semantics/1.0 and its -literals, with a minor version and surrounding space; nothing else", () => {
    const cases: [string, boolean | string][] = [
      [" semantics/1.0-literals ", true],
      ["semantics/1.0.12", false],
      ["semantics/1.0.12-literals", true],
      ["xsemantics/1.0-literals", "g.grxml: tag-format xsemantics/1.0-literals is not supported (semantics/1.0 or semantics/1.0-literals)"],
      ["semantics/1.0-literalsx", "g.grxml: tag-format semantics/1.0-literalsx is not supported (semantics/1.0 or semantics/1.0-literals)"],
    ];
    const formatted = (format: string) => {
      try {
        return parseSrgs(grxml(`<rule id="main">a</rule>`, `root="main" tag-format="${format}"`), "g.grxml").literals;
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(cases.map(([format]) => [format, formatted(format)])).toEqual(cases);
  });

  it("SG4.4 the ABNF form parses to the expansions it says: one alternative is itself, specials, empty tokens dropped, comments, spaced weights, repeat probabilities, trimmed references and tags", () => {
    const cases: [string, unknown][] = [
      ["$a = b;", words("b")],
      ["$a = $NULL $VOID $GARBAGE;", { type: "seq", items: [{ type: "null" }, { type: "void" }, { type: "garbage" }] }],
      ['$a = "" b "!!";', words("b")],
      ['$a = x"new york";', { type: "seq", items: [words("x"), words("new", "york")] }],
      ["$a = b /*/ c */ ;", words("b")],
      ["$a = / 1 / b | / 10 / c;", { type: "alt", items: [words("c"), words("b")] }],
      ["$a = b < 0-1 /0.5 >;", { type: "repeat", item: words("b"), min: 0, max: 1 }],
      ["$a = $< sizes.gram#size >;", { type: "ref", rule: "sizes.gram#size" }],
      ["$a = x { X } | y {!{ Y }!};", { type: "alt", items: [{ type: "seq", items: [words("x"), { type: "tag", code: "X" }] }, { type: "seq", items: [words("y"), { type: "tag", code: "Y" }] }] }],
      ["$a = b; // the end, without a newline", words("b")],
    ];
    expect(cases.map(([body]) => [body, rulesOf(`#ABNF 1.0;\n${body}`, "g.gram")["g.gram#a"]])).toEqual(cases);
  });

  it("SG4.5 ABNF declarations: every header is skipped, a rule may be named public, and the header line may be indented and spaced", () => {
    const headers = `#ABNF 1.0;\nlanguage en-US; mode voice; base <http://example.com/g>; lexicon <x.pls>; meta "a" is "b"; http-equiv "c" is "d";\n$a = b;`;
    expect(rulesOf(headers, "g.gram")).toEqual({ "g.gram#a": words("b") });
    expect(rulesOf("#ABNF 1.0;\npublic $public = b;", "g.gram")).toEqual({ "g.gram#public": words("b") });
    expect(rulesOf("  \n#ABNF  1.0 UTF-8;\n$a = b;", "g.gram")).toEqual({ "g.gram#a": words("b") });
    expect(rulesOf(`  \n<grammar xmlns="http://www.w3.org/2001/06/grammar" version="1.0" root="main"><rule id="main">a</rule></grammar>`)).toEqual({ "g.grxml#main": words("a") });
  });

  it("SG4.6 an ABNF grammar that is wrong is refused, saying exactly what and where in the file", () => {
    const cases: [string, string][] = [
      ["#ABNF 1.0;\n$a = b", "g.gram: expected ;, not the end"],
      ["#ABNF 1.0;\nlanguage en", "g.gram: expected ;, not the end"],
      ["#ABNF 1.0;\n$a = <1> b;", "g.gram: an empty expansion"],
      ['#ABNF 1.0;\n$a = "";', "g.gram: an empty expansion"],
      ["#ABNF 1.0;\n$a = b < x >;", 'g.gram <x>: repeat "x" is not n, n-m or n-'],
      ["#ABNF 1.0;\n$a = b <0-/x\n5>;", 'g.gram <0-/x\n5>: repeat "0-/x\n5" is not n, n-m or n-'],
      ["#ABNF 1.0;\n$a = $ $b;", "g.gram: a rule name expected at offset 16"],
      ["#ABNF 1.0;\n$a = /x/ b | /2/ c;", "g.gram: a weight expected at offset 16"],
      ["#ABNF 1.0;\n$a = b } c;", 'g.gram: unexpected "}" at offset 18'],
      ["x #ABNF 1.0;\n$a = b;", 'g.gram: an ABNF grammar starts with "#ABNF 1.0;"'],
      ['#ABNF 1.0;\n"root" $a;\n$a = b;', 'g.gram: unexpected "root"'],
      ['#ABNF 1.0;\n"tag-format" <semantics/1.0>;\n$a = b;', 'g.gram: unexpected "tag-format"'],
      ['#ABNF 1.0;\n"language" en;\n$a = b;', 'g.gram: unexpected "language"'],
      ["#ABNF 1.0;\nfoo;\n$a = b;", 'g.gram: unexpected "foo"'],
    ];
    expect(cases.map(([text]) => [text, failure(() => parseSrgs(text, "g.gram"))])).toEqual(cases);
  });

  it("SG4.7 checkRefs looks inside alternatives and repeats, and a missing rule of a known file is not defined, in checks and in matching", () => {
    const g = (body: string) => parseSrgs(`#ABNF 1.0;\n${body}`, "g.gram");
    const alone = (grammar: Grammar) => new Map([["g.gram", grammar]]);
    const alt = g("$a = b | $<missing.gram>;");
    const optional = g("$a = [$<missing.gram>];");
    const local = g("$a = $zz;");
    expect(failure(() => checkRefs(alt, alone(alt)))).toBe("rule missing.gram# is not defined");
    expect(failure(() => checkRefs(optional, alone(optional)))).toBe("rule missing.gram# is not defined");
    expect(failure(() => checkRefs(local, alone(local)))).toBe("rule g.gram#zz is not defined");
    expect(() => matchSrgs(local, alone(local), "b")).toThrow(DocumentError);
  });
});

describe("matching, exactly", () => {
  it("SG4.8 matching takes at most the steps it is given: a rule of one word takes two", () => {
    const g = parseSrgs(grxml(`<rule id="main">a</rule>`), "g.grxml");
    const all = new Map([["g.grxml", g]]);
    expect(matchSrgs(g, all, "a", 2)).toEqual({ value: "a", text: "a" });
    expect(matchSrgs(g, all, "a", 1)).toBeUndefined();
  });

  it("SG4.9 a derivation nests at most 1000 deep: 998 repeated words match, 999 do not", () => {
    const m = one(grxml(`<rule id="main"><item repeat="0-">a</item></rule>`));
    expect(m("a ".repeat(998))?.text).toBe("a ".repeat(998).trim());
    expect(m("a ".repeat(999))).toBeUndefined();
  });

  it("SG4.10 depth counts nesting, not how many alternatives were tried", () => {
    const items = Array.from({ length: 1200 }, (_, i) => `<item>w${i}</item>`).join("");
    expect(one(grxml(`<rule id="main"><one-of>${items}</one-of></rule>`))("w1199")).toEqual({ value: "w1199", text: "w1199" });
  });

  it("SG4.11 GARBAGE takes any words, up to all the rest, and they are the rule's words", () => {
    const tail = one(grxml(`<rule id="main">a <ruleref special="GARBAGE"/></rule>`));
    expect(tail("a b c")).toEqual({ value: "a b c", text: "a b c" });
    expect(tail("a")).toEqual({ value: "a", text: "a" });
    expect(one(grxml(`<rule id="main">x <ruleref special="GARBAGE"/> y</rule>`))("x um well y")).toEqual({ value: "x um well y", text: "x um well y" });
  });

  it("SG4.12 an iteration that matches nothing counts toward a repeat's minimum, and is not repeated past it", () => {
    expect(one(grxml(`<rule id="main"><item repeat="0-"><item repeat="0-1">a</item></item> b</rule>`))("b")).toBeDefined();
    expect(one(grxml(`<rule id="main"><item repeat="2"><item repeat="0-1">a</item></item> b</rule>`))("a b")).toBeDefined();
    expect(one(grxml(`<rule id="main">a <item repeat="1-"><tag>out.n = (out.n || 0) + 1</tag></item></rule>`))("a")).toEqual({ value: { n: 1 }, text: "a" });
  });
});

/** The message of the error `f` throws. */
function failure(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return "no error";
}
