import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyProposal, defineSurface, revert } from "@harness/evolution";
import type { Documents, Proposal } from "@harness/evolution";

type Ops = Proposal["edits"][number]["ops"];

const surface = defineSurface({ documents: { t: { kind: "text" }, cfg: { schema: z.any() } }, components: ["prompt", "config"] });
const proposal = (opsPerEdit: readonly Ops[]): Proposal => ({ summary: "s", edits: opsPerEdit.map((ops, i) => ({ id: `e${i}`, hypothesis: "h", targets: "t", predicted: [], ops })) });

const piece = fc.constantFrom("a", "b", "\n", "\r\n", "😀", "ab", "x y");
const text = (min: number, max: number) => fc.array(piece, { minLength: min, maxLength: max }).map((p) => p.join(""));

/** A document, and edits whose `old` is a slice of it (slices may split a surrogate pair: those are refused, which is fine). */
const textCase = fc
  .record({ doc: text(1, 12), edits: fc.array(fc.array(fc.record({ from: fc.nat(30), length: fc.integer({ min: 1, max: 3 }), replacement: fc.oneof(fc.constant(""), text(0, 3)) }), { minLength: 1, maxLength: 2 }), { minLength: 1, maxLength: 3 }) })
  .map(({ doc, edits }) => ({
    doc,
    ops: edits.map((ops) =>
      ops.map((o): Ops[number] => {
        const a = o.from % doc.length;
        return { op: "edit", document: "t", old: doc.slice(a, a + o.length), new: o.replacement };
      }),
    ),
  }));

const asText = (r: { documents: Documents }) => r.documents["t"];

describe("text edits revert exactly or refuse (properties)", () => {
  it("RS18.41 the edits of any applied proposal, taken out in reverse order, restore the original text", () => {
    fc.assert(
      fc.property(textCase, ({ doc, ops }) => {
        const r = applyProposal(surface, { t: doc, cfg: {} }, proposal(ops), 5);
        if (r.kind !== "applied") return;
        let current: Documents = r.documents;
        for (const applied of [...r.edits].reverse()) {
          const back = revert(surface, current, applied.changes);
          if (back.kind !== "applied") throw new Error(`refused: ${back.problems.join("; ")}`);
          current = back.documents;
        }
        expect(asText({ documents: current })).toBe(doc);
      }),
      { numRuns: 3000 },
    );
  });

  it("RS18.42 taking one edit out of an applied proposal restores the text the others alone make, or refuses: it is never silently wrong", () => {
    fc.assert(
      fc.property(textCase, fc.nat(), ({ doc, ops }, pick) => {
        const r = applyProposal(surface, { t: doc, cfg: {} }, proposal(ops), 5);
        if (r.kind !== "applied" || r.edits.length < 2) return;
        const k = pick % r.edits.length;
        const back = revert(surface, r.documents, r.edits[k]!.changes);
        if (back.kind === "refused") return;
        const others = applyProposal(surface, { t: doc, cfg: {} }, proposal(ops.filter((_, i) => i !== k)), 5);
        if (others.kind !== "applied") throw new Error("the others do not apply alone");
        expect(asText(back)).toBe(asText(others));
      }),
      { numRuns: 3000 },
    );
  });
});

const item = fc.constantFrom("p", "q", "r", "s", "u");
const arrays = fc.record({ a: fc.array(item, { maxLength: 5 }), b: fc.array(item, { maxLength: 5 }), c: fc.array(item, { maxLength: 5 }) });
/** Ops on the arrays a, b, c by a chosen position (resolved against the length at the time the generator picks it, so some are out of range and refused). */
const jsonOp = fc.record({ array: fc.constantFrom("a", "b", "c"), kind: fc.constantFrom("add", "addEnd", "replace", "remove"), at: fc.nat(6), value: item });

describe("JSON array edits revert exactly or refuse (properties)", () => {
  it("RS18.43 edits of different arrays are independent, apply in any order, and revert singly to the others alone or in reverse to the original", () => {
    fc.assert(
      fc.property(arrays, fc.array(fc.array(jsonOp, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 3 }), fc.nat(), (cfg, edits, pick) => {
        const toOps = (ops: readonly (typeof jsonOp extends fc.Arbitrary<infer T> ? T : never)[]): Ops =>
          ops.map((o): Ops[number] => {
            const path = o.kind === "addEnd" ? `/${o.array}/-` : `/${o.array}/${o.at}`;
            if (o.kind === "remove") return { op: "remove", document: "cfg", path };
            return { op: o.kind === "replace" ? "replace" : "add", document: "cfg", path, value: o.value };
          });
        const all = edits.map(toOps);
        const r = applyProposal(surface, { t: "x", cfg }, proposal(all), 5);
        if (r.kind !== "applied") return;
        let current: Documents = r.documents;
        for (const applied of [...r.edits].reverse()) {
          const back = revert(surface, current, applied.changes);
          if (back.kind !== "applied") throw new Error(`refused: ${back.problems.join("; ")}`);
          current = back.documents;
        }
        expect(current["cfg"]).toEqual(cfg);
        if (r.edits.length < 2) return;
        const k = pick % r.edits.length;
        const single = revert(surface, r.documents, r.edits[k]!.changes);
        const others = applyProposal(surface, { t: "x", cfg }, proposal(all.filter((_, i) => i !== k)), 5);
        if (single.kind === "applied" && others.kind === "applied") expect(single.documents["cfg"]).toEqual(others.documents["cfg"]);
      }),
      { numRuns: 2000 },
    );
  });
});
