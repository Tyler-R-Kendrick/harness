import jsonpatch from "fast-json-patch";
import { z } from "zod";

/**
 * The evolvable harness is data: named documents, each parsed by its schema (the
 * repository's rule that whatever is tuned by hand is data, with a schema). A candidate is
 * a set of edits, each a JSON Patch (RFC 6902) with the hypothesis it tests. Because the
 * edits are data, what the paper leaves to the proposer's word and a critic's reading is
 * computed here: how many independent edits a candidate makes (edits touching the same
 * part are one), which components each touches (classified from the paths it changed,
 * not from its declared tag), how large it is, whether the harness still parses (the
 * liveness check), and how to take it back out (its inverse, for pruning).
 *
 * A document is JSON (edited by JSON Patch) or text (`kind: "text"`: a JSON string, such as
 * a source file). Text is edited by `{op: "edit", old, new}`, where `old` must occur exactly
 * once (the reference implementation's edit_file), or replaced whole at the root. The same
 * guarantees hold: independence is the overlap of the character ranges the edits' `old`
 * strings occupy in the original text, size is the changed lines, liveness is the schema
 * and the host's `check`, and every edit keeps the inverse that takes it back out.
 */

const { applyPatch, compare, getValueByPointer, _areEquals: equal } = jsonpatch;

const text = z.string().min(1);
const pointer = z.string().regex(/^(\/.*)?$/, "a JSON Pointer (empty, or starting with /)");

export const OpSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("add"),
    document: text,
    path: pointer,
    value: z.json(),
  }),
  z.strictObject({
    op: z.literal("replace"),
    document: text,
    path: pointer,
    value: z.json(),
  }),
  z.strictObject({ op: z.literal("remove"), document: text, path: pointer }),
  /** Text documents: replace the one occurrence of `old` with `new`. */
  z.strictObject({
    op: z.literal("edit"),
    document: text,
    old: text,
    new: z.string(),
  }),
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
export const ProposalSchema = z.strictObject({
  summary: text,
  edits: z.array(EditSchema),
});
export type Proposal = z.output<typeof ProposalSchema>;

/** A change operation as computed from a diff: a JSON Patch add, replace or remove, or a text edit. A text document's whole-text replace is a replace at "". */
export const PatchOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), path: z.string(), value: z.json() }),
  z.strictObject({
    op: z.literal("replace"),
    path: z.string(),
    value: z.json(),
  }),
  z.strictObject({ op: z.literal("remove"), path: z.string() }),
  /**
   * A text edit as recorded: `before + old + after` becomes `before + new + after`, where
   * the context is present only when `new` alone would not be found exactly once (a
   * deletion, or text that repeats), so that the edit can be located again to revert it.
   */
  z.strictObject({
    op: z.literal("edit"),
    old: z.string(),
    new: z.string(),
    before: z.string().exactOptional(),
    after: z.string().exactOptional(),
  }),
]);
export type PatchOp = z.output<typeof PatchOpSchema>;

/** What an edit did to one document: the diff it wrote, and the patch that undoes it. */
export const ChangeSchema = z.strictObject({
  document: text,
  wrote: z.array(PatchOpSchema).readonly(),
  inverse: z.array(PatchOpSchema).readonly(),
});
export type Change = z.output<typeof ChangeSchema>;

export interface AppliedEdit {
  readonly id: string;
  readonly hypothesis: string;
  readonly targets: string;
  readonly predicted: readonly string[];
  readonly changes: readonly Change[];
  /** The surface's components of the paths it changed. */
  readonly components: readonly string[];
  /** JSON leaves written or removed, and changed lines (added and removed) of text. */
  readonly footprint: number;
}

export interface JsonDocumentSpec {
  readonly kind?: "json";
  readonly schema: z.ZodType;
  /** The component a changed path belongs to; by default a string is a prompt and anything else configuration. */
  readonly classify?: (path: string, value: unknown) => string;
}

/** A document that is one string (a source file's text, or long prose). */
export interface TextDocumentSpec {
  readonly kind: "text";
  /** The schema the text must parse with; a string by default. */
  readonly schema: z.ZodType;
  /** The host's liveness check of the whole text (it parses, it compiles): a problem, or undefined when it is fine. */
  readonly check?: (text: string) => string | undefined;
  /** The components of one changed region (the text an edit replaced and what it wrote; the whole text for a replace); by default the document's component. */
  readonly classifyText?: (before: string, after: string) => readonly string[];
  /** The component of a changed region by default, and when `classifyText` names none: `prompt`. */
  readonly component?: string;
}

export type DocumentSpec = JsonDocumentSpec | TextDocumentSpec;

/** What a surface is declared with: a text document's schema may be left out. */
export type DocumentInput = JsonDocumentSpec | (Omit<TextDocumentSpec, "schema"> & { readonly schema?: z.ZodType });

