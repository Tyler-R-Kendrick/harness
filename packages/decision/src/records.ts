/**
 * Where decisions are kept, in memory, and how they are written as JSON lines.
 *
 * `MemoryDecisionLog` is the reference `DecisionLog`: ids are assigned by `next()` in call
 * order and never reused, records are validated on the way in and copied on the way in and
 * out, and an optional cap keeps a long-running host's memory bounded without dropping
 * what has been labelled. Hosts persist it as a snapshot, or as a file of JSON lines
 * (`encodeRecords`, `decodeRecords`), which survives a crash mid-write: a torn last line is
 * reported and skipped, never fatal.
 */
import { z } from "zod";
import { DecisionError, DecisionRecordSchema, OutcomeSchema } from "./types.ts";
import type { DecisionFilter, DecisionId, DecisionLog, DecisionRecord, Json, Outcome } from "./types.ts";

/** JSON as text with object keys in sorted order, so equal values have equal text whatever order their keys were written in. */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as { readonly [key: string]: Json };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
    .join(",")}}`;
}

/**
 * Whether the action taken is the verdict the record's answers and confidence are about: the
 * authority's floor did not raise it and exploration did not replace it. A record that does
 * not say what its verdict was is taken to have acted on it unless it explored (it chose
 * at random, and nothing says that the draw landed on the verdict).
 */
export const tookVerdict = (record: DecisionRecord): boolean => (record.verdict === undefined ? !record.explored : canonicalJson(record.verdict) === canonicalJson(record.action));

/**
 * Whether the action taken is the one the policy takes without exploring (the verdict
 * raised to the floor): a decision that did not explore took it, and one that did took it
 * only when the draw landed on it. A record that explored and does not say what the
 * greedy action was is taken not to have.
 */
export const tookGreedy = (record: DecisionRecord): boolean => {
  if (!record.explored) return true;
  // Stryker disable next-line ConditionalExpression: equivalent; an action never has the text of an absent greedy action (undefined has none)
  return record.greedy !== undefined && canonicalJson(record.greedy) === canonicalJson(record.action);
};

const numberOf = (id: DecisionId): number => Number(id.slice("dec-".length));

/** A log as a host persists it: the next id to issue and the records, in id order. */
export const DecisionLogSnapshotSchema = z.strictObject({ next: z.int().nonnegative(), records: z.array(DecisionRecordSchema) });
export type DecisionLogSnapshot = z.output<typeof DecisionLogSnapshotSchema>;

export interface MemoryDecisionLogOptions {
  /**
   * Keep at most this many records. Past it the oldest records without an outcome go first
   * (labelled ones are what calibration needs), then the oldest; the newest never does.
   */
  readonly maxRecords?: number;
}

/** A copy that shares nothing with the original (records are JSON, and parsing rebuilds every container). */
const copy = (record: DecisionRecord): DecisionRecord => DecisionRecordSchema.parse(record);

export class MemoryDecisionLog implements DecisionLog {
  readonly #max: number;
  #next = 0;
  /** Ids issued by `next()` and not yet appended: the only ids `append` accepts. */
  #issued = new Set<number>();
  /** By id number, in the order records were appended (which is the order the cap drops them in). */
  #records = new Map<number, DecisionRecord>();

  constructor(options: MemoryDecisionLogOptions = {}) {
    const { maxRecords } = options;
    if (maxRecords !== undefined && !(Number.isInteger(maxRecords) && maxRecords >= 1)) {
      throw new DecisionError("invalid", `maxRecords is a whole number from 1, got ${maxRecords}`);
    }
    this.#max = maxRecords ?? Number.POSITIVE_INFINITY;
  }

  async next(): Promise<DecisionId> {
    const n = this.#next++;
    this.#issued.add(n);
    return `dec-${n}`;
  }

  async append(record: DecisionRecord): Promise<void> {
    const parsed = DecisionRecordSchema.safeParse(record);
    if (!parsed.success) throw new DecisionError("invalid", `not a decision record:\n${z.prettifyError(parsed.error)}`);
    const n = numberOf(parsed.data.id);
    if (this.#records.has(n)) throw new DecisionError("refused", `${parsed.data.id} is already in the log`);
    if (!this.#issued.has(n)) throw new DecisionError("refused", `${parsed.data.id} was not issued by next(), or has been used`);
    this.#issued.delete(n);
    this.#records.set(n, parsed.data);
    this.#trim(n);
  }

  async outcome(id: DecisionId, outcome: Outcome): Promise<boolean> {
    const parsed = OutcomeSchema.safeParse(outcome);
    if (!parsed.success) throw new DecisionError("invalid", `not an outcome:\n${z.prettifyError(parsed.error)}`);
    const n = numberOf(id);
    const record = this.#records.get(n);
    if (record === undefined) return false;
    this.#records.set(n, { ...record, outcome: parsed.data });
    return true;
  }

  async get(id: DecisionId): Promise<DecisionRecord | undefined> {
    const record = this.#records.get(numberOf(id));
    return record === undefined ? undefined : copy(record);
  }

  async query(filter: DecisionFilter = {}): Promise<DecisionRecord[]> {
    const { fork, session, mode, hasOutcome, since, until, after, limit } = filter;
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) throw new DecisionError("invalid", `limit is a whole number from 0, got ${limit}`);
    const past = after === undefined ? -1 : numberOf(after);
    const found: DecisionRecord[] = [];
    for (const n of [...this.#records.keys()].sort((a, b) => a - b)) {
      if (found.length === limit) break;
      const r = this.#records.get(n)!;
      if (
        n > past &&
        (fork === undefined || r.fork === fork) &&
        (session === undefined || r.session === session) &&
        (mode === undefined || r.mode === mode) &&
        (hasOutcome === undefined || (r.outcome !== undefined) === hasOutcome) &&
        (since === undefined || r.at >= since) &&
        (until === undefined || r.at < until)
      ) {
        found.push(copy(r));
      }
    }
    return found;
  }

  async size(): Promise<number> {
    return this.#records.size;
  }

  /** The log as a host persists it (a copy: later appends do not change it). */
  snapshot(): DecisionLogSnapshot {
    return { next: this.#next, records: [...this.#records.keys()].sort((a, b) => a - b).map((n) => copy(this.#records.get(n)!)) };
  }

  /**
   * Replace the log with a snapshot. It is refused, and the log left as it was, when it is
   * not a snapshot, lists an id twice, or holds an id at or above `next` (which would let
   * an id be issued twice). Ids issued but not appended before the restore are void.
   */
  restore(snapshot: unknown): void {
    const parsed = DecisionLogSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) throw new DecisionError("invalid", `not a decision log snapshot:\n${z.prettifyError(parsed.error)}`);
    const numbers = parsed.data.records.map((r) => numberOf(r.id));
    if (new Set(numbers).size !== numbers.length) throw new DecisionError("invalid", "a snapshot lists a decision twice");
    if (numbers.some((n) => n >= parsed.data.next)) throw new DecisionError("invalid", `a snapshot holds a decision at or above its next id, dec-${parsed.data.next}`);
    this.#next = parsed.data.next;
    this.#issued = new Set();
    this.#records = new Map(parsed.data.records.map((r, i) => [numbers[i]!, r]));
    this.#trim(numbers.at(-1));
  }

  /** Enforce the cap: oldest unlabelled first, then oldest, never `newest`. */
  #trim(newest: number | undefined): void {
    while (this.#records.size > this.#max) {
      let unlabelled: number | undefined;
      let oldest: number | undefined;
      for (const [n, r] of this.#records) {
        if (n === newest) continue;
        oldest ??= n;
        if (r.outcome === undefined) {
          unlabelled = n;
          break;
        }
      }
      this.#records.delete(unlabelled ?? oldest!);
    }
  }
}

// ---- JSON lines ------------------------------------------------------------------------------------

/** Records as JSON lines: one record per line, each line ending in a newline, so appending a record is appending its line. */
export const encodeRecords = (records: readonly DecisionRecord[]): string => records.map((r) => `${JSON.stringify(r)}\n`).join("");

export interface DecodedRecords {
  readonly records: DecisionRecord[];
  /** Lines that were not records, by their 1-based line number. */
  readonly errors: { readonly line: number; readonly message: string }[];
}

/**
 * Records from JSON lines. It never throws: a line that is not a record is reported by its
 * number and skipped, and a last line cut short by a crash (no newline, not JSON) says so.
 * Blank lines are ignored, and a line ending in a carriage return is read as the JSON it is.
 */
export function decodeRecords(text: string): DecodedRecords {
  const records: DecisionRecord[] = [];
  const errors: { line: number; message: string }[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (e) {
      const cut = i === lines.length - 1;
      errors.push({ line: i + 1, message: `${cut ? "truncated last line: " : ""}${(e as SyntaxError).message}` });
      return;
    }
    const parsed = DecisionRecordSchema.safeParse(value);
    if (parsed.success) records.push(parsed.data);
    else errors.push({ line: i + 1, message: z.prettifyError(parsed.error) });
  });
  return { records, errors };
}
