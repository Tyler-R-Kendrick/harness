import { describe, expect, it, vi } from "vitest";
import { Experimental_EvaluationMockModelV4, MockEmbeddingModelV4 } from "ai/test";
import { Dialogue } from "@harness/dialogue";
import type { Decision, ScriptInput, Step, ToolResult } from "@harness/dialogue";
import { hashEmbeddingModel } from "@harness/testkit";
import { failingModel, routerModel, settings, supportBook } from "./helpers.ts";

const S = "session-1";
const step = (utterance: string, sessionId: string | undefined = S): Step => ({ ...(sessionId === undefined ? {} : { sessionId }), utterance });
const resultStep = (result: ToolResult): Step => ({ sessionId: S, utterance: "how is my order", result });
const book = (...scripts: ScriptInput[]) => ({ scripts });
const embedder = () => hashEmbeddingModel(256);

/** Respond to a step, then have the model's reply observed, as the middleware does, and wait for what it teaches. */
async function answered(d: Dialogue, s: Step, reply: string | undefined): Promise<Decision> {
  const decision = await d.respond(s);
  d.observe(s, decision, reply);
  await d.idle();
  return decision;
}

describe("matching", () => {
  it("DG1.1 a pattern match answers with the script's reply, filled from the slots it captured, and counts it served", async () => {
    const d = new Dialogue({ settings: settings(), book: supportBook() });
    expect(await d.respond(step("Where's my order 1234?"))).toEqual({ kind: "reply", script: "order-status", text: "Let me look up order 1234.", match: { by: "pattern" } });
    expect(d.script("order-status")!.evidence.served).toBe(1);
  });

  it("DG1.2 a step no script matches goes to the model", async () => {
    const d = new Dialogue({ settings: settings(), book: supportBook() });
    expect(await d.respond(step("tell me a joke"))).toEqual({ kind: "pass", reason: "no script matches" });
  });

  it("DG1.3 an exemplar alike in meaning matches at or above the threshold, and a slot's value pattern finds its value", async () => {
    const d = new Dialogue({ settings: settings(), book: supportBook(), embedder: embedder() });
    expect(await d.respond(step("has my order 55 shipped yet"))).toEqual({
      kind: "reply",
      script: "order-status",
      text: "Let me look up order 55.",
      match: { by: "exemplar", similarity: expect.closeTo(0.913, 2) },
    });
    expect(await d.respond(step("track my order please"))).toMatchObject({ kind: "pass" });
  });

  it("DG1.4 the router picks a script (offered as a tool named by its id) with its slots as arguments, at or above its threshold", async () => {
    const router = routerModel((input) =>
      input.includes("money back") ? { tool: "refund", args: { order_id: "77" }, confidence: 0.95 } : input.includes("maybe") ? { tool: "hours", confidence: 0.5 } : undefined,
    );
    const d = new Dialogue({
      settings: settings(),
      book: book({ id: "refund", intent: "The customer wants a refund", slots: { order_id: {} }, reply: ["Refund for order ", { slot: "order_id" }, " started."] }, { id: "hours", intent: "Opening hours", reply: ["We open at 9."] }),
      router,
    });
    expect(await d.respond(step("I want my money back for 77"))).toEqual({ kind: "reply", script: "refund", text: "Refund for order 77 started.", match: { by: "router", confidence: 0.95 } });
    expect(router.offered[0]).toEqual(["refund", "hours"]);
    expect(await d.respond(step("maybe hours?"))).toEqual({ kind: "pass", reason: "no script matches", context: "refund" });
  });

  it("DG1.5 a script with a context matches only right after its context script, in the same session; a script with generated holes asks the model for them", async () => {
    const d = new Dialogue({ settings: settings(), book: supportBook() });
    expect(await d.respond(step("yes please"))).toMatchObject({ kind: "pass" });
    await d.respond(step("where is order 5"));
    expect(await d.respond(step("yes, please", "session-2"))).toMatchObject({ kind: "pass" });
    expect(await d.respond(step("yes please"))).toEqual({
      kind: "generate",
      script: "confirm-cancel",
      template: { type: "template", parts: ["Done: ", { hole: "summary", constraint: { type: "regex", pattern: "[^\\n]{1,80}" } }, "."] },
      instruction: `${settings().generate.instruction}\n\nDone: {summary}.`,
      match: { by: "pattern" },
    });
    await d.respond(step("where is order 5"));
    await d.respond(step("tell me a joke"));
    expect(await d.respond(step("yes"))).toEqual({ kind: "pass", reason: "no script matches" });
  });

  it("DG1.6 a result step is answered from the tool's input and output; one missing a value goes to the model", async () => {
    const d = new Dialogue({ settings: settings(), book: supportBook() });
    const result = { tool: "track_order", input: { id: 1234 }, output: { status: "shipped", eta: { day: "Tuesday" } } };
    expect(await d.respond(resultStep(result))).toEqual({ kind: "reply", script: "tracking", text: "Order 1234 is shipped and arrives Tuesday.", match: { by: "result" } });
    expect(await d.respond(resultStep({ ...result, output: { status: "shipped" } }))).toEqual({ kind: "pass", reason: "no script answers this track_order result", context: "tracking" });
    expect(await d.respond(resultStep({ ...result, tool: "refund" }))).toEqual({ kind: "pass", reason: "no script answers this refund result" });
  });

  it("DG1.7 an active script answers before a candidate; a retired one never does", async () => {
    const d = new Dialogue({
      settings: settings(),
      book: book(
        { id: "a", intent: "hi", status: "candidate", patterns: ["hi"], reply: ["A."] },
        { id: "b", intent: "hi", patterns: ["hi"], reply: ["B."] },
        { id: "c", intent: "bye", status: "retired", patterns: ["bye"], reply: ["C."] },
      ),
    });
    expect(await d.respond(step("hi"))).toMatchObject({ kind: "reply", script: "b" });
    expect(await d.respond(step("bye"))).toEqual({ kind: "pass", reason: "no script matches", context: "b" });
  });

  it("DG1.8 a failing embedder or router is passed over", async () => {
    const broken = new MockEmbeddingModelV4({
      doEmbed: async () => {
        throw new Error("embedder down");
      },
    });
    const router = routerModel(() => ({ tool: "order-status", args: { order_id: "8" }, confidence: 0.99 }));
    const errors: unknown[] = [];
    const onError = (e: unknown) => void errors.push(e);
    expect(await new Dialogue({ settings: settings(), book: supportBook(), embedder: broken, router, onError }).respond(step("has my order shipped yet"))).toMatchObject({ kind: "reply", match: { by: "router" } });
    expect(await new Dialogue({ settings: settings(), book: supportBook(), embedder: broken, router: failingModel(), onError }).respond(step("has my order shipped yet"))).toEqual({
      kind: "pass",
      reason: "no script matches",
    });
    expect(errors.map((e) => (e as Error).message)).toEqual(["embedder down", "embedder down", "model unavailable"]);
  });

  it("DG1.9 a router call that is not one valid pick of an offered script is no match", async () => {
    const pickUnknown = routerModel(() => ({ tool: "nope", confidence: 0.99 }));
    const pickNothing = routerModel(() => undefined);
    for (const router of [pickUnknown, pickNothing]) expect(await new Dialogue({ settings: settings(), book: supportBook(), router }).respond(step("hello"))).toMatchObject({ kind: "pass" });
  });
});