export interface Surface {
  readonly documents: Readonly<Record<string, DocumentSpec>>;
  /** The component vocabulary K. */
  readonly components: readonly string[];
  /** Components that add machinery rather than change text or constants (the paper's K_str). */
  readonly structural: readonly string[];
}

export type Documents = Readonly<Record<string, unknown>>;

export type Applied<T> = ({ readonly kind: "applied" } & T) | { readonly kind: "refused"; readonly problems: readonly string[] };

export function defineSurface(spec: { readonly documents: Readonly<Record<string, DocumentInput>>; readonly components: readonly string[]; readonly structural?: readonly string[] }): Surface {
  if (spec.components.length === 0) throw new RangeError("a surface needs at least one component");
  const stray = (spec.structural ?? []).filter((c) => !spec.components.includes(c));
  if (stray.length) throw new RangeError(`structural components must be components: ${stray.join(", ")}`);
  const documents = Object.fromEntries(
    Object.entries(spec.documents).map(([name, d]): [string, DocumentSpec] => {
      if (d.kind !== "text") return [name, d];
      if (d.component !== undefined && !spec.components.includes(d.component)) throw new RangeError(`text document ${name}'s component must be a component: ${d.component}`);
      return [name, { ...d, schema: d.schema ?? z.string() }];
    }),
  );
  return {
    documents,
    components: spec.components,
    structural: spec.structural ?? [],
  };
}

/** A JSON document's diff holds JSON Patch operations only. */
const isJsonOp = (op: PatchOp): op is Exclude<PatchOp, { op: "edit" }> => op.op !== "edit";

const isText = (spec: DocumentSpec | undefined): spec is TextDocumentSpec => spec?.kind === "text";

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

// ---- text documents ------------------------------------------------------------------

/** Where `needle` starts in `text`, every occurrence, overlapping ones included (an empty needle occurs nowhere: it cannot be located). */
function occurrences(text: string, needle: string): number[] {
  const at: number[] = [];
  if (needle === "") return at;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) at.push(i);
  return at;
}

