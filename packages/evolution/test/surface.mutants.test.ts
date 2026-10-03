import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyProposal, defineSurface, OpSchema, PatchOpSchema, revert } from "@harness/evolution";
import type { Change, Documents, Proposal } from "@harness/evolution";

type Ops = Proposal["edits"][number]["ops"];

const surface = defineSurface({
  documents: { cfg: { schema: z.any() }, t: { kind: "text" } },
  components: ["prompt", "config"],
});
const edit = (id: string, ops: Ops) => ({ id, hypothesis: `h ${id}`, targets: "mode", predicted: [], ops });
const proposal = (...edits: Proposal["edits"]): Proposal => ({ summary: "s", edits });
const apply = (documents: Documents, ...edits: Ops[]) => applyProposal(surface, documents, proposal(...edits.map((ops, i) => edit(`e${i + 1}`, ops))), edits.length + 1);
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

describe("mutation hardening of surfaces: declaring and proposing", () => {
  it("RS21.20 structural components that are not components are all named, separated by a comma and a space", () => {
    expect(() => defineSurface({ documents: {}, components: ["prompt"], structural: ["skill", "tool"] })).toThrow(new RangeError("structural components must be components: skill, tool"));
  });

  it("RS21.21 edit ids that repeat are all named, separated by a comma and a space", () => {
    const r = applyProposal(surface, { cfg: {}, t: "x" }, proposal(edit("a", [add("/p", 1)]), edit("a", [add("/q", 1)]), edit("b", [add("/r", 1)]), edit("b", [add("/s", 1)])), 4);
    expect(problems(r)).toEqual(["edit ids repeat: a, b"]);
  });

  it("RS21.22 an edit inside the part another edit touches clashes whichever comes first, and the refusal names the outer part", () => {
    const docs = { cfg: { x: { y: 1 } }, t: "" };
    expect(problems(apply(docs, [replace("/x/y", 2)], [replace("/x", { y: 3 })]))).toEqual(["edits e1 and e2 both touch cfg/x: they are one edit, or not independent"]);
    expect(problems(apply(docs, [replace("/x", { y: 3 })], [replace("/x/y", 2)]))).toEqual(["edits e1 and e2 both touch cfg/x: they are one edit, or not independent"]);
  });

  it("RS21.23 two edits that touch the same path name that path", () => {
    expect(problems(apply({ cfg: { x: 1 }, t: "" }, [replace("/x", 2)], [replace("/x", 3)]))).toEqual(["edits e1 and e2 both touch cfg/x: they are one edit, or not independent"]);
  });

  it("RS21.24 a path that is not a pointer stays its own part, so two edits at it clash", () => {
    expect(problems(apply({ cfg: {}, t: "" }, [add("/__proto__/x", 1)], [add("/__proto__/x", 2)]))).toEqual(["edits e1 and e2 both touch cfg/__proto__/x: they are one edit, or not independent"]);
  });

  it("RS21.25 where the document has nothing, only an index or - is taken for an array: other keys stay their own parts", () => {
    const r = apply({ cfg: {}, t: "" }, [add("/x/foo/a", 1)], [add("/x/bar/b", 1)]);
    expect(problems(r)).toEqual(["edit e1 does not apply: cannot add at /x/foo/a: its parent does not exist", "edit e2 does not apply: cannot add at /x/bar/b: its parent does not exist"]);
  });

  it("RS21.26 where the document has nothing, a - is taken for an array index, so edits through it are one part", () => {
    const r = apply({ cfg: {}, t: "" }, [add("/x/-/a", 1)], [add("/x/-/b", 1)]);
    expect(problems(r)).toEqual(["edits e1 and e2 both touch cfg/x: they are one edit, or not independent"]);
  });

  it("RS21.27 where the document has nothing, a number is taken for an array index, so edits through it are one part", () => {
    const r = apply({ cfg: {}, t: "" }, [add("/x/0/a", 1)], [add("/x/1/b", 1)]);
    expect(problems(r)).toEqual(["edits e1 and e2 both touch cfg/x: they are one edit, or not independent"]);
  });

  it("RS21.28 an append at any depth records the index it took, at the array's own path", () => {
    const r = done({ cfg: { a: { b: [1, 2] } }, t: "" }, [add("/a/b/-", 3)]);
    expect(r.edits[0]!.changes).toEqual([{ document: "cfg", wrote: [{ op: "add", path: "/a/b/2", value: 3 }], inverse: [{ op: "remove", path: "/a/b/2" }] }]);
    const nested = done({ cfg: { a: { b: { c: [1] } } }, t: "" }, [remove("/a/b/c/0")]);
    expect(nested.edits[0]!.changes).toEqual([{ document: "cfg", wrote: [{ op: "remove", path: "/a/b/c/0", length: 0 }], inverse: [{ op: "add", path: "/a/b/c/0", value: 1 }] }]);
  });

  it("RS21.29 replacing an array element by what it already holds changes nothing", () => {
    expect(problems(apply({ cfg: { a: [1, { k: 2 }] }, t: "" }, [replace("/a/0", 1)]))).toEqual(["edit e1 changes nothing"]);
    expect(problems(apply({ cfg: { a: [1, { k: 2 }] }, t: "" }, [replace("/a/1", { k: 2 })]))).toEqual(["edit e1 changes nothing"]);
  });

  it("RS21.30 removing a key records a removal, and the add that puts its value back", () => {
    const r = done({ cfg: { a: 1, b: { c: 2 } }, t: "" }, [remove("/a")], [remove("/b")]);
    expect(r.edits.map((e) => e.changes)).toEqual([
      [{ document: "cfg", wrote: [{ op: "remove", path: "/a" }], inverse: [{ op: "add", path: "/a", value: 1 }] }],
      [{ document: "cfg", wrote: [{ op: "remove", path: "/b" }], inverse: [{ op: "add", path: "/b", value: { c: 2 } }] }],
    ]);
    expect(r.documents["cfg"]).toEqual({});
  });

  it("RS21.31 an edit's old text that a later edit's new text repeats is not an entangled edit", () => {
    const r = done({ cfg: {}, t: "a c" }, [on("a", "b")], [on("c", "b")]);
    expect(r.documents["t"]).toBe("b b");
    expect(r.edits.map((e) => e.id)).toEqual(["e1", "e2"]);
  });
});

