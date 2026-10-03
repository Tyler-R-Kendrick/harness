import { appendFile, chmod, mkdir, open, readFile, truncate } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { AuthoritySchema, DecisionError, DecisionIdSchema, DecisionRecordSchema, OutcomeSchema, parseCalibration, parsePolicy } from "@harness/decision";
import type { Authority, CalibrationBook, DecisionFilter, DecisionId, DecisionLog, DecisionRecord, Outcome, Policy } from "@harness/decision";

/** Records carry the people's prompts, commands and paths: the owner reads them, nobody else. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const require = createRequire(import.meta.url);

// ---- the line format -------------------------------------------------------------------------------
//
// One JSON object per line, each ending in a newline, each carrying the format version `v` (1):
//
//   {"v":1,"t":"record","record":<a decision record>}      a decision, as appended
//   {"v":1,"t":"outcome","id":"dec-3","outcome":<outcome>}  what became of it (a later one replaces an earlier one)
//   {"v":1,"t":"meta","next":12}                            the first id never issued, written when the file is compacted
//
// Appending is appending a line, so a crash can only cut the last line short.

const VERSION = 1;
/** Compact when the file holds more than this many lines per live record. */
const DEFAULT_COMPACT_RATIO = 4;
const NEWLINE = 0x0a;

type Line = { readonly t: "meta"; readonly next: number } | { readonly t: "record"; readonly record: DecisionRecord } | { readonly t: "outcome"; readonly id: DecisionId; readonly outcome: Outcome };

type Decoded = { readonly ok: true; readonly line: Line } | { readonly ok: false; readonly message: string };

const numberOf = (id: DecisionId): number => Number(id.slice("dec-".length));
const failed = (message: string): Decoded => ({ ok: false, message });

/** Where a schema says a value is wrong, one problem per issue: `path: message`. */
function issuesOf(error: { readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[] }): string {
  return error.issues.map((issue) => `${issue.path.length === 0 ? "(value)" : issue.path.map(String).join(".")}: ${issue.message}`).join("; ");
}

function decodeLine(text: string): Decoded {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return failed((e as SyntaxError).message);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return failed("not a JSON object");
  const object = value as Record<string, unknown>;
  if (object["v"] !== VERSION) return failed(`unsupported line version v=${JSON.stringify(object["v"])} (this reads v=${VERSION})`);
  switch (object["t"]) {
    case "meta": {
      const next = object["next"];
      return typeof next === "number" && Number.isInteger(next) && next >= 0 ? { ok: true, line: { t: "meta", next } } : failed("meta line: next is not a whole number from 0");
    }
    case "record": {
      const parsed = DecisionRecordSchema.safeParse(object["record"]);
      return parsed.success ? { ok: true, line: { t: "record", record: parsed.data } } : failed(`record line: ${issuesOf(parsed.error)}`);
    }
    case "outcome": {
      const id = DecisionIdSchema.safeParse(object["id"]);
      const outcome = OutcomeSchema.safeParse(object["outcome"]);
      if (!id.success) return failed(`outcome line: id: ${issuesOf(id.error)}`);
      return outcome.success ? { ok: true, line: { t: "outcome", id: id.data, outcome: outcome.data } } : failed(`outcome line: ${issuesOf(outcome.error)}`);
    }
    default:
      return failed(`unknown line type t=${JSON.stringify(object["t"])}`);
  }
}

const encode = (line: object): string => `${JSON.stringify({ v: VERSION, ...line })}\n`;

// ---- the log ----------------------------------------------------------------------------------------

/** A line of the file that could not be read. */
export interface DecisionFileProblem {
  /** The line's number in the file, from 1. */
  readonly line: number;
  readonly message: string;
  /** The last line, cut short by a crash (it has been cut off the file). */
  readonly torn: boolean;
}