const preview = (s: string) => JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}...` : s);

/**
 * The lines an edit changed, added and removed: `old` and `new` as lines, less the lines
 * they share at the start and at the end.
 */
function changedLines(before: string, after: string): number {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return a.length - head - tail + (b.length - head - tail);
}

/**
 * The context to write around the `length` characters placed at `at` in `text`, the least
 * that makes the whole one occurrence: none when the text alone is found exactly once.
 * Undefined when nothing does (the text is empty).
 */
function anchor(text: string, at: number, length: number): { before?: string; after?: string } | undefined {
  const around = (n: number) => text.slice(Math.max(0, at - n), at + length + n);
  const unique = (n: number) => occurrences(text, around(n)).length === 1;
  if (unique(0)) return {};
  let high = Math.max(at, text.length - at - length);
  if (!unique(high)) return undefined;
  // More context never makes a unique snippet ambiguous, so the least is found by bisection.
  let low = 0;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (unique(mid)) high = mid;
    else low = mid;
  }
  const before = text.slice(Math.max(0, at - high), at);
  const after = text.slice(at + length, at + length + high);
  return { ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

/** An op without its document (distributed over the op kinds). */
type BareOp = Op extends infer O ? (O extends unknown ? Omit<O, "document"> : never) : never;

interface TextResult {
  readonly text: string;
  readonly wrote: PatchOp[];
  readonly inverse: PatchOp[];
  /** Each changed region as it was and as it is: the old and new of an edit, the whole text of a replace. */
  readonly regions: (readonly [string, string])[];
}

/** Apply the ops of one edit to a text document in order; each `old` must occur exactly once in the text as it then is. */
function applyTextOps(name: string, current: unknown, ops: readonly BareOp[]): TextResult {
  if (typeof current !== "string") throw new Error(`${name} is not text`);
  let text = current;
  const wrote: PatchOp[] = [];
  const inverse: PatchOp[] = [];
  const regions: (readonly [string, string])[] = [];
  for (const op of ops) {
    if (op.op === "edit") {
      const at = occurrences(text, op.old);
      if (at.length !== 1) throw new Error(at.length === 0 ? `the old text is not in ${name}: ${preview(op.old)}` : `the old text occurs ${at.length} times in ${name}, not exactly once: ${preview(op.old)}`);
      if (op.new === op.old) continue;
      const start = at[0]!;
      const next = text.slice(0, start) + op.new + text.slice(start + op.old.length);
      const context = anchor(next, start, op.new.length);
      if (context === undefined) {
        // The whole text was deleted: only a replace of the whole text can be taken back.
        wrote.push({ op: "replace", path: "", value: next });
        inverse.unshift({ op: "replace", path: "", value: text });
      } else {
        wrote.push({ op: "edit", old: op.old, new: op.new, ...context });
        inverse.unshift({ op: "edit", old: op.new, new: op.old, ...context });
      }
      regions.push([op.old, op.new]);
      text = next;
    } else if (op.op === "replace" && op.path === "") {
      if (typeof op.value !== "string") throw new Error(`${name} is text: a replace at its root needs a string`);
      if (op.value === text) continue;
      wrote.push({ op: "replace", path: "", value: op.value });
      inverse.unshift({ op: "replace", path: "", value: text });
      regions.push([text, op.value]);
      text = op.value;
    } else throw new Error(`${name} is text: only an edit or a replace at its root applies, not ${op.op} at ${JSON.stringify(op.path)}`);
  }
  return { text, wrote, inverse, regions };
}

/** Take a text change back out: its inverse, applied in order, each where it is found exactly once (a replace of the whole text only while it is still what it wrote). */
function revertText(current: unknown, change: Change): { readonly text: string } | { readonly problem: string } {
  const problem = { problem: `${change.document} was changed after the edit` };
  if (typeof current !== "string") return problem;
  let text = current;
  for (const [i, inv] of change.inverse.entries()) {
    if (inv.op === "edit") {
      const needle = `${inv.before ?? ""}${inv.old}${inv.after ?? ""}`;
      const at = occurrences(text, needle);
      if (at.length !== 1) return problem;
      text = text.slice(0, at[0]!) + `${inv.before ?? ""}${inv.new}${inv.after ?? ""}` + text.slice(at[0]! + needle.length);
    } else {
      const wrote = change.wrote[change.wrote.length - 1 - i];
      if (inv.op !== "replace" || inv.path !== "" || typeof inv.value !== "string" || wrote?.op !== "replace" || wrote.value !== text) return problem;
      text = inv.value;
    }
  }
  return { text };
}

// ---- independence --------------------------------------------------------------------

/** The part of a document an op touches: a JSON pointer, or (text) the characters its `old` occupies in the original. The root pointer is the whole document. */
type Region = { readonly document: string; readonly path: string } | { readonly document: string; readonly start: number; readonly end: number };

/**
 * An edit of a text document is located by its `old` in the ORIGINAL text; one that is not
 * found exactly once there (it needs an earlier edit's output, or is ambiguous) cannot be
 * shown independent and counts as the whole document, as does any op that is not an edit.
 */
function regionOf(surface: Surface, documents: Documents, op: Op): Region {
  if (isText(surface.documents[op.document])) {
    const original = documents[op.document];
    if (op.op === "edit" && typeof original === "string") {
      const at = occurrences(original, op.old);
      if (at.length === 1)
        return {
          document: op.document,
          start: at[0]!,
          end: at[0]! + op.old.length,
        };
    }
    return { document: op.document, path: "" };
  }
  return { document: op.document, path: op.op === "edit" ? "" : op.path };
}

/** Where two regions overlap, as they are named in a refusal; undefined when they do not. */
function clash(a: Region, b: Region): string | undefined {
  if (a.document !== b.document) return undefined;
  if ("path" in a && "path" in b) return overlaps(a.path, b.path) ? `${a.document}${a.path.length <= b.path.length ? a.path : b.path}` : undefined;
  if ("path" in a || "path" in b) return a.document;
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? `${a.document}[${start}:${end}]` : undefined;
}

function parseAll(surface: Surface, documents: Documents, changed: Iterable<string>): string[] {
  return [...new Set(changed)].flatMap((name) => {
    const spec = surface.documents[name]!;
    const result = spec.schema.safeParse(documents[name]);
    if (!result.success) return [`${name} no longer parses: ${z.prettifyError(result.error)}`];
    const problem = isText(spec) ? spec.check?.(String(documents[name])) : undefined;
    return problem === undefined ? [] : [`${name} fails its check: ${problem}`];
  });
}

/**
 * Apply a proposal to the incumbent's documents (which are not changed). Refused, with
 * every reason, when it has no edits or more than the round's budget, repeats an id,
 * has two edits touching the same part, names no document of the surface, does not
 * apply, changes nothing, touches a part its surface classifies outside its components,
 * or leaves a document its schema (or, for text, its check) refuses.
 */
export function applyProposal(
  surface: Surface,
  documents: Documents,
  proposal: Proposal,
  budget: number,
): Applied<{
  readonly documents: Documents;
  readonly edits: readonly AppliedEdit[];
}> {
  const { edits } = proposal;
  if (edits.length === 0) return { kind: "refused", problems: ["no edits"] };
  if (edits.length > budget)
    return {
      kind: "refused",
      problems: [`${edits.length} edits, more than this round's budget of ${budget}`],
    };
  const problems: string[] = [];
  const ids = edits.map((e) => e.id);
  const repeated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (repeated.length) problems.push(`edit ids repeat: ${repeated.join(", ")}`);
  const regions = edits.map((e) => e.ops.map((op) => regionOf(surface, documents, op)));
  for (let i = 0; i < edits.length; i++)
    for (let j = i + 1; j < edits.length; j++) {
      const shared = regions[i]!.flatMap((a) => regions[j]!.flatMap((b) => clash(a, b) ?? []));
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
    const texts: Record<string, TextResult> = {};
    try {
      for (const name of names) {
        const ops = edit.ops.filter((o) => o.document === name).map(({ document: _, ...op }) => op);
        if (isText(surface.documents[name])) {
          texts[name] = applyTextOps(name, working[name], ops);
          after[name] = texts[name].text;
        } else {
          const patch = ops.flatMap((op) => (op.op === "edit" ? [] : [op]));
          if (patch.length < ops.length) throw new Error(`${name} is JSON: an edit op applies to text documents`);
          after[name] = applyPatch(working[name], patch, true, false).newDocument;
        }
      }
    } catch (e) {
      problems.push(`edit ${edit.id} does not apply: ${message(e)}`);
      continue;
    }
    const changes = names
      .map((name) => ({
        document: name,
        ...(texts[name] ?? diff(working[name], after[name])),
      }))
      .filter((c) => c.wrote.length > 0);
    if (changes.length === 0) {
      problems.push(`edit ${edit.id} changes nothing`);
      continue;
    }
    const components = new Set<string>();
    let footprint = 0;
    for (const change of changes) {
      const spec = surface.documents[change.document]!;
      const claim = (where: string, component: string) => {
        if (!surface.components.includes(component)) problems.push(`edit ${edit.id} changes ${where}, which the surface classifies as ${component}, not one of ${surface.components.join(", ")}`);
        components.add(component);
      };
      if (isText(spec)) {
        for (const [before, now] of texts[change.document]!.regions) {
          footprint += changedLines(before, now);
          const named = spec.classifyText?.(before, now) ?? [];
          for (const component of named.length ? named : [spec.component ?? "prompt"]) claim(change.document, component);
        }
        continue;
      }
      const classify = spec.classify ?? defaultClassify;
      for (const op of change.wrote.filter(isJsonOp)) {
        const value = op.op === "remove" ? getValueByPointer(working[change.document], op.path) : op.value;
        footprint += leaves(value);
        claim(`${change.document}${op.path}`, classify(op.path, value));
      }
    }
    for (const name of names) working[name] = after[name];
    changedDocs.push(...names);
    applied.push({
      id: edit.id,
      hypothesis: edit.hypothesis,
      targets: edit.targets,
      predicted: edit.predicted,
      changes: changes.map(({ document, wrote, inverse }) => ({
        document,
        wrote,
        inverse,
      })),
      components: [...components].sort(),
      footprint,
    });
  }
  problems.push(...parseAll(surface, working, changedDocs));
  return problems.length ? { kind: "refused", problems } : { kind: "applied", documents: working, edits: applied };
}

