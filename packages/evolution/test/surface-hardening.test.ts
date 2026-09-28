import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyProposal, defineSurface, Evolution, leaks, revert } from "@harness/evolution";
import type { Change, Documents, Proposal } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { score } from "@harness/evolution";
import { settings } from "./world.ts";

type Ops = Proposal["edits"][number]["ops"];

const surface = defineSurface({
  documents: { cfg: { schema: z.any() }, other: { schema: z.any() }, t: { kind: "text" } },
  components: ["prompt", "config"],
});
const edit = (id: string, ops: Ops) => ({ id, hypothesis: `h ${id}`, targets: "mode", predicted: [], ops });
const proposal = (...edits: Proposal["edits"]): Proposal => ({ summary: "s", edits });
const apply = (documents: Documents, ...edits: Ops[]) => applyProposal(surface, documents, proposal(...edits.map((ops, i) => edit(`e${i}`, ops))), edits.length + 1);
const problems = (r: ReturnType<typeof applyProposal>) => (r.kind === "refused" ? r.problems : []);
const done = (documents: Documents, ...edits: Ops[]) => {
  const r = apply(documents, ...edits);
  if (r.kind !== "applied") throw new Error(r.problems.join("; "));
  return r;
};
const add = (path: string, value: unknown, document = "cfg") => ({ op: "add" as const, document, path, value: value as never });
const replace = (path: string, value: unknown, document = "cfg") => ({ op: "replace" as const, document, path, value: value as never });
const remove = (path: string, document = "cfg") => ({ op: "remove" as const, document, path });
const on = (old: string, replacement: string, document = "t") => ({ op: "edit" as const, document, old, new: replacement });

describe("revert is total: it refuses, it never throws", () => {
  const base = { cfg: { a: { b: 1 }, c: 1 }, other: {}, t: "x" };

  it("RS18.1 a written path whose parent was removed later is refused as changed after the edit", () => {
    const m1 = done(base, [add("/a/n", 5)]);
    const m2 = applyProposal(surface, m1.documents, proposal(edit("f", [remove("/a")])), 1);
    if (m2.kind !== "applied") throw new Error("not applied");
    expect(m2.documents["cfg"]).toEqual({ c: 1 });
    expect(revert(surface, m2.documents, m1.edits[0]!.changes)).toEqual({ kind: "refused", problems: ["cfg/a/n was changed after the edit"] });
  });

  it("RS18.2 a parent replaced by null, a string, a number or an array is refused, too", () => {
    const m1 = done(base, [add("/a/n", 5)]);
    for (const parent of [null, "s", 7, [1], true]) {
      const docs = { ...m1.documents, cfg: { a: parent, c: 1 } };
      expect(revert(surface, docs, m1.edits[0]!.changes)).toEqual({ kind: "refused", problems: ["cfg/a/n was changed after the edit"] });
    }
    // The document itself is no longer a container.
    expect(revert(surface, { ...m1.documents, cfg: null }, m1.edits[0]!.changes)).toEqual({ kind: "refused", problems: ["cfg/a/n was changed after the edit"] });
  });

  it("RS18.3 the removal of a value whose parent is gone cannot be taken back, and says so", () => {
    const m1 = done(base, [remove("/a/b")]);
    for (const docs of [{ ...m1.documents, cfg: { c: 1 } }, { ...m1.documents, cfg: { a: 3, c: 1 } }]) expect(revert(surface, docs, m1.edits[0]!.changes)).toEqual({ kind: "refused", problems: ["cfg/a/b was changed after the edit"] });
    // A removed key that a later edit put back (whatever it holds now) is refused.
    expect(revert(surface, { ...m1.documents, cfg: { a: { b: 9 }, c: 1 } }, m1.edits[0]!.changes)).toEqual({ kind: "refused", problems: ["cfg/a/b was changed after the edit"] });
  });

  it("RS18.4 a change naming a document that is on Object.prototype, or not of the surface, is refused", () => {
    for (const document of ["toString", "constructor", "hasOwnProperty", "nowhere"]) {
      const change: Change = { document, wrote: [{ op: "add", path: "/x", value: 1 }], inverse: [{ op: "remove", path: "/x" }] };
      expect(revert(surface, base, [change])).toEqual({ kind: "refused", problems: [`${document} is not a document of the surface`] });
    }
    // A document of the surface that the documents lack.
    const change: Change = { document: "other", wrote: [{ op: "add", path: "/x", value: 1 }], inverse: [{ op: "remove", path: "/x" }] };
    expect(revert(surface, { cfg: {}, t: "" }, [change])).toEqual({ kind: "refused", problems: ["other is not a document of the surface"] });
  });

  it("RS18.5 an evolution round with a mechanism whose parent a later accepted mechanism removed does not throw: it is entangled", async () => {
    const policy = z.object({ skills: z.array(z.object({ name: z.string(), desc: z.string() })) });
    const s = defineSurface({ documents: { policy: { schema: policy } }, components: ["prompt", "config"] });
    const config = settings({ rounds: 6, trials: 2, candidates: 1, budget: { min: 1, max: 2 }, explore: { window: 2, reserved: 0 }, repair: 0 });
    const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, text: `task number ${i}` }));
    const evaluate = async (_d: unknown, ts: readonly { id: string }[], k: number) => ts.map((t) => ({ task: t.id, trials: Array.from({ length: k }, () => ({ reward: score(0.5) })) }));
    const base = { policy: { skills: [{ name: "a", desc: "d" }, { name: "b", desc: "d" }] } };
    const e0 = await Evolution.start({ surface: s, settings: config, split: { evolve: tasks }, documents: base, ports: { evaluate, entropy: new SeededEntropy(1) } });
    const first = applyProposal(s, base, proposal(edit("m1", [replace("/skills/1/desc", "better", "policy")])), 3);
    if (first.kind !== "applied") throw new Error("m1");
    const second = applyProposal(s, first.documents, proposal(edit("m2", [remove("/skills/1", "policy")])), 3);
    if (second.kind !== "applied") throw new Error("m2");
    const saved = structuredClone(e0.save()) as Record<string, unknown>;
    saved["documents"] = second.documents;
    saved["mechanisms"] = [first, second].map((r, i) => ({ id: `r${i}A.m${i + 1}`, round: i, hypothesis: `h${i}`, components: r.edits[0]!.components, changes: r.edits[0]!.changes, lower: 0.1 }));
    saved["round"] = 3;
    const e = new Evolution({ surface: s, settings: config, split: { evolve: tasks }, saved: saved as never });
    const report = await e.round({ evaluate, propose: async () => "no", entropy: new SeededEntropy(2) });
    expect(report.round).toBe(3);
    expect(e.mechanisms.find((m) => m.id === "r0A.m1")!.entangled).toBe(true);
    expect(e.mechanisms.find((m) => m.id === "r1A.m2")!.entangled).toBeUndefined();
  });
});

