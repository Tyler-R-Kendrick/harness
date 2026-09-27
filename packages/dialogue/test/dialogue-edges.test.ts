import { describe, expect, it, vi } from "vitest";
import { Dialogue } from "@harness/dialogue";
import type { Decision, ScriptInput, Step, ToolResult } from "@harness/dialogue";
import { scriptedJudge } from "@harness/testkit";
import { routerModel, settings, supportBook, textModel, vectorEmbedder } from "./helpers.ts";

const S = "session-1";
const step = (utterance: string, sessionId = S): Step => ({ sessionId, utterance });
const resultStep = (result: ToolResult): Step => ({ sessionId: S, utterance: "how is my order", result });
const book = (...scripts: ScriptInput[]) => ({ scripts });

async function answered(d: Dialogue, s: Step, reply: string | undefined): Promise<Decision> {
  const decision = await d.respond(s);
  d.observe(s, decision, reply);
  await d.idle();
  return decision;
}

describe("matching, exactly", () => {
  it("DG1.10 a pass carries no context or shadow it does not have", async () => {
    expect(await new Dialogue({ settings: settings(), book: supportBook() }).respond(step("tell me a joke"))).toStrictEqual({ kind: "pass", reason: "no script matches" });
  });

  it("DG1.11 exemplar similarity is the cosine, whatever the vectors' lengths; a zero vector is alike to nothing", async () => {
    const embedder = vectorEmbedder({ nothing: [0, 0, 0], alpha: [3, 0, 0], beta: [0, 2, 0], "a word": [1, 1, 0] });
    const d = new Dialogue({
      settings: settings({ match: { similar: 0.7 } }),
      book: book({ id: "zero", intent: "z", exemplars: ["nothing"], reply: ["Z."] }, { id: "a", intent: "a", exemplars: ["alpha"], reply: ["A."] }, { id: "b", intent: "b", exemplars: ["beta"], reply: ["B."] }),
      embedder,
    });
    expect(await d.respond(step("a word"))).toEqual({ kind: "reply", script: "a", text: "A.", match: { by: "exemplar", similarity: expect.closeTo(Math.SQRT1_2, 9) } });
  });

  it("DG1.21 an utterance that embeds to nothing is alike to nothing, and nothing fails", async () => {
    const onError = vi.fn();
    const embedder = vectorEmbedder({ silence: [0, 0, 0], alpha: [3, 0, 0] });
    const d = new Dialogue({ settings: settings({ match: { similar: -1 } }), book: book({ id: "a", intent: "a", exemplars: ["alpha"], reply: ["A."] }), embedder, onError });
    expect(await d.respond(step("silence"))).toMatchObject({ kind: "reply", script: "a", match: { similarity: 0 } });
    expect(onError).not.toHaveBeenCalled();
  });

  it("DG1.12 an exemplar exactly as alike as the threshold matches, and of equally alike scripts the first does", async () => {
    const embedder = vectorEmbedder({ alpha: [3, 0, 0], "alpha too": [3, 0, 0], "the word": [2, 0, 0] });
    const d = new Dialogue({ settings: settings({ match: { similar: 1 } }), book: book({ id: "a", intent: "a", exemplars: ["alpha"], reply: ["A."] }, { id: "a2", intent: "a", exemplars: ["alpha too"], reply: ["A2."] }), embedder });
    expect(await d.respond(step("the word"))).toMatchObject({ kind: "reply", script: "a", match: { similarity: 1 } });
  });

  it("DG1.13 utterances are embedded as queries and exemplars as documents, each exemplar once; nothing is embedded when no script has exemplars", async () => {
    const embedder = vectorEmbedder({});
    const d = new Dialogue({ settings: settings(), book: book({ id: "a", intent: "a", exemplars: ["alpha", "beta"], reply: ["A."] }), embedder });
    await d.respond(step("one"));
    await d.respond(step("two"));
    expect(embedder.calls).toEqual([
      { values: ["one"], kind: "query" },
      { values: ["alpha", "beta"], kind: "document" },
      { values: ["two"], kind: "query" },
    ]);
    const unused = vectorEmbedder({});
    await new Dialogue({ settings: settings(), book: book({ id: "a", intent: "a", patterns: ["a"], reply: ["A."] }), embedder: unused }).respond(step("one"));
    expect(unused.calls).toEqual([]);
  });

  it("DG1.14 the router is offered each eligible script as a tool: its id, intent, and slots as string parameters", async () => {
    const router = routerModel(() => ({ tool: "hours", confidence: 0.9 }));
    const d = new Dialogue({
      settings: settings(),
      book: book({ id: "refund", intent: "A refund", slots: { order_id: { description: "The order number" }, note: {} }, reply: ["Refund ", { slot: "order_id" }, "."] }, { id: "hours", intent: "Opening hours", reply: ["We open at 9."] }),
      router,
    });
    expect(await d.respond(step("when do you open"))).toMatchObject({ kind: "reply", script: "hours", match: { by: "router", confidence: 0.9 } });
    expect(router.tools[0]).toStrictEqual([
      { type: "function", name: "refund", description: "A refund", inputSchema: { type: "object", properties: { order_id: { type: "string", description: "The order number" }, note: { type: "string" } }, additionalProperties: false } },
      { type: "function", name: "hours", description: "Opening hours", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    ]);
  });

  it("DG1.15 the router is not offered result scripts or scripts out of context, and is not asked when nothing is eligible", async () => {
    const router = routerModel(() => undefined);
    await new Dialogue({ settings: settings(), book: supportBook(), router }).respond(step("hello"));
    expect(router.offered).toEqual([["order-status"]]);
    const idle = routerModel(() => undefined);
    await new Dialogue({ settings: settings(), book: book({ id: "later", intent: "x", context: "first", reply: ["X."] }, { id: "first", intent: "y", result: { tool: "t" }, reply: ["Y."] }), router: idle }).respond(step("hello"));
    expect(idle.offered).toEqual([]);
  });

  it("DG1.16 a router's pick counts only when it is its one valid call; its string arguments fill slots, trimmed, and empty ones do not", async () => {
    const hours = { id: "hours", intent: "Opening hours", slots: { day: { prompts: ["Which day?"] } }, reply: ["Open on ", { slot: "day" }, "."] } as const;
    const two = routerModel(() => [
      { tool: "hours", args: { day: "Monday" }, confidence: 0.99 },
      { tool: "hours", args: { day: "Friday" }, confidence: 0.99 },
    ]);
    const invalid = routerModel(() => [
      { tool: "hours", args: { day: "Monday" }, confidence: 0.99 },
      { tool: "nope", confidence: 0.99 },
    ]);
    for (const router of [two, invalid]) expect(await new Dialogue({ settings: settings(), book: book(hours), router }).respond(step("when"))).toMatchObject({ kind: "pass" });
    const trimmed = routerModel(() => ({ tool: "hours", args: { day: " Monday " }, confidence: 0.99 }));
    expect(await new Dialogue({ settings: settings(), book: book(hours), router: trimmed }).respond(step("when"))).toMatchObject({ kind: "reply", text: "Open on Monday." });
    const empty = routerModel(() => ({ tool: "hours", args: { day: " " }, confidence: 0.99 }));
    const d = new Dialogue({ settings: settings(), book: book(hours), router: empty });
    expect(await d.respond(step("when"))).toMatchObject({ kind: "ask", slot: "day" });
    expect(empty.offered).toHaveLength(1);
  });

  it("DG1.17 value patterns fill only the slots still missing, and the router is asked only for what they do not find", async () => {
    const pair = { id: "pair", intent: "two numbers", patterns: ["(?<a>\\d+) then (?<b>\\d+)"], slots: { a: { pattern: "\\d+" }, b: { pattern: "\\d+" } }, reply: [{ slot: "a" }, " then ", { slot: "b" }, "."] } as const;
    const router = routerModel(() => undefined);
    expect(await new Dialogue({ settings: settings(), book: book(pair), router }).respond(step("12 then 34"))).toMatchObject({ kind: "reply", text: "12 then 34." });
    expect(router.offered).toEqual([]);
    const two = { id: "two", intent: "two", exemplars: ["two things"], slots: { n: { pattern: "\\d+" }, name: {} }, reply: [{ slot: "n" }, " for ", { slot: "name" }, "."] } as const;
    const naming = routerModel(() => ({ tool: "two", args: { name: "Ann", n: "99" }, confidence: 0.95 }));
    const embedder = vectorEmbedder({ "two things": [1, 0], "two things 5": [1, 0] });
    expect(await new Dialogue({ settings: settings(), book: book(two), router: naming, embedder }).respond(step("two things 5"))).toMatchObject({ kind: "reply", text: "5 for Ann." });
    expect(naming.offered).toEqual([["two"]]);
    const found = routerModel(() => undefined);
    await new Dialogue({ settings: settings(), book: supportBook(), router: found, embedder: vectorEmbedder({ "track my package": [1, 0], "track my package 42": [1, 0] }) }).respond(step("track my package 42"));
    expect(found.offered).toEqual([]);
  });

  it("DG1.18 in context, a contextual script answers before one without; out of it, the one without does", async () => {
    const d = new Dialogue({
      settings: settings(),
      book: book(
        { id: "first", intent: "first", patterns: ["start"], reply: ["Started."] },
        { id: "any-yes", intent: "yes", patterns: ["yes"], reply: ["Yes to what?"] },
        { id: "confirm", intent: "confirm", context: "first", patterns: ["yes"], reply: ["Confirmed."] },
        { id: "maybe", intent: "confirm", status: "candidate", context: "first", patterns: ["yes"], reply: ["Maybe."] },
      ),
    });
    expect(await d.respond(step("yes"))).toMatchObject({ script: "any-yes" });
    await d.respond(step("start"));
    expect(await d.respond(step("yes"))).toMatchObject({ script: "confirm" });
  });

  it("DG1.19 a result step: an active script answers before a candidate, retired and utterance scripts never; a script may leave holes to the model", async () => {
    const result = { tool: "t", input: {}, output: { v: "x" } };
    const d = new Dialogue({
      settings: settings(),
      book: book(
        { id: "hi", intent: "hi", reply: ["Hi."] },
        { id: "old", intent: "t", status: "retired", result: { tool: "t" }, reply: ["Old ", { output: ["v"] }, "."] },
        { id: "new", intent: "t", status: "candidate", result: { tool: "t" }, reply: ["New ", { output: ["v"] }, "."] },
        { id: "live", intent: "t", result: { tool: "t" }, reply: ["Live ", { output: ["v"] }, ": ", { generate: "why" }, "."] },
      ),
    });
    expect(await d.respond(resultStep(result))).toEqual({ kind: "generate", script: "live", template: { type: "template", parts: ["Live x: ", { hole: "why" }, "."] }, match: { by: "result" } });
    expect(d.script("live")!.evidence.served).toBe(1);
    d.feedback("live", "harmful");
    d.feedback("live", "harmful");
    expect(await d.respond(resultStep(result))).toEqual({ kind: "pass", reason: "new is a candidate", context: "live", shadow: { script: "new", slots: {}, match: { by: "result" } } });
    expect(await d.respond(resultStep({ ...result, tool: "u" }))).toMatchObject({ kind: "pass", reason: "no script answers this u result" });
  });
});

describe("forms, exactly", () => {
  const table = {
    id: "table",
    intent: "Book a table",
    patterns: ["book a table(?: for (?<people>\\d+))?(?: at (?<time>\\S+))?"],
    slots: { people: { pattern: "\\d+", prompts: ["For how many?", "How many people?"] }, time: { prompts: ["At what time?"] } },
    reply: ["Booked for ", { slot: "people" }, " at ", { slot: "time" }, "."],
  } as const;

  it("FM1.7 a form keeps the slots it has, and an answer its script's pattern matches fills them all", async () => {
    const d = new Dialogue({ settings: settings(), book: book(table) });
    expect(await d.respond(step("book a table at 8pm"))).toMatchObject({ kind: "ask", slot: "people", text: "For how many?" });
    expect(await d.respond(step("4"))).toMatchObject({ kind: "reply", text: "Booked for 4 at 8pm." });
    await d.respond(step("book a table"));
    expect(await d.respond(step("book a table for 2 at 9pm"))).toMatchObject({ kind: "reply", text: "Booked for 2 at 9pm.", match: { by: "form" } });
  });

  it("FM1.8 saying the form's own request again is no answer: the next prompt follows", async () => {
    const d = new Dialogue({ settings: settings(), book: book({ ...table, exemplars: ["reserve a table"] }), embedder: vectorEmbedder({ "reserve a table": [1, 0] }) });
    await d.respond(step("book a table at 8pm"));
    expect(await d.respond(step("reserve a table"))).toMatchObject({ kind: "ask", text: "How many people?" });
  });

  it("FM1.9 a router finding no value in the answer leads to the next prompt", async () => {
    const router = routerModel(() => undefined);
    const d = new Dialogue({ settings: settings(), book: book(table), router });
    await d.respond(step("book a table for 2"));
    expect(await d.respond(step("whenever"))).toEqual({ kind: "pass", reason: "no time after 1 prompts", context: "table" });
  });
});

describe("learning, exactly", () => {
  it("PM1.7 a retired script stays retired whatever it is told", () => {
    const d = new Dialogue({ settings: settings({ promote: { fits: 1 } }), book: book({ id: "x", intent: "x", status: "retired", patterns: ["x"], reply: ["X."], evidence: { fits: 3, misses: 3, served: 0 } }) });
    d.feedback("x", "helpful");
    expect(d.script("x")!.status).toBe("retired");
  });

  it("PM1.8 the judge sees a result candidate's result, and a probability at the threshold counts as a fit", async () => {
    const judge = scriptedJudge(() => ({ type: "boolean", probability: 0.8 }));
    const d = new Dialogue({ settings: settings(), book: book({ id: "r", intent: "r", status: "candidate", result: { tool: "t" }, reply: ["It is ", { output: ["v"] }, "."] }), judge });
    const result = { tool: "t", input: {}, output: { v: "x" } };
    await answered(d, resultStep(result), "Yes: x.");
    expect(judge.requests[0]!.state).toEqual({ request: "how is my order", result, reply: "Yes: x.", candidate: "It is x." });
    expect(d.script("r")!.evidence.fits).toBe(1);
  });

  it("PM1.9 feedback and changes to scripts are reported to onChange", () => {
    const onChange = vi.fn();
    const d = new Dialogue({ settings: settings(), book: supportBook(), onChange });
    d.feedback("order-status", "helpful");
    expect(onChange).toHaveBeenCalledTimes(1);
    d.put({ id: "follow", intent: "follow", context: "order-status", patterns: ["and then"], reply: ["Then."] });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("DG2.9 an observation that only joins a cluster is reported; utterance and result steps with the same words cluster apart", async () => {
    const onChange = vi.fn();
    const d = new Dialogue({ settings: settings(), onChange });
    await answered(d, resultStep({ tool: "t", input: {}, output: {} }), "Checked.");
    expect(onChange).toHaveBeenCalledTimes(1);
    await answered(d, step("how is my order"), "Fine.");
    expect(d.save()).toMatchObject({ clusters: [{ tool: "t", observations: [{ reply: "Checked." }] }, { observations: [{ reply: "Fine." }] }] });
  });

  it("DG2.10 an utterance joins the most alike of the clusters at the threshold", async () => {
    const d = new Dialogue({ settings: settings({ induce: { cluster: 0.6, support: 3, keep: 3 } }) });
    await answered(d, step("a b c d e"), "One.");
    await answered(d, step("a b x y z"), "Two.");
    await answered(d, step("a b c d z"), "Three.");
    expect(d.save()).toMatchObject({ clusters: [{ observations: [{ reply: "One." }, { reply: "Three." }] }, { observations: [{ reply: "Two." }] }] });
  });

  it("DG2.11 a candidate's miss is added to its own cluster, and counted even when the cluster no longer aligns", async () => {
    const d = new Dialogue({ settings: settings() });
    await answered(d, step("tell me a joke"), "No.");
    await answered(d, resultStep({ tool: "t", input: { id: 1 }, output: {} }), "Order 1 done.");
    await answered(d, resultStep({ tool: "t", input: { id: 2 }, output: {} }), "Order 2 done.");
    await answered(d, resultStep({ tool: "t", input: { id: 3 }, output: {} }), "Something else entirely happened here.");
    expect(d.script("s1")).toMatchObject({ reply: ["Order ", { input: ["id"] }, " done."], evidence: { fits: 2, misses: 1 } });
    expect(d.scripts).toHaveLength(1);
    expect(d.save()).toMatchObject({ clusters: [{ observations: [{ reply: "No." }] }, { script: "s1", observations: [{}, {}, { reply: "Something else entirely happened here." }] }] });
  });

  it("DG2.12 observed replies are kept without the whitespace around them", async () => {
    const d = new Dialogue({ settings: settings() });
    await answered(d, step("hi"), "  Hello there.\n");
    expect(d.save()).toMatchObject({ clusters: [{ observations: [{ reply: "Hello there." }] }] });
  });

  it("DG2.13 built scripts' ids skip ids an authored script has", async () => {
    const d = new Dialogue({ settings: settings(), book: book({ id: "s1", intent: "x", patterns: ["x"], reply: ["X."] }) });
    for (const id of [1, 2]) await answered(d, resultStep({ tool: "t", input: { id }, output: {} }), `Order ${id} done.`);
    expect(d.scripts.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("DG2.14 the drafter is not asked for result clusters, and a cluster is marked drafted only when it was", async () => {
    const drafter = textModel(() => "{}");
    const d = new Dialogue({ settings: settings(), drafter });
    await answered(d, resultStep({ tool: "t", input: {}, output: {} }), "Alpha beta.");
    await answered(d, resultStep({ tool: "t", input: {}, output: {} }), "Gamma delta epsilon zeta.");
    expect(drafter.calls).toHaveLength(0);
    const undrafted = new Dialogue({ settings: settings() });
    await answered(undrafted, step("say"), "Alpha beta.");
    await answered(undrafted, step("say"), "Gamma delta epsilon zeta.");
    expect(undrafted.save()).toMatchObject({ clusters: [{ drafted: false }] });
  });
});

describe("without models, and with failing ones", () => {
  it("DG1.20 a dialogue with no models matches by pattern, clusters by shape and never fails", async () => {
    const onError = vi.fn();
    const d = new Dialogue({ settings: settings({ induce: { cluster: 0.7 } }), book: book({ id: "hours", intent: "hours", status: "candidate", exemplars: ["when do you open"], patterns: ["hours"], slots: { day: { prompts: ["Which day?"] } }, reply: ["Open ", { slot: "day" }, "."] }), onError });
    await answered(d, step("where is order 12"), "Order 12.");
    await answered(d, step("where is order 34"), "Order 34.");
    await answered(d, step("when do you open"), "At nine.");
    await answered(d, step("hours"), "Open daily.");
    expect(onError).not.toHaveBeenCalled();
    expect(d.script("s1")).toMatchObject({ status: "candidate" });
  });

  it("DG2.15 the first utterance of a context is not embedded: there is nothing to compare it with", async () => {
    const embedder = vectorEmbedder({});
    await answered(new Dialogue({ settings: settings(), embedder }), step("hello"), "Hi.");
    expect(embedder.calls).toEqual([]);
  });

  it("DG2.16 when the embedder fails, utterances cluster by shape, and the failure is reported", async () => {
    const errors: unknown[] = [];
    const broken = { ...vectorEmbedder({}), doEmbed: async () => Promise.reject(new Error("embedder down")) };
    const d = new Dialogue({ settings: settings({ induce: { cluster: 0.7 } }), embedder: broken, onError: (e) => void errors.push(e) });
    await answered(d, step("where is order 12"), "Order 12.");
    await answered(d, step("where is order 34"), "Order 34.");
    expect(d.script("s1")).toMatchObject({ reply: ["Order ", { slot: "slot_1" }, "."] });
    expect(errors.map((e) => (e as Error).message)).toEqual(["embedder down"]);
  });
});

describe("sessions", () => {
  it("DG3.4 a session seen again is the most recent, so the least recent other is forgotten", async () => {
    const d = new Dialogue({ settings: settings({ sessions: 2 }), book: supportBook() });
    await d.respond(step("where is order 5", "a"));
    await d.respond(step("hello", "b"));
    await d.respond(step("hello", "a"));
    await d.respond(step("where is order 6", "a"));
    await d.respond(step("hello", "c"));
    expect(await d.respond(step("yes", "a"))).toMatchObject({ kind: "generate" });
  });
});