describe("forms (VoiceXML's form interpretation)", () => {
  const withHours = () => {
    const b = supportBook() as { scripts: ScriptInput[] };
    return { scripts: [...b.scripts, { id: "hours", intent: "Opening hours", patterns: ["when are you open"], reply: ["We open at 9."] }] };
  };

  it("FM1.1 a matched script lacking a slot asks for it, and the answer's value completes the reply", async () => {
    const d = new Dialogue({ settings: settings(), book: supportBook(), embedder: embedder() });
    expect(await d.respond(step("has my order shipped yet"))).toEqual({
      kind: "ask",
      script: "order-status",
      slot: "order_id",
      text: "What is your order number?",
      match: { by: "exemplar", similarity: expect.closeTo(1, 5) },
    });
    expect(await d.respond(step("it's 4321"))).toEqual({ kind: "reply", script: "order-status", text: "Let me look up order 4321.", match: { by: "form" } });
  });

  it("FM1.2 no value in the answer gets the next prompt; after the last one the step goes to the model and the form is dropped", async () => {
    const d = new Dialogue({ settings: settings(), book: supportBook(), embedder: embedder() });
    await d.respond(step("has my order shipped yet"));
    expect(await d.respond(step("I don't know"))).toMatchObject({ kind: "ask", slot: "order_id", text: "Sorry, I need the order number: the digits on your receipt.", match: { by: "form" } });
    expect(await d.respond(step("no idea"))).toEqual({ kind: "pass", reason: "no order_id after 2 prompts", context: "order-status" });
    expect(await d.respond(step("5555"))).toEqual({ kind: "pass", reason: "no script matches" });
  });

  it("FM1.3 an answer another script matches is taken up by that script, and the form is dropped", async () => {
    const d = new Dialogue({ settings: settings(), book: withHours(), embedder: embedder() });
    await d.respond(step("has my order shipped yet"));
    expect(await d.respond(step("when are you open?"))).toMatchObject({ kind: "reply", script: "hours" });
    expect(await d.respond(step("1234"))).toMatchObject({ kind: "pass" });
  });

  it("FM1.4 a slot with no prompts is never asked for, and nothing is asked outside a session", async () => {
    const d = new Dialogue({ settings: settings(), book: book({ id: "greet", intent: "greeting", patterns: ["call me (?<name>\\w+)|hello"], slots: { name: {} }, reply: ["Hi ", { slot: "name" }, "."] }) });
    expect(await d.respond(step("hello"))).toEqual({ kind: "pass", reason: "no value for slot name" });
    const e = new Dialogue({ settings: settings(), book: supportBook(), embedder: embedder() });
    expect(await e.respond({ utterance: "has my order shipped yet" })).toEqual({ kind: "pass", reason: "no value for slot order_id" });
  });

  it("FM1.5 a slot with no value pattern takes the router's value for it, or else the whole answer", async () => {
    const table = book({ id: "book-table", intent: "Book a table", patterns: ["book a table"], slots: { time: { prompts: ["For what time?"] } }, reply: ["Booked for ", { slot: "time" }, "."] });
    const plain = new Dialogue({ settings: settings(), book: table });
    expect(await plain.respond(step("book a table"))).toMatchObject({ kind: "ask", text: "For what time?" });
    expect(await plain.respond(step("7pm."))).toMatchObject({ kind: "reply", text: "Booked for 7pm." });
    const router = routerModel((input) => ({ tool: "book-table", args: input.includes("seven") ? { time: "19:00" } : {}, confidence: 0.95 }));
    const routed = new Dialogue({ settings: settings(), book: table, router });
    await routed.respond(step("book a table"));
    expect(await routed.respond(step("seven in the evening"))).toMatchObject({ kind: "reply", text: "Booked for 19:00." });
    expect(router.offered).toEqual([["book-table"], ["book-table"]]);
  });

  it("FM1.6 a form whose script was retired meanwhile is dropped", async () => {
    const d = new Dialogue({ settings: settings({ promote: { retireMargin: 1 } }), book: supportBook(), embedder: embedder() });
    await d.respond(step("has my order shipped yet"));
    d.feedback("order-status", "harmful");
    expect(await d.respond(step("4321"))).toEqual({ kind: "pass", reason: "no script matches", context: "order-status" });
  });
});

