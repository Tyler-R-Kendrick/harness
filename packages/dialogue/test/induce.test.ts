import { describe, expect, it } from "vitest";
import { findValue, induce, maskExemplar, matchPattern, normalizeUtterance, parseSettings, scriptId } from "@harness/dialogue";
import type { Observation, ToolResult } from "@harness/dialogue";
import { readFileSync } from "node:fs";

const file = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")) as { induce: Record<string, unknown> };
const settings = (induce: Record<string, unknown> = {}) => parseSettings({ ...file, induce: { ...file.induce, ...induce } }).induce;
const id = scriptId("s7");

/** Each observation from a session of its own: scripts are built from several sessions. */
let sessions = 0;
const session = () => `u${++sessions}`;
const tracked = (id: number, status: string, eta: string, reply: string): Observation => ({ utterance: `where is ${id}`, result: { tool: "track_order", input: { id }, output: { status, eta } }, reply, session: session() });
const asked = (utterance: string, reply: string): Observation => ({ utterance, reply, session: session() });

describe("induce", () => {
  it("IN1.1 replies to one tool's results become a result script reading each varying value where the result has it, input first", () => {
    const induced = induce(
      {
        tool: "track_order",
        observations: [tracked(1234, "shipped", "Tuesday", "Order 1234 is shipped and arrives Tuesday."), tracked(99, "delayed", "Friday", "Order 99 is delayed and arrives Friday.")],
      },
      settings(),
      id,
    );
    expect(induced).toEqual({
      script: expect.objectContaining({
        id: "s7",
        status: "candidate",
        origin: "induced",
        result: { tool: "track_order" },
        reply: ["Order ", { input: ["id"] }, " is ", { output: ["status"] }, " and arrives ", { output: ["eta"] }, "."],
        evidence: { fits: 0, misses: 0, served: 0, audits: 0, sessions: [] },
      }),
    });
  });

  it("IN1.2 a varying part the result does not hold is generated", () => {
    const induced = induce(
      { tool: "track_order", observations: [tracked(1, "shipped", "Tuesday", "Order 1 is on time, sorry."), tracked(2, "late", "Friday", "Order 2 is running late, sorry.")] },
      settings({ determined: 0.5 }),
      id,
    );
    expect(induced).toMatchObject({ script: { reply: ["Order ", { input: ["id"] }, " is ", { generate: "hole_2" }, ", sorry."] } });
  });

  it("IN1.3 reply parts repeating what the user said are slots: the utterances become a pattern, and the exemplar masks the values", () => {
    const induced = induce({ observations: [asked("Where is order 1234?", "Let me look up order 1234."), asked("where is order 99", "Let me look up order 99.")] }, settings(), id);
    expect(induced).toMatchObject({
      script: {
        intent: "Where is order {slot_1}",
        patterns: ["Where\\s+is\\s+order\\s+(?<slot_1>\\d+)"],
        exemplars: ["Where is order {slot_1}"],
        slots: { slot_1: { pattern: "\\d+", prompts: [] } },
        reply: ["Let me look up order ", { slot: "slot_1" }, "."],
        evidence: { fits: 0 },
      },
    });
    const script = "script" in induced ? induced.script : undefined;
    expect(matchPattern(script!.patterns[0]!, "WHERE is order 5!")).toEqual({ slot_1: "5" });
  });

  it("IN1.4 paraphrases give no pattern: the utterances are exemplars and the reply's varying parts are generated", () => {
    const induced = induce({ observations: [asked("has my package shipped", "It shipped Monday, thanks for waiting."), asked("did my order go out yet?", "It shipped today, thanks for waiting.")] }, settings(), id);
    expect(induced).toMatchObject({
      script: { intent: "has my package shipped", patterns: [], exemplars: ["has my package shipped", "did my order go out yet"], slots: {}, reply: ["It shipped ", { generate: "hole_1" }, ", thanks for waiting."] },
    });
  });

  it("IN1.5 replies that share too little are not a script, and say why", () => {
    const induced = induce({ observations: [asked("tell me a joke", "Why did the chicken cross the road?"), asked("tell me a joke", "A horse walks into a bar.")] }, settings(), id);
    expect(induced).toEqual({ problem: "only 0.00 of the reply is determined, below 0.6" });
  });

  it("IN1.6 replies with too many holes are not a script", () => {
    const observations = [asked("x", "a 1 b 2 c 3 d 4 e"), asked("x", "a 5 b 6 c 7 d 8 e")];
    expect(induce({ observations }, settings({ holes: 3, determined: 0.1 }), id)).toEqual({ problem: "4 holes, more than 3" });
  });

  it("IN1.7 a cluster smaller than the support is not a script yet", () => {
    expect(induce({ observations: [asked("hi", "Hello!")] }, settings(), id)).toEqual({ problem: "1 observation(s), fewer than 2" });
  });

  it("IN1.8 a script is induced in its cluster's context", () => {
    const induced = induce({ context: scriptId("order-status"), observations: [asked("yes", "Done."), asked("Yes", "Done.")] }, settings(), id);
    expect(induced).toMatchObject({ script: { context: "order-status", patterns: ["yes"], exemplars: ["yes"], reply: ["Done."] } });
  });

  it("IN1.9 a slot whose values are not all digits has no value pattern", () => {
    const induced = induce({ observations: [asked("call me Ann", "Nice to meet you, Ann."), asked("call me Bo", "Nice to meet you, Bo.")] }, settings(), id);
    expect(induced).toMatchObject({ script: { slots: { slot_1: { prompts: [] } } } });
    expect("script" in induced && induced.script.slots["slot_1"]!.pattern).toBeUndefined();
  });

  it("IN1.10 an utterance cluster whose utterances vary more than they share gets no pattern", () => {
    const induced = induce({ observations: [asked("order 1234 please", "Order 1234."), asked("order 99 now thanks", "Order 99.")] }, settings({ determined: 0.7 }), id);
    expect(induced).toMatchObject({ script: { patterns: [], reply: ["Order ", { generate: "hole_1" }, "."] } });
  });

  it("IN1.11 an observation that does not fit the induced script is not counted for it", () => {
    const induced = induce({ observations: [asked("where is order 1", "Order 1 ships."), asked("where is order 2", "Order 2 ships."), asked("where is order 3", "Order 3  ships.")] }, settings(), id);
    expect(induced).toMatchObject({ script: { evidence: { fits: 0 } } });
  });

  it("IN1.12 a gap some utterance leaves empty may be empty in the pattern", () => {
    const induced = induce({ observations: [asked("where is order 12", "Order 12."), asked("where is my order 34", "Order 34.")] }, settings(), id);
    expect(induced).toMatchObject({ script: { patterns: ["where\\s+is\\s+(?:(?<slot_1>\\S+(?:\\s+\\S+){0,7}?)\\s+)?order\\s+(?<slot_2>\\d+)"], reply: ["Order ", { slot: "slot_2" }, "."] } });
    const script = "script" in induced ? induced.script : undefined;
    expect(matchPattern(script!.patterns[0]!, "where is order 5")).toEqual({ slot_2: "5" });
    expect(matchPattern(script!.patterns[0]!, "where is my own order 5")).toEqual({ slot_1: "my own", slot_2: "5" });
  });

  const result = (input: ToolResult["input"], output: ToolResult["output"], reply: string): Observation => ({ utterance: "x", result: { tool: "t", input, output }, reply, session: session() });

  it("IN1.13 a value is read from where every observation has it, not just the first", () => {
    const induced = induce({ tool: "t", observations: [result({}, { a: "x", b: "x" }, "Value x."), result({}, { a: "y", b: "z" }, "Value z.")] }, settings(), id);
    expect(induced).toMatchObject({ script: { reply: ["Value ", { output: ["b"] }, "."] } });
  });

  it("IN1.14 an array's items are read by index; a null is no value", () => {
    const induced = induce({ tool: "t", observations: [result({}, { eta: ["Tuesday"], s: null }, "Due Tuesday, null."), result({}, { eta: ["Friday"], s: "late" }, "Due Friday, late.")] }, settings(), id);
    expect(induced).toMatchObject({ script: { reply: ["Due ", { output: ["eta", 0] }, ", ", { generate: "hole_2" }, "."] } });
  });

  it("IN1.15 a reply may open with a hole, and whitespace around replies is not part of them", () => {
    const induced = induce({ tool: "t", observations: [result({ id: 1234 }, { status: "shipped" }, " 1234 is shipped. "), result({ id: 99 }, { status: "late" }, "99 is late.\n")] }, settings(), id);
    expect(induced).toMatchObject({ script: { reply: [{ input: ["id"] }, " is ", { output: ["status"] }, "."], evidence: { fits: 0 } } });
  });

  it("IN1.16 the share determined is exact: fixed text and found values over all the replies' text", () => {
    const induced = induce({ tool: "t", observations: [result({}, {}, "Order 1 is on time, sorry."), result({}, {}, "Order 2 is running late, sorry.")] }, settings({ determined: 0.9 }), id);
    expect(induced).toEqual({ problem: "only 0.63 of the reply is determined, below 0.9" });
    const found = induce({ tool: "t", observations: [result({ id: 1 }, {}, "Order 1 is on time, sorry."), result({ id: 2 }, {}, "Order 2 is running late, sorry.")] }, settings({ determined: 0.95 }), id);
    expect(found).toEqual({ problem: "only 0.67 of the reply is determined, below 0.95" });
  });

  it("IN1.17 utterances become a pattern when enough of them is fixed, the threshold included", () => {
    const go = [asked("go 12", "Going to 12."), asked("go 34", "Going to 34.")];
    expect(induce({ observations: go }, settings({ determined: 0.7 }), id)).toMatchObject({ script: { patterns: [], reply: ["Going to ", { generate: "hole_1" }, "."] } });
    expect(induce({ observations: go }, settings({ determined: 0.6 }), id)).toMatchObject({ script: { patterns: ["go\\s+(?<slot_1>\\d+)"], reply: ["Going to ", { slot: "slot_1" }, "."] } });
  });

  it("IN1.18 a pattern needs fixed words, whatever the settings", () => {
    expect(induce({ observations: [asked("a b", "Yes, a b."), asked("c d", "Yes, c d.")] }, settings({ determined: 0 }), id)).toMatchObject({ script: { patterns: [] } });
  });

  it("IN1.19 a reply part is a slot only when every observation repeats it", () => {
    expect(induce({ observations: [asked("call me Ann", "Hi Ann."), asked("call me Bo", "Hi Robert.")] }, settings({ determined: 0.4 }), id)).toMatchObject({ script: { reply: ["Hi ", { generate: "hole_1" }, "."] } });
  });

  it("IN1.20 empty replies are not a script; one empty reply among others leaves little determined", () => {
    expect(induce({ observations: [asked("x", ""), asked("x", " ")] }, settings(), id)).toEqual({ problem: "the replies are empty" });
    expect(induce({ observations: [asked("x", ""), asked("x", "Done.")] }, settings(), id)).toEqual({ problem: "only 0.00 of the reply is determined, below 0.6" });
  });

  it("IN1.21 a slot has a digits pattern only when every value is all digits", () => {
    for (const [a, b] of [
      ["12a", "34b"],
      ["a12", "b34"],
      ["12", "ab"],
    ]) {
      const induced = induce({ observations: [asked(`book ${a}`, `Booked ${a}.`), asked(`book ${b}`, `Booked ${b}.`)] }, settings(), id);
      expect("script" in induced && induced.script.slots["slot_1"]).toEqual({ prompts: [] });
    }
  });

  it("IN1.22 a pattern matches the fixed text literally, any whitespace for any whitespace", () => {
    const induced = induce({ observations: [asked("is  item 12 in stock (size m)?", "Item 12: yes."), asked("is item 7 in stock (size m)", "Item 7: yes.")] }, settings(), id);
    expect(induced).toMatchObject({ script: { patterns: ["is\\s+item\\s+(?<slot_1>\\d+)\\s+in\\s+stock\\s+\\(size\\s+m\\)"] } });
  });

  it("IN1.23 a gap takes at most `words` words", () => {
    const induced = induce({ observations: [asked("where is order 12", "Order 12."), asked("where is my order 34", "Order 34.")] }, settings({ words: 2 }), id);
    const script = "script" in induced ? induced.script : undefined;
    expect(script!.patterns).toEqual(["where\\s+is\\s+(?:(?<slot_1>\\S+(?:\\s+\\S+){0,1}?)\\s+)?order\\s+(?<slot_2>\\d+)"]);
    expect(matchPattern(script!.patterns[0]!, "where is my own order 5")).toEqual({ slot_1: "my own", slot_2: "5" });
    expect(matchPattern(script!.patterns[0]!, "where is my very own order 5")).toBeUndefined();
  });
});