describe("malformed proposals are refused, not thrown", () => {
  const base = { cfg: { a: 1 }, other: {}, t: "x" };

  it("RS18.6 the root of a JSON document cannot be removed", () => {
    expect(apply(base, [remove("")])).toEqual({ kind: "refused", problems: ["edit e0 does not apply: the root of cfg cannot be removed"] });
  });

  it("RS18.7 the root of a JSON document that is an object or an array must stay one: a replace or add of null, a string, a number, a boolean is refused", () => {
    for (const value of [null, "s", 5, true]) {
      for (const op of [replace("", value), add("", value)]) expect(apply(base, [op])).toEqual({ kind: "refused", problems: ["edit e0 does not apply: the root of cfg must stay an object or an array"] });
    }
  });

  it("RS18.8 the root can be replaced by another object or by an array; the change records it and it reverts", () => {
    const r = done(base, [replace("", [1, 2])]);
    expect(r.documents["cfg"]).toEqual([1, 2]);
    expect(r.edits[0]!.changes).toEqual([{ document: "cfg", wrote: [{ op: "replace", path: "", value: [1, 2] }], inverse: [{ op: "replace", path: "", value: { a: 1 } }] }]);
    expect(r.edits[0]!.footprint).toBe(2);
    expect(revert(surface, r.documents, r.edits[0]!.changes)).toEqual({ kind: "applied", documents: base });
    const viaAdd = done(base, [add("", { z: [] })]);
    expect(viaAdd.documents["cfg"]).toEqual({ z: [] });
    expect(revert(surface, { ...base, cfg: { z: [1] } }, viaAdd.edits[0]!.changes)).toEqual({ kind: "refused", problems: ["cfg was changed after the edit"] });
    expect(apply(base, [replace("", { a: 1 })])).toEqual({ kind: "refused", problems: ["edit e0 changes nothing"] });
    // A root that is a scalar may be replaced by any value, and by a container (and gets its old value back).
    expect(done({ ...base, cfg: "s" }, [replace("", null)]).documents["cfg"]).toBeNull();
    expect(problems(apply({ ...base, cfg: "s" }, [replace("", "s")]))).toEqual(["edit e0 changes nothing"]);
    const scalar = done({ ...base, cfg: "s" }, [replace("", { a: 1 })]);
    expect(scalar.edits[0]!.changes[0]!.inverse).toEqual([{ op: "replace", path: "", value: "s" }]);
    expect(revert(surface, scalar.documents, scalar.edits[0]!.changes)).toEqual({ kind: "applied", documents: { ...base, cfg: "s" } });
    // ...and no path resolves in it.
    expect(problems(apply({ ...base, cfg: "s" }, [add("/x", 1)]))).toEqual(["edit e0 does not apply: cannot add at /x: its parent does not exist"]);
  });

  it("RS18.9 a document named like an Object.prototype key is not a document of the surface, alone or beside another edit", () => {
    for (const document of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(apply(base, [add("/x", 1, document)])).toEqual({ kind: "refused", problems: [`edit e0 names no document of the surface: ${document}`] });
      expect(apply(base, [add("/x", 1, document)], [add("/x", 1, document)]).kind).toBe("refused");
      expect(problems(apply(base, [on("a", "b", document)], [replace("", { a: 2 })]))).toEqual([`edit e0 names no document of the surface: ${document}`]);
    }
  });

  it("RS18.10 a document of the surface that the documents lack is refused as naming none", () => {
    expect(apply({ cfg: {}, t: "" }, [add("/x", 1, "other")])).toEqual({ kind: "refused", problems: ["edit e0 names no document of the surface: other"] });
  });

  it("RS18.11 replace and remove on a key only Object.prototype has are refused, and add creates an own key without touching the prototype", () => {
    expect(problems(apply(base, [replace("/toString", 5)]))).toEqual(["edit e0 does not apply: cannot replace at /toString: there is nothing there"]);
    expect(problems(apply(base, [remove("/toString")]))).toEqual(["edit e0 does not apply: cannot remove at /toString: there is nothing there"]);
    expect(problems(apply(base, [remove("/constructor")]))).toEqual(["edit e0 does not apply: cannot remove at /constructor: there is nothing there"]);
    const r = done(base, [add("/toString", 5)]);
    const cfg = r.documents["cfg"] as Record<string, unknown>;
    expect(Object.hasOwn(cfg, "toString")).toBe(true);
    expect(cfg["toString"]).toBe(5);
    expect(r.edits[0]!.changes[0]).toEqual({ document: "cfg", wrote: [{ op: "add", path: "/toString", value: 5 }], inverse: [{ op: "remove", path: "/toString" }] });
    expect(revert(surface, r.documents, r.edits[0]!.changes)).toEqual({ kind: "applied", documents: base });
  });

  it("RS18.12 a path through __proto__ or an inherited key is refused and pollutes nothing", () => {
    expect(problems(apply(base, [add("/__proto__/x", 1)]))).toEqual(["edit e0 does not apply: modifying __proto__ is not allowed"]);
    expect(problems(apply(base, [add("/__proto__", 1)]))).toEqual(["edit e0 does not apply: modifying __proto__ is not allowed"]);
    expect(problems(apply(base, [add("/constructor/prototype/x", 1)]))).toEqual(["edit e0 does not apply: cannot add at /constructor/prototype/x: its parent does not exist"]);
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
    expect(Object.getPrototypeOf(base.cfg)).toBe(Object.prototype);
  });

  it("RS18.13 a path that is not a JSON pointer, or names an array index that is not one, is refused with a reason", () => {
    expect(problems(apply(base, [add("x", 1)]))).toEqual(['edit e0 does not apply: "x" is not a JSON pointer']);
    const arr = { ...base, cfg: { arr: ["a", "b"] } };
    expect(problems(apply(arr, [add("/arr/01", "z")]))).toEqual(["edit e0 does not apply: cannot add at /arr/01: the index is not valid"]);
    expect(problems(apply(arr, [add("/arr/x", "z")]))).toEqual(["edit e0 does not apply: cannot add at /arr/x: the index is not valid"]);
    expect(problems(apply(arr, [add("/arr/3", "z")]))).toEqual(["edit e0 does not apply: cannot add at /arr/3: the index is out of range"]);
    expect(problems(apply(arr, [replace("/arr/2", "z")]))).toEqual(["edit e0 does not apply: cannot replace at /arr/2: the index is out of range"]);
    expect(problems(apply(arr, [remove("/arr/-")]))).toEqual(["edit e0 does not apply: cannot remove at /arr/-: the index is not valid"]);
    expect(problems(apply(arr, [replace("/arr/-", "z")]))).toEqual(["edit e0 does not apply: cannot replace at /arr/-: the index is not valid"]);
    expect(problems(apply(arr, [remove("/arr/2")]))).toEqual(["edit e0 does not apply: cannot remove at /arr/2: the index is out of range"]);
    expect(problems(apply(arr, [remove("/nowhere")]))).toEqual(["edit e0 does not apply: cannot remove at /nowhere: there is nothing there"]);
    // An escaped key is one segment.
    const keyed = done({ ...base, cfg: { "a/b": { "c~d": 1 } } }, [replace("/a~1b/c~0d", 2)]);
    expect(keyed.documents["cfg"]).toEqual({ "a/b": { "c~d": 2 } });
    expect(keyed.edits[0]!.changes[0]!.wrote).toEqual([{ op: "replace", path: "/a~1b/c~0d", value: 2 }]);
  });
});

