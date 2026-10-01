import { describe, expect, it, vi } from "vitest";
import { Dialogue, matchPattern } from "@harness/dialogue";
import type { Decision, Outcome, ScriptInput, Step } from "@harness/dialogue";
import { routerModel, settings, textModel, vectorEmbedder } from "./helpers.ts";

const step = (utterance: string, sessionId = "s-1"): Step => ({ sessionId, utterance });
const resultStep = (id: number, sessionId = "s-1", output: { readonly [key: string]: string } = {}): Step => ({ sessionId, utterance: "how is it", result: { tool: "track", input: { id }, output } });
const book = (...scripts: ScriptInput[]) => ({ scripts });
const ACTED = { acted: true } as const;

async function answered(d: Dialogue, s: Step, outcome: Outcome): Promise<Decision> {
  const decision = await d.respond(s);
  d.observe(s, decision, outcome);
  await d.idle();
  return decision;
}

/** Steps like "where is my order number <n>" answered alike in `sessions`, one each. */
async function teach(d: Dialogue, sessions: readonly string[], first = 1) {
  for (const [i, session] of sessions.entries()) await answered(d, step(`where is my order number ${first + i}`, session), `Checking order ${first + i}.`);
}

describe("a script is trusted only on independent evidence", () => {
  it("HR1.1 a candidate whose step the model acted on (called tools) instead of replying gets a miss", async () => {
    const d = new Dialogue({ settings: settings(), book: book({ id: "yes", intent: "yes", status: "candidate", patterns: ["yes"], reply: ["Okay, done."] }) });
    await answered(d, step("yes"), ACTED);
    expect(d.script("yes")!.evidence).toMatchObject({ fits: 0, misses: 1 });
  });

  it("HR1.2 steps the model acted on are never scripted, even once the acting step is no longer kept", async () => {
    const d = new Dialogue({ settings: settings({ induce: { keep: 2 } }) });
    await answered(d, resultStep(1, "a"), ACTED);
    for (const [i, s] of ["b", "c", "d"].entries()) await answered(d, resultStep(i + 2, s), `Order ${i + 2} found.`);
    await answered(d, step("cancel it", "a"), ACTED);
    for (const s of ["b", "c", "d"]) await answered(d, step("cancel it", s), "Cancelled.");
    expect(d.scripts).toEqual([]);
    expect(d.save()).toMatchObject({ clusters: [{ acted: true }, { acted: true }] });
  });

  it("HR2.1 a built script starts with no evidence: what it was built from is not a fit", async () => {
    const d = new Dialogue({ settings: settings() });
    await teach(d, ["a", "b"]);
    expect(d.script("s1")).toMatchObject({ status: "candidate", evidence: { fits: 0, misses: 0, served: 0, sessions: [] } });
  });

  it("HR2.2 a candidate is promoted by fits from enough other sessions, not from the sessions that built it", async () => {
    const d = new Dialogue({ settings: settings({ promote: { fits: 2, sessions: 2 } }) });
    await teach(d, ["a", "b"]);
    await teach(d, ["a", "b", "a"], 10);
    expect(d.script("s1")).toMatchObject({ status: "candidate", evidence: { fits: 0, sessions: [] } });
    await teach(d, ["c"], 20);
    expect(d.script("s1")).toMatchObject({ status: "candidate", evidence: { fits: 1, sessions: ["c"] } });
    await teach(d, ["c"], 21);
    expect(d.script("s1")!.status).toBe("candidate");
    await answered(d, { utterance: "where is my order number 22" }, "Checking order 22.");
    expect(d.script("s1")).toMatchObject({ status: "candidate", evidence: { fits: 3, sessions: ["c"] } });
    await teach(d, ["d"], 23);
    expect(d.script("s1")).toMatchObject({ status: "active", evidence: { sessions: ["c", "d"] } });
  });

  it("HR2.3 a candidate induced again is a new template: its evidence starts again", async () => {
    const d = new Dialogue({ settings: settings({ promote: { fits: 9 } }) });
    for (const [n, s] of [[1, "a"], [2, "b"], [3, "c"]] as const) await answered(d, resultStep(n, s), `Order ${n} is here. Thanks!`);
    await answered(d, resultStep(4, "d"), "Order 4 is here. Sorry!");
    expect(d.script("s1")).toMatchObject({ reply: ["Order ", { input: ["id"] }, " is here. ", { generate: "hole_2" }, "!"], evidence: { fits: 0, misses: 0, sessions: [] } });
  });

  it("HR3.1 one session repeating itself builds nothing: a reply is scripted only when other sessions got it too", async () => {
    const d = new Dialogue({ settings: settings() });
    for (let i = 0; i < 3; i++) await answered(d, step("what is my account number", "alice"), "Your account number is 4417-2290.");
    expect(d.scripts).toEqual([]);
    await answered(d, step("what is my account number", "bob"), "Your account number is 8810-1234.");
    expect(d.script("s1")!.reply).toEqual(["Your account number is ", { generate: "hole_1" }, "."]);
  });

  it("HR3.2 exemplars kept from what people said mask numbers, emails and links", async () => {
    const receipt = [1, 0];
    const link = [0, 1];
    const embedder = vectorEmbedder({ "send receipt 12345 to ann@example.com": receipt, "send receipt 777 to bo@example.org": receipt, "read https://x.example/a/b/c": link, "read http://other.org": link });
    const d = new Dialogue({ settings: settings(), embedder });
    await answered(d, step("send receipt 12345 to ann@example.com", "a"), "Sent it.");
    await answered(d, step("send receipt 777 to bo@example.org", "b"), "Sent it.");
    await answered(d, step("read https://x.example/a/b/c", "a"), "Opened.");
    await answered(d, step("read http://other.org", "b"), "Opened.");
    expect(d.scripts.map((s) => s.exemplars)).toEqual([["send receipt {number} to {email}"], ["read {link}"]]);
  });
});

