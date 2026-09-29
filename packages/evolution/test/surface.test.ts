import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyProposal, defineSurface, leaks, revert } from "@harness/evolution";
import type { Proposal } from "@harness/evolution";

const Settings = z.strictObject({ system: z.string().min(1), threshold: z.number().min(0).max(1), steps: z.array(z.string()) });
const surface = defineSurface({
  documents: {
    settings: { schema: Settings },
    book: { schema: z.strictObject({ scripts: z.array(z.strictObject({ name: z.string(), reply: z.string() })) }), classify: (path) => (path.startsWith("/scripts") ? "skill" : "config") },
    free: { schema: z.record(z.string(), z.string()) },
  },
  components: ["prompt", "config", "skill"],
  structural: ["skill"],
});
const docs = { settings: { system: "Be brief.", threshold: 0.5, steps: ["plan"] }, book: { scripts: [] }, free: { a: "1", ab: "2" } };

const edit = (id: string, ops: Proposal["edits"][number]["ops"], extra: Partial<Proposal["edits"][number]> = {}) => ({ id, hypothesis: `h ${id}`, targets: "mode", predicted: [], ops, ...extra });
const proposal = (...edits: Proposal["edits"]): Proposal => ({ summary: "s", edits });

describe("the harness as data, edited by JSON Patch", () => {
  it("RS5.1 edits apply to a copy, and each records what it changed, its components and its size", () => {
    const r = applyProposal(
      surface,
      docs,
      proposal(
        edit("e1", [{ op: "replace", document: "settings", path: "/system", value: "Be brief. Check the output before finishing." }]),
        edit("e2", [{ op: "add", document: "book", path: "/scripts/-", value: { name: "greet", reply: "Hello." } }]),
      ),
      2,
    );
    if (r.kind !== "applied") throw new Error(r.problems.join("; "));
    expect(docs.settings.system).toBe("Be brief.");
    expect(r.documents).toEqual({ ...docs, settings: { ...docs.settings, system: "Be brief. Check the output before finishing." }, book: { scripts: [{ name: "greet", reply: "Hello." }] } });
    expect(r.edits.map((e) => [e.id, e.components, e.footprint])).toEqual([
      ["e1", ["prompt"], 1],
      ["e2", ["skill"], 2],
    ]);
    expect(r.edits[1]!.changes[0]).toEqual({ document: "book", wrote: [{ op: "add", path: "/scripts/0", value: { name: "greet", reply: "Hello." } }], inverse: [{ op: "remove", path: "/scripts/0" }] });
  });

  it("RS5.2 the budget counts edits, and an edit must change something: an empty or inert proposal is refused", () => {
    const one = edit("e1", [{ op: "replace", document: "settings", path: "/threshold", value: 0.6 }]);
    const two = edit("e2", [{ op: "replace", document: "settings", path: "/system", value: "x" }]);
    expect(applyProposal(surface, docs, proposal(one, two), 1)).toEqual({ kind: "refused", problems: ["2 edits, more than this round's budget of 1"] });
    expect(applyProposal(surface, docs, proposal(), 1)).toEqual({ kind: "refused", problems: ["no edits"] });
    expect(applyProposal(surface, docs, proposal(edit("e1", [{ op: "replace", document: "settings", path: "/threshold", value: 0.5 }])), 1)).toEqual({ kind: "refused", problems: ["edit e1 changes nothing"] });
  });

  it("RS5.3 edits that touch the same part are not independent, and ids are unique: the L0 count is computed, not declared", () => {
    const r = applyProposal(
      surface,
      docs,
      proposal(edit("e1", [{ op: "replace", document: "settings", path: "/steps", value: ["a"] }]), edit("e2", [{ op: "add", document: "settings", path: "/steps/0", value: "b" }]), edit("e1", [{ op: "replace", document: "book", path: "", value: { scripts: [] } }])),
      3,
    );
    expect(r).toEqual({ kind: "refused", problems: ["edit ids repeat: e1", "edits e1 and e2 both touch settings/steps: they are one edit, or not independent"] });
    // A root path overlaps everything in its document; paths that merely share a prefix do not overlap.
    const root = applyProposal(surface, docs, proposal(edit("a", [{ op: "replace", document: "book", path: "", value: { scripts: [] } }]), edit("b", [{ op: "add", document: "book", path: "/scripts/-", value: { name: "n", reply: "r" } }])), 2);
    expect(root).toEqual({ kind: "refused", problems: ["edits a and b both touch book: they are one edit, or not independent"] });
    const prefix = applyProposal(surface, docs, proposal(edit("a", [{ op: "replace", document: "free", path: "/a", value: "3" }]), edit("b", [{ op: "replace", document: "free", path: "/ab", value: "4" }])), 2);
    expect(prefix.kind === "applied" && prefix.documents["free"]).toEqual({ a: "3", ab: "4" });
  });

  it("RS5.4 an edit that cannot apply, names an unknown document, or leaves a document its schema refuses is refused (the liveness check)", () => {
    const r = applyProposal(
      surface,
      docs,
      proposal(
        edit("e1", [{ op: "replace", document: "settings", path: "/missing/deep", value: 1 }]),
        edit("e2", [{ op: "replace", document: "nowhere", path: "/x", value: 1 }]),
        edit("e3", [{ op: "replace", document: "settings", path: "/threshold", value: 2 }]),
      ),
      3,
    );
    expect(r.kind).toBe("refused");
    const problems = r.kind === "refused" ? r.problems : [];
    expect(problems[0]).toMatch(/^edit e1 does not apply: /);
    expect(problems[1]).toBe("edit e2 names no document of the surface: nowhere");
    expect(problems[2]).toMatch(/^settings no longer parses: [\s\S]*threshold/);
    expect(problems).toHaveLength(3);
  });

  it("RS5.5 an accepted edit can be reverted while what it wrote is still there; not once something later rewrote it", () => {
    const applied = applyProposal(surface, docs, proposal(edit("e1", [{ op: "replace", document: "settings", path: "/system", value: "Longer." }, { op: "add", document: "settings", path: "/steps/-", value: "verify" }])), 1);
    if (applied.kind !== "applied") throw new Error("not applied");
    const [e1] = applied.edits;
    expect(revert(surface, applied.documents, e1!.changes)).toEqual({ kind: "applied", documents: docs });
    const rewritten = { ...applied.documents, settings: { ...(applied.documents["settings"] as object), system: "Rewritten." } };
    expect(revert(surface, rewritten, e1!.changes)).toEqual({ kind: "refused", problems: ["settings/system was changed after the edit"] });
    const removed = { ...applied.documents, settings: { system: "Longer.", threshold: 0.5, steps: ["plan"] } };
    expect(revert(surface, removed, e1!.changes)).toEqual({ kind: "refused", problems: ["settings/steps/1 was changed after the edit"] });
  });

  it("RS5.6 a removal records its old value, so reverting it restores it; the default classifier reads strings as prompts and the rest as configuration", () => {
    const applied = applyProposal(surface, docs, proposal(edit("e1", [{ op: "remove", document: "settings", path: "/steps/0" }]), edit("e2", [{ op: "replace", document: "settings", path: "/threshold", value: 0.7 }])), 2);
    if (applied.kind !== "applied") throw new Error("not applied");
    expect(applied.edits.map((e) => e.components)).toEqual([["prompt"], ["config"]]);
    expect(revert(surface, applied.documents, applied.edits[0]!.changes)).toEqual({ kind: "applied", documents: { ...docs, settings: { ...docs.settings, threshold: 0.7 } } });
    const readded = { ...applied.documents, settings: { ...(applied.documents["settings"] as object), steps: ["other"] } };
    expect(revert(surface, readded, applied.edits[0]!.changes).kind).toBe("refused");
  });

  it("RS5.7 a surface's classifier must answer with one of its components", () => {
    const bad = defineSurface({ documents: { settings: { schema: Settings, classify: () => "memory" } }, components: ["prompt"] });
    expect(applyProposal(bad, docs, proposal(edit("e1", [{ op: "replace", document: "settings", path: "/threshold", value: 0.6 }])), 1)).toEqual({ kind: "refused", problems: ["edit e1 changes settings/threshold, which the surface classifies as memory, not one of prompt"] });
    expect(() => defineSurface({ documents: {}, components: ["prompt"], structural: ["skill"] })).toThrow(/structural components must be components: skill/);
    expect(() => defineSurface({ documents: {}, components: [] })).toThrow(/at least one component/);
  });
});