describe("mutation hardening of surfaces: taking changes back out", () => {
  const base = { cfg: { a: [1, 2], b: 1 }, t: "x" };
  const mixed: Change = { document: "cfg", wrote: [{ op: "add", path: "/b", value: 1 }, { op: "edit", old: "p", new: "q" }], inverse: [{ op: "remove", path: "/b" }] };

  it("RS21.32 a path through an array reads an index only: the array's length is not a value written", () => {
    const change: Change = { document: "cfg", wrote: [{ op: "replace", path: "/a/length", value: 2 }], inverse: [{ op: "replace", path: "/b", value: 0 }] };
    expect(revert(surface, base, [change])).toEqual({ kind: "refused", problems: ["cfg/a/length was changed after the edit"] });
  });

  it("RS21.33 a written path that is not a pointer was changed after the edit, even when the inverse names other paths", () => {
    const change: Change = { document: "cfg", wrote: [{ op: "add", path: "nowhere", value: 1 }], inverse: [{ op: "add", path: "/n", value: 5 }] };
    expect(revert(surface, base, [change])).toEqual({ kind: "refused", problems: ["cfgnowhere was changed after the edit"] });
  });

  it("RS21.34 a JSON change whose writes include a text edit is refused as a whole", () => {
    expect(revert(surface, base, [mixed])).toEqual({ kind: "refused", problems: ["cfg is JSON: an edit op applies to text documents"] });
  });

  it("RS21.35 a JSON change whose inverse includes a text edit is refused as a whole", () => {
    const change: Change = { document: "cfg", wrote: [{ op: "add", path: "/b", value: 1 }], inverse: [{ op: "remove", path: "/b" }, { op: "edit", old: "p", new: "q" }] };
    expect(revert(surface, base, [change])).toEqual({ kind: "refused", problems: ["cfg is JSON: an edit op applies to text documents"] });
  });

  it("RS21.36 a change with fewer inverse ops than writes is not paired, and is taken out as a whole", () => {
    const change: Change = { document: "cfg", wrote: [{ op: "add", path: "/n", value: 1 }, { op: "add", path: "/m", value: 2 }], inverse: [{ op: "remove", path: "/n" }] };
    const docs = { ...base, cfg: { ...base.cfg, n: 1, m: 2 } };
    expect(revert(surface, docs, [change])).toEqual({ kind: "applied", documents: { cfg: { ...base.cfg, m: 2 }, t: "x" } });
  });

  it("RS21.37 a change whose inverse paths do not match its writes is not paired, and is taken out as a whole", () => {
    const change: Change = { document: "cfg", wrote: [{ op: "add", path: "/n", value: 1 }, { op: "add", path: "/m", value: 2 }], inverse: [{ op: "remove", path: "/n" }, { op: "remove", path: "/zzz" }] };
    const docs = { ...base, cfg: { ...base.cfg, n: 1, m: 2 } };
    expect(revert(surface, docs, [change])).toEqual({ kind: "refused", problems: ["cfg/zzz was changed after the edit"] });
  });

  it("RS21.38 a text document's inverse that is not a replace of the whole text is refused", () => {
    const change: Change = { document: "t", wrote: [{ op: "replace", path: "", value: "x" }], inverse: [{ op: "add", path: "", value: "old" }] };
    expect(revert(surface, base, [change])).toEqual({ kind: "refused", problems: ["t was changed after the edit"] });
  });

  it("RS21.39 a text document's inverse replace must put back a string", () => {
    const change: Change = { document: "t", wrote: [{ op: "replace", path: "", value: "x" }], inverse: [{ op: "replace", path: "", value: 5 }] };
    expect(revert(surface, base, [change])).toEqual({ kind: "refused", problems: ["t was changed after the edit"] });
  });

  it("RS21.40 a change to a document the surface lacks is refused though the documents hold it", () => {
    const change: Change = { document: "nowhere", wrote: [{ op: "add", path: "/x", value: 1 }], inverse: [{ op: "remove", path: "/x" }] };
    expect(revert(surface, { ...base, nowhere: { x: 1 } }, [change])).toEqual({ kind: "refused", problems: ["nowhere is not a document of the surface"] });
  });
});

