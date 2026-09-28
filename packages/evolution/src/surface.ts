import jsonpatch from "fast-json-patch";
import { z } from "zod";

/**
 * The evolvable harness is data: named JSON documents, each parsed by its schema (the
 * repository's rule that whatever is tuned by hand is data, with a schema). A candidate is
 * a set of edits, each a JSON Patch (RFC 6902) with the hypothesis it tests. Because the
 * edits are data, what the paper leaves to the proposer's word and a critic's reading is
 * computed here: how many independent edits a candidate makes (edits touching the same
 * part are one), which components each touches (classified from the paths it changed,
 * not from its declared tag), how large it is, whether the harness still parses (the
 * liveness check), and how to take it back out (its inverse, for pruning).
 */

const { applyPatch, compare, getValueByPointer, _areEquals: equal } = jsonpatch;

const text = z.string().min(1);
const pointer = z.string().regex(/^(\/.*)?$/, "a JSON Pointer (empty, or starting with /)");

export const OpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), document: text, path: pointer, value: z.json() }),
  z.strictObject({ op: z.literal("replace"), document: text, path: pointer, value: z.json() }),
  z.strictObject({ op: z.literal("remove"), document: text, path: pointer }),
]);
export type Op = z.output<typeof OpSchema>;

export const EditSchema = z.strictObject({
  id: text,
  /** The mechanism, and why it should move the score. */
  hypothesis: text,
  /** The failure mode, capability gap or habit it targets. */
  targets: text,
  /** Tasks it should move; checked against the evaluation afterwards. */
  predicted: z.array(text).default([]),
  ops: z.array(OpSchema).min(1),
});
export type Edit = z.output<typeof EditSchema>;

/** What a proposer answers: a candidate harness as edits to the incumbent. */
export const ProposalSchema = z.strictObject({ summary: text, edits: z.array(EditSchema) });
export type Proposal = z.output<typeof ProposalSchema>;

/** A JSON Patch operation as computed from a diff: an add, a replace or a remove. */
export const PatchOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), path: z.string(), value: z.json() }),
  z.strictObject({ op: z.literal("replace"), path: z.string(), value: z.json() }),
  z.strictObject({ op: z.literal("remove"), path: z.string() }),
]);
export type PatchOp = z.output<typeof PatchOpSchema>;

/** What an edit did to one document: the diff it wrote, and the patch that undoes it. */
export const ChangeSchema = z.strictObject({ document: text, wrote: z.array(PatchOpSchema).readonly(), inverse: z.array(PatchOpSchema).readonly() });
export type Change = z.output<typeof ChangeSchema>;

export interface AppliedEdit {
  readonly id: string;
  readonly hypothesis: string;
  readonly targets: string;
  readonly predicted: readonly string[];
  readonly changes: readonly Change[];
  /** The surface's components of the paths it changed. */
  readonly components: readonly string[];
  /** JSON leaves written or removed. */
  readonly footprint: number;
}

export interface DocumentSpec {
  readonly schema: z.ZodType;
  /** The component a changed path belongs to; by default a string is a prompt and anything else configuration. */
  readonly classify?: (path: string, value: unknown) => string;
}

export interface Surface {
  readonly documents: Readonly<Record<string, DocumentSpec>>;
  /** The component vocabulary K. */
  readonly components: readonly string[];
  /** Components that add machinery rather than change text or constants (the paper's K_str). */
  readonly structural: readonly string[];
}

export type Documents = Readonly<Record<string, unknown>>;

export type Applied<T> = ({ readonly kind: "applied" } & T) | { readonly kind: "refused"; readonly problems: readonly string[] };

export function defineSurface(spec: { readonly documents: Readonly<Record<string, DocumentSpec>>; readonly components: readonly string[]; readonly structural?: readonly string[] }): Surface {
  if (spec.components.length === 0) throw new RangeError("a surface needs at least one component");
  const stray = (spec.structural ?? []).filter((c) => !spec.components.includes(c));
  if (stray.length) throw new RangeError(`structural components must be components: ${stray.join(", ")}`);
  return { documents: spec.documents, components: spec.components, structural: spec.structural ?? [] };
}

const defaultClassify = (_: string, value: unknown) => (typeof value === "string" ? "prompt" : "config");

/** JSON leaves in a value (an empty object or array counts as one). */
function leaves(value: unknown): number {
  if (typeof value !== "object" || value === null) return 1;
  const children = Object.values(value);
  return children.length === 0 ? 1 : children.reduce<number>((n, v) => n + leaves(v), 0);
}

/** Whether two pointers in one document address overlapping parts (one is the other or inside it). */
const overlaps = (a: string, b: string) => a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!;

function diff(before: unknown, after: unknown): { wrote: PatchOp[]; inverse: PatchOp[] } {
  // compare() takes objects and arrays; a document is one, as its schema says.
  const wrote = z.array(PatchOpSchema).parse(compare(before as object, after as object));
  const inverse = z.array(PatchOpSchema).parse(compare(after as object, before as object));
  return { wrote, inverse };
}

