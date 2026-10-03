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

const { _areEquals: equal } = jsonpatch;

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
  /** `length`: for an array element, the array's length after the removal (later indices moved, so what is left of the array is how it is told). */
  z.strictObject({ op: z.literal("remove"), path: z.string(), length: z.int().min(0).exactOptional() }),
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

/**
 * What an edit did to one document: the ops as it applied them, and the ops that undo them.
 * For JSON, the inverse at each position undoes the write at that position and they are
 * applied last to first (an append is written at the index it took; an element's removal
 * keeps the array's length after it). For text, the inverse is already in the order to apply.
 */
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

/** A value as a recorded op holds it (JSON, whatever the document's own type says). */
const asJson = (value: unknown): Extract<PatchOp, { op: "add" }>["value"] => value as never;

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

/** A named entry of a map that is its own (never one `Object.prototype` has: `toString`, `constructor`, ...). */
const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

// ---- JSON documents ------------------------------------------------------------------

const isContainer = (value: unknown): value is Record<string, unknown> | unknown[] => typeof value === "object" && value !== null;

/** A deep copy of a JSON value (own properties only; a key named `__proto__` stays a key). */
function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneJson) as T;
  if (isContainer(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneJson(v)])) as T;
  return value;
}

/** An array index as JSON Pointer writes it: no sign, no leading zeros. */
const INDEX = /^(0|[1-9][0-9]*)$/;

const pointerSegments = (path: string): string[] => {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new Error(`${JSON.stringify(path)} is not a JSON pointer`);
  const segments = path
    .slice(1)
    .split("/")
    .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (segments.includes("__proto__")) throw new Error("modifying __proto__ is not allowed");
  return segments;
};