/**
 * Take an accepted edit back out of the documents: its inverse patch, applied only while
 * every part it wrote still holds what it wrote (an edit a later one rewrote is no longer
 * one mechanism that can be removed on its own). For text, the inverse edits must each be
 * found exactly once, so text that was altered, or now occurs twice, refuses.
 */
export function revert(surface: Surface, documents: Documents, changes: readonly Change[]): Applied<{ readonly documents: Documents }> {
  const reverted = new Map<string, string>();
  const problems = changes.flatMap((c) => {
    if (isText(surface.documents[c.document])) {
      const r = revertText(documents[c.document], c);
      if ("problem" in r) return [r.problem];
      reverted.set(c.document, r.text);
      return [];
    }
    return c.wrote.flatMap((op) => {
      if (op.op === "edit") return [`${c.document} is JSON: an edit op applies to text documents`];
      const now = getValueByPointer(documents[c.document], op.path);
      const intact = op.op === "remove" ? now === undefined : equal(now, op.value);
      return intact ? [] : [`${c.document}${op.path} was changed after the edit`];
    });
  });
  if (problems.length) return { kind: "refused", problems };
  const working: Record<string, unknown> = { ...documents };
  for (const c of changes)
    working[c.document] =
      reverted.get(c.document) ??
      applyPatch(
        working[c.document],
        c.inverse.filter((op) => op.op !== "edit"),
        true,
        false,
      ).newDocument;
  const invalid = parseAll(
    surface,
    working,
    changes.map((c) => c.document),
  );
  return invalid.length ? { kind: "refused", problems: invalid } : { kind: "applied", documents: working };
}
