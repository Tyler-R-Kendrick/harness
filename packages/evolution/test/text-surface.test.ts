import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyProposal, ChangeSchema, defineSurface, Evolution, leaks, OpSchema, PatchOpSchema, ProposalSchema, revert, StateSchema } from "@harness/evolution";
import type { Change, DocumentInput, Documents, Proposal } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { scripted, settings, world } from "./world.ts";

type Ops = Proposal["edits"][number]["ops"];

const SOURCE = "def run(task):\n    plan = think(task)\n    return act(plan)\n";

const surfaceOf = (code: Partial<DocumentInput> & { kind?: "text" } = {}, components = ["prompt", "config", "skill"]) =>
  defineSurface({
    documents: {
      code: { kind: "text", ...code },
      notes: { kind: "text" },
      settings: { schema: z.strictObject({ threshold: z.number(), steps: z.array(z.string()) }) },
    },
    components,
    structural: ["skill"],
  });
const surface = surfaceOf();
const docs: Documents = { code: SOURCE, notes: "alpha\nbeta\ngamma\ndelta\n", settings: { threshold: 0.5, steps: ["plan"] } };

const edit = (id: string, ops: Ops) => ({ id, hypothesis: `h ${id}`, targets: "mode", predicted: [], ops });
const proposal = (...edits: Proposal["edits"]): Proposal => ({ summary: "s", edits });
const on = (document: string, old: string, replacement: string) => ({ op: "edit" as const, document, old, new: replacement });
const problems = (r: ReturnType<typeof applyProposal>) => (r.kind === "refused" ? r.problems : []);
const applied = (s: typeof surface, documents: Documents, ...edits: Proposal["edits"]) => {
  const r = applyProposal(s, documents, proposal(...edits), edits.length);
  if (r.kind !== "applied") throw new Error(r.problems.join("; "));
  return r;
};