function parseAll(surface: Surface, documents: Documents, changed: Iterable<string>): string[] {
  return [...new Set(changed)].flatMap((name) => {
    const result = surface.documents[name]!.schema.safeParse(documents[name]);
    return result.success ? [] : [`${name} no longer parses: ${z.prettifyError(result.error)}`];
  });
}

/**
 * Apply a proposal to the incumbent's documents (which are not changed). Refused, with
 * every reason, when it has no edits or more than the round's budget, repeats an id,
 * has two edits touching the same part, names no document of the surface, does not
 * apply, changes nothing, touches a path its surface classifies outside its components,
 * or leaves a document its schema refuses.
 */
export function applyProposal(surface: Surface, documents: Documents, proposal: Proposal, budget: number): Applied<{ readonly documents: Documents; readonly edits: readonly AppliedEdit[] }> {
  const { edits } = proposal;
  if (edits.length === 0) return { kind: "refused", problems: ["no edits"] };
  if (edits.length > budget) return { kind: "refused", problems: [`${edits.length} edits, more than this round's budget of ${budget}`] };
  const problems: string[] = [];
  const ids = edits.map((e) => e.id);
  const repeated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (repeated.length) problems.push(`edit ids repeat: ${repeated.join(", ")}`);
  for (let i = 0; i < edits.length; i++)
    for (let j = i + 1; j < edits.length; j++) {
      const shared = edits[i]!.ops.flatMap((a) => edits[j]!.ops.filter((b) => a.document === b.document && overlaps(a.path, b.path)).map((b) => `${a.document}${a.path.length <= b.path.length ? a.path : b.path}`));
      if (shared.length) problems.push(`edits ${edits[i]!.id} and ${edits[j]!.id} both touch ${shared[0]}: they are one edit, or not independent`);
    }
  if (problems.length) return { kind: "refused", problems };

  const working: Record<string, unknown> = { ...documents };
  const applied: AppliedEdit[] = [];
  const changedDocs: string[] = [];
  for (const edit of edits) {
    const unknown = edit.ops.find((o) => !(o.document in surface.documents) || !(o.document in documents));
    if (unknown) {
      problems.push(`edit ${edit.id} names no document of the surface: ${unknown.document}`);
      continue;
    }
    const names = [...new Set(edit.ops.map((o) => o.document))];
    const after: Record<string, unknown> = {};
    try {
      for (const name of names) {
        const ops = edit.ops.filter((o) => o.document === name).map(({ document: _, ...op }) => op);
        after[name] = applyPatch(working[name], ops, true, false).newDocument;
      }
    } catch (e) {
      problems.push(`edit ${edit.id} does not apply: ${message(e)}`);
      continue;
    }
    const changes = names.map((name) => ({ document: name, ...diff(working[name], after[name]) })).filter((c) => c.wrote.length > 0);
    if (changes.length === 0) {
      problems.push(`edit ${edit.id} changes nothing`);
      continue;
    }
    const components = new Set<string>();
    let footprint = 0;
    for (const change of changes) {
      const classify = surface.documents[change.document]!.classify ?? defaultClassify;
      for (const op of change.wrote) {
        const value = op.op === "remove" ? getValueByPointer(working[change.document], op.path) : op.value;
        footprint += leaves(value);
        const component = classify(op.path, value);
        if (!surface.components.includes(component)) problems.push(`edit ${edit.id} changes ${change.document}${op.path}, which the surface classifies as ${component}, not one of ${surface.components.join(", ")}`);
        components.add(component);
      }
    }
    for (const name of names) working[name] = after[name];
    changedDocs.push(...names);
    applied.push({ id: edit.id, hypothesis: edit.hypothesis, targets: edit.targets, predicted: edit.predicted, changes, components: [...components].sort(), footprint });
  }
  problems.push(...parseAll(surface, working, changedDocs));
  return problems.length ? { kind: "refused", problems } : { kind: "applied", documents: working, edits: applied };
}

/**
 * Take an accepted edit back out of the documents: its inverse patch, applied only while
 * every path it wrote still holds what it wrote (an edit a later one rewrote is no longer
 * one mechanism that can be removed on its own).
 */
export function revert(surface: Surface, documents: Documents, changes: readonly Change[]): Applied<{ readonly documents: Documents }> {
  const problems = changes.flatMap((c) =>
    c.wrote.flatMap((op) => {
      const now = getValueByPointer(documents[c.document], op.path);
      const intact = op.op === "remove" ? now === undefined : equal(now, op.value);
      return intact ? [] : [`${c.document}${op.path} was changed after the edit`];
    }),
  );
  if (problems.length) return { kind: "refused", problems };
  const working: Record<string, unknown> = { ...documents };
  for (const c of changes) working[c.document] = applyPatch(working[c.document], [...c.inverse], true, false).newDocument;
  const invalid = parseAll(
    surface,
    working,
    changes.map((c) => c.document),
  );
  return invalid.length ? { kind: "refused", problems: invalid } : { kind: "applied", documents: working };
}