const pointerOf = (segments: readonly string[]): string => segments.map((s) => `/${s.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");

/** The value at a path, following own keys and array indices only; undefined wherever the walk leaves the document (JSON has no undefined). */
function lookup(document: unknown, segments: readonly string[]): unknown {
  let node = document;
  for (const key of segments) {
    if (Array.isArray(node)) node = INDEX.test(key) ? node[Number(key)] : undefined;
    else if (isContainer(node) && Object.hasOwn(node, key)) node = (node as Record<string, unknown>)[key];
    else return undefined;
  }
  return node;
}

/** One op as it was written: the ops it was applied as, and the value it wrote or removed (what the footprint counts and the classifier reads). */
interface Step {
  readonly path: string;
  readonly value: unknown;
}

interface JsonResult {
  readonly document: unknown;
  readonly wrote: PatchOp[];
  readonly inverse: PatchOp[];
  readonly steps: Step[];
}

type JsonOp = Exclude<BareOp, { op: "edit" }>;

/**
 * Apply the ops of one edit to a JSON document, in order, on a copy. Each op is recorded
 * as it was applied (an append at the index it took, an add over a key as a replace, a
 * removal with the value it removed) with the op that takes it back out: the change is
 * what the ops did, not a positional diff of two documents, so an insert in an array is
 * one add however long the array. An op that changes nothing is not recorded.
 */
function applyJsonOps(name: string, current: unknown, ops: readonly JsonOp[], restoring = false): JsonResult {
  let document = cloneJson(current);
  const wrote: PatchOp[] = [];
  const inverse: PatchOp[] = [];
  const steps: Step[] = [];
  const record = (w: JsonPatchOp, i: JsonPatchOp, value: unknown) => {
    wrote.push(w);
    inverse.push(i);
    steps.push({ path: w.path, value });
  };
  for (const op of ops) {
    const segments = pointerSegments(op.path);
    if (segments.length === 0) {
      if (op.op === "remove") throw new Error(`the root of ${name} cannot be removed`);
      // An object or an array root stays one (its schema says which); a root that is a scalar may be replaced.
      if (!restoring && isContainer(document) && !isContainer(op.value)) throw new Error(`the root of ${name} must stay an object or an array`);
      if (equal(document, op.value)) continue;
      record({ op: "replace", path: "", value: cloneJson(op.value) }, { op: "replace", path: "", value: asJson(document) }, op.value);
      document = cloneJson(op.value);
      continue;
    }
    const key = segments[segments.length - 1]!;
    const parent = lookup(document, segments.slice(0, -1));
    const fail = (reason: string) => new Error(`cannot ${op.op} at ${op.path}: ${reason}`);
    if (!isContainer(parent)) throw fail("its parent does not exist");
    if (Array.isArray(parent)) {
      const append = op.op === "add" && key === "-";
      if (!append && !INDEX.test(key)) throw fail("the index is not valid");
      const at = append ? parent.length : Number(key);
      if (at > parent.length || (op.op !== "add" && at === parent.length)) throw fail("the index is out of range");
      const path = pointerOf([...segments.slice(0, -1), String(at)]);
      if (op.op === "add") {
        parent.splice(at, 0, cloneJson(op.value));
        record({ op: "add", path, value: cloneJson(op.value) }, { op: "remove", path }, op.value);
      } else if (op.op === "remove") {
        const [previous] = parent.splice(at, 1);
        record({ op: "remove", path, length: parent.length }, { op: "add", path, value: asJson(previous) }, previous);
      } else {
        const previous = parent[at];
        if (equal(previous, op.value)) continue;
        parent[at] = cloneJson(op.value);
        record({ op: "replace", path, value: cloneJson(op.value) }, { op: "replace", path, value: asJson(previous) }, op.value);
      }
      continue;
    }
    const exists = Object.hasOwn(parent, key);
    if (op.op !== "add" && !exists) throw fail("there is nothing there");
    if (op.op === "remove") {
      const previous = parent[key];
      delete parent[key];
      record({ op: "remove", path: op.path }, { op: "add", path: op.path, value: asJson(previous) }, previous);
      continue;
    }
    const previous = parent[key];
    if (exists && equal(previous, op.value)) continue;
    parent[key] = cloneJson(op.value);
    record({ op: exists ? "replace" : "add", path: op.path, value: cloneJson(op.value) }, exists ? { op: "replace", path: op.path, value: asJson(previous) } : { op: "remove", path: op.path }, op.value);
  }
  return { document, wrote, inverse, steps };
}

/** A JSON Patch op as recorded (a text edit is not one). */
type JsonPatchOp = Exclude<PatchOp, { op: "edit" }>;

/** Whether what an op wrote still holds in the document (a removal: that nothing is at its path, or of an array element, that the array is as long as the removal left it). */
function holds(document: unknown, op: JsonPatchOp): boolean {
  let segments: string[];
  try {
    segments = pointerSegments(op.path);
  } catch {
    return false;
  }
  if (op.op !== "remove") return equal(lookup(document, segments), op.value);
  const parent = lookup(document, segments.slice(0, -1));
  const key = segments[segments.length - 1] ?? "";
  // An array is as long as the removal left it (a removal recorded before its length was: it left nothing at the index).
  if (Array.isArray(parent)) return INDEX.test(key) && (op.length === undefined ? Number(key) >= parent.length : parent.length === op.length);
  return isContainer(parent) && !Object.hasOwn(parent, key);
}

/**
 * Take a JSON change back out. Its writes are undone from the last to the first (the
 * inverse at each position undoes the write at that position), each only while it holds
 * in the document as the later ones leave it. A change whose inverse does not pair with
 * its writes (as saved before ops were replayed) is checked as a whole against the
 * document, then its inverse is applied in order. It refuses, and never throws.
 */
function revertJson(current: unknown, change: Change): { readonly document: unknown } | { readonly problems: string[] } {
  const { wrote, inverse } = change;
  if (!wrote.every(isJsonOp) || !inverse.every(isJsonOp)) return { problems: [`${change.document} is JSON: an edit op applies to text documents`] };
  const changed = (op: JsonPatchOp) => ({ problems: [`${change.document}${op.path} was changed after the edit`] });
  const paired = inverse.length === wrote.length && inverse.every((op, k) => op.path === wrote[k]!.path);
  let document = cloneJson(current);
  const undo = (inv: JsonPatchOp) => {
    document = applyJsonOps(change.document, document, [inv], true).document;
  };
  if (paired) {
    for (let k = wrote.length - 1; k >= 0; k--) {
      const w = wrote[k]!;
      if (!holds(document, w)) return changed(w);
      try {
        undo(inverse[k]!);
      } catch {
        return changed(w);
      }
    }
    return { document };
  }
  const stale = wrote.find((op) => !holds(document, op));
  if (stale) return changed(stale);
  for (const inv of inverse) {
    try {
      undo(inv);
    } catch {
      return changed(inv);
    }
  }
  return { document };
}

// ---- text documents ------------------------------------------------------------------

/** Where `needle` starts in `text`, every occurrence, overlapping ones included (an empty needle occurs nowhere: it cannot be located). */
function occurrences(text: string, needle: string): number[] {
  const at: number[] = [];
  if (needle === "") return at;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) at.push(i);
  return at;
}

/** Whether a string has no lone surrogate (String.prototype.isWellFormed, which this package's ES2022 library does not have). */
const wellFormed = (s: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

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
  // Stryker disable next-line ArithmeticOperator: equivalent; `high` only bounds the bisection below, and any bound at or above the whole text (all three are) is unique when the least context is, since a wider window around one place can only occur once if a narrower one does, so the least context found is the same
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
  const checked = (result: string) => {
    if (!wellFormed(result)) throw new Error(`${name} would hold a lone surrogate`);
    return result;
  };
  for (const op of ops) {
    if (op.op === "edit") {
      if (!wellFormed(op.old)) throw new Error(`the old text has a lone surrogate: ${preview(op.old)}`);
      if (!wellFormed(op.new)) throw new Error(`the new text has a lone surrogate: ${preview(op.new)}`);
      const at = occurrences(text, op.old);
      if (at.length !== 1) throw new Error(at.length === 0 ? `the old text is not in ${name}: ${preview(op.old)}` : `the old text occurs ${at.length} times in ${name}, not exactly once: ${preview(op.old)}`);
      if (op.new === op.old) continue;
      const start = at[0]!;
      const next = checked(text.slice(0, start) + op.new + text.slice(start + op.old.length));
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
      checked(op.value);
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

/** The first segment of a path that indexes an array of the original document (or, where the document has nothing there to tell, looks like an index: a number or `-`); -1 when none does. */
function arrayIndexAt(original: unknown, segments: readonly string[]): number {
  let node = original;
  for (const [i, key] of segments.entries()) {
    if (Array.isArray(node)) return i;
    if (isContainer(node)) node = Object.hasOwn(node, key) ? (node as Record<string, unknown>)[key] : undefined;
    else if (key === "-" || INDEX.test(key)) return i;
  }
  return -1;
}

/**
 * An edit of a text document is located by its `old` in the ORIGINAL text; one that is not
 * found exactly once there (it needs an earlier edit's output, or is ambiguous) cannot be
 * shown independent and counts as the whole document, as does any op that is not an edit.
 * A JSON op is its path, except that an array's indices move as elements are inserted and
 * removed, so a path through an index (or `-`) of an array is that array.
 */
function regionOf(surface: Surface, documents: Documents, op: Op): Region {
  const original = own(documents, op.document);
  if (isText(own(surface.documents, op.document))) {
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
  if (op.op === "edit") return { document: op.document, path: "" };
  let segments: string[];
  try {
    segments = pointerSegments(op.path);
  } catch {
    return { document: op.document, path: op.path };
  }
  const index = arrayIndexAt(original, segments);
  return { document: op.document, path: index === -1 ? op.path : pointerOf(segments.slice(0, index)) };
}

/** Where two regions overlap, as they are named in a refusal; undefined when they do not. Regions that touch (one ends where the other starts) are dependent: the context that finds one again may lie in the other. */
function clash(a: Region, b: Region): string | undefined {
  if (a.document !== b.document) return undefined;
  // Stryker disable next-line EqualityOperator: equivalent; paths that overlap are equal or one is longer (it continues past a `/`), so `<=` and `<` choose the same path when the lengths are equal
  if ("path" in a && "path" in b) return overlaps(a.path, b.path) ? `${a.document}${a.path.length <= b.path.length ? a.path : b.path}` : undefined;
  if ("path" in a || "path" in b) return a.document;
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start <= end ? `${a.document}[${start}:${end}]` : undefined;
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
 * The edits of a text document that could not be taken out on their own: those whose
 * recorded context, found again in the text all the edits made, is not where it was written
 * (another edit rewrote it, to text that holds it). Each edit's revert is tried here, against
 * the text of the others alone; only a revert that would put text in the wrong place counts
 * (one that refuses is safe, and is left to the round to call entangled).
 */
function misplaced(name: string, original: string, made: string, edits: readonly { readonly id: string; readonly change: Change }[]): string[] {
  if (edits.length < 2) return [];
  return edits.flatMap((mine) => {
    const reverted = revertText(made, mine.change);
    if ("problem" in reverted) return [];
    const others = edits.filter((e) => e !== mine).flatMap((e) => e.change.wrote);
    let expected: string | undefined;
    try {
      expected = applyTextOps(name, original, others).text;
    } catch {
      // The others alone do not apply to the original (they leaned on the text this edit wrote): nothing to compare with.
    }
    return reverted.text === expected ? [] : [`edit ${mine.id} could not be taken out of ${name} on its own: the text that locates it overlaps another edit's (make them one edit, or leave more text between them)`];
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
    const unknown = edit.ops.find((o) => !Object.hasOwn(surface.documents, o.document) || !Object.hasOwn(documents, o.document));
    if (unknown) {
      problems.push(`edit ${edit.id} names no document of the surface: ${unknown.document}`);
      continue;
    }
    const names = [...new Set(edit.ops.map((o) => o.document))];
    const after = new Map<string, unknown>();
    const results = new Map<string, TextResult | JsonResult>();
    try {
      for (const name of names) {
        const ops = edit.ops.filter((o) => o.document === name).map(({ document: _, ...op }) => op);
        if (isText(surface.documents[name])) {
          const result = applyTextOps(name, working[name], ops);
          results.set(name, result);
          after.set(name, result.text);
        } else {
          const patch = ops.flatMap((op) => (op.op === "edit" ? [] : [op]));
          if (patch.length < ops.length) throw new Error(`${name} is JSON: an edit op applies to text documents`);
          const result = applyJsonOps(name, working[name], patch);
          results.set(name, result);
          after.set(name, result.document);
        }
      }
    } catch (e) {
      problems.push(`edit ${edit.id} does not apply: ${message(e)}`);
      continue;
    }
    const changes = names.map((name) => ({ document: name, wrote: results.get(name)!.wrote, inverse: results.get(name)!.inverse })).filter((c) => c.wrote.length > 0);
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
      const result = results.get(change.document)!;
      if (isText(spec)) {
        for (const [before, now] of (result as TextResult).regions) {
          footprint += changedLines(before, now);
          const named = spec.classifyText?.(before, now) ?? [];
          for (const component of named.length ? named : [spec.component ?? "prompt"]) claim(change.document, component);
        }
        continue;
      }
      const classify = spec.classify ?? defaultClassify;
      for (const step of (result as JsonResult).steps) {
        footprint += leaves(step.value);
        claim(`${change.document}${step.path}`, classify(step.path, step.value));
      }
    }
    for (const name of names) working[name] = after.get(name);
    changedDocs.push(...names);
    applied.push({
      id: edit.id,
      hypothesis: edit.hypothesis,
      targets: edit.targets,
      predicted: edit.predicted,
      changes,
      components: [...components].sort(),
      footprint,
    });
  }
  if (problems.length === 0)
    for (const name of new Set(changedDocs)) {
      if (!isText(surface.documents[name])) continue;
      const mine = applied.flatMap((e) => e.changes.filter((c) => c.document === name).map((change) => ({ id: e.id, change })));
      problems.push(...misplaced(name, documents[name] as string, working[name] as string, mine));
    }
  problems.push(...parseAll(surface, working, changedDocs));
  return problems.length ? { kind: "refused", problems } : { kind: "applied", documents: working, edits: applied };
}

