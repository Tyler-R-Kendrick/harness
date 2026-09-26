import { describe, expect, it } from "vitest";
import { promptText } from "@harness/testkit";
import { Learning } from "@harness/learning";
import type { TrajectoryInput } from "@harness/learning";
import { reply, settings, setup } from "./helpers.ts";

const deploy: TrajectoryInput = {
  id: "t1",
  task: "deploy the web app to staging",
  steps: [
    { role: "user", content: "deploy the web app to staging" },
    { role: "assistant", content: "running the deploy", call: { name: "deploy", arguments: { env: "staging" } } },
    { role: "tool", content: "error: migrations pending" },
    { role: "assistant", content: "ran migrations, deployed" },
  ],
  outcome: { status: "success", feedback: "worked after migrations" },
};
const add = (title: string, text: string, kind = "strategy") => ({ op: "add", kind, title, text });

describe("learning from sessions", () => {
  it("LN1.1 a reflection's new lessons are kept and found again by meaning for a related task", async () => {
    const { reasoner, memory } = setup({ reflect: () => reply([add("staging deploy migrations", "run pending migrations before a staging deploy", "procedure")]) });
    const learning = new Learning({ reasoner, memory, settings });
    const result = await learning.observe(deploy);
    expect(result).toEqual({ changes: [{ op: "added", id: "l1" }], rejected: [] });
    expect(learning.lessons()).toMatchObject([{ id: "l1", kind: "procedure", title: "staging deploy migrations", helpful: 0, harmful: 0, sources: ["t1"], artifacts: [] }]);
    const recalled = await learning.recall("deploy to staging again");
    expect(recalled.lessons.map((l) => l.id)).toEqual(["l1"]);
    expect(recalled.playbook).toBe("Lessons from earlier sessions:\n- [procedure] staging deploy migrations: run pending migrations before a staging deploy");
    expect(await memory.recall("staging deploy migrations", { kinds: ["lesson"], minScore: 0.2 })).toHaveLength(1);
  });

  it("LN1.2 the reflection is given the instructions, the session, and the related lessons with their ids", async () => {
    const seen: string[] = [];
    const { reasoner, memory, generator } = setup({ reflect: (r) => (seen.push(r.prompt.map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join(""))).join("\n")), reply([add("staging deploy migrations", "run pending migrations first")])) });
    const learning = new Learning({ reasoner, memory, settings });
    await learning.observe(deploy);
    await learning.observe({ ...deploy, id: "t2" });
    const calls = generator.doGenerateCalls;
    expect(calls[0]!.prompt[0]).toEqual({ role: "system", content: "Distill lessons as JSON." });
    expect(calls[0]!.maxOutputTokens).toBe(512);
    expect(calls[0]!.responseFormat).toMatchObject({ type: "json", schema: { type: "object", required: ["operations"] } });
    expect(JSON.parse(promptText(calls[1]!.prompt))).toMatchObject({ session: { task: deploy.task, outcome: deploy.outcome }, lessons: [{ id: "l1", title: "staging deploy migrations" }] });
    expect(seen).toHaveLength(2);
  });

  it("LN1.3 a new lesson that says what an old one says is merged into it, as a confirmation", async () => {
    const { reasoner, memory } = setup({ reflect: () => reply([add("staging deploy migrations", "run pending migrations before a staging deploy")]) });
    const learning = new Learning({ reasoner, memory, settings });
    await learning.observe(deploy);
    expect(await learning.observe({ ...deploy, id: "t2" })).toEqual({ changes: [{ op: "merged", id: "l1" }], rejected: [] });
    expect(learning.lessons()).toMatchObject([{ id: "l1", helpful: 1, sources: ["t1", "t2"] }]);
    expect(memory.size).toBe(1);
  });

  it("LN1.4 lessons are refined in place, confirmed, and retired once they mislead more than they help", async () => {
    const script = [
      reply([add("deploys", "deploy on fridays")]),
      reply([{ op: "refine", id: "l1", title: "deploys", text: "never deploy on fridays", when: "release planning" }]),
      reply([{ op: "helpful", id: "l1" }]),
      reply([{ op: "harmful", id: "l1" }]),
      reply([{ op: "harmful", id: "l1" }]),
      reply([{ op: "harmful", id: "l1" }]),
    ];
    const { reasoner, memory } = setup({ reflect: () => script.shift()! });
    const learning = new Learning({ reasoner, memory, settings });
    await learning.observe(deploy);
    expect((await learning.observe({ ...deploy, id: "t2" })).changes).toEqual([{ op: "refined", id: "l1" }]);
    expect(learning.lessons()[0]).toMatchObject({ text: "never deploy on fridays", when: "release planning", sources: ["t1", "t2"] });
    expect((await memory.recall("never deploy on fridays", { kinds: ["lesson"], minScore: 0.5 }))[0]!.id).toBe(learning.lessons()[0]!.memoryId);
    expect(memory.size).toBe(1);
    await learning.observe({ ...deploy, id: "t3" });
    await learning.observe({ ...deploy, id: "t4" });
    expect((await learning.observe({ ...deploy, id: "t5" })).changes).toEqual([{ op: "harmful", id: "l1" }]);
    expect((await learning.observe({ ...deploy, id: "t6" })).changes).toEqual([{ op: "harmful", id: "l1" }, { op: "retired", id: "l1" }]);
    expect(learning.lessons()).toEqual([]);
    expect(memory.size).toBe(0);
  });

  it("LN1.5 edits to lessons the reflection was not shown are rejected; output that is not a reflection changes nothing and says why", async () => {
    const script = [reply([{ op: "helpful", id: "l9" }, add("a", "b")]), "I think you should deploy carefully.", `{"operations": [{"op": "delete", "id": "l1"}]}`];
    const { reasoner, memory } = setup({ reflect: () => script.shift()! });
    const learning = new Learning({ reasoner, memory, settings });
    expect(await learning.observe(deploy)).toEqual({ changes: [{ op: "added", id: "l1" }], rejected: ["helpful l9: no such lesson was shown"] });
    const prose = await learning.observe({ ...deploy, id: "t2" });
    expect(prose.changes).toEqual([]);
    expect(prose.rejected).toEqual([expect.stringMatching(/^the reflection was not valid: No object generated: could not parse the response\.\nJSON parsing failed[\s\S]*not valid JSON/)]);
    const bad = await learning.observe({ ...deploy, id: "t3" });
    expect(bad.changes).toEqual([]);
    expect(bad.rejected[0]).toMatch(/^the reflection was not valid/);
    expect(learning.lessons()).toHaveLength(1);
  });

  it("LN1.6 feedback from outside a reflection counts too, and an unknown lesson is an error", async () => {
    const { reasoner, memory } = setup({ reflect: () => reply([add("deploys", "check migrations")]) });
    const learning = new Learning({ reasoner, memory, settings });
    await learning.observe(deploy);
    expect(await learning.feedback("l1", true)).toEqual([{ op: "helpful", id: "l1" }]);
    expect(await learning.feedback("l1", false)).toEqual([{ op: "harmful", id: "l1" }]);
    expect(learning.lessons()[0]).toMatchObject({ helpful: 1, harmful: 1 });
    await expect(learning.feedback("l7", true)).rejects.toThrow("no lesson l7");
  });

  it("LN1.7 lessons save to JSON and restore, with ids continuing; saved state of another kind is refused", async () => {
    const changes: number[] = [];
    const { reasoner, memory } = setup({ reflect: () => reply([add("deploys", "check migrations first")]) });
    const learning = new Learning({ reasoner, memory, settings, onChange: (l) => changes.push(l.lessons().length) });
    await learning.observe(deploy);
    const saved = JSON.parse(JSON.stringify(learning.save()));
    const restored = new Learning({ reasoner, memory, settings, saved });
    expect(restored.lessons()).toEqual(learning.lessons());
    expect(changes).toEqual([1]);
    expect(() => new Learning({ reasoner, memory, settings, saved: { format: "other" } })).toThrow(/invalid saved learning/);
  });

  it("LN1.8 consolidation rebuilds the lessons: near-duplicates learned apart merge into the oldest", async () => {
    const script = [reply([add("deploys", "run migrations before deploying"), add("bananas", "bananas are yellow", "insight")])];
    const { reasoner, memory } = setup({ reflect: () => script.shift() ?? reply([]) });
    const learning = new Learning({ reasoner, memory, settings });
    await learning.observe(deploy);
    // A copy added as it came (e.g. imported), without the merge check a reflection gets.
    expect(await learning.addLesson({ kind: "strategy", title: "deploys", text: "run migrations before deploying", source: "t9" })).toMatchObject({ id: "l3" });
    expect(learning.lessons()).toHaveLength(3);
    const merged = await learning.consolidate();
    expect(merged).toEqual([{ op: "merged", id: "l1" }, { op: "retired", id: "l3" }]);
    expect(learning.lessons().map((l) => [l.id, l.helpful, l.sources])).toEqual([
      ["l1", 1, ["t1", "t9"]],
      ["l2", 0, ["t1"]],
    ]);
  });

  it("LN1.9 a reflection whose JSON is broken says so; recall can keep to kinds, and says nothing when nothing relates", async () => {
    const script = ['{"operations": [', reply([add("deploys", "check migrations first", "procedure"), add("bananas", "bananas are yellow fruit", "insight")])];
    const { reasoner, memory } = setup({ reflect: () => script.shift()! });
    const learning = new Learning({ reasoner, memory, settings });
    const broken = await learning.observe(deploy);
    expect(broken.changes).toEqual([]);
    expect(broken.rejected[0]).toMatch(/^the reflection was not valid: No object generated: could not parse the response\.\n.*JSON/);
    await learning.observe({ ...deploy, id: "t2" });
    expect((await learning.recall("deploys check migrations first", { kinds: ["insight"] })).lessons).toEqual([]);
    expect((await learning.recall("deploys check migrations first", { kinds: ["procedure"] })).lessons.map((l) => l.id)).toEqual(["l1"]);
    expect(await learning.recall("zebra crossing quantum")).toEqual({ lessons: [], playbook: "" });
  });

  it("LN1.10 within one reflection, a lesson retired by one edit cannot be edited by the next; the recall limit comes from the settings", async () => {
    const script = [reply([add("deploys", "deploy on fridays")]), reply([{ op: "harmful", id: "l1" }, { op: "harmful", id: "l1" }, { op: "helpful", id: "l1" }])];
    const { reasoner, memory } = setup({ reflect: () => script.shift()! });
    const recalls: unknown[] = [];
    const spy = { recall: (q: string, o: object) => (recalls.push(o), memory.recall(q, o)), remember: memory.remember.bind(memory), forget: memory.forget.bind(memory) } as unknown as typeof memory;
    const learning = new Learning({ reasoner, memory: spy, settings });
    await learning.observe(deploy);
    expect(await learning.observe({ ...deploy, id: "t2" })).toEqual({ changes: [{ op: "harmful", id: "l1" }, { op: "harmful", id: "l1" }, { op: "retired", id: "l1" }], rejected: ["helpful l1: no such lesson was shown"] });
    await learning.recall("anything");
    expect(recalls.at(-1)).toEqual({ kinds: ["lesson"], limit: settings.recall.limit, minScore: settings.recall.minScore });
    expect(recalls[0]).toMatchObject({ limit: settings.reflection.related });
  });

  it("LN1.11 consolidation sums what merged lessons earned, keeps the oldest whichever is found first, and reports the change once", async () => {
    const changes: number[] = [];
    const { reasoner, memory } = setup();
    const learning = new Learning({ reasoner, memory, settings, onChange: () => changes.push(1) });
    await learning.addLesson({ kind: "strategy", title: "deploys", text: "run migrations before deploying", source: "a" });
    await learning.addLesson({ kind: "strategy", title: "deploys", text: "run migrations before deploying", source: "b" });
    await learning.feedback("l2", true);
    await learning.feedback("l2", false);
    changes.length = 0;
    expect(await learning.consolidate()).toEqual([{ op: "merged", id: "l1" }, { op: "retired", id: "l2" }]);
    expect(learning.lessons()).toMatchObject([{ id: "l1", helpful: 2, harmful: 1, sources: ["a", "b"] }]);
    expect(changes).toEqual([1]);
    expect(await learning.consolidate()).toEqual([]);
    expect(changes).toEqual([1]);
  });

  it("LN1.12 feedback adds no source, and a session already among a lesson's sources is not added twice", async () => {
    const { reasoner, memory } = setup({ reflect: () => reply([add("deploys", "check migrations"), { op: "helpful", id: "l1" }]) });
    const learning = new Learning({ reasoner, memory, settings });
    await learning.observe(deploy);
    await learning.feedback("l1", true);
    await learning.observe(deploy);
    expect(learning.lesson("l1").sources).toEqual(["t1"]);
  });
});

