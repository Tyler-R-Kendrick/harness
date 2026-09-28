import { describe, expect, it } from "vitest";
import { Dialogue, draftedScript, scriptId } from "@harness/dialogue";
import type { Draft, Step } from "@harness/dialogue";
import { promptText } from "@harness/testkit";
import { failingModel, settings, textModel, vectorEmbedder } from "./helpers.ts";

const step = (utterance: string, sessionId = "a"): Step => ({ sessionId, utterance });

async function answered(d: Dialogue, utterance: string, reply: string, sessionId = "a"): Promise<void> {
  const s = step(utterance, sessionId);
  d.observe(s, await d.respond(s), reply);
  await d.idle();
}

/** Drafts match by meaning, so drafting needs an embedder (or a router); this one finds everything alike. */
const embedder = () => vectorEmbedder({});

const hours: Draft = {
  intent: "Opening hours",
  exemplars: ["when do you open"],
  slots: [],
  reply: [{ text: "We're open from " }, { generate: "time" }, { text: " in the morning." }],
  followUps: [{ intent: "Weekend hours", exemplars: ["what about weekends"], slots: [], reply: [{ text: "On weekends we open at 10." }] }],
};
const drafter = (answer: Draft) => textModel(() => JSON.stringify(answer));

/** Two replies to one question, in two sessions, too different to align: induction fails, so the drafter is asked. */
async function unalignable(d: Dialogue): Promise<void> {
  await answered(d, "when do you open", "We're open from nine in the morning.", "a");
  await answered(d, "when do you open", "Doors open at 9am, see you then!", "b");
}