describe("candidates: shadowing, promotion and retirement", () => {
  const hours = (status: "candidate" | "active" = "candidate", fits = 0) => book({ id: "hours", intent: "Opening hours", status, patterns: ["when are you open"], reply: ["We open at 9."], evidence: { fits, misses: 0, served: 0 } });

  it("PM1.1 a matching candidate never answers: the model does, and each reply that fits counts for it until it is active", async () => {
    const d = new Dialogue({ settings: settings({ promote: { fits: 2 } }), book: hours() });
    expect(await answered(d, step("when are you open?"), "We open at 9.")).toEqual({
      kind: "pass",
      reason: "hours is a candidate",
      shadow: { script: "hours", slots: {}, match: { by: "pattern" } },
    });
    expect(d.script("hours")).toMatchObject({ status: "candidate", evidence: { fits: 1, sessions: [S] } });
    await answered(d, step("when are you open", "session-2"), " We open at 9.\n");
    expect(d.script("hours")).toMatchObject({ status: "active", evidence: { fits: 2, sessions: [S, "session-2"] } });
    expect(await d.respond(step("when are you open"))).toMatchObject({ kind: "reply", text: "We open at 9." });
  });

  it("PM1.2 replies that do not fit count against a candidate, and it is retired at the margin", async () => {
    const d = new Dialogue({ settings: settings(), book: hours() });
    await answered(d, step("when are you open"), "We open at 10.");
    expect(d.script("hours")).toMatchObject({ status: "candidate", evidence: { misses: 1 } });
    await answered(d, step("when are you open"), "We open at 10.");
    expect(d.script("hours")!.status).toBe("retired");
    expect(await d.respond(step("when are you open"))).toEqual({ kind: "pass", reason: "no script matches", context: "hours" });
  });

  it("PM1.3 with a judge, a reply that does not fit still counts for the candidate when the judge finds its reply as good", async () => {
    const judge = await import("@harness/testkit").then((t) => t.scriptedJudge((_, __, state) => ({ type: "boolean", probability: (state as { reply: string }).reply.includes("doors") ? 0.9 : 0.5 })));
    const d = new Dialogue({ settings: settings(), book: hours(), judge });
    await answered(d, step("when are you open"), "Our doors open at 9 am.");
    expect(d.script("hours")!.evidence).toMatchObject({ fits: 1, misses: 0 });
    expect(judge.requests[0]).toMatchObject({
      state: { request: "when are you open", reply: "Our doors open at 9 am.", candidate: "We open at 9." },
      questions: { equivalent: { type: "boolean", instructions: settings().promote.question } },
    });
    await answered(d, step("when are you open"), "At 9.");
    expect(d.script("hours")!.evidence).toMatchObject({ fits: 1, misses: 1 });
  });

  it("PM1.4 the judge is not asked about a script the model would have to finish, and a failing judge counts as no", async () => {
    const judge = await import("@harness/testkit").then((t) => t.scriptedJudge(() => ({ type: "boolean", probability: 1 })));
    const d = new Dialogue({ settings: settings(), book: book({ id: "g", intent: "x", status: "candidate", patterns: ["x"], reply: ["It is ", { generate: "what" }, "."] }), judge });
    await answered(d, step("x"), "Nothing to say");
    expect(judge.requests).toHaveLength(0);
    expect(d.script("g")!.evidence.misses).toBe(1);
    const errors: unknown[] = [];
    const broken = new Dialogue({ settings: settings(), book: hours(), judge: failingJudge(), onError: (e) => void errors.push(e) });
    await answered(broken, step("when are you open"), "Our doors open at 9 am.");
    expect(broken.script("hours")!.evidence.misses).toBe(1);
    expect(errors.map((e) => (e as Error).message)).toEqual(["judge unavailable"]);
  });

  it("PM1.5 feedback counts like shadowing: helpful promotes a candidate, harmful retires an active script", () => {
    const d = new Dialogue({ settings: settings({ promote: { fits: 2, sessions: 1 } }), book: hours("candidate", 1) });
    d.feedback("hours", "helpful", S);
    expect(d.script("hours")!.status).toBe("active");
    d.feedback("hours", "harmful");
    d.feedback("hours", "harmful");
    expect(d.script("hours")!.status).toBe("active");
    d.feedback("hours", "harmful");
    d.feedback("hours", "harmful");
    expect(d.script("hours")!.status).toBe("retired");
    expect(() => d.feedback("nope", "helpful")).toThrow(/no script nope/);
  });

  it("PM1.6 a shadowed script that was retired meanwhile is not checked", async () => {
    const d = new Dialogue({ settings: settings(), book: hours("candidate", 1) });
    const s = step("when are you open");
    const decision = await d.respond(s);
    for (let i = 0; i < 3; i++) d.feedback("hours", "harmful");
    expect(d.script("hours")!.status).toBe("retired");
    d.observe(s, decision, "We open at 9.");
    await d.idle();
    expect(d.script("hours")!.evidence.fits).toBe(1);
  });
});