describe("the leakage screen", () => {
  const tasks = [
    { id: "fix-git", text: "Recover the lost commit from the reflog of the repository in /app and restore the branch named release-candidate" },
    { id: "t2", text: "Summarize the lease", reference: "The tenant must pay four thousand two hundred dollars by the first of March" },
  ];
  const added = (text: string) => [{ document: "settings", wrote: [{ op: "replace" as const, path: "/system", value: { nested: [text] } }], inverse: [] }];

  it("RS6.1 an edit repeating a run of words from an evolve task, or from its reference answer, leaks it", () => {
    expect(leaks(added("When stuck, recover the lost commit from the reflog of the repository."), tasks, { ngram: 6 })).toEqual(['it repeats "recover the lost commit from the" from task fix-git']);
    expect(leaks(added("Answer: the tenant must pay four thousand two hundred dollars."), tasks, { ngram: 6 })).toEqual(['it repeats "the tenant must pay four thousand" from task t2']);
  });

  it("RS6.2 an edit naming a task, or carrying a credential, leaks; general practice does not", () => {
    expect(leaks(added("If the task is fix-git, use git reflog."), tasks, { ngram: 6 })).toEqual(["it names task fix-git"]);
    expect(leaks(added("use api_key = 'abcdefgh12345'"), tasks, { ngram: 6 })).toEqual(["it carries a credential"]);
    expect(leaks(added("Before finishing, check that the requested files exist and the tests pass."), tasks, { ngram: 6 })).toEqual([]);
    // Short runs of common words are not leakage, and removals add nothing.
    expect(leaks(added("recover the lost commit"), tasks, { ngram: 6 })).toEqual([]);
    expect(leaks([{ document: "settings", wrote: [{ op: "remove", path: "/system" }], inverse: [] }], tasks, { ngram: 6 })).toEqual([]);
  });
});