export interface FileDecisionLogOptions {
  /**
   * Keep at most this many records, by the rule of `MemoryDecisionLog`: past it the oldest
   * records without an outcome go first (labelled ones are what calibration needs), then the
   * oldest; the newest never does. The file keeps dropped records until it is compacted.
   */
  readonly maxRecords?: number;
  /** Rewrite the file on open when it holds more than this many lines per live record (default 4). */
  readonly compactRatio?: number;
  /** Told of every line that could not be read: a torn last line, or a bad line elsewhere (skipped). */
  readonly onError?: (problem: DecisionFileProblem) => void;
}

/** Whether the file is empty, missing, or ends in a newline: whether a line appended to it starts on a line of its own. */
async function endsWithNewline(file: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] === NEWLINE;
  } finally {
    await handle.close();
  }
}

/** Enforce a cap in the `MemoryDecisionLog`'s order: oldest unlabelled first, then oldest, never `newest`. */
function trim(records: Map<number, DecisionRecord>, max: number, newest: number | undefined): void {
  while (records.size > max) {
    let unlabelled: number | undefined;
    let oldest: number | undefined;
    for (const [n, r] of records) {
      if (n === newest) continue;
      oldest ??= n;
      if (r.outcome === undefined) {
        unlabelled = n;
        break;
      }
    }
    records.delete(unlabelled ?? oldest!);
  }
}

/** The file as it is rewritten by compaction: the first id never issued, then each live record (with its outcome) in the order it was appended. */
const compacted = (next: number, records: ReadonlyMap<number, DecisionRecord>): string => encode({ t: "meta", next }) + [...records.values()].map((record) => encode({ t: "record", record })).join("");

/**
 * Decisions kept durably in one append-only file of JSON lines (see the format above).
 * Every record and outcome is a line appended through a single queue, so concurrent calls
 * are written, and applied, in the order they were made. Opening replays the file: a later
 * outcome replaces an earlier one, a bad line is reported and skipped, and a last line cut
 * short by a crash is reported and cut off, so the next line starts cleanly. Ids from
 * `next()` are never reused: the next one is past every id the file has held, kept in a
 * `meta` line when compaction drops the record that had it. The file is compacted
 * (rewritten atomically) on open when it holds more than `compactRatio` lines per live
 * record, or more records than `maxRecords`.
 */
export class FileDecisionLog implements DecisionLog {
  readonly file: string;
  readonly #max: number;
  #next: number;
  /** Ids issued by `next()` and not yet appended: the only ids `append` accepts. */
  readonly #issued = new Set<number>();
  /** By id number, in the order records were appended (which is the order the cap drops them in). */
  readonly #records: Map<number, DecisionRecord>;
  #queue: Promise<unknown> = Promise.resolve();
  /** A write failed, so the file may end in half a line: the next write checks first. */
  #repair = false;

  private constructor(file: string, max: number, next: number, records: Map<number, DecisionRecord>) {
    this.file = file;
    this.#max = max;
    this.#next = next;
    this.#records = records;
  }