describe("normalizeUtterance", () => {
  it("IN3.1 drops whitespace around an utterance and all its closing punctuation", () => {
    expect(normalizeUtterance("  where is it?! ")).toBe("where is it");
    expect(normalizeUtterance("where . is it …")).toBe("where . is it");
    expect(normalizeUtterance("?! .")).toBe("");
  });

  it("IN3.3 takes time linear in an utterance's length, however it ends", () => {
    const text = "a" + " .".repeat(50_000) + "b";
    const started = performance.now();
    expect(normalizeUtterance(text)).toBe(text);
    expect(normalizeUtterance(" .".repeat(50_000))).toBe("");
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("maskExemplar", () => {
  it("IN3.4 masks links, email addresses and numbers, word by word, and keeps the whitespace between words", () => {
    expect(maskExemplar("mail  ann@x.org or see https://x.org/42 about order 12b!")).toBe("mail  {email} or see {link} about order {number}b");
    expect(maskExemplar("an @ sign, a@b@c and http:/x")).toBe("an @ sign, a@b@c and http:/x");
  });

  it("IN3.5 takes time linear in an utterance's length", () => {
    const started = performance.now();
    expect(maskExemplar("@".repeat(50_000) + " x")).toBe("@".repeat(50_000) + " x");
    expect(maskExemplar("a@".repeat(20_000))).toBe("a@".repeat(20_000));
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("findValue", () => {
  it("IN3.2 finds a value anywhere in an answer, without whitespace around it; an empty find is no value", () => {
    expect(findValue("\\s\\d+", "it is 12 now")).toBe("12");
    expect(findValue("x*", "abc")).toBeUndefined();
    expect(findValue("\\d+", "none")).toBeUndefined();
  });
});

describe("matchPattern", () => {
  it("IN2.1 a pattern matches a whole utterance, ignoring case, whitespace around it and closing punctuation", () => {
    expect(matchPattern("where is order (?<id>\\d+)", "  Where is order 12?! ")).toEqual({ id: "12" });
    expect(matchPattern("where is order (?<id>\\d+)", "so where is order 12")).toBeUndefined();
    expect(matchPattern("yes", "yes.")).toEqual({});
  });

  it("IN2.2 an optional group that took no part leaves its slot unfilled", () => {
    expect(matchPattern("order(?: (?<id>\\d+))?", "order")).toEqual({});
    expect(matchPattern("call me(?<name>.*)", "call me  Ann")).toEqual({ name: "Ann" });
    expect(matchPattern("call me(?<name>\\s*)", "call me  ")).toEqual({});
  });
});

describe("induce refuses, saying why", () => {
  const result = (reply: string, s = session()): Observation => ({ utterance: "how is it", result: { tool: "t", input: {}, output: {} }, reply, session: s });

  it("IN2.3 steps the model acted on, and steps from too few sessions (those with none count none)", () => {
    expect(induce({ acted: true, observations: [asked("a b", "X."), asked("a c", "X.")] }, settings(), id)).toEqual({ problem: "the model acted on steps like these" });
    const unnamed = [{ utterance: "a b", reply: "X." }, { utterance: "a c", reply: "X." }];
    expect(induce({ observations: unnamed }, settings({ sessions: 1 }), id)).toEqual({ problem: "observations from 0 session(s), fewer than 1" });
  });

  it("IN2.4 a template fewer than the support's replies fit", () => {
    expect(induce({ tool: "t", observations: [result("It is 1.5."), result("It is 2.")] }, settings({ determined: 0 }), id)).toEqual({ problem: "1 observation(s) fit the script, fewer than 2" });
  });

  it("IN2.5 an utterance with as many gaps as the holes allowed is a pattern; with more it is an exemplar", () => {
    const two = [asked("send 1 to 2", "Sent."), asked("send 3 to 4", "Sent.")];
    expect(induce({ observations: two }, settings({ holes: 2, determined: 0.3 }), id)).toMatchObject({ script: { patterns: ["send\\s+(?<slot_1>\\d+)\\s+to\\s+(?<slot_2>\\d+)"] } });
    expect(induce({ observations: two }, settings({ holes: 1, determined: 0.3 }), id)).toMatchObject({ script: { patterns: [], exemplars: ["send {number} to {number}"] } });
  });
});