/**
 * Take an accepted edit back out of the documents: its inverse patch, applied only while
 * every part it wrote still holds what it wrote (an edit a later one rewrote is no longer
 * one mechanism that can be removed on its own). For text, the inverse edits must each be
 * found exactly once, so text that was altered, or now occurs twice, refuses. It refuses
 * for whatever it cannot take out, and never throws.
 */
export function revert(surface: Surface, documents: Documents, changes: readonly Change[]): Applied<{ readonly documents: Documents }> {
  const working: Record<string, unknown> = { ...documents };
  const problems = changes.flatMap((c) => {
    const spec = own(surface.documents, c.document);
    if (spec === undefined || !Object.hasOwn(documents, c.document)) return [`${c.document} is not a document of the surface`];
    if (isText(spec)) {
      const r = revertText(working[c.document], c);
      if ("problem" in r) return [r.problem];
      working[c.document] = r.text;
      return [];
    }
    const r = revertJson(working[c.document], c);
    if ("problems" in r) return r.problems;
    working[c.document] = r.document;
    return [];
  });
  if (problems.length) return { kind: "refused", problems };
  const invalid = parseAll(
    surface,
    working,
    changes.map((c) => c.document),
  );
  return invalid.length ? { kind: "refused", problems: invalid } : { kind: "applied", documents: working };
}