  /** Opens the log on `file` (made, with its directories, when the first line is written), replaying what it holds. */
  static async open(file: string, options: FileDecisionLogOptions = {}): Promise<FileDecisionLog> {
    const { maxRecords, onError } = options;
    const ratio = options.compactRatio ?? DEFAULT_COMPACT_RATIO;
    if (maxRecords !== undefined && !(Number.isInteger(maxRecords) && maxRecords >= 1)) throw new DecisionError("invalid", `maxRecords is a whole number from 1, got ${maxRecords}`);
    if (!(Number.isFinite(ratio) && ratio >= 1)) throw new DecisionError("invalid", `compactRatio is a number from 1, got ${ratio}`);
    const max = maxRecords ?? Number.POSITIVE_INFINITY;
    await mkdir(dirname(file), { recursive: true, mode: DIR_MODE });

    let existed = true;
    const bytes = await readFile(file).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      existed = false;
      return Buffer.alloc(0);
    });
    // A log from before it was private is closed to others now.
    if (existed) await chmod(file, FILE_MODE);
    // Everything up to the last newline is whole lines; what follows is a line a crash may have cut short.
    const tailStart = bytes.lastIndexOf(NEWLINE) + 1;
    const whole = bytes.subarray(0, tailStart).toString("utf8").split("\n");
    whole.pop();
    const tail = bytes.subarray(tailStart).toString("utf8");
    const texts = tail.trim() === "" ? whole : [...whole, tail];

    const records = new Map<number, DecisionRecord>();
    let next = 0;
    let newest: number | undefined;
    let lines = 0;
    let recordLines = 0;
    let tailLine: "whole" | "torn" | undefined;
    texts.forEach((text, i) => {
      if (text.trim() === "") return;
      lines++;
      const isTail = i === whole.length;
      const decoded = decodeLine(text);
      if (isTail) tailLine = decoded.ok ? "whole" : "torn";
      if (!decoded.ok) {
        onError?.({ line: i + 1, message: isTail ? `truncated last line: ${decoded.message}` : decoded.message, torn: isTail });
        return;
      }
      const line = decoded.line;
      if (line.t === "meta") next = Math.max(next, line.next);
      else if (line.t === "outcome") {
        const record = records.get(numberOf(line.id));
        if (record !== undefined) records.set(numberOf(line.id), { ...record, outcome: line.outcome });
      } else {
        const n = numberOf(line.record.id);
        next = Math.max(next, n + 1);
        if (records.has(n)) {
          onError?.({ line: i + 1, message: `${line.record.id} is already in the file`, torn: false });
          return;
        }
        recordLines++;
        newest = n;
        records.set(n, line.record);
      }
    });
    trim(records, max, newest);

    if (lines > ratio * Math.max(records.size, 1) || recordLines > max) {
      // Rewritten from what is live; this also drops a torn tail and the lines that could not be read.
      await writeFileAtomic(file, compacted(next, records), { mode: FILE_MODE });
    } else if (tail !== "") {
      // A torn (or blank) tail is cut off; a whole last line that only lacks its newline gets one.
      if (tailLine === "whole") await appendFile(file, "\n");
      else await truncate(file, tailStart);
    }
    return new FileDecisionLog(file, max, next, records);
  }

  #enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(job);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Appends text to the file; after a failed write, first makes sure it starts a line of its own. */
  async #write(text: string): Promise<void> {
    try {
      const prefix = this.#repair && !(await endsWithNewline(this.file)) ? "\n" : "";
      await appendFile(this.file, prefix + text, { mode: FILE_MODE });
    } catch (e) {
      this.#repair = true;
      throw e;
    }
    this.#repair = false;
  }

  async next(): Promise<DecisionId> {
    const n = this.#next++;
    this.#issued.add(n);
    return `dec-${n}`;
  }

  async append(record: DecisionRecord): Promise<void> {
    const parsed = DecisionRecordSchema.safeParse(record);
    if (!parsed.success) throw new DecisionError("invalid", `not a decision record:\n${issuesOf(parsed.error)}`);
    const n = numberOf(parsed.data.id);
    return this.#enqueue(async () => {
      if (this.#records.has(n)) throw new DecisionError("refused", `${parsed.data.id} is already in the log`);
      if (!this.#issued.has(n)) throw new DecisionError("refused", `${parsed.data.id} was not issued by next(), or has been used`);
      await this.#write(encode({ t: "record", record: parsed.data }));
      this.#issued.delete(n);
      this.#records.set(n, parsed.data);
      trim(this.#records, this.#max, n);
    });
  }

  async outcome(id: DecisionId, outcome: Outcome): Promise<boolean> {
    const parsed = OutcomeSchema.safeParse(outcome);
    if (!parsed.success) throw new DecisionError("invalid", `not an outcome:\n${issuesOf(parsed.error)}`);
    const n = numberOf(id);
    return this.#enqueue(async () => {
      const record = this.#records.get(n);
      if (record === undefined) return false;
      await this.#write(encode({ t: "outcome", id, outcome: parsed.data }));
      this.#records.set(n, { ...record, outcome: parsed.data });
      return true;
    });
  }

  get(id: DecisionId): Promise<DecisionRecord | undefined> {
    return this.#enqueue(async () => {
      const record = this.#records.get(numberOf(id));
      return record === undefined ? undefined : DecisionRecordSchema.parse(record);
    });
  }

  query(filter: DecisionFilter = {}): Promise<DecisionRecord[]> {
    const { fork, session, mode, hasOutcome, since, until, after, limit } = filter;
    return this.#enqueue(async () => {
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
          found.push(DecisionRecordSchema.parse(r));
        }
      }
      return found;
    });
  }

  size(): Promise<number> {
    return this.#enqueue(async () => this.#records.size);
  }

  /** Resolves once every call made so far has been applied and written (or has failed). A host awaits it before it exits. */
  async settled(): Promise<void> {
    await this.#queue;
  }
}