function failingJudge() {
  return new Experimental_EvaluationMockModelV4({
    doEvaluate: async () => {
      throw new Error("judge unavailable");
    },
  });
}

describe("building scripts from what the model answered", () => {
  /** A result step answered in a session of its own (scripts are built from several sessions). */
  const tracked = (id: number, status: string, reply: string): [Step, string] => [{ ...resultStep({ tool: "track_order", input: { id }, output: { status } }), sessionId: `u${id}` }, reply];

  it("DG2.1 steps the model answered after one tool's results become a candidate at the support, and it is active after enough fits from other sessions", async () => {
    const d = new Dialogue({ settings: settings(), onChange: vi.fn() });
    await answered(d, ...tracked(1, "shipped", "Order 1 is shipped."));
    expect(d.scripts).toHaveLength(0);
    await answered(d, ...tracked(2, "late", "Order 2 is late."));
    expect(d.scripts).toEqual([expect.objectContaining({ id: "s1", status: "candidate", origin: "induced", reply: ["Order ", { input: ["id"] }, " is ", { output: ["status"] }, "."], evidence: { fits: 0, misses: 0, served: 0, audits: 0, sessions: [] } })]);
    expect(await answered(d, ...tracked(3, "lost", "Order 3 is lost."))).toMatchObject({ kind: "pass", shadow: { script: "s1", match: { by: "result" } } });
    await answered(d, ...tracked(4, "late", "Order 4 is late."));
    expect(d.script("s1")!.status).toBe("candidate");
    await answered(d, ...tracked(5, "found", "Order 5 is found."));
    expect(d.script("s1")).toMatchObject({ status: "active", evidence: { fits: 3, sessions: ["u3", "u4", "u5"] } });
    expect(d.save()).toMatchObject({ clusters: [] });
    expect(await d.respond(tracked(6, "found", "")[0])).toEqual({ kind: "reply", script: "s1", text: "Order 6 is found.", match: { by: "result" } });
  });

  it("DG2.2 utterances cluster by meaning, in their context; induced scripts then shadow what they match", async () => {
    const d = new Dialogue({ settings: settings({ induce: { cluster: 0.7 } }), embedder: embedder() });
    await answered(d, step("where is order 12", "a"), "Let me check order 12.");
    await answered(d, step("tell me a joke", "a"), "Knock knock.");
    await answered(d, step("Where is order 34?", "b"), "Let me check order 34.");
    // Clusters are kept most recently added to last.
    expect(d.save()).toMatchObject({ clusters: [{ observations: [{ utterance: "tell me a joke" }] }, { script: "s1", observations: [{ utterance: "where is order 12" }, { utterance: "Where is order 34?" }] }] });
    expect(d.script("s1")).toMatchObject({ patterns: ["where\\s+is\\s+order\\s+(?<slot_1>\\d+)"], reply: ["Let me check order ", { slot: "slot_1" }, "."] });
    expect(await d.respond(step("where is order 56", "c"))).toMatchObject({ kind: "pass", shadow: { script: "s1", slots: { slot_1: "56" } } });
  });

  it("DG2.3 without an embedder, utterances cluster by shape; a cluster in another context is another cluster", async () => {
    const d = new Dialogue({ settings: settings({ induce: { cluster: 0.7 } }), book: book({ id: "hi", intent: "hi", patterns: ["hi"], reply: ["Hi."] }) });
    await answered(d, step("where is order 12", "a"), "Let me check order 12.");
    await d.respond(step("hi", "b"));
    await answered(d, step("where is order 34", "b"), "Let me check order 34.");
    expect(d.save()).toMatchObject({ clusters: [{ observations: [{ utterance: "where is order 12" }] }, { context: "hi", observations: [{ utterance: "where is order 34" }] }] });
    await answered(d, step("where is order 56", "c"), "Let me check order 56.");
    expect(d.script("s1")).toMatchObject({ status: "candidate" });
  });

  it("DG2.4 steps where the model called tools or said nothing, and steps a script answered, teach nothing", async () => {
    const d = new Dialogue({ settings: settings(), book: supportBook() });
    await answered(d, step("tell me a joke"), undefined);
    await answered(d, step("tell me a joke"), "   ");
    await answered(d, step("where is order 1"), "Let me look up order 1.");
    expect(d.save()).toMatchObject({ clusters: [] });
  });

  it("DG2.5 a cluster keeps its latest observations", async () => {
    const d = new Dialogue({ settings: settings({ induce: { keep: 2 } }) });
    for (const reply of ["Alpha one.", "Bravo two three.", "Charlie."]) await answered(d, step("say something"), reply);
    expect(d.save()).toMatchObject({ clusters: [{ observations: [{ reply: "Bravo two three." }, { reply: "Charlie." }] }] });
  });

  it("DG2.6 a script built from however many observations is a candidate: they are not evidence for it", async () => {
    const d = new Dialogue({ settings: settings({ promote: { fits: 2 }, induce: { support: 3, keep: 3 } }) });
    for (const n of [1, 2, 3]) await answered(d, ...tracked(n, "shipped", `Order ${n} is shipped.`));
    expect(d.script("s1")).toMatchObject({ status: "candidate", evidence: { fits: 0 } });
  });

  it("DG2.7 a candidate the model disagrees with is induced again from its cluster: the part that varied becomes a hole, and its evidence starts again", async () => {
    const d = new Dialogue({ settings: settings() });
    await answered(d, ...tracked(1, "shipped", "Order 1 is shipped. Thanks!"));
    await answered(d, ...tracked(2, "late", "Order 2 is late. Thanks!"));
    await answered(d, ...tracked(3, "lost", "Order 3 is lost. Sorry!"));
    expect(d.script("s1")).toMatchObject({
      status: "candidate",
      reply: ["Order ", { input: ["id"] }, " is ", { output: ["status"] }, ". ", { generate: "hole_3" }, "!"],
      evidence: { fits: 0, misses: 0 },
    });
  });

  it("DG2.17 a candidate is not induced again into the shape of a retired script", async () => {
    const retired = { id: "old", intent: "o", status: "retired" as const, origin: "induced" as const, result: { tool: "track_order" }, reply: ["Order ", { input: ["id"] }, " is ", { output: ["status"] }, ". ", { generate: "hole_3" }, "!"] };
    const d = new Dialogue({ settings: settings(), book: { scripts: [retired] } });
    await answered(d, ...tracked(1, "shipped", "Order 1 is shipped. Thanks!"));
    await answered(d, ...tracked(2, "late", "Order 2 is late. Thanks!"));
    await answered(d, ...tracked(3, "lost", "Order 3 is lost. Sorry!"));
    expect(d.script("s1")).toMatchObject({ status: "candidate", reply: ["Order ", { input: ["id"] }, " is ", { output: ["status"] }, ". Thanks!"], evidence: { misses: 1 } });
  });

  it("DG2.8 an utterance like a candidate's cluster that the candidate did not match widens it", async () => {
    const d = new Dialogue({ settings: settings({ induce: { cluster: 0.5 } }), embedder: embedder() });
    await answered(d, step("where is order 12", "a"), "Checking order 12.");
    await answered(d, step("where is order 34", "b"), "Checking order 34.");
    expect(d.script("s1")!.patterns).toEqual(["where\\s+is\\s+order\\s+(?<slot_1>\\d+)"]);
    await answered(d, step("where is my order 56", "c"), "Checking order 56.");
    expect(d.script("s1")!.patterns).toEqual(["where\\s+is\\s+(?:(?<slot_1>\\S+(?:\\s+\\S+){0,7}?)\\s+)?order\\s+(?<slot_2>\\d+)"]);
    expect(d.script("s1")!.reply).toEqual(["Checking order ", { slot: "slot_2" }, "."]);
  });
});