describe("text documents: an edit replaces text that occurs exactly once", () => {
  it("RS13.1 an edit applies to a copy of the text, and records what it wrote, its inverse, its component and its size", () => {
    const r = applyProposal(surface, docs, proposal(edit("e1", [on("code", "plan = think(task)", "plan = think(task, depth=2)")])), 1);
    if (r.kind !== "applied") throw new Error(r.problems.join("; "));
    expect(docs["code"]).toBe(SOURCE);
    expect(r.documents["code"]).toBe("def run(task):\n    plan = think(task, depth=2)\n    return act(plan)\n");
    expect(r.documents["notes"]).toBe(docs["notes"]);
    expect(r.edits).toEqual([
      {
        id: "e1",
        hypothesis: "h e1",
        targets: "mode",
        predicted: [],
        components: ["prompt"],
        footprint: 2,
        changes: [
          {
            document: "code",
            wrote: [{ op: "edit", old: "plan = think(task)", new: "plan = think(task, depth=2)" }],
            inverse: [{ op: "edit", old: "plan = think(task, depth=2)", new: "plan = think(task)" }],
          },
        ],
      },
    ]);
  });

  it("RS13.2 an old text that is nowhere in the document is refused, and the reason names it", () => {
    const r = applyProposal(surface, docs, proposal(edit("e1", [on("code", "plan = think(job)", "x")])), 1);
    expect(r).toEqual({ kind: "refused", problems: ['edit e1 does not apply: the old text is not in code: "plan = think(job)"'] });
    const long = applyProposal(surface, docs, proposal(edit("e1", [on("code", "z".repeat(60), "x")])), 1);
    expect(problems(long)).toEqual([`edit e1 does not apply: the old text is not in code: "${"z".repeat(40)}..."`]);
    // Exactly 40 characters is quoted whole.
    expect(problems(applyProposal(surface, docs, proposal(edit("e1", [on("code", "z".repeat(40), "x")])), 1))).toEqual([`edit e1 does not apply: the old text is not in code: "${"z".repeat(40)}"`]);
  });

  it("RS13.3 an old text that occurs more than once is refused with its count, overlapping occurrences included", () => {
    const twice = applyProposal(surface, docs, proposal(edit("e1", [on("code", "task", "job")])), 1);
    expect(twice).toEqual({ kind: "refused", problems: ['edit e1 does not apply: the old text occurs 2 times in code, not exactly once: "task"'] });
    const overlapping = applyProposal(surface, { ...docs, code: "aaa" }, proposal(edit("e1", [on("code", "aa", "b")])), 1);
    expect(problems(overlapping)).toEqual(['edit e1 does not apply: the old text occurs 2 times in code, not exactly once: "aa"']);
    // An empty old text cannot be located anywhere.
    expect(problems(applyProposal(surface, docs, proposal(edit("e1", [on("code", "", "x")])), 1))).toEqual(['edit e1 does not apply: the old text is not in code: ""']);
  });

  it("RS13.4 the ops of one edit apply in order, each to the text as it then is, and each must be unique there", () => {
    const r = applied(surface, docs, edit("e1", [on("code", "plan = think(task)", "plan = draft(task)"), on("code", "draft(task)", "draft(task, 3)"), on("code", "return act(plan)", "return act(plan, verify=True)")]));
    expect(r.documents["code"]).toBe("def run(task):\n    plan = draft(task, 3)\n    return act(plan, verify=True)\n");
    expect(r.edits[0]!.changes[0]!.wrote).toHaveLength(3);
    expect(r.edits[0]!.changes[0]!.inverse.map((o) => (o.op === "edit" ? o.new : ""))).toEqual(["return act(plan)", "draft(task)", "plan = think(task)"]);
    // The second op needs text the first one wrote; without it, it is not there.
    const missing = applyProposal(surface, docs, proposal(edit("e1", [on("code", "draft(task)", "x")])), 1);
    expect(problems(missing)).toEqual(['edit e1 does not apply: the old text is not in code: "draft(task)"']);
    // An op that leaves the text as it was is skipped; if every op does, the edit changes nothing.
    expect(problems(applyProposal(surface, docs, proposal(edit("e1", [on("code", "return", "return")])), 1))).toEqual(["edit e1 changes nothing"]);
    const mixed = applied(surface, docs, edit("e1", [on("code", "return", "return"), on("code", "act", "walk")]));
    expect(mixed.edits[0]!.changes[0]!.wrote).toEqual([{ op: "edit", old: "act", new: "walk" }]);
  });

  it("RS13.5 a replace at the root writes the whole text; the same text changes nothing; anything else than an edit or that is refused", () => {
    const whole = applied(surface, docs, edit("e1", [{ op: "replace", document: "code", path: "", value: "print(1)\n" }]));
    expect(whole.documents["code"]).toBe("print(1)\n");
    expect(whole.edits[0]!.changes[0]).toEqual({
      document: "code",
      wrote: [{ op: "replace", path: "", value: "print(1)\n" }],
      inverse: [{ op: "replace", path: "", value: SOURCE }],
    });
    expect(problems(applyProposal(surface, docs, proposal(edit("e1", [{ op: "replace", document: "code", path: "", value: SOURCE }])), 1))).toEqual(["edit e1 changes nothing"]);
    expect(problems(applyProposal(surface, docs, proposal(edit("e1", [{ op: "replace", document: "code", path: "", value: 3 }])), 1))).toEqual(["edit e1 does not apply: code is text: a replace at its root needs a string"]);
    expect(problems(applyProposal(surface, docs, proposal(edit("e1", [{ op: "replace", document: "code", path: "/0", value: "x" }])), 1))).toEqual([
      'edit e1 does not apply: code is text: only an edit or a replace at its root applies, not replace at "/0"',
    ]);
    expect(problems(applyProposal(surface, docs, proposal(edit("e1", [{ op: "add", document: "code", path: "/-", value: "x" }])), 1))).toEqual(['edit e1 does not apply: code is text: only an edit or a replace at its root applies, not add at "/-"']);
    expect(problems(applyProposal(surface, docs, proposal(edit("e1", [{ op: "remove", document: "code", path: "" }])), 1))).toEqual(['edit e1 does not apply: code is text: only an edit or a replace at its root applies, not remove at ""']);
  });

  it("RS13.6 a text document that is not text in the documents, an edit op on a JSON document, and an unknown document are refused", () => {
    expect(problems(applyProposal(surface, { ...docs, code: { not: "text" } }, proposal(edit("e1", [on("code", "a", "b")])), 1))).toEqual(["edit e1 does not apply: code is not text"]);
    expect(problems(applyProposal(surface, docs, proposal(edit("e1", [on("settings", "0.5", "0.6")])), 1))).toEqual(["edit e1 does not apply: settings is JSON: an edit op applies to text documents"]);
    expect(problems(applyProposal(surface, docs, proposal(edit("e1", [on("nowhere", "a", "b")])), 1))).toEqual(["edit e1 names no document of the surface: nowhere"]);
  });

  it("RS13.7 the schema of a text document is a string by default, and a given one applies", () => {
    expect(problems(applyProposal(surface, { ...docs, code: SOURCE }, proposal(edit("e1", [{ op: "replace", document: "code", path: "", value: SOURCE + "!" }])), 1))).toEqual([]);
    const short = surfaceOf({ schema: z.string().max(40) });
    const r = applyProposal(short, { ...docs, code: "short" }, proposal(edit("e1", [on("code", "short", "a text well past the forty characters this schema allows")])), 1);
    expect(problems(r)).toHaveLength(1);
    expect(problems(r)[0]).toMatch(/^code no longer parses: [\s\S]*40/);
    expect(surface.documents["code"]!.schema.safeParse(3).success).toBe(false);
    expect(surface.documents["code"]!.schema.safeParse("x").success).toBe(true);
  });

  it("RS13.8 the host's check of the whole text refuses a proposal it fails, and names the problem", () => {
    const seen: string[] = [];
    const checked = surfaceOf({
      check: (text) => {
        seen.push(text);
        return text.includes("return") ? undefined : "it never returns";
      },
    });
    const bad = applyProposal(checked, docs, proposal(edit("e1", [on("code", "return act(plan)", "act(plan)")])), 1);
    expect(bad).toEqual({ kind: "refused", problems: ["code fails its check: it never returns"] });
    expect(seen).toEqual(["def run(task):\n    plan = think(task)\n    act(plan)\n"]);
    const good = applyProposal(checked, docs, proposal(edit("e1", [on("code", "plan = think(task)", "plan = think(task, 2)")])), 1);
    expect(good.kind).toBe("applied");
    // A document the edit did not touch is not checked again; a failed schema is reported without the check.
    seen.length = 0;
    applyProposal(checked, docs, proposal(edit("e1", [on("notes", "alpha", "ALPHA")])), 1);
    expect(seen).toEqual([]);
    const both = surfaceOf({ schema: z.string().max(5), check: () => "never called" });
    expect(problems(applyProposal(both, { ...docs, code: "ab" }, proposal(edit("e1", [on("code", "ab", "abcdefgh")])), 1))).toEqual([expect.stringMatching(/^code no longer parses: /)]);
  });

  it("RS13.9 a check that fails is reported next to the other problems of the proposal", () => {
    const checked = surfaceOf({ check: (t) => (t.includes("TODO") ? "a TODO is left" : undefined) });
    const r = applyProposal(checked, docs, proposal(edit("e1", [on("code", "act(plan)", "TODO")]), edit("e2", [on("notes", "nothing here", "x")])), 2);
    expect(r).toEqual({ kind: "refused", problems: ['edit e2 does not apply: the old text is not in notes: "nothing here"', "code fails its check: a TODO is left"] });
  });
});