// ---- the decision files of one directory ---------------------------------------------------------------

/** The decisions of a directory: records in `decisions.jsonl`, and `policy.json`, `authority.json` and `calibration.json` beside them. */
export interface DecisionFiles {
  readonly log: FileDecisionLog;
  readonly policy: Policy;
  readonly authority: Authority;
  /** The calibration book: what the directory held (or the shipped empty book), then what `saveCalibration` last saved. */
  readonly calibration: CalibrationBook;
  /** Validates the book and replaces `calibration.json` atomically (a crash leaves the old book or the new one). */
  saveCalibration(book: CalibrationBook): Promise<void>;
}

const shipped = (file: string): string => require.resolve(`@harness/decision/data/${file}`);

/** The file's JSON, undefined when it does not exist; an error that names the file when it cannot be read or is not JSON. */
async function readJsonFile(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new DecisionError("unavailable", `cannot read ${file}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new DecisionError("invalid", `${file} is not valid JSON: ${(e as SyntaxError).message}`);
  }
}

/** `<dir>/<name>` when it exists, else the file shipped in `@harness/decision`, parsed; a parse error names the file that was read. */
async function loadData<T>(dir: string, name: string, fallback: string, parse: (json: unknown) => T): Promise<T> {
  const own = join(dir, name);
  const json = await readJsonFile(own);
  const [file, found] = json === undefined ? [fallback, await readJsonFile(fallback)] : [own, json];
  try {
    return parse(found);
  } catch (e) {
    throw new DecisionError("invalid", `${file}: ${(e as Error).message}`);
  }
}

function parseAuthority(json: unknown): Authority {
  const parsed = AuthoritySchema.safeParse(json);
  if (!parsed.success) throw new Error(`not an authority: ${issuesOf(parsed.error)}`);
  return parsed.data;
}

/**
 * Opens the decision files of a directory: the records (a `FileDecisionLog` on
 * `decisions.jsonl`), the policy and the authority (`policy.json`, `authority.json`; the
 * files shipped in `@harness/decision` when the directory has none), and the calibration
 * book (`calibration.json`; the shipped empty book when there is none). Each is parsed, and
 * an error names the file that is wrong. `saveCalibration` writes the book back.
 */
export async function decisionFiles(dir: string, options: FileDecisionLogOptions = {}): Promise<DecisionFiles> {
  const calibrationFile = join(dir, "calibration.json");
  const [policy, authority, book] = await Promise.all([
    loadData(dir, "policy.json", shipped("policy.json"), parsePolicy),
    loadData(dir, "authority.json", shipped("permission.json"), parseAuthority),
    loadData(dir, "calibration.json", shipped("calibration.json"), parseCalibration),
  ]);
  const log = await FileDecisionLog.open(join(dir, "decisions.jsonl"), options);
  let current = book;
  let saving: Promise<unknown> = Promise.resolve();
  return {
    log,
    policy,
    authority,
    get calibration() {
      return current;
    },
    saveCalibration(next) {
      const parsed = parseCalibration(next);
      const save = saving.then(async () => {
        await writeFileAtomic(calibrationFile, `${JSON.stringify(parsed, null, 2)}\n`, { mode: FILE_MODE });
        current = parsed;
      });
      saving = save.catch(() => undefined);
      return save;
    },
  };
}
