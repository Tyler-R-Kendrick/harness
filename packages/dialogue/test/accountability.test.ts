import { describe, expect, it, vi } from "vitest";
import { Dialogue } from "@harness/dialogue";
import type { Decision, Outcome, ScriptInput, Step } from "@harness/dialogue";
import { routerModel, settings, textModel, vectorEmbedder } from "./helpers.ts";

const step = (utterance: string, sessionId = "s-1"): Step => ({ sessionId, utterance });
const book = (...scripts: ScriptInput[]) => ({ scripts });

async function answered(d: Dialogue, s: Step, outcome: Outcome): Promise<Decision> {
  const decision = await d.respond(s);
  d.observe(s, decision, outcome);
  await d.idle();
  return decision;
}

async function teach(d: Dialogue, sessions: readonly string[], first = 1) {
  for (const [i, session] of sessions.entries()) await answered(d, step(`where is my order number ${first + i}`, session), `Checking order ${first + i}.`);
}

const table: ScriptInput = { id: "table", intent: "t", patterns: ["book a table at (?<time>\\S+)", "book a table"], slots: { time: { prompts: ["For what time?"] } }, reply: ["Booked for ", { slot: "time" }, "."] };

describe("what a dialogue keeps", () => {
  it("AC1.1 a result step's values are kept up to 100 characters each, in lists too; numbers, booleans and nulls as they are", async () => {
    const d = new Dialogue({ settings: settings() });
    const output = { exact: "x".repeat(100), long: "x".repeat(101), list: ["y".repeat(101), "ok"], n: 5, flag: true, none: null };
    await answered(d, { sessionId: "a", utterance: "how is it", result: { tool: "track", input: { id: 1 }, output } }, "Fine.");
    const [cluster] = (d.save() as { clusters: { observations: { result: unknown }[] }[] }).clusters;
    expect(cluster!.observations[0]!.result).toEqual({ tool: "track", input: { id: 1 }, output: { exact: "x".repeat(100), long: null, list: [null, "ok"], n: 5, flag: true, none: null } });
  });

  it("AC1.8 how long a result's kept values may be is a setting", async () => {
    const d = new Dialogue({ settings: settings({ induce: { valueLength: 3 } }) });
    await answered(d, { sessionId: "a", utterance: "how is it", result: { tool: "track", input: { id: "abc" }, output: { status: "late" } } }, "Fine.");
    const [cluster] = (d.save() as { clusters: { observations: { result: unknown }[] }[] }).clusters;
    expect(cluster!.observations[0]!.result).toEqual({ tool: "track", input: { id: "abc" }, output: { status: null } });
  });

  it("AC1.2 a session is saved only with something to keep: its context, form or flow", async () => {
    const d = new Dialogue({ settings: settings(), book: book(table) });
    await d.respond(step("nothing to see", "a"));
    await d.respond(step("book a table", "b"));
    expect((d.save() as { sessions: object[] }).sessions.map((s) => Object.keys(s))).toEqual([["id", "last", "form"]]);
  });

  it("AC1.3 a book's entry flow is saved with it, and a book without one saves none", () => {
    expect(new Dialogue({ settings: settings(), book: { scripts: [], entry: "a-bot" } }).save()).toMatchObject({ entry: "a-bot" });
    expect(Object.keys(new Dialogue({ settings: settings(), book: { scripts: [] } }).save() as object)).not.toContain("entry");
  });

  it("AC1.4 a turn only a session's state changed on (a prompt for a slot) is reported", async () => {
    const onChange = vi.fn();
    const d = new Dialogue({ settings: settings(), book: book(table), onChange });
    await d.respond(step("book a table"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("AC1.5 a step the model acted on is kept with no reply, and with no session when the step had none", async () => {
    const d = new Dialogue({ settings: settings() });
    await answered(d, { utterance: "cancel it" }, { acted: true });
    expect((d.save() as { clusters: { observations: unknown[] }[] }).clusters[0]!.observations[0]).toStrictEqual({ utterance: "cancel it", reply: "", acted: true });
  });

  it("AC1.6 skipping a session with nothing to end changes nothing; skipping one with a context ends it, and is reported", async () => {
    const onChange = vi.fn();
    const d = new Dialogue({
      settings: settings(),
      book: book({ id: "order", intent: "o", patterns: ["where is order (?<n>\\d+)"], slots: { n: {} }, reply: ["Order ", { slot: "n" }, "."] }, { id: "yes", intent: "y", context: "order", patterns: ["yes"], reply: ["Done."] }),
      onChange,
    });
    d.skip("never-seen");
    await d.respond(step("nothing to see"));
    onChange.mockClear();
    d.skip("s-1");
    expect(onChange).not.toHaveBeenCalled();
    await d.respond(step("where is order 5"));
    onChange.mockClear();
    d.skip("s-1");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(await d.respond(step("yes"))).toEqual({ kind: "pass", reason: "no script matches" });
  });

  it("AC1.7 clusters for scripts do not count toward the cap on clusters without one", async () => {
    const d = new Dialogue({ settings: settings({ induce: { clusters: 1 } }) });
    await teach(d, ["a", "b"]);
    await answered(d, step("tell me a joke", "a"), "No.");
    await answered(d, step("sing me a song", "b"), "La.");
    expect((d.save() as { clusters: { script?: string; observations: { utterance: string }[] }[] }).clusters.map((c) => c.script ?? c.observations[0]!.utterance)).toEqual(["s1", "sing me a song"]);
  });
});

describe("what a dialogue builds", () => {
  it("AC2.1 a retired script of another shape does not stop a script being built", async () => {
    const d = new Dialogue({ settings: settings(), book: book({ id: "old", intent: "o", status: "retired", patterns: ["something else"], reply: ["Other."] }) });
    await teach(d, ["a", "b"]);
    expect(d.script("s1")).toMatchObject({ status: "candidate" });
  });

  it("AC2.2 a new cluster in a context keeps the context, when the context's clusters are unlike it", async () => {
    const d = new Dialogue({ settings: settings(), book: book({ id: "go", intent: "g", patterns: ["go"], reply: ["Going."] }) });
    await d.respond(step("go"));
    await answered(d, step("alpha bravo charlie"), "One.");
    await d.respond(step("go"));
    await answered(d, step("xray yankee zulu quebec"), "Two.");
    expect((d.save() as { clusters: { context?: string }[] }).clusters.map((c) => c.context)).toEqual(["go", "go"]);
  });

  it("AC2.3 an utterance joins the most alike cluster, the first among equals", async () => {
    const embedder = vectorEmbedder({ first: [1, 0, 0], second: [0.8, 0.6, 0], third: [0.6, 0.8, 0], near: [0.62, 0.78, 0], even: [0.8, 0.6, 0] });
    const d = new Dialogue({ settings: settings({ induce: { cluster: 0.5, sessions: 9 } }), embedder, onError: vi.fn() });
    const heads = { first: "first", second: "second", third: "third" };
    await answered(d, step(heads.first, "a"), "1.");
    // "second" is alike enough to "first" (0.8): it joins it; so do the next unless more alike elsewhere.
    await answered(d, step("third", "a"), "3.");
    await answered(d, step("near", "b"), "N.");
    await answered(d, step("even", "c"), "E.");
    const clusters = (d.save() as { clusters: { observations: { utterance: string }[] }[] }).clusters.map((c) => c.observations.map((o) => o.utterance));
    expect(clusters).toContainEqual(expect.arrayContaining(["third", "near"]));
    expect(clusters.find((c) => c.includes("even"))).toContain("first");
  });

  it("AC2.4 a cluster by meaning embeds with no error", async () => {
    const onError = vi.fn();
    const d = new Dialogue({ settings: settings(), embedder: vectorEmbedder({}), onError });
    await answered(d, step("one thing", "a"), "One.");
    await answered(d, step("another thing", "b"), "Two.");
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("what a dialogue drafts", () => {
  const draftOf = (reply: unknown[], slots: unknown[] = []) => textModel(() => JSON.stringify({ intent: "i", exemplars: ["e"], slots, reply, followUps: [] }));
  const replies = ["We're open from nine in the morning.", "Doors open at 9am, see you then!"];
  async function unalignable(d: Dialogue, sessions: readonly (string | undefined)[] = ["a", "b"]) {
    for (const [i, s] of sessions.entries()) await answered(d, s === undefined ? { utterance: "when do you open" } : step("when do you open", s), replies[i % 2]!);
  }

  it("AC3.1 a tool's cluster is never drafted, and neither are steps from too few sessions or none", async () => {
    const drafter = draftOf([{ text: "We're open from " }, { generate: "time" }, { text: "." }]);
    const d = new Dialogue({ settings: settings(), drafter, embedder: vectorEmbedder({}) });
    await answered(d, { sessionId: "a", utterance: "how is it", result: { tool: "t", input: {}, output: { v: "x" } } }, "It went one way entirely.");
    await answered(d, { sessionId: "b", utterance: "how is it", result: { tool: "t", input: {}, output: { v: "y" } } }, "Nothing alike at all here!");
    await unalignable(d, ["a", "a", "a"]);
    await unalignable(new Dialogue({ settings: settings(), drafter, embedder: vectorEmbedder({}) }), [undefined, undefined, undefined]);
    expect(drafter.calls).toHaveLength(0);
  });

  it("AC3.2 a draft is kept at exactly the determined share and the most holes; one more hole is too many", async () => {
    const at = (determined: number, holes: number, reply: unknown[], slots: unknown[] = []) => {
      const d = new Dialogue({ settings: settings({ induce: { determined, holes } }), drafter: draftOf(reply, slots), embedder: vectorEmbedder({}) });
      return unalignable(d).then(() => d.scripts.length);
    };
    // "We're open from " + "nine in the morning" + ".": 17 of 36 characters are the hole's.
    const reply = [{ text: "We're open from " }, { generate: "time" }, { text: "." }];
    expect(await at(17 / 36, 1, reply)).toBe(1);
    expect(await at(17 / 36 + 0.001, 1, reply)).toBe(0);
    expect(await at(0.1, 0, reply)).toBe(0);
  });

  it("AC3.3 a drafted script's cluster does not build another as it grows", async () => {
    const drafter = draftOf([{ text: "We're open from " }, { generate: "time" }, { text: "." }]);
    const embedder = vectorEmbedder({ e: [1, 0, 0], "when do you open": [0, 1, 0], "what time is opening": [0, 1, 0] });
    const d = new Dialogue({ settings: settings({ induce: { determined: 0.4 } }), drafter, embedder });
    await unalignable(d);
    await answered(d, step("what time is opening", "c"), "Open soon enough, I think!");
    await answered(d, step("what time is opening", "d"), "Open soon enough, I think!");
    expect(d.scripts.map((s) => s.origin)).toEqual(["drafted"]);
  });
});

describe("how scripts are judged", () => {
  it("AC4.1 an active built script is audited every `audit` times it would answer, counting from the first", async () => {
    const d = new Dialogue({ settings: settings({ promote: { audit: 3 } }), book: book({ id: "hours", intent: "h", origin: "induced", patterns: ["hours"], reply: ["We open at 9."] }) });
    const kinds = [];
    for (let i = 0; i < 3; i++) kinds.push((await d.respond(step("hours"))).kind);
    expect(kinds).toEqual(["reply", "reply", "pass"]);
  });

  it("AC4.2 an audit's miss counts against the active script, with no error (it has no cluster)", async () => {
    const onError = vi.fn();
    const d = new Dialogue({ settings: settings({ promote: { audit: 1, retireMargin: 5 } }), book: book({ id: "hours", intent: "h", origin: "induced", patterns: ["hours"], reply: ["We open at 9."] }), onError });
    await answered(d, step("hours"), "We open at 10 now.");
    expect(d.script("hours")!.evidence.misses).toBe(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("AC4.3 the judge is asked only about a reply the script finishes itself, and not at all without a judge", async () => {
    const judge = vi.fn();
    const onError = vi.fn();
    const templated = book({ id: "c", intent: "c", status: "candidate", patterns: ["cancel"], reply: ["Cancelled: ", { generate: "why" }, "."] });
    const d = new Dialogue({ settings: settings(), book: templated, judge: { specificationVersion: "v4", provider: "t", modelId: "t", doEvaluate: judge } as never, onError });
    await answered(d, step("cancel"), "Sure, it is gone.");
    expect(judge).not.toHaveBeenCalled();
    const plain = new Dialogue({ settings: settings(), book: book({ id: "c", intent: "c", status: "candidate", patterns: ["cancel"], reply: ["Cancelled."] }), onError });
    await answered(plain, step("cancel"), "Sure, it is gone.");
    expect(plain.script("c")!.evidence.misses).toBe(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("AC4.4 a candidate built from sessions is promoted only once its fits come from enough sessions", async () => {
    const d = new Dialogue({ settings: settings({ promote: { fits: 2, sessions: 2 } }) });
    await teach(d, ["a", "b"]);
    await teach(d, ["c", "c", "c"], 10);
    expect(d.script("s1")).toMatchObject({ status: "candidate", evidence: { fits: 3, sessions: ["c"] } });
  });

  it("AC4.5 a fit from a step with no session counts, even when steps with none are in the cluster", async () => {
    const d = new Dialogue({ settings: settings({ promote: { fits: 9 } }) });
    await teach(d, ["a", "b"]);
    await answered(d, { utterance: "where is my order number 30" }, "Hmm, let me see about 30.");
    await answered(d, { utterance: "where is my order number 31" }, "Checking order 31.");
    expect(d.script("s1")!.evidence.fits).toBe(1);
  });

  it("AC4.6 a candidate's cluster that sees the model act again gets a miss for the candidate; a new acting cluster reports no error", async () => {
    const onError = vi.fn();
    const d = new Dialogue({ settings: settings(), onError });
    await answered(d, { sessionId: "a", utterance: "how is it", result: { tool: "track", input: { id: 1 }, output: {} } }, "Order 1 is on its way.");
    await answered(d, { sessionId: "b", utterance: "how is it", result: { tool: "track", input: { id: 2 }, output: {} } }, "Order 2 is on its way.");
    expect(d.script("s1")!.status).toBe("candidate");
    // A step the candidate cannot fill (no id) lands in its cluster, and the model acted on it.
    await answered(d, { sessionId: "c", utterance: "how is it", result: { tool: "track", input: {}, output: {} } }, { acted: true });
    expect(d.script("s1")!.evidence.misses).toBe(1);
    await answered(d, step("do something", "d"), { acted: true });
    expect(onError).not.toHaveBeenCalled();
  });

  it("AC4.7 an acted step while a built candidate is shadowed retires the candidate, and the same replies later build nothing in its place", async () => {
    const d = new Dialogue({ settings: settings() });
    await teach(d, ["a", "b"]);
    await answered(d, step("where is my order number 9", "c"), { acted: true });
    expect(d.script("s1")!.status).toBe("retired");
    await teach(d, ["d", "e", "f"], 20);
    expect(d.scripts.filter((s) => s.status !== "retired")).toEqual([]);
  });

  it("AC4.8 a script's evidence names at most 32 sessions", () => {
    const d = new Dialogue({ settings: settings({ promote: { fits: 99 } }), book: book({ id: "x", intent: "x", status: "candidate", patterns: ["x"], reply: ["X."] }) });
    for (let i = 0; i < 34; i++) d.feedback("x", "helpful", `s${i}`);
    expect(d.script("x")!.evidence.sessions).toHaveLength(32);
  });

  it("AC4.9 the turns after an audit are served again: a built script is audited every `audit` turns, for as long as it answers", async () => {
    const d = new Dialogue({ settings: settings({ promote: { audit: 3 } }), book: book({ id: "hours", intent: "h", origin: "induced", patterns: ["hours"], reply: ["We open at 9."] }) });
    const kinds = [];
    for (let i = 0; i < 7; i++) kinds.push((await d.respond(step("hours"))).kind);
    expect(kinds).toEqual(["reply", "reply", "pass", "reply", "reply", "pass", "reply"]);
    expect(d.script("hours")!.evidence).toMatchObject({ served: 5, audits: 2 });
  });

  it("AC4.10 how many sessions a script's evidence names is a setting", () => {
    const d = new Dialogue({ settings: settings({ promote: { fits: 99, sessionsKept: 3 } }), book: book({ id: "x", intent: "x", status: "candidate", patterns: ["x"], reply: ["X."] }) });
    for (let i = 0; i < 5; i++) d.feedback("x", "helpful", `s${i}`);
    expect(d.script("x")!.evidence.sessions).toEqual(["s0", "s1", "s2"]);
  });
});

describe("how matching is bounded", () => {
  it("AC5.1 an utterance exactly as long as the limit is matched by patterns; a longer form answer is not read by them, nor taken whole", async () => {
    const d = new Dialogue({ settings: settings({ match: { maxLength: 19 } }), book: book(table) });
    expect(await d.respond(step("book a table at 7pm"))).toMatchObject({ kind: "reply", text: "Booked for 7pm." });
    expect(await d.respond(step("book a table"))).toMatchObject({ kind: "ask" });
    expect(await d.respond(step("book a table at 8pm, thank you"))).toMatchObject({ kind: "pass" });
  });

  it("AC5.2 a long utterance's slots come from the router, not from value patterns", async () => {
    const router = routerModel(() => ({ tool: "order", confidence: 0.99 }));
    const d = new Dialogue({ settings: settings({ match: { maxLength: 20 } }), book: book({ id: "order", intent: "o", slots: { n: { pattern: "\\d+" } }, reply: ["Order ", { slot: "n" }, "."] }), router });
    expect(await d.respond(step("please tell me where my order 55 is right now"))).toEqual({ kind: "pass", reason: "no value for slot n" });
    expect(router.offered).toHaveLength(1);
  });

  it("AC5.3 among exemplars, a better-ranked script wins over a more alike one, and the more alike wins among equals", async () => {
    const embedder = vectorEmbedder({ q: [1, 0], "cand close": [1, 0], "active far": [0.9, 0.44], "active near": [0.95, 0.31] });
    const d = new Dialogue({
      settings: settings({ match: { similar: 0.8 } }),
      book: book({ id: "cand", intent: "c", status: "candidate", exemplars: ["cand close"], reply: ["C."] }, { id: "far", intent: "f", exemplars: ["active far"], reply: ["F."] }, { id: "near", intent: "n", exemplars: ["active near"], reply: ["N."] }),
      embedder,
    });
    expect(await d.respond(step("q"))).toMatchObject({ kind: "reply", script: "near" });
  });

  it("AC5.4 with an embedder and no exemplar alike enough, and no router, nothing matches, with no error", async () => {
    const onError = vi.fn();
    const d = new Dialogue({ settings: settings(), book: book({ id: "x", intent: "x", exemplars: ["far away"], reply: ["X."] }), embedder: vectorEmbedder({ "far away": [1, 0], q: [0, 1] }), onError });
    expect(await d.respond(step("q"))).toEqual({ kind: "pass", reason: "no script matches" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("AC5.5 a script the router picked is not sent to the router again for its missing slots", async () => {
    const router = routerModel(() => ({ tool: "order", confidence: 0.99 }));
    const d = new Dialogue({ settings: settings(), book: book({ id: "order", intent: "o", slots: { n: {} }, reply: ["Order ", { slot: "n" }, "."] }), router });
    await d.respond(step("my order"));
    expect(router.offered).toHaveLength(1);
  });
});