describe("mutation hardening of surfaces: what a declaration keeps", () => {
  it("RS21.41 a JSON document is kept as declared", () => {
    const spec = { schema: z.any(), classify: () => "config" };
    expect(defineSurface({ documents: { cfg: spec }, components: ["config"] }).documents["cfg"]).toBe(spec);
  });

  it("RS21.42 a surface declared without structural components has none", () => {
    expect(defineSurface({ documents: {}, components: ["prompt"] }).structural).toEqual([]);
  });

  it("RS21.43 the removal of a key that is the empty string is told apart from a path that names no key", () => {
    const change: Change = { document: "cfg", wrote: [{ op: "remove", path: "" }], inverse: [{ op: "replace", path: "/b", value: 0 }] };
    expect(revert(surface, { cfg: { "": 1, b: 1 }, t: "x" }, [change])).toEqual({ kind: "refused", problems: ["cfg was changed after the edit"] });
  });
});

describe("mutation hardening of surfaces: footprint, regions and entangled edits", () => {
  it("RS21.44 the footprint of a deletion counts the lines it removed even when the last of them repeats a line kept at the start", () => {
    const r = done({ cfg: {}, t: "x\ny\nx\nrest" }, [on("x\ny\nx", "x")]);
    expect(r.documents["t"]).toBe("x\nrest");
    expect(r.edits[0]!.footprint).toBe(2);
  });

  it("RS21.45 the footprint of an insertion counts the lines it added even when the last of them repeats a line kept at the start", () => {
    const r = done({ cfg: {}, t: "x\nrest" }, [on("x", "x\ny\nx")]);
    expect(r.edits[0]!.footprint).toBe(2);
  });

  it("RS21.46 a whole-text replace of a text that holds the word undefined is still a replace of the whole text", () => {
    const r = done({ cfg: {}, t: "say undefined once" }, [replace("", "new text", "t")]);
    expect(r.documents["t"]).toBe("new text");
  });

  it("RS21.47 when an edit does not apply, the others are not also reported as entangled", () => {
    const docs = { cfg: {}, t: "yxabaab\nbbab" };
    expect(problems(apply(docs, [on("\n", "")], [on("aa", "")]))).toEqual(["edit e1 could not be taken out of t on its own: the text that locates it overlaps another edit's (make them one edit, or leave more text between them)"]);
    expect(problems(apply(docs, [on("\n", "")], [on("aa", "")], [add("/x/y", 1)]))).toEqual(["edit e3 does not apply: cannot add at /x/y: its parent does not exist"]);
  });

  it("RS21.48 edits of one JSON document are never reported as entangled text", () => {
    const r = done({ cfg: { a: 1, b: 1 }, t: "" }, [replace("/a", 2)], [replace("/b", 2)]);
    expect(r.documents["cfg"]).toEqual({ a: 2, b: 2 });
  });
});