describe("active scripts stay accountable", () => {
  const hours = (origin: "induced" | "authored") => book({ id: "hours", intent: "hours", origin, patterns: ["hours"], reply: ["We open at 9."] });

  it("HR4.1 an active built script is audited every so often: the model answers in shadow, and its misses retire the script", async () => {
    const d = new Dialogue({ settings: settings({ promote: { audit: 2, retireMargin: 1 } }), book: hours("induced") });
    expect(await answered(d, step("hours"), undefined)).toMatchObject({ kind: "reply" });
    expect(await answered(d, step("hours"), "We open at 10 now.")).toEqual({ kind: "pass", reason: "auditing hours", shadow: { script: "hours", slots: {}, match: { by: "pattern" } }, context: "hours" });
    expect(d.script("hours")).toMatchObject({ status: "retired", evidence: { misses: 1, served: 1 } });
    const authored = new Dialogue({ settings: settings({ promote: { audit: 1 } }), book: hours("authored") });
    expect(await authored.respond(step("hours"))).toMatchObject({ kind: "reply" });
  });

  it("HR4.2 a retired script's shape is not built again", async () => {
    const d = new Dialogue({ settings: settings({ promote: { retireMargin: 1 } }) });
    await teach(d, ["a", "b"]);
    d.feedback("s1", "harmful");
    expect(d.script("s1")!.status).toBe("retired");
    await teach(d, ["c", "d", "e"], 5);
    expect(d.scripts.map((s) => s.id)).toEqual(["s1"]);
  });

  it("HR4.3 feedback from a session counts that session", () => {
    const d = new Dialogue({ settings: settings({ promote: { fits: 1, sessions: 1 } }), book: book({ id: "x", intent: "x", status: "candidate", origin: "induced", patterns: ["x"], reply: ["X."] }) });
    d.feedback("x", "helpful");
    expect(d.script("x")!.status).toBe("candidate");
    d.feedback("x", "helpful", "s-9");
    expect(d.script("x")).toMatchObject({ status: "active", evidence: { sessions: ["s-9"] } });
  });
});