describe("text documents: independence is computed from the ranges the edits occupy", () => {
  const two = (a: Ops, b: Ops) => applyProposal(surface, docs, proposal(edit("a", a), edit("b", b)), 2);

  it("RS13.10 edits of disjoint ranges of one text are independent, whatever order they are written in", () => {
    const r = two([on("notes", "alpha", "ALPHA")], [on("notes", "gamma", "GAMMA")]);
    expect(r.kind === "applied" && r.documents["notes"]).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
    const reversed = two([on("notes", "gamma", "GAMMA")], [on("notes", "alpha", "ALPHA")]);
    expect(reversed.kind === "applied" && reversed.documents["notes"]).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
    // The ranges are those in the ORIGINAL text: a later edit's position does not move with an earlier one's growth.
    const grown = two([on("notes", "alpha", "alpha and much more text than before")], [on("notes", "beta", "BETA")]);
    expect(grown.kind).toBe("applied");
  });

  it("RS13.11 ranges that touch end to start are dependent (the context that finds one again may lie in the other); a gap of one character is enough to be independent", () => {
    // "alpha\n" is [0,6) and "beta" is [6,10).
    expect(two([on("notes", "alpha\n", "A\n")], [on("notes", "beta", "B")])).toEqual({ kind: "refused", problems: ["edits a and b both touch notes[6:6]: they are one edit, or not independent"] });
    expect(two([on("notes", "beta", "B")], [on("notes", "alpha\n", "A\n")])).toEqual({ kind: "refused", problems: ["edits a and b both touch notes[6:6]: they are one edit, or not independent"] });
    // "alpha" is [0,5) and "beta" [6,10): the newline between them is in neither.
    expect(two([on("notes", "alpha", "A")], [on("notes", "beta", "B")]).kind).toBe("applied");
    // "alpha\nb" is [0,7): it shares the "b" at 6.
    expect(two([on("notes", "alpha\nb", "AB")], [on("notes", "beta", "B")])).toEqual({ kind: "refused", problems: ["edits a and b both touch notes[6:7]: they are one edit, or not independent"] });
    expect(two([on("notes", "beta", "B")], [on("notes", "alpha\nb", "AB")])).toEqual({ kind: "refused", problems: ["edits a and b both touch notes[6:7]: they are one edit, or not independent"] });
  });

  it("RS13.12 overlapping, nested and identical ranges are not independent, and the refusal names the shared characters", () => {
    expect(two([on("notes", "alpha\nbeta", "x")], [on("notes", "beta\ngamma", "y")]).kind).toBe("refused");
    expect(problems(two([on("notes", "alpha\nbeta", "x")], [on("notes", "beta\ngamma", "y")]))).toEqual(["edits a and b both touch notes[6:10]: they are one edit, or not independent"]);
    expect(problems(two([on("notes", "beta\ngamma", "y")], [on("notes", "alpha\nbeta", "x")]))).toEqual(["edits a and b both touch notes[6:10]: they are one edit, or not independent"]);
    expect(problems(two([on("notes", "alpha\nbeta\ngamma", "x")], [on("notes", "beta", "y")]))).toEqual(["edits a and b both touch notes[6:10]: they are one edit, or not independent"]);
    expect(problems(two([on("notes", "beta", "y")], [on("notes", "alpha\nbeta\ngamma", "x")]))).toEqual(["edits a and b both touch notes[6:10]: they are one edit, or not independent"]);
    expect(problems(two([on("notes", "beta", "x")], [on("notes", "beta", "y")]))).toEqual(["edits a and b both touch notes[6:10]: they are one edit, or not independent"]);
  });

  it("RS13.13 a whole-text replace overlaps every edit of that document, and any other edit of it", () => {
    const whole: Ops = [{ op: "replace", document: "notes", path: "", value: "new\n" }];
    expect(problems(two(whole, [on("notes", "alpha", "x")]))).toEqual(["edits a and b both touch notes: they are one edit, or not independent"]);
    expect(problems(two([on("notes", "alpha", "x")], whole))).toEqual(["edits a and b both touch notes: they are one edit, or not independent"]);
    expect(problems(two(whole, [{ op: "replace", document: "notes", path: "", value: "other\n" }]))).toEqual(["edits a and b both touch notes: they are one edit, or not independent"]);
    // Other documents are untouched by it.
    expect(two(whole, [on("code", "act(plan)", "act(plan, 1)")]).kind).toBe("applied");
  });

  it("RS13.14 an edit whose old text is not found exactly once in the original cannot be shown independent", () => {
    // "beta" occurs only in what edit a writes: b depends on a.
    const dependent = two([on("notes", "alpha", "alpha beta beta")], [on("notes", "beta beta", "x")]);
    expect(problems(dependent)).toEqual(["edits a and b both touch notes: they are one edit, or not independent"]);
    // "a" occurs many times in the original: it cannot be placed, so it counts as the whole text.
    expect(problems(two([on("notes", "delta", "x")], [on("notes", "a", "x")]))).toEqual(["edits a and b both touch notes: they are one edit, or not independent"]);
    expect(problems(two([on("notes", "a", "x")], [on("notes", "delta", "x")]))).toEqual(["edits a and b both touch notes: they are one edit, or not independent"]);
    // A JSON-Patch op that is not a root replace counts as the whole text, too.
    expect(problems(two([{ op: "add", document: "notes", path: "/0", value: "x" }], [on("notes", "beta", "y")]))).toEqual(["edits a and b both touch notes: they are one edit, or not independent"]);
  });

  it("RS13.15 edits of different documents are independent, and an edit across two documents is one edit", () => {
    expect(two([on("notes", "alpha", "x")], [on("code", "alpha", "y")]).kind).toBe("refused"); // "alpha" is not in code: refused by apply, not by independence
    expect(problems(two([on("notes", "alpha", "x")], [on("code", "alpha", "y")]))).toEqual(['edit b does not apply: the old text is not in code: "alpha"']);
    const r = two([on("notes", "alpha", "x")], [on("code", "act(plan)", "act(plan, 1)")]);
    expect(r.kind).toBe("applied");
    const across = applied(surface, docs, edit("e1", [on("notes", "alpha", "ALPHA"), on("code", "act(plan)", "act(plan, 1)"), { op: "replace", document: "settings", path: "/threshold", value: 0.9 }]));
    expect(across.edits[0]!.changes.map((c) => c.document)).toEqual(["notes", "code", "settings"]);
    expect(across.edits[0]!.footprint).toBe(2 + 2 + 1);
    expect(across.documents["settings"]).toEqual({ threshold: 0.9, steps: ["plan"] });
    // The same range in the same edit is fine: an edit is one edit.
    expect(applied(surface, docs, edit("e1", [on("notes", "alpha", "ALPHAX"), on("notes", "ALPHAX", "Z")])).kind).toBe("applied");
    // JSON documents keep their own independence rules next to text ones.
    const json = two([{ op: "replace", document: "settings", path: "/steps", value: [] }], [{ op: "add", document: "settings", path: "/steps/0", value: "x" }]);
    expect(problems(json)).toEqual(["edits a and b both touch settings/steps: they are one edit, or not independent"]);
    // The shorter of two overlapping pointers names the refusal, whichever edit has it.
    const nested = two([{ op: "add", document: "settings", path: "/steps/0", value: "x" }], [{ op: "replace", document: "settings", path: "/steps", value: [] }]);
    expect(problems(nested)).toEqual(["edits a and b both touch settings/steps: they are one edit, or not independent"]);
    // A JSON document's edit op counts as the whole document (and is refused when applied).
    expect(problems(two([on("settings", "x", "y")], [{ op: "replace", document: "settings", path: "/threshold", value: 1 }]))).toEqual(["edits a and b both touch settings: they are one edit, or not independent"]);
  });
});

