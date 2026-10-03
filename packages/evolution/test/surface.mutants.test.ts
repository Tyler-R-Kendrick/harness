import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type * as Api from "@harness/evolution";
import type { Change, Documents, Proposal, Surface } from "@harness/evolution";

// The package is imported inside a hook, not at the top, and a load that throws is left for the tests to report: a mutant in a
// schema the module builds as it loads then fails each test (api is undefined) where a failing static import, or a failing hook,
// would only fail or skip the file, and the mutation run would count that as a survivor.
let api: typeof Api;
let surface: Surface;
beforeAll(async () => {
  try {
    api = await import("@harness/evolution");
    surface = api.defineSurface({
      documents: { cfg: { schema: z.any() }, t: { kind: "text" } },
      components: ["prompt", "config"],
    });
  } catch {
    // every test below needs api and fails without it
  }
});

type Ops = Proposal["edits"][number]["ops"];

const edit = (id: string, ops: Ops) => ({ id, hypothesis: `h ${id}`, targets: "mode", predicted: [], ops });
const proposal = (...edits: Proposal["edits"]): Proposal => ({ summary: "s", edits });
const apply = (documents: Documents, ...edits: Ops[]) => api.applyProposal(surface, documents, proposal(...edits.map((ops, i) => edit(`e${i + 1}`, ops))), edits.length + 1);
const problems = (r: ReturnType<typeof api.applyProposal>) => (r.kind === "refused" ? r.problems : []);
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
    expect(() => api.defineSurface({ documents: {}, components: ["prompt"], structural: ["skill", "tool"] })).toThrow(new RangeError("structural components must be components: skill, tool"));
  });

  it("RS21.21 edit ids that repeat are all named, separated by a comma and a space", () => {
    const r = api.applyProposal(surface, { cfg: {}, t: "x" }, proposal(edit("a", [add("/p", 1)]), edit("a", [add("/q", 1)]), edit("b", [add("/r", 1)]), edit("b", [add("/s", 1)])), 4);
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
    expect(api.revert(surface, base, [change])).toEqual({ kind: "refused", problems: ["cfg/a/length was changed after the edit"] });
  });

  it("RS21.33 a written path that is not a pointer was changed after the edit, even when the inverse names other paths", () => {
    const change: Change = { document: "cfg", wrote: [{ op: "add", path: "nowhere", value: 1 }], inverse: [{ op: "add", path: "/n", value: 5 }] };
    expect(api.revert(surface, base, [change])).toEqual({ kind: "refused", problems: ["cfgnowhere was changed after the edit"] });
  });

  it("RS21.34 a JSON change whose writes include a text edit is refused as a whole", () => {
    expect(api.revert(surface, base, [mixed])).toEqual({ kind: "refused", problems: ["cfg is JSON: an edit op applies to text documents"] });
  });

  it("RS21.35 a JSON change whose inverse includes a text edit is refused as a whole", () => {
    const change: Change = { document: "cfg", wrote: [{ op: "add", path: "/b", value: 1 }], inverse: [{ op: "remove", path: "/b" }, { op: "edit", old: "p", new: "q" }] };
    expect(api.revert(surface, base, [change])).toEqual({ kind: "refused", problems: ["cfg is JSON: an edit op applies to text documents"] });
  });

  it("RS21.36 a change with fewer inverse ops than writes is not paired, and is taken out as a whole", () => {
    const change: Change = { document: "cfg", wrote: [{ op: "add", path: "/n", value: 1 }, { op: "add", path: "/m", value: 2 }], inverse: [{ op: "remove", path: "/n" }] };
    const docs = { ...base, cfg: { ...base.cfg, n: 1, m: 2 } };
    expect(api.revert(surface, docs, [change])).toEqual({ kind: "applied", documents: { cfg: { ...base.cfg, m: 2 }, t: "x" } });
  });

  it("RS21.37 a change whose inverse paths do not match its writes is not paired, and is taken out as a whole", () => {
    const change: Change = { document: "cfg", wrote: [{ op: "add", path: "/n", value: 1 }, { op: "add", path: "/m", value: 2 }], inverse: [{ op: "remove", path: "/n" }, { op: "remove", path: "/zzz" }] };
    const docs = { ...base, cfg: { ...base.cfg, n: 1, m: 2 } };
    expect(api.revert(surface, docs, [change])).toEqual({ kind: "refused", problems: ["cfg/zzz was changed after the edit"] });
  });

  it("RS21.38 a text document's inverse that is not a replace of the whole text is refused", () => {
    const change: Change = { document: "t", wrote: [{ op: "replace", path: "", value: "x" }], inverse: [{ op: "add", path: "", value: "old" }] };
    expect(api.revert(surface, base, [change])).toEqual({ kind: "refused", problems: ["t was changed after the edit"] });
  });

  it("RS21.39 a text document's inverse replace must put back a string", () => {
    const change: Change = { document: "t", wrote: [{ op: "replace", path: "", value: "x" }], inverse: [{ op: "replace", path: "", value: 5 }] };
    expect(api.revert(surface, base, [change])).toEqual({ kind: "refused", problems: ["t was changed after the edit"] });
  });

  it("RS21.40 a change to a document the surface lacks is refused though the documents hold it", () => {
    const change: Change = { document: "nowhere", wrote: [{ op: "add", path: "/x", value: 1 }], inverse: [{ op: "remove", path: "/x" }] };
    expect(api.revert(surface, { ...base, nowhere: { x: 1 } }, [change])).toEqual({ kind: "refused", problems: ["nowhere is not a document of the surface"] });
  });
});