describe("keeping state", () => {
  it("DG3.1 what a dialogue built is saved and restored, and ids are never reused", async () => {
    const onChange = vi.fn();
    const d = new Dialogue({ settings: settings(), onChange });
    const tracked = (id: number, reply: string): [Step, string] => [{ ...resultStep({ tool: "track_order", input: { id }, output: {} }), sessionId: `u${id}` }, reply];
    await answered(d, ...tracked(1, "Order 1 found."));
    await answered(d, ...tracked(2, "Order 2 found."));
    expect(onChange).toHaveBeenCalled();
    const restored = new Dialogue({ settings: settings(), book: JSON.parse(JSON.stringify(d.save())) });
    expect(restored.save()).toEqual(d.save());
    const other = (id: number, reply: string): [Step, string] => [{ ...resultStep({ tool: "refund", input: { id }, output: {} }), sessionId: `v${id}` }, reply];
    await answered(restored, ...other(1, "Refund 1 done."));
    await answered(restored, ...other(2, "Refund 2 done."));
    expect(restored.scripts.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("DG3.2 put adds or replaces an authored script, checked like a book's", () => {
    const d = new Dialogue({ settings: settings(), book: supportBook() });
    d.put({ id: "hours", intent: "Opening hours", patterns: ["when are you open"], reply: ["We open at 9."] });
    d.put({ id: "hours", intent: "Opening hours", patterns: ["when are you open"], reply: ["We open at 8."] });
    expect(d.script("hours")!.reply).toEqual(["We open at 8."]);
    expect(() => d.put({ id: "x", intent: "x", context: "nope", reply: ["X."] })).toThrow(/context nope is not a script in the book/);
    expect(() => new Dialogue({ settings: settings(), book: { scripts: "no" } })).toThrow(/invalid script book/);
  });

  it("DG3.3 the least recently seen session's dialogue state is forgotten beyond the limit", async () => {
    const d = new Dialogue({ settings: settings({ sessions: 1 }), book: supportBook() });
    await d.respond(step("where is order 5"));
    await d.respond(step("hello", "session-2"));
    expect(await d.respond(step("yes"))).toMatchObject({ kind: "pass" });
    await d.respond(step("where is order 5"));
    await d.respond(step("where is order 6"));
    expect(await d.respond(step("yes"))).toMatchObject({ kind: "generate" });
  });
});