describe("matching is careful", () => {
  it("HR5.1 a form's answer that another script matches goes to that script before it can become the slot's value", async () => {
    const d = new Dialogue({
      settings: settings(),
      book: book(
        { id: "table", intent: "t", patterns: ["book a table"], slots: { time: { prompts: ["For what time?"] } }, reply: ["Booked for ", { slot: "time" }, "."] },
        { id: "cancel", intent: "c", patterns: ["cancel"], reply: ["Nothing booked."] },
      ),
    });
    await d.respond(step("book a table"));
    expect(await d.respond(step("cancel"))).toMatchObject({ kind: "reply", script: "cancel" });
  });

  it("HR6.1 an induced slot whose values were digits matches only digits", async () => {
    const d = new Dialogue({ settings: settings() });
    await teach(d, ["a", "b"]);
    expect(d.script("s1")!.patterns).toEqual(["where\\s+is\\s+my\\s+order\\s+number\\s+(?<slot_1>\\d+)"]);
    expect(matchPattern(d.script("s1")!.patterns[0]!, "where is my order number 1234 and refund me $500")).toBeUndefined();
  });

  it("HR7.1 utterances longer than the limit are not matched by patterns, and long hostile ones finish quickly", async () => {
    const d = new Dialogue({ settings: settings({ match: { maxLength: 40 } }), book: book({ id: "x", intent: "x", patterns: ["(?<a>.+?)x(?<b>.+?)y(?<c>.+?)z"], slots: { a: {}, b: {}, c: {} }, reply: ["X."] }) });
    const hostile = "x".repeat(4000) + "q";
    const started = performance.now();
    expect(await d.respond(step(hostile))).toMatchObject({ kind: "pass" });
    expect(performance.now() - started).toBeLessThan(200);
    expect(await d.respond(step("1x2y3z"))).toMatchObject({ kind: "reply" });
  });

  it("HR7.2 an induced group spans a few words at most", async () => {
    const d = new Dialogue({ settings: settings() });
    await answered(d, step("please call me Ann now", "a"), "Hi Ann.");
    await answered(d, step("please call me Bo now", "b"), "Hi Bo.");
    const [pattern] = d.script("s1")!.patterns;
    expect(matchPattern(pattern!, "please call me Ann Lee now")).toEqual({ slot_1: "Ann Lee" });
    expect(matchPattern(pattern!, `please call me ${"w ".repeat(20)}now`)).toBeUndefined();
  });

  it("HR11.1 the router is offered active scripts only: candidates wait for patterns and exemplars", async () => {
    const router = routerModel(() => undefined);
    const d = new Dialogue({ settings: settings(), book: book({ id: "live", intent: "l", reply: ["L."] }, { id: "maybe", intent: "m", status: "candidate", reply: ["M."] }), router });
    await d.respond(step("hello"));
    expect(router.offered).toEqual([["live"]]);
  });

  it("HR13.1 a result script answers only in its context, when it has one", async () => {
    const d = new Dialogue({ settings: settings(), book: book({ id: "start", intent: "s", patterns: ["start"], reply: ["Go."] }, { id: "after", intent: "a", context: "start", result: { tool: "track" }, reply: ["Found."] }) });
    expect(await d.respond(resultStep(1))).toMatchObject({ kind: "pass" });
    await d.respond(step("start"));
    expect(await d.respond(resultStep(1))).toMatchObject({ kind: "reply", script: "after" });
  });

  it("HR13.2 among exemplars alike enough, a script in context comes first", async () => {
    const embedder = vectorEmbedder({ close: [1, 0], "in context": [0.9, 0.44], "the question": [1, 0], go: [0, 1] });
    const d = new Dialogue({
      settings: settings({ match: { similar: 0.8 } }),
      book: book({ id: "go", intent: "g", patterns: ["go"], reply: ["Going."] }, { id: "free", intent: "f", exemplars: ["close"], reply: ["Free."] }, { id: "ctx", intent: "c", context: "go", exemplars: ["in context"], reply: ["Ctx."] }),
      embedder,
    });
    await d.respond(step("go"));
    expect(await d.respond(step("the question"))).toMatchObject({ script: "ctx" });
  });

  it("HR13.3 a turn the dialogue did not see ends the form and the context", async () => {
    const d = new Dialogue({ settings: settings(), book: book({ id: "table", intent: "t", patterns: ["book a table"], slots: { time: { prompts: ["For what time?"] } }, reply: ["Booked for ", { slot: "time" }, "."] }) });
    await d.respond(step("book a table"));
    d.skip("s-1");
    expect(await d.respond(step("7pm"))).toEqual({ kind: "pass", reason: "no script matches" });
  });

  it("HR13.4 patterns match across lines", async () => {
    const d = new Dialogue({ settings: settings(), book: book({ id: "x", intent: "x", patterns: ["hello.+world"], reply: ["X."] }) });
    expect(await d.respond(step("hello\nworld"))).toMatchObject({ kind: "reply" });
  });
});