describe("drafting scripts ahead of need", () => {
  it("DF1.1 a cluster induction cannot align goes to the drafter once: its script is a candidate that reproduces a reply, and its follow-ups are candidates in its context", async () => {
    const model = drafter(hours);
    const d = new Dialogue({ settings: settings(), drafter: model, embedder: embedder() });
    await unalignable(d);
    expect(d.scripts).toEqual([
      expect.objectContaining({ id: "s1", status: "candidate", origin: "drafted", intent: "Opening hours", reply: ["We're open from ", { generate: "time" }, " in the morning."], evidence: { fits: 0, misses: 0, served: 0, audits: 0, sessions: [] } }),
      expect.objectContaining({ id: "s2", status: "candidate", origin: "drafted", context: "s1", exemplars: ["what about weekends"], reply: ["On weekends we open at 10."], evidence: { fits: 0, misses: 0, served: 0, audits: 0, sessions: [] } }),
    ]);
    await answered(d, "when do you open", "From nine.");
    expect(model.calls).toHaveLength(1);
  });

  it("DF1.2 the drafter is asked with the exchanges and the number of follow-ups wanted, for JSON in the draft's schema", async () => {
    const model = drafter(hours);
    await unalignable(new Dialogue({ settings: settings(), drafter: model, embedder: embedder() }));
    const call = model.calls[0]!;
    expect(call.responseFormat).toMatchObject({ type: "json", schema: expect.objectContaining({ type: "object" }) });
    expect(call.prompt[0]).toEqual({ role: "system", content: settings().draft.system });
    expect(JSON.parse(promptText(call.prompt))).toEqual({
      exchanges: [
        { user: "when do you open", assistant: "We're open from nine in the morning." },
        { user: "when do you open", assistant: "Doors open at 9am, see you then!" },
      ],
      followUps: 3,
    });
  });

  it("DF1.3 a draft that reproduces none of the replies is dropped, and the cluster is not drafted again", async () => {
    const model = drafter({ ...hours, reply: [{ text: "We never close." }] });
    const d = new Dialogue({ settings: settings(), drafter: model, embedder: embedder() });
    await unalignable(d);
    await answered(d, "when do you open", "At nine.");
    expect(d.scripts).toEqual([]);
    expect(model.calls).toHaveLength(1);
  });

  it("DF1.4 a failing drafter builds nothing, and its failure is reported", async () => {
    const errors: unknown[] = [];
    const d = new Dialogue({ settings: settings(), drafter: failingModel(), embedder: embedder(), onError: (e) => void errors.push(e) });
    await unalignable(d);
    expect(d.scripts).toEqual([]);
    expect(errors.map((e) => (e as Error).message)).toEqual(["model unavailable"]);
  });

  it("DF1.5 follow-ups that are not valid scripts are dropped, and at most the number asked for are kept", async () => {
    const bad = { intent: "bad", exemplars: [], slots: [{ name: "Bad Name", description: "x" }], reply: [{ text: "x" }] };
    const weekday = { intent: "Weekday hours", exemplars: ["and on weekdays"], slots: [], reply: [{ text: "Weekdays at 9." }] };
    const d = new Dialogue({ settings: settings({ draft: { followUps: 1 } }), drafter: drafter({ ...hours, followUps: [bad, ...hours.followUps, weekday] }), embedder: embedder() });
    await unalignable(d);
    expect(d.scripts.map((s) => s.intent)).toEqual(["Opening hours", "Weekend hours"]);
  });

  it("DF1.6 drafted slots keep their description, value pattern and prompt, and fit only values the user said", async () => {
    const d = new Dialogue({
      settings: settings(),
      embedder: embedder(),
      drafter: drafter({
        intent: "Open on a day",
        exemplars: ["are you open on {day}"],
        slots: [{ name: "day", description: "The day asked about", pattern: "\\w+day", prompt: "Which day?" }],
        reply: [{ text: "Yes, we open on " }, { slot: "day" }, { text: " at " }, { generate: "time" }, { text: "." }],
        followUps: [],
      }),
    });
    await answered(d, "are you open on monday", "Yes, we open on monday at 9.", "a");
    await answered(d, "are you open on sunday", "Sorry, sunday is our day off.", "b");
    expect(d.script("s1")).toMatchObject({ slots: { day: { description: "The day asked about", pattern: "\\w+day", prompts: ["Which day?"] } }, evidence: { fits: 0 } });
  });

  it("DF1.8 a draft outside the draft's schema is dropped", async () => {
    const d = new Dialogue({ settings: settings(), drafter: textModel(() => JSON.stringify({ ...hours, extra: true })), embedder: embedder() });
    await unalignable(d);
    expect(d.scripts).toEqual([]);
  });

  it("DF1.9 empty drafted text is no part, a slot without a pattern or prompt has neither, and follow-ups take the next ids", async () => {
    const weekday = { intent: "Weekday hours", exemplars: ["and on weekdays"], slots: [], reply: [{ text: "Weekdays at 9." }] };
    const d = new Dialogue({
      settings: settings(),
      drafter: drafter({ ...hours, slots: [{ name: "note", description: "Anything else" }], reply: [{ text: "" }, ...hours.reply], followUps: [...hours.followUps, weekday] }),
      embedder: embedder(),
    });
    await unalignable(d);
    expect(d.script("s1")).toMatchObject({ reply: ["We're open from ", { generate: "time" }, " in the morning."] });
    expect(d.script("s1")!.slots).toStrictEqual({ note: { description: "Anything else", prompts: [] } });
    expect(d.scripts.map((s) => [s.id, s.intent])).toEqual([
      ["s1", "Opening hours"],
      ["s2", "Weekend hours"],
      ["s3", "Weekday hours"],
    ]);
    expect(d.save()).toMatchObject({ next: 4 });
  });

  it("DF1.7 a drafted script is drafted in its cluster's context", async () => {
    const d = new Dialogue({ settings: settings(), book: { scripts: [{ id: "hi", intent: "hi", patterns: ["hi"], reply: ["Hi."] }] }, drafter: drafter({ ...hours, followUps: [] }), embedder: embedder() });
    for (const [reply, session] of [["We're open from nine in the morning.", "a"], ["Doors open at 9am, see you then!", "b"]] as const) {
      await d.respond(step("hi", session));
      await answered(d, "when do you open", reply, session);
    }
    expect(d.script("s1")).toMatchObject({ context: "hi" });
  });
});

describe("draftedScript", () => {
  it("DF2.1 a drafted slot pattern that could take exponential time is refused, naming the slot; a safe one is kept", () => {
    const drafted = (pattern: string) => ({ intent: "i", exemplars: [], slots: [{ name: "t", description: "t", pattern }], reply: [{ slot: "t" }] });
    expect(() => draftedScript(drafted("(a+)+b"), scriptId("s1"), undefined)).toThrow("drafted slot t has a pattern that can take exponential time: (a+)+b");
    expect(draftedScript(drafted("\\d+"), scriptId("s1"), undefined).slots).toEqual({ t: { description: "t", pattern: "\\d+", prompts: [] } });
  });
});