describe("text documents: components and size", () => {
  const ranked = (before: string, after: string): readonly string[] => (after.includes("retry") ? ["skill", "config"] : before.includes("think") ? ["config"] : []);

  it("RS13.16 by default a changed region is the document's component: prompt, or the one it declares", () => {
    expect(applied(surface, docs, edit("e1", [on("code", "act", "run")])).edits[0]!.components).toEqual(["prompt"]);
    const skill = surfaceOf({ component: "skill" });
    expect(applied(skill, docs, edit("e1", [on("code", "act", "run")])).edits[0]!.components).toEqual(["skill"]);
    expect(applied(skill, docs, edit("e1", [{ op: "replace", document: "code", path: "", value: "x" }])).edits[0]!.components).toEqual(["skill"]);
    expect(() => surfaceOf({ component: "memory" })).toThrow(/text document code's component must be a component: memory/);
    expect(() => defineSurface({ documents: { d: { kind: "text", component: "prompt" } }, components: ["prompt"] })).not.toThrow();
  });

  it("RS13.17 classifyText names the components of each changed region from what it replaced and what it wrote", () => {
    const calls: [string, string][] = [];
    const classified = surfaceOf({
      classifyText: (before, after) => {
        calls.push([before, after]);
        return ranked(before, after);
      },
    });
    const r = applied(classified, docs, edit("e1", [on("code", "plan = think(task)", "plan = think(task)  # retry"), on("code", "return act(plan)", "return act(plan)")]));
    expect(r.edits[0]!.components).toEqual(["config", "skill"]);
    // The whole text of a replace is the region.
    const whole = applied(classified, docs, edit("e2", [{ op: "replace", document: "code", path: "", value: "retry\n" }]));
    expect(whole.edits[0]!.components).toEqual(["config", "skill"]);
    expect(calls).toEqual([
      ["plan = think(task)", "plan = think(task)  # retry"],
      [SOURCE, "retry\n"],
    ]);
    const second = applied(classified, docs, edit("e1", [on("code", "think(task)", "think(job)")]));
    expect(second.edits[0]!.components).toEqual(["config"]);
  });

  it("RS13.18 a region classifyText names nothing for is the document's component; one it names outside the vocabulary is refused", () => {
    const empty = surfaceOf({ classifyText: () => [], component: "skill" });
    expect(applied(empty, docs, edit("e1", [on("code", "act", "run")])).edits[0]!.components).toEqual(["skill"]);
    const outside = surfaceOf({ classifyText: () => ["prompt", "memory"] });
    expect(applyProposal(outside, docs, proposal(edit("e1", [on("code", "act", "run")])), 1)).toEqual({ kind: "refused", problems: ["edit e1 changes code, which the surface classifies as memory, not one of prompt, config, skill"] });
    const outsideDefault = defineSurface({ documents: { code: { kind: "text", component: "prompt" } }, components: ["prompt"] });
    expect(applyProposal(outsideDefault, { code: "a" }, proposal(edit("e1", [on("code", "a", "b")])), 1).kind).toBe("applied");
    // With no `prompt` in the vocabulary, the default component is refused like any other.
    const noPrompt = defineSurface({ documents: { code: { kind: "text" } }, components: ["config"] });
    expect(problems(applyProposal(noPrompt, { code: "a" }, proposal(edit("e1", [on("code", "a", "b")])), 1))).toEqual(["edit e1 changes code, which the surface classifies as prompt, not one of config"]);
  });

  it("RS13.19 JSON documents keep the default classification of their paths: strings are prompts, the rest configuration", () => {
    const r = applied(surface, docs, edit("e1", [{ op: "replace", document: "settings", path: "/threshold", value: 0.7 }]), edit("e2", [{ op: "add", document: "settings", path: "/steps/-", value: "verify" }]));
    expect(r.edits.map((e) => [e.components, e.footprint])).toEqual([
      [["config"], 1],
      [["prompt"], 1],
    ]);
  });

  it("RS13.20 the footprint of a text edit is the lines it changed, added and removed, less the lines it shares at the ends", () => {
    const size = (text: string, old: string, replacement: string) => applied(surface, { ...docs, code: text }, edit("e1", [on("code", old, replacement)])).edits[0]!.footprint;
    expect(size("a\nb\nc\n", "b", "B")).toBe(2); // one line out, one in
    expect(size("a\nb\nc\n", "a\nb\nc", "a\nB\nc")).toBe(2); // shared lines are not counted
    expect(size("a\nb\nc\n", "b\n", "")).toBe(1); // a line deleted
    expect(size("a\nc\n", "a\n", "a\nb\n")).toBe(1); // a line added
    expect(size("a\nb\nc\nd\n", "b\nc", "X\nY\nZ")).toBe(5);
    expect(size("one", "one", "one two")).toBe(2);
    expect(size("a\n", "a", "a\n")).toBe(1); // only a line break was added
    expect(size("a\n\nb\n", "a\n\nb", "a\n\n\nb")).toBe(1);
    const whole = applied(surface, { ...docs, code: "a\nb\nc\n" }, edit("e1", [{ op: "replace", document: "code", path: "", value: "a\nx\ny\nc\n" }]));
    expect(whole.edits[0]!.footprint).toBe(3); // b out; x and y in
    const many = applied(surface, docs, edit("e1", [on("notes", "alpha", "A"), on("notes", "delta", "D")]));
    expect(many.edits[0]!.footprint).toBe(4);
  });
});

describe("text documents: the recorded change", () => {
  it("RS13.21 the change schema takes a text edit, with or without its context, and still takes the JSON changes saved before", () => {
    const edited = { document: "code", wrote: [{ op: "edit", old: "a", new: "b" }], inverse: [{ op: "edit", old: "b", new: "a" }] };
    expect(ChangeSchema.parse(edited)).toEqual(edited);
    const anchored = { document: "code", wrote: [{ op: "edit", old: "a", new: "", before: "x", after: "y" }], inverse: [{ op: "edit", old: "", new: "a", before: "x", after: "y" }] };
    expect(ChangeSchema.parse(anchored)).toEqual(anchored);
    const json = {
      document: "settings",
      wrote: [
        { op: "replace", path: "/x", value: 1 },
        { op: "add", path: "/y", value: [2] },
        { op: "remove", path: "/z" },
      ],
      inverse: [{ op: "replace", path: "/x", value: 0 }],
    };
    expect(ChangeSchema.parse(json)).toEqual(json);
    expect(ChangeSchema.safeParse({ ...edited, wrote: [{ op: "edit", old: "a", new: "b", extra: 1 }] }).success).toBe(false);
    expect(ChangeSchema.safeParse({ ...edited, wrote: [{ op: "edit", old: "a" }] }).success).toBe(false);
    expect(PatchOpSchema.safeParse({ op: "edit", old: "a", new: "b", before: 3 }).success).toBe(false);
  });

  it("RS13.22 the op schema takes an edit with a non-empty old text and any new text, and the proposal's JSON Schema offers it", () => {
    expect(OpSchema.parse({ op: "edit", document: "code", old: "a", new: "" })).toEqual({ op: "edit", document: "code", old: "a", new: "" });
    expect(OpSchema.safeParse({ op: "edit", document: "code", old: "", new: "b" }).success).toBe(false);
    expect(OpSchema.safeParse({ op: "edit", document: "", old: "a", new: "b" }).success).toBe(false);
    expect(OpSchema.safeParse({ op: "edit", document: "code", old: "a", new: "b", path: "" }).success).toBe(false);
    expect(ProposalSchema.safeParse(proposal(edit("e1", [on("code", "a", "b")]))).success).toBe(true);
    expect(JSON.stringify(z.toJSONSchema(ProposalSchema))).toContain('"edit"');
  });

  it("RS13.23 the recorded edit of a deletion, or of text that repeats, carries the least context that finds it again", () => {
    const deleted = applied(surface, { ...docs, code: "a\nb\nc\n" }, edit("e1", [on("code", "b\n", "")]));
    expect(deleted.documents["code"]).toBe("a\nc\n");
    expect(deleted.edits[0]!.changes[0]).toEqual({
      document: "code",
      wrote: [{ op: "edit", old: "b\n", new: "", before: "\n", after: "c" }],
      inverse: [{ op: "edit", old: "", new: "b\n", before: "\n", after: "c" }],
    });
    const repeated = applied(surface, { ...docs, code: "a = 1\nb = 2\n" }, edit("e1", [on("code", "a = 1", "b = 2")]));
    expect(repeated.documents["code"]).toBe("b = 2\nb = 2\n");
    expect(repeated.edits[0]!.changes[0]!.wrote).toEqual([{ op: "edit", old: "a = 1", new: "b = 2", after: "\nb" }]);
    const front = applied(surface, { ...docs, code: "x\ny\nx\n" }, edit("e1", [on("code", "y\nx\n", "x\n")]));
    expect(front.documents["code"]).toBe("x\nx\n");
    expect(front.edits[0]!.changes[0]!.wrote).toEqual([{ op: "edit", old: "y\nx\n", new: "x\n", before: "\n" }]);
    // A text that occurs once needs no context, even if it is a substring of the text it replaced.
    const unique = applied(surface, docs, edit("e1", [on("code", "plan = think(task)", "planning")]));
    expect(unique.edits[0]!.changes[0]!.wrote).toEqual([{ op: "edit", old: "plan = think(task)", new: "planning" }]);
  });

  it("RS13.24 deleting the whole text is recorded as a replace of the whole text, which can be taken back", () => {
    const gone = applied(surface, { ...docs, code: "only" }, edit("e1", [on("code", "only", "")]));
    expect(gone.documents["code"]).toBe("");
    expect(gone.edits[0]!.changes[0]).toEqual({ document: "code", wrote: [{ op: "replace", path: "", value: "" }], inverse: [{ op: "replace", path: "", value: "only" }] });
    expect(revert(surface, gone.documents, gone.edits[0]!.changes)).toEqual({ kind: "applied", documents: { ...docs, code: "only" } });
    expect(revert(surface, { ...gone.documents, code: "changed" }, gone.edits[0]!.changes).kind).toBe("refused");
  });
});

describe("text documents: an accepted edit is reverted while what it wrote is there", () => {
  const first = applied(surface, docs, edit("e1", [on("code", "plan = think(task)", "plan = think(task, depth=2)")]));
  const mine = first.edits[0]!.changes;

  it("RS13.25 an intact edit reverts to exactly the text before it, and other changes to the document are kept", () => {
    expect(revert(surface, first.documents, mine)).toEqual({ kind: "applied", documents: docs });
    const later = applied(surface, first.documents, edit("e2", [on("code", "return act(plan)", "return act(plan, verify=True)")]));
    expect(revert(surface, later.documents, mine)).toEqual({ kind: "applied", documents: { ...docs, code: "def run(task):\n    plan = think(task)\n    return act(plan, verify=True)\n" } });
    // The text around the edit may move; an edit elsewhere in the document is not a rewrite.
    const shifted = applied(surface, first.documents, edit("e2", [on("code", "def run(task):", "# entry point\ndef run(task):")]));
    expect(revert(surface, shifted.documents, mine)).toEqual({ kind: "applied", documents: { ...docs, code: "# entry point\ndef run(task):\n    plan = think(task)\n    return act(plan)\n" } });
  });

  it("RS13.26 an edit whose text was rewritten later is refused: the document was changed after the edit", () => {
    const rewritten = applied(surface, first.documents, edit("e2", [on("code", "depth=2", "depth=5")]));
    expect(revert(surface, rewritten.documents, mine)).toEqual({ kind: "refused", problems: ["code was changed after the edit"] });
    expect(revert(surface, { ...first.documents, code: "" }, mine)).toEqual({ kind: "refused", problems: ["code was changed after the edit"] });
    expect(revert(surface, { ...first.documents, code: 3 }, mine)).toEqual({ kind: "refused", problems: ["code was changed after the edit"] });
  });

  it("RS13.27 an edit whose text now occurs twice is refused: it can no longer be found exactly once", () => {
    const copied = { ...first.documents, code: `${first.documents["code"]}plan = think(task, depth=2)\n` };
    expect(revert(surface, copied, mine)).toEqual({ kind: "refused", problems: ["code was changed after the edit"] });
  });

  it("RS13.28 a deletion is reverted at its context, and refused when the context was altered", () => {
    const base = { ...docs, code: "a\nb\nc\n" };
    const deleted = applied(surface, base, edit("e1", [on("code", "b\n", "")]));
    expect(revert(surface, deleted.documents, deleted.edits[0]!.changes)).toEqual({ kind: "applied", documents: base });
    expect(revert(surface, { ...deleted.documents, code: "a\nX\n" }, deleted.edits[0]!.changes).kind).toBe("refused");
    // Text that repeated is put back where it was: not at its other occurrence.
    const dup = { ...docs, code: "a = 1\nb = 2\n" };
    const changed = applied(surface, dup, edit("e1", [on("code", "a = 1", "b = 2")]));
    expect(revert(surface, changed.documents, changed.edits[0]!.changes)).toEqual({ kind: "applied", documents: dup });
  });

  it("RS13.29 the ops of one edit are taken out in the reverse of their order", () => {
    const three = applied(surface, docs, edit("e1", [on("code", "plan = think(task)", "plan = draft(task)"), on("code", "draft(task)", "draft(task, 3)"), on("code", "act(plan)", "act(plan, 1)")]));
    expect(revert(surface, three.documents, three.edits[0]!.changes)).toEqual({ kind: "applied", documents: docs });
    const altered = { ...three.documents, code: String(three.documents["code"]).replace("draft(task, 3)", "draft(task, 4)") };
    expect(revert(surface, altered, three.edits[0]!.changes).kind).toBe("refused");
  });

  it("RS13.30 a whole-text replace reverts while the text is still what it wrote, and not once it was touched", () => {
    const whole = applied(surface, docs, edit("e1", [{ op: "replace", document: "code", path: "", value: "print(1)\n" }]));
    const changes = whole.edits[0]!.changes;
    expect(revert(surface, whole.documents, changes)).toEqual({ kind: "applied", documents: docs });
    expect(revert(surface, { ...whole.documents, code: "print(2)\n" }, changes)).toEqual({ kind: "refused", problems: ["code was changed after the edit"] });
    // Edits that follow a replace in the same edit are undone before it.
    const both = applied(surface, docs, edit("e1", [{ op: "replace", document: "code", path: "", value: "print(1)\n" }, on("code", "print(1)", "print(2)")]));
    expect(revert(surface, both.documents, both.edits[0]!.changes)).toEqual({ kind: "applied", documents: docs });
  });

  it("RS13.31 a revert whose result fails the schema or the check is refused, like any other proposal", () => {
    const checked = surfaceOf({ check: (t) => (t.includes("depth=2") ? undefined : "the depth is gone") });
    const done = applied(checked, docs, edit("e1", [on("code", "plan = think(task)", "plan = think(task, depth=2)")]));
    // Reverting removes the depth: the checked text no longer passes.
    expect(revert(checked, done.documents, done.edits[0]!.changes)).toEqual({ kind: "refused", problems: ["code fails its check: the depth is gone"] });
  });

  it("RS13.32 a change that does not fit its document is refused: a JSON-Patch op on a text document, or an edit on a JSON one", () => {
    const wrongOnText: Change = { document: "code", wrote: [{ op: "add", path: "/0", value: "x" }], inverse: [{ op: "remove", path: "/0" }] };
    expect(revert(surface, docs, [wrongOnText])).toEqual({ kind: "refused", problems: ["code was changed after the edit"] });
    const wrongPath: Change = { document: "code", wrote: [{ op: "replace", path: "/0", value: "x" }], inverse: [{ op: "replace", path: "/0", value: SOURCE }] };
    expect(revert(surface, { ...docs, code: "x" }, [wrongPath]).kind).toBe("refused");
    const nonString: Change = { document: "code", wrote: [{ op: "replace", path: "", value: "x" }], inverse: [{ op: "replace", path: "", value: 3 }] };
    expect(revert(surface, { ...docs, code: "x" }, [nonString]).kind).toBe("refused");
    const unpaired: Change = { document: "code", wrote: [], inverse: [{ op: "replace", path: "", value: "y" }] };
    expect(revert(surface, { ...docs, code: "x" }, [unpaired]).kind).toBe("refused");
    const wrongWrote: Change = { document: "code", wrote: [{ op: "edit", old: "a", new: "x" }], inverse: [{ op: "replace", path: "", value: "y" }] };
    expect(revert(surface, { ...docs, code: "x" }, [wrongWrote]).kind).toBe("refused");
    const onJson: Change = { document: "settings", wrote: [{ op: "edit", old: "a", new: "b" }], inverse: [{ op: "edit", old: "b", new: "a" }] };
    expect(revert(surface, docs, [onJson])).toEqual({ kind: "refused", problems: ["settings is JSON: an edit op applies to text documents"] });
  });

  it("RS13.33 a change with an unlocated context is refused, and one recorded without context is found by its text alone", () => {
    const bare: Change = { document: "code", wrote: [{ op: "edit", old: "x", new: "y" }], inverse: [{ op: "edit", old: "y", new: "x" }] };
    expect(revert(surface, { ...docs, code: "a y b" }, [bare])).toEqual({ kind: "applied", documents: { ...docs, code: "a x b" } });
    const empty: Change = { document: "code", wrote: [{ op: "edit", old: "x", new: "" }], inverse: [{ op: "edit", old: "", new: "x" }] };
    expect(revert(surface, { ...docs, code: "a b" }, [empty]).kind).toBe("refused");
  });

  it("RS13.34 several changes revert together, a text one and a JSON one, or none does", () => {
    const both = applied(surface, docs, edit("e1", [on("code", "act", "run"), { op: "replace", document: "settings", path: "/threshold", value: 0.9 }]));
    expect(revert(surface, both.documents, both.edits[0]!.changes)).toEqual({ kind: "applied", documents: docs });
    const half = { ...both.documents, settings: { threshold: 0.1, steps: ["plan"] } };
    expect(revert(surface, half, both.edits[0]!.changes)).toEqual({ kind: "refused", problems: ["settings/threshold was changed after the edit"] });
  });
});

describe("text documents: the leakage screen sees the text an edit adds", () => {
  const tasks = [
    { id: "fix-git", text: "Recover the lost commit from the reflog of the repository in /app and restore the branch named release-candidate" },
    { id: "t2", text: "Summarize the lease", reference: "The tenant must pay four thousand two hundred dollars by the first of March" },
  ];
  const wrote = (...ops: Change["wrote"]): Change[] => [{ document: "code", wrote: ops, inverse: [] }];

  it("RS13.35 text an edit adds is screened like an added JSON string: copied runs of words, a task's name, a credential", () => {
    expect(leaks(wrote({ op: "edit", old: "pass", new: "# recover the lost commit from the reflog of the repository" }), tasks, { ngram: 6 })).toEqual(['it repeats "recover the lost commit from the" from task fix-git']);
    expect(leaks(wrote({ op: "edit", old: "pass", new: "# the tenant must pay four thousand dollars" }), tasks, { ngram: 6 })).toEqual(['it repeats "the tenant must pay four thousand" from task t2']);
    expect(leaks(wrote({ op: "edit", old: "pass", new: "if task == 'fix-git': git_reflog()" }), tasks, { ngram: 6 })).toEqual(["it names task fix-git"]);
    expect(leaks(wrote({ op: "edit", old: "pass", new: "api_key = 'abcdefgh12345'" }), tasks, { ngram: 6 })).toEqual(["it carries a credential"]);
    expect(leaks(wrote({ op: "edit", old: "pass", new: "check that the requested files exist and the tests pass" }), tasks, { ngram: 6 })).toEqual([]);
  });

  it("RS13.36 a replaced whole text is screened, and what an edit removes adds nothing", () => {
    expect(leaks(wrote({ op: "replace", path: "", value: "# recover the lost commit from the reflog of the repository\n" }), tasks, { ngram: 6 })).toEqual(['it repeats "recover the lost commit from the" from task fix-git']);
    // The old text is what was removed: it may say anything.
    expect(leaks(wrote({ op: "edit", old: "recover the lost commit from the reflog of the repository fix-git", new: "pass" }), tasks, { ngram: 6 })).toEqual([]);
    expect(leaks(wrote({ op: "edit", old: "api_key = 'abcdefgh12345'", new: "" }), tasks, { ngram: 6 })).toEqual([]);
    // Context recorded for finding the edit again is not text the edit adds.
    expect(leaks(wrote({ op: "edit", old: "x", new: "", before: "recover the lost commit from the ", after: "reflog fix-git" }), tasks, { ngram: 6 })).toEqual([]);
    // Every edit of a change is screened.
    expect(leaks(wrote({ op: "edit", old: "a", new: "fine" }, { op: "edit", old: "b", new: "call fix-git" }), tasks, { ngram: 6 })).toEqual(["it names task fix-git"]);
  });

  it("RS13.37 a proposal's edit is screened as it was recorded", () => {
    const r = applied(surface, docs, edit("e1", [on("code", "plan = think(task)", "# recover the lost commit from the reflog of the repository")]));
    expect(leaks(r.edits[0]!.changes, tasks, { ngram: 6 })).toEqual(['it repeats "recover the lost commit from the" from task fix-git']);
  });
});

describe("text documents in a surface with JSON documents", () => {
  it("RS13.38 JSON documents behave as before next to text ones", () => {
    const r = applied(
      surface,
      docs,
      edit("e1", [
        { op: "add", document: "settings", path: "/steps/-", value: "verify" },
        { op: "replace", document: "settings", path: "/threshold", value: 0.7 },
      ]),
    );
    expect(r.documents["settings"]).toEqual({ threshold: 0.7, steps: ["plan", "verify"] });
    expect(r.edits[0]!.changes).toEqual([
      {
        document: "settings",
        wrote: [
          { op: "add", path: "/steps/1", value: "verify" },
          { op: "replace", path: "/threshold", value: 0.7 },
        ],
        inverse: [
          { op: "remove", path: "/steps/1" },
          { op: "replace", path: "/threshold", value: 0.5 },
        ],
      },
    ]);
    expect(revert(surface, r.documents, r.edits[0]!.changes)).toEqual({ kind: "applied", documents: docs });
    expect(problems(applyProposal(surface, docs, proposal(edit("e1", [{ op: "replace", document: "settings", path: "/threshold", value: "high" }])), 1))[0]).toMatch(/^settings no longer parses: /);
    // A JSON string is not a text document: JSON Patch still edits it, as before.
    const jsonStrings = defineSurface({ documents: { prose: { schema: z.string() } }, components: ["prompt"] });
    expect(applied(jsonStrings, { prose: "hello" }, edit("e1", [{ op: "replace", document: "prose", path: "", value: "bye" }])).documents["prose"]).toBe("bye");
    expect(problems(applyProposal(jsonStrings, { prose: "hello" }, proposal(edit("e1", [on("prose", "hello", "bye")])), 1))).toEqual(["edit e1 does not apply: prose is JSON: an edit op applies to text documents"]);
  });

  it("RS13.39 a saved state holding text changes parses, and states saved before text documents still parse", () => {
    const w = world({ n: 4, base: () => 0.5, code: true });
    const mechanism = { id: "r0A.e1", round: 0, hypothesis: "h", components: ["skill"], changes: [{ document: "code", wrote: [{ op: "edit", old: "a", new: "b", after: "c" }], inverse: [{ op: "edit", old: "b", new: "a", after: "c" }] }], lower: 0.1 };
    const legacy = { ...mechanism, changes: [{ document: "policy", wrote: [{ op: "add", path: "/rules/x", value: true }], inverse: [{ op: "remove", path: "/rules/x" }] }] };
    const measurement = { k: 1, score: 0.5, tasks: [], cost: 1000 };
    const state = { format: "harness.evolution/v1", round: 1, documents: { ...w.documents }, base: measurement, incumbent: [], observed: measurement, best: 0.5, trajectory: [0.5], drift: 0, records: [] };
    const parsed = (mechanisms: unknown[]) => StateSchema.safeParse({ ...state, mechanisms });
    expect(parsed([mechanism]).error?.message ?? "").not.toMatch(/edit/);
    expect(parsed([legacy]).error?.message ?? "").not.toMatch(/changes/);
    expect(parsed([mechanism]).success === parsed([legacy]).success).toBe(true);
  });
});

describe("text documents in an evolution run", () => {
  const first = { n: 40, base: () => 0, code: true, effects: { verify: (i: number) => (i < 20 ? 1 : 0), verify2: () => 1 } };
  const enable = (rule: string) => ({ summary: `enable ${rule}`, edits: [{ id: "e1", hypothesis: `${rule} helps`, targets: "failures", ops: [on("code", "# rules\n", `# rules\nenable ${rule}\n`)] }] });
  const noise = (r: { round: number; candidate: string }) => ({ summary: "noise", edits: [{ id: "e1", hypothesis: "noise", targets: "t", ops: [on("code", "mode = base", `mode = base${r.round}${r.candidate}`)] }] });
  const start = (w: ReturnType<typeof world>, s = settings()) => Evolution.start({ surface: w.surface, settings: s, split: w.split, documents: w.documents, ports: { evaluate: w.evaluate, entropy: new SeededEntropy(1) } });
  const ports = (w: ReturnType<typeof world>, propose: Parameters<typeof scripted>[0]) => ({ evaluate: w.evaluate, propose: scripted(propose).propose, entropy: new SeededEntropy(2) });
  const byCandidate = <T extends { candidate: string }>(records: readonly T[]) => Object.fromEntries(records.map((r) => [r.candidate, r]));

  it("RS13.40 a real text edit is accepted on a supported gain, recorded as a mechanism with its inverse, and its saved state loads again", async () => {
    const w = world(first);
    const e = await start(w);
    const report = await e.round(ports(w, (r) => (r.candidate === "A" && r.round === 0 ? enable("verify") : noise(r))));
    expect(report.accepted).toBe("A");
    expect(e.documents["code"]).toBe(`# harness code\n# rules\nenable verify\nmode = base\n`);
    expect(byCandidate(report.records)["A"]).toMatchObject({ outcome: "accepted", measured: { gain: 0.5, verdict: "supported" }, edits: [{ components: ["skill"], footprint: 1 }] });
    expect(e.mechanisms).toEqual([
      expect.objectContaining({
        id: "r0A.e1",
        components: ["skill"],
        changes: [{ document: "code", wrote: [{ op: "edit", old: "# rules\n", new: "# rules\nenable verify\n" }], inverse: [{ op: "edit", old: "# rules\nenable verify\n", new: "# rules\n" }] }],
      }),
    ]);
    const saved = JSON.parse(JSON.stringify(e.save()));
    const again = new Evolution({ surface: w.surface, settings: settings(), split: w.split, saved });
    expect(again.documents["code"]).toBe(e.documents["code"]);
    expect(again.mechanisms).toEqual(e.mechanisms);
  });

  it("RS13.41 a proposal whose text edit fails the host's check, or does not find its old text, is refused before any evaluation is spent", async () => {
    const w = world(first);
    const e = await start(w);
    const before = w.calls.length;
    const bad = {
      summary: "conflict",
      edits: [{ id: "e1", hypothesis: "h", targets: "t", ops: [on("code", "mode = base", "<<<<<<< HEAD")] }],
    };
    const missing = { summary: "missing", edits: [{ id: "e1", hypothesis: "h", targets: "t", ops: [on("code", "mode = other", "x")] }] };
    const report = await e.round(ports(w, (r) => (r.candidate === "A" ? bad : missing)));
    expect(byCandidate(report.records)["A"]).toMatchObject({ outcome: "screened", reason: expect.stringMatching(/code fails its check: it holds a merge conflict marker/) });
    expect(byCandidate(report.records)["B"]).toMatchObject({ outcome: "screened", reason: expect.stringMatching(/the old text is not in code: "mode = other"/) });
    expect(w.calls.length - before).toBeLessThanOrEqual(1); // at most the incumbent's re-measurement
  });

  it("RS13.42 an accepted text mechanism that earns nothing is ablated: its text is taken out and the removal accepted", async () => {
    const w = world({ ...first, effects: { verify: (i: number) => (i < 20 ? 1 : 0), fluff: () => 0 } });
    const e = await start(w);
    const propose = (r: { candidate: string; round: number }) =>
      r.round === 0 && r.candidate === "A"
        ? {
            summary: "two",
            edits: [
              { id: "e1", hypothesis: "verify", targets: "t", ops: [on("code", "# rules", "# rules\nenable verify")] },
              { id: "e2", hypothesis: "fluff", targets: "t", ops: [on("code", "mode = base", "mode = base\nenable fluff")] },
            ],
          }
        : noise(r);
    await e.round(ports(w, propose));
    expect(e.mechanisms.map((m) => m.id)).toEqual(["r0A.e1", "r0A.e2"]);
    expect(e.documents["code"]).toBe("# harness code\n# rules\nenable verify\nmode = base\nenable fluff\n");
    let removed: string | undefined;
    for (let i = 0; i < 4 && removed === undefined; i++) {
      const report = await e.round(ports(w, (r) => noise(r)));
      const prune = byCandidate(report.records)["P"];
      if (prune?.outcome === "accepted") removed = prune.edits[0]!.id;
    }
    expect(removed).toBe("r0A.e2");
    expect(e.documents["code"]).toBe("# harness code\n# rules\nenable verify\nmode = base\n");
    expect(e.mechanisms.map((m) => m.id)).toEqual(["r0A.e1"]);
  });

  it("RS13.43 an accepted text mechanism that a later edit rewrote is entangled: revert refuses, and it is not ablated on its own", async () => {
    const w = world({ ...first, effects: { verify: (i: number) => (i < 10 ? 1 : 0), verify2: () => 1 } });
    const s = settings({ prune: { after: 1, every: 1 } });
    const e = await start(w, s);
    await e.round(ports(w, (r) => (r.candidate === "A" && r.round === 0 ? enable("verify") : noise(r))));
    expect(e.mechanisms.map((m) => m.id)).toEqual(["r0A.e1"]);
    // A later edit rewrites the line the mechanism wrote, and is accepted for its own gain.
    const rewrite = { summary: "rewrite", edits: [{ id: "e1", hypothesis: "verify2 is stronger", targets: "t", ops: [on("code", "enable verify\n", "enable verify2\n")] }] };
    const report = await e.round(ports(w, (r) => (r.candidate === "A" && r.round === 1 ? rewrite : noise(r))));
    expect(report.accepted).toBe("A");
    expect(e.documents["code"]).toBe("# harness code\n# rules\nenable verify2\nmode = base\n");
    expect(revert(w.surface, e.documents, e.mechanisms[0]!.changes)).toEqual({ kind: "refused", problems: ["code was changed after the edit"] });
    const next = await e.round(ports(w, (r) => noise(r)));
    expect(e.mechanisms[0]!.entangled).toBe(true);
    expect(byCandidate(next.records)["P"]).toBeUndefined();
  });
});