describe("mutation hardening of surfaces: the shapes that were once hidden from Stryker", () => {
  const entangled = (id: string) => `edit ${id} could not be taken out of t on its own: the text that locates it overlaps another edit's (make them one edit, or leave more text between them)`;
  const clashing = (a: string, b: string, where: string) => `edits ${a} and ${b} both touch ${where}: they are one edit, or not independent`;

  it("RS28.1 the footprint of an edit that changes the last of two lines counts the changed line on each side, not the shared first one", () => {
    expect(done({ cfg: {}, t: "a\nb\nz" }, [on("a\nb", "a\nc")]).edits[0]!.footprint).toBe(2);
  });

  it("RS28.2 the footprint of an edit that only appends lines counts them, though the old text is a prefix of the new", () => {
    expect(done({ cfg: {}, t: "a\nz" }, [on("a", "a\nb\nc")]).edits[0]!.footprint).toBe(2);
  });

  it("RS28.3 the footprint of an edit that only drops trailing lines counts them, though the new text is a prefix of the old", () => {
    expect(done({ cfg: {}, t: "a\nb\nc\nz" }, [on("a\nb\nc", "a")]).edits[0]!.footprint).toBe(2);
  });

  it("RS28.4 the footprint of an edit that changes the first line counts it, though the later lines are shared", () => {
    expect(done({ cfg: {}, t: "a\nb\nz" }, [on("a\nb", "c\nb")]).edits[0]!.footprint).toBe(2);
  });

  it("RS28.5 a refusal for overlapping paths names the shorter whichever edit holds it, and the path itself when they are equal", () => {
    const docs = { cfg: { a: { b: { c: 1 } } }, t: "" };
    expect(problems(apply(docs, [replace("/a/b/c", 2)], [replace("/a/b", { c: 3 })]))).toEqual([clashing("e1", "e2", "cfg/a/b")]);
    expect(problems(apply(docs, [replace("/a/b", { c: 3 })], [replace("/a/b/c", 2)]))).toEqual([clashing("e1", "e2", "cfg/a/b")]);
    expect(problems(apply(docs, [replace("/a/b", { c: 3 })], [replace("/a/b", { c: 4 })]))).toEqual([clashing("e1", "e2", "cfg/a/b")]);
  });

  it("RS28.6 two edits are compared when only the first pair clashes, and when only the last pair does", () => {
    const docs = { cfg: { a: 1, b: 1, c: 1 }, t: "" };
    expect(problems(apply(docs, [replace("/a", 2)], [replace("/a", 3)]))).toEqual([clashing("e1", "e2", "cfg/a")]);
    expect(problems(apply(docs, [replace("/a", 2)], [replace("/b", 2)], [replace("/b", 3)]))).toEqual([clashing("e2", "e3", "cfg/b")]);
    expect(problems(apply(docs, [replace("/a", 2)], [replace("/b", 2)], [replace("/a", 3)]))).toEqual([clashing("e1", "e3", "cfg/a")]);
  });

  it("RS28.7 two edits whose recorded context overlaps are refused as entangled, naming the first", () => {
    expect(problems(apply({ cfg: {}, t: "yxabaab\nbbab" }, [on("\n", "")], [on("aa", "")]))).toEqual([entangled("e1")]);
  });

  it("RS28.8 two edits of one text whose contexts do not overlap are both applied", () => {
    const r = done({ cfg: {}, t: "alpha one\n\nbeta two\n\ngamma three" }, [on("one", "1")], [on("three", "3")]);
    expect(r.documents["t"]).toBe("alpha 1\n\nbeta two\n\ngamma 3");
  });

  it("RS28.9 the entangled check runs for a text document when the same proposal also edits a JSON document", () => {
    const docs = { cfg: { a: 1 }, t: "yxabaab\nbbab" };
    expect(problems(apply(docs, [on("\n", "")], [on("aa", "")], [replace("/a", 2)]))).toEqual([entangled("e1")]);
  });

  it("RS28.10 a lone text edit of a text that repeats its neighbourhood is applied, not called entangled", () => {
    const r = done({ cfg: {}, t: "ab ab ab" }, [on("ab ab ab", "ab ab")]);
    expect(r.documents["t"]).toBe("ab ab");
  });

  it("RS28.11 a JSON document whose root is a string is edited alone without being called entangled text", () => {
    const r = done({ cfg: "old", t: "" }, [replace("", "new")]);
    expect(r.documents["cfg"]).toBe("new");
  });
});