describe("JSON arrays: independence and recorded changes follow the ops, not positions", () => {
  const arr = { cfg: { arr: ["alpha", "beta", "gamma", "delta"] }, other: {}, t: "x" };
  const clash = "edits e0 and e1 both touch cfg/arr: they are one edit, or not independent";

  it("RS18.14 an append and an edit of the index that append will take are not independent", () => {
    const r = apply({ ...arr, cfg: { arr: ["a", "b", "c"] } }, [add("/arr/-", "Z")], [replace("/arr/3", "Y")]);
    expect(r).toEqual({ kind: "refused", problems: [clash] });
  });

  it("RS18.15 an insert at the front and an edit of a later index are not independent (either order)", () => {
    expect(apply(arr, [add("/arr/0", "Z")], [replace("/arr/2", "C")])).toEqual({ kind: "refused", problems: [clash] });
    expect(apply(arr, [replace("/arr/2", "C")], [add("/arr/0", "Z")])).toEqual({ kind: "refused", problems: [clash] });
  });

  it("RS18.16 any two ops under one array overlap: two indices, an index and a remove, a nested path through an index, and the array itself", () => {
    expect(apply(arr, [replace("/arr/0", "A")], [replace("/arr/1", "B")])).toEqual({ kind: "refused", problems: [clash] });
    expect(apply(arr, [remove("/arr/0")], [remove("/arr/3")])).toEqual({ kind: "refused", problems: [clash] });
    expect(apply(arr, [add("/arr/-", "x")], [add("/arr/-", "y")])).toEqual({ kind: "refused", problems: [clash] });
    expect(apply(arr, [replace("/arr", ["z"])], [replace("/arr/1", "B")])).toEqual({ kind: "refused", problems: [clash] });
    const nested = { cfg: { arr: [{ name: "a" }, { name: "b" }] }, other: {}, t: "x" };
    expect(apply(nested, [replace("/arr/0/name", "A")], [replace("/arr/1/name", "B")])).toEqual({ kind: "refused", problems: [clash] });
    expect(apply(nested, [replace("/arr/0/name", "A")], [add("/arr/-", { name: "c" })])).toEqual({ kind: "refused", problems: [clash] });
  });

  it("RS18.17 arrays that are not the same array, and numeric keys of an object, stay independent", () => {
    const two = { cfg: { a: ["x"], b: ["y"], keyed: { "1": "one", "2": "two" }, deep: { list: [{ n: 1 }] } }, other: {}, t: "x" };
    const r = done(two, [replace("/a/0", "X")], [replace("/b/0", "Y")], [replace("/keyed/1", "1!")], [replace("/keyed/2", "2!")], [replace("/deep/list/0/n", 2)]);
    expect(r.documents["cfg"]).toEqual({ a: ["X"], b: ["Y"], keyed: { "1": "1!", "2": "2!" }, deep: { list: [{ n: 2 }] } });
    // The same array in two documents is two arrays.
    expect(done({ ...two, other: { a: ["x"] } }, [replace("/a/0", "X")], [replace("/a/0", "Y", "other")]).edits).toHaveLength(2);
  });

  it("RS18.18 a path through a numeric segment or - of a part that does not exist yet counts as an array index", () => {
    expect(apply(base(), [add("/new/0", 1)], [add("/new/1", 2)])).toEqual({ kind: "refused", problems: ["edits e0 and e1 both touch cfg/new: they are one edit, or not independent"] });
    expect(apply(base(), [add("/new/-", 1)], [add("/new/0", 2)])).toEqual({ kind: "refused", problems: ["edits e0 and e1 both touch cfg/new: they are one edit, or not independent"] });
    expect(apply(base(), [add("/new/0/deep", 1)], [add("/new/1/deep", 2)]).kind).toBe("refused");
    // Missing keys that are not numbers are independent (the ops fail on their own: there is no parent).
    expect(problems(apply(base(), [add("/p/k", 1)], [add("/q/k", 2)]))).toEqual(["edit e0 does not apply: cannot add at /p/k: its parent does not exist", "edit e1 does not apply: cannot add at /q/k: its parent does not exist"]);
    // A numeric-looking key of an existing object is a key.
    expect(apply({ cfg: { o: { "5": {} } }, other: {}, t: "" }, [add("/o/5/x", 1)], [add("/o/6", 1)]).kind).toBe("applied");
    function base() {
      return { cfg: { o: {} }, other: {}, t: "x" };
    }
  });

  it("RS18.45 an index equal to the length appends; the path of a resolved append escapes the keys above it; a key named like a prototype is copied as a key", () => {
    const keyed = { cfg: { "a/b~c": ["x", "y"] }, other: {}, t: "x" };
    const appended = done(keyed, [add("/a~1b~0c/-", "z")]);
    expect(appended.edits[0]!.changes[0]).toEqual({ document: "cfg", wrote: [{ op: "add", path: "/a~1b~0c/2", value: "z" }], inverse: [{ op: "remove", path: "/a~1b~0c/2" }] });
    expect(revert(surface, appended.documents, appended.edits[0]!.changes)).toEqual({ kind: "applied", documents: keyed });
    expect(done(keyed, [add("/a~1b~0c/2", "z")]).documents["cfg"]).toEqual({ "a/b~c": ["x", "y", "z"] });
    // A document read from JSON may hold a key named __proto__: it is copied as a key, and the copy has no prototype of it.
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "n": 1}') as Record<string, unknown>;
    const copy = done({ ...keyed, cfg: parsed }, [replace("/n", 2)]).documents["cfg"] as Record<string, unknown>;
    expect(Object.hasOwn(copy, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(copy["n"]).toBe(2);
  });

  it("RS18.19 inserting one element at the front of a 4-element array writes one add: its footprint is the inserted value's leaves", () => {
    const r = done(arr, [add("/arr/0", "new")]);
    expect(r.documents["cfg"]).toEqual({ arr: ["new", "alpha", "beta", "gamma", "delta"] });
    expect(r.edits[0]!.footprint).toBe(1);
    expect(r.edits[0]!.components).toEqual(["prompt"]);
    expect(r.edits[0]!.changes).toEqual([{ document: "cfg", wrote: [{ op: "add", path: "/arr/0", value: "new" }], inverse: [{ op: "remove", path: "/arr/0" }] }]);
    const object = done(arr, [add("/arr/0", { a: "x", b: [1, 2] })]);
    expect(object.edits[0]!.footprint).toBe(3);
    expect(object.edits[0]!.components).toEqual(["config"]);
  });

  it("RS18.20 an append records the index it took, a removal records its old value, a replace its old value", () => {
    const appended = done(arr, [add("/arr/-", "omega")]);
    expect(appended.edits[0]!.changes[0]).toEqual({ document: "cfg", wrote: [{ op: "add", path: "/arr/4", value: "omega" }], inverse: [{ op: "remove", path: "/arr/4" }] });
    const removed = done(arr, [remove("/arr/1")]);
    expect(removed.documents["cfg"]).toEqual({ arr: ["alpha", "gamma", "delta"] });
    expect(removed.edits[0]!.changes[0]).toEqual({ document: "cfg", wrote: [{ op: "remove", path: "/arr/1", length: 3 }], inverse: [{ op: "add", path: "/arr/1", value: "beta" }] });
    expect(removed.edits[0]!.footprint).toBe(1);
    const replaced = done(arr, [replace("/arr/3", "DELTA")]);
    expect(replaced.edits[0]!.changes[0]).toEqual({ document: "cfg", wrote: [{ op: "replace", path: "/arr/3", value: "DELTA" }], inverse: [{ op: "replace", path: "/arr/3", value: "delta" }] });
    // The footprint of a removal is the leaves it removed; an emptied object counts as one.
    const big = done({ ...arr, cfg: { obj: { a: 1, b: { c: 2, d: 3 }, e: {} } } }, [remove("/obj")]);
    expect(big.edits[0]!.footprint).toBe(4);
  });

  it("RS18.21 the ops of one edit are recorded one by one, with the indices they saw, and revert in reverse to the original", () => {
    const r = done(arr, [add("/arr/0", "Z"), add("/arr/-", "Y"), replace("/arr/2", "BETA"), remove("/arr/1")]);
    expect(r.documents["cfg"]).toEqual({ arr: ["Z", "BETA", "gamma", "delta", "Y"] });
    expect(r.edits[0]!.changes[0]).toEqual({
      document: "cfg",
      wrote: [
        { op: "add", path: "/arr/0", value: "Z" },
        { op: "add", path: "/arr/5", value: "Y" },
        { op: "replace", path: "/arr/2", value: "BETA" },
        { op: "remove", path: "/arr/1", length: 5 },
      ],
      // The inverse at each position undoes the write at that position; they are applied last to first.
      inverse: [
        { op: "remove", path: "/arr/0" },
        { op: "remove", path: "/arr/5" },
        { op: "replace", path: "/arr/2", value: "beta" },
        { op: "add", path: "/arr/1", value: "alpha" },
      ],
    });
    expect(r.edits[0]!.footprint).toBe(4);
    expect(revert(surface, r.documents, r.edits[0]!.changes)).toEqual({ kind: "applied", documents: arr });
  });

  it("RS18.22 an array edit reverts while a later insert after it left it in place, and is refused when a later insert moved it", () => {
    const first = done(arr, [add("/arr/1", "mine")]);
    const later = done(first.documents, [add("/arr/-", "tail")]);
    expect(revert(surface, later.documents, first.edits[0]!.changes)).toEqual({ kind: "applied", documents: { ...arr, cfg: { arr: ["alpha", "beta", "gamma", "delta", "tail"] } } });
    const moved = done(first.documents, [add("/arr/0", "front")]);
    expect(revert(surface, moved.documents, first.edits[0]!.changes)).toEqual({ kind: "refused", problems: ["cfg/arr/1 was changed after the edit"] });
    // A removal is taken back at its index while the array reaches it; not once the array is shorter.
    const gone = done(arr, [remove("/arr/3")]);
    expect(revert(surface, gone.documents, gone.edits[0]!.changes)).toEqual({ kind: "applied", documents: arr });
    expect(revert(surface, { ...gone.documents, cfg: { arr: ["alpha"] } }, gone.edits[0]!.changes)).toEqual({ kind: "refused", problems: ["cfg/arr/3 was changed after the edit"] });
    expect(revert(surface, { ...gone.documents, cfg: { arr: "text" } }, gone.edits[0]!.changes)).toEqual({ kind: "refused", problems: ["cfg/arr/3 was changed after the edit"] });
    // A later change to the array's length leaves a removal in the middle unlocatable: it is refused, not put back somewhere.
    const later2 = done(gone.documents, [add("/arr/-", "tail")]);
    expect(revert(surface, later2.documents, gone.edits[0]!.changes)).toEqual({ kind: "refused", problems: ["cfg/arr/3 was changed after the edit"] });
    const middle = done(arr, [remove("/arr/1")]);
    expect(revert(surface, middle.documents, middle.edits[0]!.changes)).toEqual({ kind: "applied", documents: arr });
  });

  it("RS18.23 task words in pre-existing elements that an insert shifts are not leaked by the insert", () => {
    const tasks = [{ id: "t1", text: "Reconcile the ledger against the invoice batch and report every discrepancy found today" }];
    const words = "Reconcile the ledger against the invoice batch and report every discrepancy found today";
    const shifted = { cfg: { arr: [words, `${words} again`, "b", "c"] }, other: {}, t: "x" };
    const r = done(shifted, [add("/arr/0", "check the output before finishing")]);
    expect(r.edits[0]!.changes[0]!.wrote).toEqual([{ op: "add", path: "/arr/0", value: "check the output before finishing" }]);
    expect(leaks(r.edits[0]!.changes, tasks, { ngram: 6 })).toEqual([]);
    // What the edit itself writes is still screened.
    const bad = done(shifted, [add("/arr/0", words)]);
    expect(leaks(bad.edits[0]!.changes, tasks, { ngram: 6 })).toEqual([`it repeats "reconcile the ledger against the invoice" from task t1`]);
  });
});

describe("JSON ops record what they did", () => {
  const base = { cfg: { a: 1, o: { k: "v" } }, other: {}, t: "x" };

  it("RS18.24 an add over an existing key is recorded as a replace of its old value; the same value, added or replaced, changes nothing", () => {
    const r = done(base, [add("/a", 2)]);
    expect(r.edits[0]!.changes[0]).toEqual({ document: "cfg", wrote: [{ op: "replace", path: "/a", value: 2 }], inverse: [{ op: "replace", path: "/a", value: 1 }] });
    expect(apply(base, [add("/a", 1)])).toEqual({ kind: "refused", problems: ["edit e0 changes nothing"] });
    expect(apply(base, [replace("/o", { k: "v" })])).toEqual({ kind: "refused", problems: ["edit e0 changes nothing"] });
    // An op that changes nothing is skipped; the others are recorded.
    const mixed = done(base, [replace("/a", 1), add("/b", 3)]);
    expect(mixed.edits[0]!.changes[0]!.wrote).toEqual([{ op: "add", path: "/b", value: 3 }]);
  });

  it("RS18.25 the ops of an edit may build on each other; the recorded values are copies, and neither the proposal nor the documents are changed", () => {
    const value = { z: 1 };
    const docs = structuredClone(base);
    const p = proposal(edit("e", [add("/n", value), add("/n/q", 2)]));
    const before = structuredClone(p);
    const r = applyProposal(surface, docs, p, 1);
    if (r.kind !== "applied") throw new Error("not applied");
    expect(value).toEqual({ z: 1 });
    expect(p).toEqual(before);
    expect(docs).toEqual(base);
    expect(r.documents["cfg"]).toEqual({ a: 1, o: { k: "v" }, n: { z: 1, q: 2 } });
    const wrote = r.edits[0]!.changes[0]!.wrote;
    expect(wrote).toEqual([
      { op: "add", path: "/n", value: { z: 1 } },
      { op: "add", path: "/n/q", value: 2 },
    ]);
    const cfg = r.documents["cfg"] as { n: unknown };
    expect((wrote[0] as { value: unknown }).value).not.toBe(cfg.n);
    expect((wrote[0] as { value: unknown }).value).not.toBe(value);
    expect(cfg.n).not.toBe(value);
    expect(r.edits[0]!.footprint).toBe(2);
    expect(revert(surface, r.documents, r.edits[0]!.changes)).toEqual({ kind: "applied", documents: base });
    // Untouched documents are not copied or changed, and the input's nested values are not shared with the result.
    expect(r.documents["other"]).toBe(docs.other);
    expect((r.documents["cfg"] as { o: unknown }).o).not.toBe(docs.cfg.o);
  });

  it("RS18.26 a removal is classified and sized by the value it removed, an add or replace by the value it wrote", () => {
    const seen: [string, unknown][] = [];
    const s = defineSurface({
      documents: {
        cfg: {
          schema: z.any(),
          classify: (path, value) => {
            seen.push([path, value]);
            return typeof value === "string" ? "prompt" : "config";
          },
        },
      },
      components: ["prompt", "config"],
    });
    const r = applyProposal(s, { cfg: { a: "old", b: { c: 1, d: 2 } } }, proposal(edit("e", [remove("/a"), replace("/b/c", "new"), add("/n", 3)])), 1);
    if (r.kind !== "applied") throw new Error("not applied");
    expect(seen).toEqual([
      ["/a", "old"],
      ["/b/c", "new"],
      ["/n", 3],
    ]);
    expect(r.edits[0]!.components).toEqual(["config", "prompt"]);
    expect(r.edits[0]!.footprint).toBe(3);
  });

  it("RS18.27 a change recorded before this format, in any order, still reverts while what it wrote holds, and is refused with a reason otherwise", () => {
    // Two writes whose inverse is not in the reverse order of them (as a positional diff wrote it).
    const legacy: Change = {
      document: "cfg",
      wrote: [
        { op: "add", path: "/x", value: 1 },
        { op: "add", path: "/y", value: 2 },
      ],
      inverse: [
        { op: "remove", path: "/y" },
        { op: "remove", path: "/x" },
      ],
    };
    const docs = { cfg: { a: 1, x: 1, y: 2 }, other: {}, t: "" };
    expect(revert(surface, docs, [legacy])).toEqual({ kind: "applied", documents: { cfg: { a: 1 }, other: {}, t: "" } });
    expect(revert(surface, { ...docs, cfg: { a: 1, x: 1, y: 3 } }, [legacy])).toEqual({ kind: "refused", problems: ["cfg/y was changed after the edit"] });
    expect(revert(surface, { ...docs, cfg: { a: 1, x: 1 } }, [legacy])).toEqual({ kind: "refused", problems: ["cfg/y was changed after the edit"] });
    // Fewer inverse operations than writes are not paired either; an inverse that cannot apply is refused, not thrown.
    const short: Change = { document: "cfg", wrote: [{ op: "remove", path: "/gone" }, { op: "remove", path: "/x" }], inverse: [{ op: "add", path: "/nowhere/deep", value: 1 }] };
    expect(revert(surface, { cfg: { a: 1 }, other: {}, t: "" }, [short])).toEqual({ kind: "refused", problems: ["cfg/nowhere/deep was changed after the edit"] });
    // A removal recorded before it kept the array's length left nothing at its index.
    const noLength: Change = { document: "cfg", wrote: [{ op: "remove", path: "/arr/1" }], inverse: [{ op: "add", path: "/arr/1", value: "b" }] };
    expect(revert(surface, { cfg: { arr: ["a"] }, other: {}, t: "" }, [noLength])).toEqual({ kind: "applied", documents: { cfg: { arr: ["a", "b"] }, other: {}, t: "" } });
    expect(revert(surface, { cfg: { arr: ["a", "c"] }, other: {}, t: "" }, [noLength])).toEqual({ kind: "refused", problems: ["cfg/arr/1 was changed after the edit"] });
    expect(revert(surface, { cfg: { arr: ["a"] }, other: {}, t: "" }, [{ ...noLength, wrote: [{ op: "remove", path: "/arr/x" }] }]).kind).toBe("refused");
  });

  it("RS18.28 an inverse that cannot be applied refuses the revert; so does an edit op in a JSON change", () => {
    const broken: Change = { document: "cfg", wrote: [{ op: "add", path: "/x", value: 1 }], inverse: [{ op: "remove", path: "/elsewhere" }] };
    expect(revert(surface, { cfg: { x: 1 }, other: {}, t: "" }, [broken])).toEqual({ kind: "refused", problems: ["cfg/elsewhere was changed after the edit"] });
    // Paired with its write, an inverse that cannot apply is that write's problem.
    const unpairable: Change = { document: "cfg", wrote: [{ op: "remove", path: "/arr/1" }], inverse: [{ op: "remove", path: "/arr/1" }] };
    expect(revert(surface, { cfg: { arr: ["a"] }, other: {}, t: "" }, [unpairable])).toEqual({ kind: "refused", problems: ["cfg/arr/1 was changed after the edit"] });
    // A write whose path is not a pointer holds nowhere.
    const malformed: Change = { document: "cfg", wrote: [{ op: "add", path: "x", value: 1 }], inverse: [{ op: "remove", path: "x" }] };
    expect(revert(surface, { cfg: { x: 1 }, other: {}, t: "" }, [malformed])).toEqual({ kind: "refused", problems: ["cfgx was changed after the edit"] });
    const misfit: Change = { document: "cfg", wrote: [{ op: "add", path: "/x", value: 1 }], inverse: [{ op: "edit", old: "a", new: "b" }] };
    expect(revert(surface, { cfg: { x: 1 }, other: {}, t: "" }, [misfit])).toEqual({ kind: "refused", problems: ["cfg is JSON: an edit op applies to text documents"] });
    const edited: Change = { document: "cfg", wrote: [{ op: "edit", old: "a", new: "b" }], inverse: [{ op: "edit", old: "b", new: "a" }] };
    expect(revert(surface, { cfg: {}, other: {}, t: "" }, [edited])).toEqual({ kind: "refused", problems: ["cfg is JSON: an edit op applies to text documents"] });
  });

  it("RS18.29 a revert of several changes reports each document's problem and leaves the documents alone", () => {
    const r = done(base, [add("/b", 1), add("/z", 1, "other"), on("x", "y")]);
    const docs = { cfg: { a: 1, o: { k: "v" } }, other: { z: 2 }, t: "changed" };
    const reverted = revert(surface, docs, r.edits[0]!.changes);
    expect(reverted).toEqual({ kind: "refused", problems: ["cfg/b was changed after the edit", "other/z was changed after the edit", "t was changed after the edit"] });
    expect(docs).toEqual({ cfg: { a: 1, o: { k: "v" } }, other: { z: 2 }, t: "changed" });
    const ok = revert(surface, r.documents, r.edits[0]!.changes);
    expect(ok).toEqual({ kind: "applied", documents: base });
    expect(r.documents["cfg"]).toEqual({ a: 1, o: { k: "v" }, b: 1 });
  });
});

describe("text documents: touching regions, context and surrogates", () => {
  const doc = { cfg: {}, other: {}, t: "aa\n" };

  it("RS18.30 regions that touch end to start are not independent: the recorded context of one may lie in the other", () => {
    expect(apply(doc, [on("aa", "")], [on("\n", "\r\n😀")])).toEqual({ kind: "refused", problems: ["edits e0 and e1 both touch t[2:2]: they are one edit, or not independent"] });
    expect(apply(doc, [on("\n", "\r\n😀")], [on("aa", "")])).toEqual({ kind: "refused", problems: ["edits e0 and e1 both touch t[2:2]: they are one edit, or not independent"] });
    // One character apart they are independent again.
    const apart = done({ ...doc, t: "aa-\n" }, [on("aa", "")], [on("\n", "\r\n")]);
    expect(apart.documents["t"]).toBe("-\r\n");
  });

  it("RS18.31 an edit whose recorded context lies in text another edit rewrote is refused: taken out alone it would put its text in the wrong place", () => {
    // Deleting the newline is located by the "ab" before it and "bb" after it; the first "a" of that "ab" is deleted by the other edit,
    // which leaves "abbb" at the wrong place ("yxab" + "bb" + "bbab").
    const text = "yxabaab\nbbab";
    const r = apply({ ...doc, t: text }, [on("\n", "")], [on("aa", "")]);
    expect(r).toEqual({
      kind: "refused",
      problems: ["edit e0 could not be taken out of t on its own: the text that locates it overlaps another edit's (make them one edit, or leave more text between them)"],
    });
    // Each alone is fine, and so are they as one edit (which is taken out as one).
    expect(apply({ ...doc, t: text }, [on("\n", "")]).kind).toBe("applied");
    expect(apply({ ...doc, t: text }, [on("aa", "")]).kind).toBe("applied");
    const one = done({ ...doc, t: text }, [on("\n", ""), on("aa", "")]);
    expect(revert(surface, one.documents, one.edits[0]!.changes)).toEqual({ kind: "applied", documents: { ...doc, t: text } });
    // Far enough apart, the context of one is untouched by the other.
    const apart = done({ ...doc, t: "yxabaab-------\nbbab" }, [on("\n", "")], [on("aa", "")]);
    expect(revert(surface, apart.documents, apart.edits[0]!.changes)).toEqual({ kind: "applied", documents: { ...doc, t: "yxabb-------\nbbab" } });
  });

  it("RS18.32 a lone surrogate in the old or new text is refused, and the reason names it", () => {
    const emoji = { ...doc, t: "a😀b" };
    expect(problems(apply(emoji, [on("\ude00", "")]))).toEqual(['edit e0 does not apply: the old text has a lone surrogate: "\\ude00"']);
    expect(problems(apply(emoji, [on("a", "\ud83d")]))).toEqual(['edit e0 does not apply: the new text has a lone surrogate: "\\ud83d"']);
    expect(problems(apply(emoji, [on("😀", "😀!")]))).toEqual([]);
    expect(apply(emoji, [on("😀", "x")]).kind).toBe("applied");
  });

  it("RS18.33 a whole-text replace with a lone surrogate, or an edit whose result is not well-formed, is refused", () => {
    expect(problems(apply(doc, [replace("", "a\ud800", "t")]))).toEqual(["edit e0 does not apply: t would hold a lone surrogate"]);
    // The text itself was already malformed: a result of it is not well-formed either.
    expect(problems(apply({ ...doc, t: "a\ud83d" }, [on("a", "b")]))).toEqual(["edit e0 does not apply: t would hold a lone surrogate"]);
    expect(apply({ ...doc, t: "a😀" }, [replace("", "😀a", "t")]).kind).toBe("applied");
  });

  it("RS18.34 the text of another edit's region is never anchored inside the change that reverts: reverting one of two adjacent-but-separate edits restores the other's text", () => {
    const text = "one\ntwo\nthree\nfour\n";
    const r = done({ ...doc, t: text }, [on("one", "1")], [on("three", "3")]);
    expect(r.documents["t"]).toBe("1\ntwo\n3\nfour\n");
    expect(revert(surface, r.documents, r.edits[0]!.changes)).toEqual({ kind: "applied", documents: { ...doc, t: "one\ntwo\n3\nfour\n" } });
    expect(revert(surface, r.documents, r.edits[1]!.changes)).toEqual({ kind: "applied", documents: { ...doc, t: "1\ntwo\nthree\nfour\n" } });
  });
});

describe("the leakage screen reads paths and keys as well as values", () => {
  const tasks = [{ id: "invoice-batch-77", text: "Reconcile ledger 12 against invoice batch 77 and report discrepancies quickly today" }];
  const change = (wrote: Change["wrote"]): Change[] => [{ document: "cfg", wrote, inverse: [] }];
  const named = ["it names task invoice-batch-77"];

  it("RS18.35 a path segment that names a task leaks, for add and replace", () => {
    expect(leaks(change([{ op: "add", path: "/overrides/invoice-batch-77", value: true }]), tasks, { ngram: 6 })).toEqual(named);
    expect(leaks(change([{ op: "replace", path: "/overrides/invoice-batch-77", value: 1 }]), tasks, { ngram: 6 })).toEqual(named);
    expect(leaks(change([{ op: "add", path: "/overrides/other", value: true }]), tasks, { ngram: 6 })).toEqual([]);
  });

  it("RS18.36 an object key that names a task leaks, however deep, alone or in an array", () => {
    expect(leaks(change([{ op: "add", path: "/overrides", value: { "invoice-batch-77": "skip step 2" } }]), tasks, { ngram: 6 })).toEqual(named);
    expect(leaks(change([{ op: "add", path: "/overrides", value: { a: [{ b: { "invoice-batch-77": 1 } }] } }]), tasks, { ngram: 6 })).toEqual(named);
    expect(leaks(change([{ op: "replace", path: "/x", value: [{ "Invoice-Batch-77": 1 }] }]), tasks, { ngram: 6 })).toEqual(named);
  });

  it("RS18.37 a task id is found in an escaped path segment, and an id with a slash across two segments", () => {
    const slash = [{ id: "a/b", text: "unrelated words only appear in this particular task text here" }];
    expect(leaks(change([{ op: "add", path: "/k/a~1b", value: 1 }]), slash, { ngram: 6 })).toEqual(["it names task a/b"]);
    expect(leaks(change([{ op: "add", path: "/k/a/b", value: 1 }]), slash, { ngram: 6 })).toEqual(["it names task a/b"]);
    const tilde = [{ id: "a~b", text: "unrelated words only appear in this particular task text here" }];
    expect(leaks(change([{ op: "add", path: "/k/a~0b", value: 1 }]), tilde, { ngram: 6 })).toEqual(["it names task a~b"]);
  });

  it("RS18.38 a run of task words spread over the segments of a path, or in a key, leaks; removals still add nothing", () => {
    const t = [{ id: "t9", text: "recover the lost commit from the reflog of the repository" }];
    expect(leaks(change([{ op: "add", path: "/recover/the/lost/commit/from/the", value: 1 }]), t, { ngram: 6 })).toEqual(['it repeats "recover the lost commit from the" from task t9']);
    expect(leaks(change([{ op: "add", path: "/k", value: { "recover the lost commit from the reflog": 1 } }]), t, { ngram: 6 })).toEqual(['it repeats "recover the lost commit from the" from task t9']);
    expect(leaks(change([{ op: "remove", path: "/invoice-batch-77/recover/the/lost/commit/from/the" }]), tasks.concat(t), { ngram: 6 })).toEqual([]);
    // A single segment is not a run.
    expect(leaks(change([{ op: "add", path: "/recover/the", value: 1 }]), t, { ngram: 6 })).toEqual([]);
  });

  it("RS18.44 a run of words that two tasks share is reported for the first of them, once", () => {
    const both = [
      { id: "first", text: "recover the lost commit from the reflog today" },
      { id: "second", text: "please recover the lost commit from the reflog again" },
    ];
    expect(leaks(change([{ op: "add", path: "/k", value: "recover the lost commit from the reflog" }]), both, { ngram: 6 })).toEqual(['it repeats "recover the lost commit from the" from task first']);
  });

  it("RS18.39 a credential in a key or a path is carried, too; a root path adds no words", () => {
    expect(leaks(change([{ op: "add", path: "/x", value: { "sk-abcdefghijklmnopqrstuvwxyz": 1 } }]), tasks, { ngram: 6 })).toEqual(["it carries a credential"]);
    expect(leaks(change([{ op: "add", path: "/sk-abcdefghijklmnopqrstuvwxyz", value: 1 }]), tasks, { ngram: 6 })).toEqual(["it carries a credential"]);
    expect(leaks(change([{ op: "replace", path: "", value: { a: "fine" } }]), tasks, { ngram: 6 })).toEqual([]);
  });

  it("RS18.40 the proposal that adds such a key is screened end to end, as the round screens it", () => {
    const s = defineSurface({ documents: { p: { schema: z.any() } }, components: ["prompt", "config"] });
    for (const ops of [[add("/overrides/invoice-batch-77", true, "p")], [add("/overrides", { "invoice-batch-77": "skip step 2" }, "p")]]) {
      const r = applyProposal(s, { p: { overrides: {} } }, proposal(edit("e", ops)), 1);
      if (r.kind !== "applied") throw new Error("not applied");
      expect(leaks(r.edits[0]!.changes, tasks, { ngram: 6 })).toEqual(named);
    }
  });
});