describe("what is kept is bounded", () => {
  it("HR9.1 clusters without a script are capped: the one least recently added to goes", async () => {
    const d = new Dialogue({ settings: settings({ induce: { clusters: 2, sessions: 3 } }) });
    for (const [u, s] of [["alpha one", "a"], ["bravo two", "a"], ["alpha one", "b"], ["charlie three", "a"]] as const) await answered(d, step(u, s), `Reply to ${u}.`);
    expect(d.save()).toMatchObject({ clusters: [{ observations: [{ utterance: "alpha one" }, { utterance: "alpha one" }] }, { observations: [{ utterance: "charlie three" }] }] });
  });

  it("HR9.2 a result step is kept with its short values only", async () => {
    const d = new Dialogue({ settings: settings() });
    await answered(d, resultStep(1, "a", { status: "late", body: "x".repeat(500) }), "Order 1 is late.");
    expect(d.save()).toMatchObject({ clusters: [{ observations: [{ result: { input: { id: 1 }, output: { status: "late", body: null } } }] }] });
  });
});

describe("drafts are held to the same bar", () => {
  const drafter = (reply: unknown[]) => textModel(() => JSON.stringify({ intent: "i", exemplars: ["e"], slots: [], reply, followUps: [] }));
  async function unalignable(d: Dialogue) {
    await answered(d, step("when do you open", "a"), "We're open from nine in the morning.");
    await answered(d, step("when do you open", "b"), "Doors open at 9am, see you then!");
  }

  it("HR12.1 a draft that is mostly holes is not kept", async () => {
    const d = new Dialogue({ settings: settings(), drafter: drafter([{ generate: "all" }]), embedder: vectorEmbedder({}) });
    await unalignable(d);
    expect(d.scripts).toEqual([]);
  });

  it("HR12.2 nothing is drafted when nothing could match a draft (no embedder and no router)", async () => {
    const model = drafter([{ text: "We're open from " }, { generate: "time" }, { text: "." }]);
    await unalignable(new Dialogue({ settings: settings(), drafter: model }));
    expect(model.calls).toHaveLength(0);
  });

  it("HR12.3 a drafted slot pattern that could take exponential time is refused, and the refusal reported", async () => {
    const onError = vi.fn();
    const d = new Dialogue({
      settings: settings(),
      embedder: vectorEmbedder({}),
      drafter: textModel(() => JSON.stringify({ intent: "i", exemplars: ["e"], slots: [{ name: "t", description: "t", pattern: "(a+)+b" }], reply: [{ text: "We're open from " }, { slot: "t" }, { text: "." }], followUps: [] })),
      onError,
    });
    await unalignable(d);
    expect(d.scripts).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/drafted slot t has a pattern that can take exponential time: \(a\+\)\+b/) }));
  });
});

describe("templates are shown to the model", () => {
  it("HR14.1 a script's generated holes come with an instruction from the settings showing its template, holes written as blanks", async () => {
    const d = new Dialogue({ settings: settings({ generate: { instruction: "Fill it in." } }), book: book({ id: "t", intent: "t", patterns: ["go"], reply: ["A ", { generate: "x" }, " and ", { generate: "y" }, "."] }) });
    expect(await d.respond(step("go"))).toMatchObject({ kind: "generate", instruction: "Fill it in.\n\nA ____ and ____." });
  });
});