describe("mutation hardening of surfaces: what a declaration keeps", () => {
  it("RS21.41 a JSON document is kept as declared", () => {
    const spec = { schema: z.any(), classify: () => "config" };
    expect(api.defineSurface({ documents: { cfg: spec }, components: ["config"] }).documents["cfg"]).toBe(spec);
  });

  it("RS21.42 a surface declared without structural components has none", () => {
    expect(api.defineSurface({ documents: {}, components: ["prompt"] }).structural).toEqual([]);
  });

  it("RS21.43 the removal of a key that is the empty string is told apart from a path that names no key", () => {
    const change: Change = { document: "cfg", wrote: [{ op: "remove", path: "" }], inverse: [{ op: "replace", path: "/b", value: 0 }] };
    expect(api.revert(surface, { cfg: { "": 1, b: 1 }, t: "x" }, [change])).toEqual({ kind: "refused", problems: ["cfg was changed after the edit"] });
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

describe("mutation hardening of surfaces: the op schemas", () => {
  const ops = [
    { op: "add", document: "cfg", path: "/a", value: { k: [1, null] } },
    { op: "replace", document: "cfg", path: "", value: "whole" },
    { op: "remove", document: "cfg", path: "/a/0" },
    { op: "edit", document: "t", old: "a", new: "" },
  ];

  it("RS21.53 each kind of proposed op parses, as it was written", () => {
    for (const op of ops) expect(api.OpSchema.parse(op)).toEqual(op);
  });

  it("RS21.54 each kind of recorded op parses, as it was written", () => {
    const recorded = [
      { op: "add", path: "/a", value: { k: [1, null] } },
      { op: "replace", path: "", value: "whole" },
      { op: "remove", path: "/a/0", length: 0 },
      { op: "remove", path: "/a" },
      { op: "edit", old: "a", new: "", before: "x", after: "y" },
      { op: "edit", old: "a", new: "b" },
    ];
    for (const op of recorded) expect(api.PatchOpSchema.parse(op)).toEqual(op);
    expect(api.PatchOpSchema.safeParse({ op: "remove", path: "/a", length: -1 }).success).toBe(false);
  });

  it("RS21.55 a proposed path is a JSON Pointer: empty, or starting with a slash and holding no line break", () => {
    for (const path of ["", "/", "/a/b", "/a b", "/~0/~1"]) expect(api.OpSchema.safeParse({ op: "remove", document: "cfg", path }).success).toBe(true);
    for (const path of ["a", "a/b", " /a", "\n/a", "/a\nb", "/a\n"]) expect(api.OpSchema.safeParse({ op: "remove", document: "cfg", path }).success).toBe(false);
  });

  it("RS21.56 a path that is not a pointer is refused with the reason", () => {
    const r = api.OpSchema.safeParse({ op: "remove", document: "cfg", path: "a" });
    expect(r.success ? [] : r.error.issues.map((i) => i.message)).toEqual(["a JSON Pointer (empty, or starting with /)"]);
  });

  it("RS21.57 an array index of two or more digits is an index", () => {
    const docs = { cfg: { a: Array.from({ length: 12 }, (_, i) => i) }, t: "" };
    const r = done(docs, [replace("/a/10", "ten")]);
    expect((r.documents["cfg"] as { a: unknown[] }).a[10]).toBe("ten");
    expect(problems(apply(docs, [replace("/a/1x", 0)]))).toEqual(["edit e1 does not apply: cannot replace at /a/1x: the index is not valid"]);
  });
});