describe("mutation hardening of surfaces: the schemas of ops and of recorded changes", () => {
  const reason = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.success ? [] : r.error!.issues.map((i) => i.message));

  it("RS28.12 a path is empty or starts with a slash, and the refusal says so", () => {
    const op = (path: string) => OpSchema.safeParse({ op: "add", document: "d", path, value: 1 });
    expect(op("").success).toBe(true);
    expect(op("/a/b").success).toBe(true);
    expect(op("a").success).toBe(false);
    expect(op("a/b").success).toBe(false);
    expect(reason(op("a"))).toEqual(["a JSON Pointer (empty, or starting with /)"]);
  });

  it("RS28.13 an add, a replace and a remove op each take a document, a path and (but for remove) a value, and no more", () => {
    const add = { op: "add", document: "d", path: "/p", value: { a: [1] } };
    const replaced = { op: "replace", document: "d", path: "/p", value: null };
    const removed = { op: "remove", document: "d", path: "/p" };
    for (const op of [add, replaced, removed]) {
      expect(OpSchema.parse(op)).toEqual(op);
      expect(OpSchema.safeParse({ ...op, extra: 1 }).success).toBe(false);
      expect(OpSchema.safeParse({ ...op, document: "" }).success).toBe(false);
      expect(OpSchema.safeParse({ ...op, path: "p" }).success).toBe(false);
    }
    expect(OpSchema.safeParse({ ...removed, value: 1 }).success).toBe(false);
    expect(OpSchema.safeParse({ op: "add", document: "d", path: "/p" }).success).toBe(false);
    expect(OpSchema.safeParse({ ...add, op: "move" }).success).toBe(false);
  });

  it("RS28.14 an edit op takes a non-empty document and old text and any new text, and no path", () => {
    const edit = { op: "edit", document: "d", old: "a", new: "" };
    expect(OpSchema.parse(edit)).toEqual(edit);
    expect(OpSchema.safeParse({ ...edit, extra: 1 }).success).toBe(false);
    expect(OpSchema.safeParse({ ...edit, old: "" }).success).toBe(false);
    expect(OpSchema.safeParse({ ...edit, new: 1 }).success).toBe(false);
  });

  it("RS28.15 a recorded patch op is an add, a replace, a remove (with the length an array is left at) or an edit (with its context), and no more", () => {
    const ops = [
      { op: "add", path: "/p", value: [1] },
      { op: "replace", path: "", value: "t" },
      { op: "remove", path: "/p" },
      { op: "remove", path: "/p/0", length: 0 },
      { op: "edit", old: "a", new: "b" },
      { op: "edit", old: "a", new: "", before: "x", after: "y" },
    ];
    for (const op of ops) {
      expect(PatchOpSchema.parse(op)).toEqual(op);
      expect(PatchOpSchema.safeParse({ ...op, extra: 1 }).success).toBe(false);
    }
    expect(PatchOpSchema.safeParse({ op: "remove", path: "/p/0", length: -1 }).success).toBe(false);
    expect(PatchOpSchema.safeParse({ op: "remove", path: "/p/0", length: 1.5 }).success).toBe(false);
    expect(PatchOpSchema.safeParse({ op: "add", path: "/p" }).success).toBe(false);
    expect(PatchOpSchema.safeParse({ op: "move", path: "/p" }).success).toBe(false);
  });

  it("RS28.16 a path through a number of several digits that the original has nothing at is an array index, so edits through two such indices touch the same part", () => {
    const docs = { cfg: {}, t: "" };
    expect(problems(apply(docs, [add("/missing/12/x", 1)], [add("/missing/13/y", 1)]))).toEqual(["edits e1 and e2 both touch cfg/missing: they are one edit, or not independent"]);
  });
});
