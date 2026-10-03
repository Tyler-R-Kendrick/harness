import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probability } from "@harness/cognitive";
import { DecisionError, DecisionIdSchema, forkId } from "@harness/decision";
import type { DecisionId, DecisionRecord, Outcome } from "@harness/decision";
import { FileDecisionLog } from "@harness/platform-native";
import type { DecisionFileProblem } from "@harness/platform-native";

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "harness-decisions-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const record = (id: DecisionId, overrides: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id,
  fork: forkId("test.fork"),
  forkVersion: "1",
  at: 100,
  input: { q: "x" },
  rung: "model",
  policy: "policy-1",
  answers: { q: { type: "boolean", distribution: { true: probability(0.75), false: probability(0.25) }, top: "true" } },
  action: "go",
  confidence: probability(0.75),
  propensity: probability(1),
  explored: false,
  mode: "active",
  trace: [],
  ...overrides,
});
const outcome = (overrides: Partial<Outcome> = {}): Outcome => ({ at: 200, source: "human", kind: "approved", ...overrides });

/** Appends n records through the log: dec-0 .. dec-(n-1). */
async function fill(log: FileDecisionLog, n: number, shape: (i: number) => Partial<DecisionRecord> = () => ({})): Promise<DecisionId[]> {
  const ids: DecisionId[] = [];
  for (let i = 0; i < n; i++) {
    const id = await log.next();
    ids.push(id);
    await log.append(record(id, shape(i)));
  }
  return ids;
}

const lines = (file: string): string[] => readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
const problems = (): { seen: DecisionFileProblem[]; onError: (p: DecisionFileProblem) => void } => {
  const seen: DecisionFileProblem[] = [];
  return { seen, onError: (p) => void seen.push(p) };
};

describe("FileDecisionLog: the file", () => {
  it("DHK1.1 a record is one versioned JSON line and an outcome another, in the order they happened", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    const [id] = await fill(log, 1);
    await log.outcome(id!, outcome({ correct: true }));
    const written = lines(file).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(written).toEqual([
      { v: 1, t: "record", record: record(id!) },
      { v: 1, t: "outcome", id: id, outcome: outcome({ correct: true }) },
    ]);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  it("DHK1.2 opening creates the directories, and the file when the first line is written", async () => {
    const file = join(await tempDir(), "a", "b", "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    expect(existsSync(join(file, ".."))).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(await log.size()).toBe(0);
    await fill(log, 1);
    expect(existsSync(file)).toBe(true);
  });

  it("DHK1.3 the file the log was opened on is named", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    expect((await FileDecisionLog.open(file)).file).toBe(file);
  });

  it("DHK1.4 an outcome for a decision the log does not have writes nothing", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    await fill(log, 1);
    expect(await log.outcome("dec-9", outcome())).toBe(false);
    expect(lines(file)).toHaveLength(1);
  });

  it("DHK1.5 a record or outcome that is refused writes nothing, with the error codes of the memory log", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    const id = await log.next();
    await expect(log.append({ ...record(id), at: -1 })).rejects.toMatchObject({ name: "DecisionError", code: "invalid" });
    await expect(log.append(record("dec-7"))).rejects.toMatchObject({ code: "refused" });
    await log.append(record(id));
    await expect(log.append(record(id))).rejects.toMatchObject({ code: "refused" });
    await expect(log.outcome(id, { at: 1, source: "nobody", kind: "approved" } as unknown as Outcome)).rejects.toMatchObject({ code: "invalid" });
    expect(lines(file)).toHaveLength(1);
  });

  it("DHK1.6 a query with a negative or fractional limit is refused", async () => {
    const log = await FileDecisionLog.open(join(await tempDir(), "decisions.jsonl"));
    await expect(log.query({ limit: -1 })).rejects.toMatchObject({ code: "invalid" });
    await expect(log.query({ limit: 1.5 })).rejects.toBeInstanceOf(DecisionError);
  });
});

describe("FileDecisionLog: replay", () => {
  it("DHK2.1 a later outcome replaces an earlier one when the file is read again", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    const [id] = await fill(log, 1);
    await log.outcome(id!, outcome({ kind: "approved" }));
    await log.outcome(id!, outcome({ kind: "denied", at: 300 }));
    expect((await (await FileDecisionLog.open(file)).get(id!))?.outcome).toEqual(outcome({ kind: "denied", at: 300 }));
  });

  it("DHK2.2 ids continue past the highest id in the file, however sparse the ids are", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    writeFileSync(file, `${JSON.stringify({ v: 1, t: "record", record: record("dec-7") })}\n`);
    const log = await FileDecisionLog.open(file);
    expect(await log.next()).toBe("dec-8");
    expect(await log.next()).toBe("dec-9");
  });

  it("DHK2.3 an id issued and never appended before a restart may be issued again, one that was appended never is", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    await fill(log, 2);
    await log.next();
    const again = await FileDecisionLog.open(file);
    expect(await again.next()).toBe("dec-2");
  });

  it("DHK2.4 a missing file is an empty log, and so is an empty one", async () => {
    const dir = await tempDir();
    expect(await (await FileDecisionLog.open(join(dir, "none.jsonl"))).size()).toBe(0);
    writeFileSync(join(dir, "empty.jsonl"), "");
    const { seen, onError } = problems();
    const log = await FileDecisionLog.open(join(dir, "empty.jsonl"), { onError });
    expect(await log.size()).toBe(0);
    expect(await log.next()).toBe("dec-0");
    expect(seen).toEqual([]);
  });

  it("DHK2.5 blank lines and carriage returns are read as the lines they surround", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const line = JSON.stringify({ v: 1, t: "record", record: record("dec-0") });
    writeFileSync(file, `\n${line}\r\n\n   \n`);
    const { seen, onError } = problems();
    const log = await FileDecisionLog.open(file, { onError });
    expect((await log.query()).map((r) => r.id)).toEqual(["dec-0"]);
    expect(seen).toEqual([]);
  });

  it("DHK2.6 an outcome for a decision the file no longer holds is ignored", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    writeFileSync(file, `${JSON.stringify({ v: 1, t: "outcome", id: "dec-4", outcome: outcome() })}\n${JSON.stringify({ v: 1, t: "record", record: record("dec-5") })}\n`);
    const { seen, onError } = problems();
    const log = await FileDecisionLog.open(file, { onError });
    expect((await log.query()).map((r) => r.id)).toEqual(["dec-5"]);
    expect(seen).toEqual([]);
  });

  it("DHK2.8 a second record with an id the file already holds is reported and skipped, and the first stays", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const rec = (action: string) => JSON.stringify({ v: 1, t: "record", record: record("dec-0", { action }) });
    writeFileSync(file, `${rec("first")}\n${rec("second")}\n`);
    const { seen, onError } = problems();
    const log = await FileDecisionLog.open(file, { onError });
    expect((await log.get("dec-0"))?.action).toBe("first");
    expect(await log.size()).toBe(1);
    expect(seen).toEqual([{ line: 2, message: "dec-0 is already in the file", torn: false }]);
  });

  it("DHK2.9 a file that cannot be read, because it is a directory, fails the open", async () => {
    const dir = await tempDir();
    mkdirSync(join(dir, "decisions.jsonl"));
    await expect(FileDecisionLog.open(join(dir, "decisions.jsonl"))).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("DHK2.7 records written with an outcome inside them are read as labelled", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    writeFileSync(file, `${JSON.stringify({ v: 1, t: "record", record: record("dec-0", { outcome: outcome({ correct: false }) }) })}\n`);
    expect((await (await FileDecisionLog.open(file)).get("dec-0"))?.outcome).toEqual(outcome({ correct: false }));
  });
});

describe("FileDecisionLog: crashes and bad lines", () => {
  it("DHK3.1 a last line cut short by a crash is reported as torn and dropped, and the records before it are kept", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    await fill(log, 3);
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.slice(0, text.length - 40));
    const { seen, onError } = problems();
    const again = await FileDecisionLog.open(file, { onError });
    expect((await again.query()).map((r) => r.id)).toEqual(["dec-0", "dec-1"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ line: 3, torn: true });
    expect(seen[0]!.message).toMatch(/truncated last line/);
  });

  it("DHK3.2 after a torn line the next record starts on a line of its own, and the next restart sees no problem", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    await fill(log, 2);
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.slice(0, text.length - 10));
    const again = await FileDecisionLog.open(file, { onError: () => {} });
    const id = await again.next();
    expect(id).toBe("dec-1");
    await again.append(record(id, { action: "after the crash" }));
    const { seen, onError } = problems();
    const third = await FileDecisionLog.open(file, { onError });
    expect(seen).toEqual([]);
    expect((await third.get("dec-1"))?.action).toBe("after the crash");
    expect(await third.size()).toBe(2);
  });

  it("DHK3.3 a torn line is dropped from the file by cutting it, so lines before it are byte for byte as written", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    await fill(log, 2);
    const whole = readFileSync(file, "utf8");
    appendFileSync(file, '{"v":1,"t":"rec');
    await FileDecisionLog.open(file, { onError: () => {} });
    expect(readFileSync(file, "utf8")).toBe(whole);
  });

  it("DHK3.4 a last line that is whole but missing its newline is kept, and the next line starts after a newline", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const first = JSON.stringify({ v: 1, t: "record", record: record("dec-0") });
    writeFileSync(file, first);
    const { seen, onError } = problems();
    const log = await FileDecisionLog.open(file, { onError });
    expect(seen).toEqual([]);
    expect(await log.size()).toBe(1);
    await log.append(record(await log.next()));
    expect(lines(file)).toHaveLength(2);
    expect(await (await FileDecisionLog.open(file)).size()).toBe(2);
  });

  it("DHK3.5 a tail of only whitespace is cut without a report", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const first = `${JSON.stringify({ v: 1, t: "record", record: record("dec-0") })}\n`;
    writeFileSync(file, `${first}   `);
    const { seen, onError } = problems();
    const log = await FileDecisionLog.open(file, { onError });
    expect(seen).toEqual([]);
    await log.append(record(await log.next()));
    expect(readFileSync(file, "utf8").startsWith(first)).toBe(true);
    expect(lines(file)).toHaveLength(2);
  });

  it("DHK3.6 a garbage line in the middle is reported by its number and skipped, and the lines around it load", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const rec = (n: number) => JSON.stringify({ v: 1, t: "record", record: record(DecisionIdSchema.parse(`dec-${n}`)) });
    writeFileSync(file, `${rec(0)}\nthis is not json\n${rec(1)}\n`);
    const { seen, onError } = problems();
    const log = await FileDecisionLog.open(file, { onError });
    expect((await log.query()).map((r) => r.id)).toEqual(["dec-0", "dec-1"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ line: 2, torn: false });
    expect(seen[0]!.message).not.toMatch(/truncated/);
  });

  it("DHK3.7 a line that is JSON but not a line of ours is reported with what is wrong with it: an unknown version, a bad record, a stray value", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const good = JSON.stringify({ v: 1, t: "record", record: record("dec-0") });
    writeFileSync(
      file,
      [
        good,
        JSON.stringify({ v: 2, t: "record", record: record("dec-1") }),
        JSON.stringify({ v: 1, t: "record", record: { ...record("dec-2"), at: -1 } }),
        "42",
        "[]",
        JSON.stringify({ v: 1, t: "unheard-of" }),
        JSON.stringify({ v: 1, t: "meta", next: -1 }),
        JSON.stringify({ v: 1, t: "outcome", id: "nope", outcome: outcome() }),
        JSON.stringify({ v: 1, t: "outcome", id: "dec-0", outcome: { at: 1 } }),
        JSON.stringify({ v: 1, t: "record", record: "x" }),
        "",
      ].join("\n"),
    );
    const { seen, onError } = problems();
    const log = await FileDecisionLog.open(file, { onError });
    expect((await log.query()).map((r) => r.id)).toEqual(["dec-0"]);
    expect(seen.map((p) => p.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(seen[8]!.message).toBe("record line: (value): Invalid input: expected object, received string");
    expect(seen.every((p) => !p.torn && p.message.length > 0)).toBe(true);
    expect(seen[0]!.message).toMatch(/v/);
  });

  it("DHK3.8 after a torn line the next id is the one after the highest id that survived", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    await fill(log, 3);
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.slice(0, text.length - 5));
    const again = await FileDecisionLog.open(file, { onError: () => {} });
    expect(await again.next()).toBe("dec-2");
  });

  it("DHK3.9 a bad line does not fail the open when no callback is given", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    writeFileSync(file, "garbage\n");
    expect(await (await FileDecisionLog.open(file)).size()).toBe(0);
  });
});

describe("FileDecisionLog: the cap", () => {
  it("DHK4.1 past maxRecords the oldest records without an outcome go first, as in the memory log, and what is left is the same after a restart", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const log = await FileDecisionLog.open(file, { maxRecords: 3 });
    const ids = await fill(log, 3);
    await log.outcome(ids[0]!, outcome());
    await fill(log, 2);
    expect((await log.query()).map((r) => r.id)).toEqual(["dec-0", "dec-3", "dec-4"]);
    const again = await FileDecisionLog.open(file, { maxRecords: 3 });
    expect((await again.query()).map((r) => r.id)).toEqual(["dec-0", "dec-3", "dec-4"]);
  });

  it("DHK4.2 when everything is labelled the oldest goes, and the newest never does", async () => {
    const log = await FileDecisionLog.open(join(await tempDir(), "decisions.jsonl"), { maxRecords: 2 });
    const ids = await fill(log, 2);
    for (const id of ids) await log.outcome(id, outcome());
    await fill(log, 1);
    expect((await log.query()).map((r) => r.id)).toEqual(["dec-1", "dec-2"]);
    const solo = await FileDecisionLog.open(join(await tempDir(), "solo.jsonl"), { maxRecords: 1 });
    await fill(solo, 3);
    expect((await solo.query()).map((r) => r.id)).toEqual(["dec-2"]);
  });

  it("DHK4.3 a maxRecords that is not a whole number from 1 is refused", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    for (const maxRecords of [0, -1, 1.5, Number.NaN]) {
      await expect(FileDecisionLog.open(file, { maxRecords }), String(maxRecords)).rejects.toMatchObject({ code: "invalid" });
    }
  });

  it("DHK4.4 a compactRatio below 1 or not a number is refused", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    for (const compactRatio of [0.5, 0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(FileDecisionLog.open(file, { compactRatio }), String(compactRatio)).rejects.toMatchObject({ code: "invalid" });
    }
  });
});

describe("FileDecisionLog: compaction", () => {
  it("DHK5.1 a file with more than the ratio of lines to live records is rewritten on open, one line per live record, and reads the same", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    const [id] = await fill(log, 2);
    for (let i = 0; i < 10; i++) await log.outcome(id!, outcome({ at: 200 + i }));
    const before = await log.query();
    expect(lines(file)).toHaveLength(12);
    const again = await FileDecisionLog.open(file, { compactRatio: 2 });
    expect(await again.query()).toEqual(before);
    const written = lines(file).map((l) => JSON.parse(l) as { t: string });
    expect(written.map((l) => l.t)).toEqual(["meta", "record", "record"]);
    expect((await (await FileDecisionLog.open(file)).get(id!))?.outcome).toEqual(outcome({ at: 209 }));
  });

  it("DHK5.2 a file within the ratio is left exactly as it is", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    const ids = await fill(log, 4);
    await log.outcome(ids[0]!, outcome());
    const before = readFileSync(file, "utf8");
    await FileDecisionLog.open(file, { compactRatio: 2 });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("DHK5.3 the ratio is a multiple of the live records: lines equal to it do not compact, one more does", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    const [id] = await fill(log, 2);
    await log.outcome(id!, outcome());
    await log.outcome(id!, outcome({ at: 300 }));
    const before = readFileSync(file, "utf8");
    await FileDecisionLog.open(file, { compactRatio: 2 });
    expect(readFileSync(file, "utf8")).toBe(before);
    await log.outcome(id!, outcome({ at: 400 }));
    await FileDecisionLog.open(file, { compactRatio: 2 });
    expect(lines(file)).toHaveLength(3);
  });

  it("DHK5.4 a file holding more records than maxRecords is rewritten with the live ones, in the memory log's order of dropping", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    const ids = await fill(log, 5);
    await log.outcome(ids[1]!, outcome());
    expect(lines(file)).toHaveLength(6);
    const capped = await FileDecisionLog.open(file, { maxRecords: 3 });
    expect((await capped.query()).map((r) => r.id)).toEqual(["dec-1", "dec-3", "dec-4"]);
    expect(lines(file)).toHaveLength(4);
    expect((await (await FileDecisionLog.open(file)).query()).map((r) => r.id)).toEqual(["dec-1", "dec-3", "dec-4"]);
  });

  it("DHK5.5 a file with exactly maxRecords records is not rewritten", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    await fill(log, 3);
    const before = readFileSync(file, "utf8");
    await FileDecisionLog.open(file, { maxRecords: 3 });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("DHK5.6 compaction keeps the next id past a dropped record with the highest id", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const log = await FileDecisionLog.open(file, { maxRecords: 1 });
    const a = await log.next();
    const b = await log.next();
    const c = await log.next();
    await log.append(record(c));
    await log.append(record(a));
    expect((await log.query()).map((r) => r.id)).toEqual([a]);
    expect(b).toBe("dec-1");
    const again = await FileDecisionLog.open(file, { maxRecords: 1 });
    expect((await again.query()).map((r) => r.id)).toEqual([a]);
    expect(lines(file).map((l) => (JSON.parse(l) as { t: string }).t)).toEqual(["meta", "record"]);
    expect(await again.next()).toBe("dec-3");
    expect(await (await FileDecisionLog.open(file, { maxRecords: 1 })).next()).toBe("dec-3");
  });

  it("DHK5.7 compaction leaves no temporary file beside the log", async () => {
    const dir = await tempDir();
    const file = join(dir, "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    const [id] = await fill(log, 1);
    for (let i = 0; i < 5; i++) await log.outcome(id!, outcome({ at: i }));
    await FileDecisionLog.open(file, { compactRatio: 1 });
    expect(readdirSync(dir)).toEqual(["decisions.jsonl"]);
  });

  it("DHK5.8 compaction drops the bad lines it reported", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const rec = (n: number) => JSON.stringify({ v: 1, t: "record", record: record(DecisionIdSchema.parse(`dec-${n}`)) });
    writeFileSync(file, `${rec(0)}\ngarbage\n${rec(1)}\n`);
    const { seen, onError } = problems();
    await FileDecisionLog.open(file, { compactRatio: 1, onError });
    expect(seen).toHaveLength(1);
    expect(lines(file).map((l) => (JSON.parse(l) as { t: string }).t)).toEqual(["meta", "record", "record"]);
    const quiet = problems();
    await FileDecisionLog.open(file, { onError: quiet.onError });
    expect(quiet.seen).toEqual([]);
  });

  it("DHK5.9 compaction does not create a file that was not there, and rewrites a file of only bad lines to its meta line", async () => {
    const dir = await tempDir();
    const none = join(dir, "none.jsonl");
    await FileDecisionLog.open(none, { compactRatio: 1 });
    expect(existsSync(none)).toBe(false);
    const garbage = join(dir, "garbage.jsonl");
    writeFileSync(garbage, "x\ny\n");
    await FileDecisionLog.open(garbage, { compactRatio: 1, onError: () => {} });
    expect(lines(garbage).map((l) => (JSON.parse(l) as { t: string }).t)).toEqual(["meta"]);
  });

  it("DHK5.10 a meta line raises the next id and is not counted as a record", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    writeFileSync(file, `${JSON.stringify({ v: 1, t: "meta", next: 12 })}\n${JSON.stringify({ v: 1, t: "record", record: record("dec-3") })}\n`);
    const log = await FileDecisionLog.open(file);
    expect(await log.size()).toBe(1);
    expect(await log.next()).toBe("dec-12");
  });
});

describe("FileDecisionLog: calls in flight", () => {
  it("DHK6.1 calls made together without awaiting are applied, and written, in the order they were made", async () => {
    const file = join(await tempDir(), "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    const ids = await Promise.all(Array.from({ length: 20 }, () => log.next()));
    await Promise.all(ids.map((id, i) => log.append(record(id, { action: i }))));
    const written = lines(file).map((l) => (JSON.parse(l) as { record: DecisionRecord }).record);
    expect(written.map((r) => r.id)).toEqual(ids);
    expect(written.map((r) => r.action)).toEqual(ids.map((_, i) => i));
  });

  it("DHK6.2 a read, an outcome or a size asked for before the append before it has finished waits for it", async () => {
    const log = await FileDecisionLog.open(join(await tempDir(), "decisions.jsonl"));
    const id = await log.next();
    const appended = log.append(record(id));
    const labelled = log.outcome(id, outcome());
    const read = log.get(id);
    const listed = log.query();
    const counted = log.size();
    await appended;
    expect(await labelled).toBe(true);
    expect((await read)?.outcome).toEqual(outcome());
    expect(await listed).toHaveLength(1);
    expect(await counted).toBe(1);
  });

  it("DHK6.3 a write that fails rejects, changes nothing in the log, and does not stop the calls after it", async () => {
    const dir = await tempDir();
    const file = join(dir, "sub", "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    const [first] = await fill(log, 1);
    rmSync(join(dir, "sub"), { recursive: true });
    const id = await log.next();
    const failed = log.append(record(id));
    const second = log.size();
    await expect(failed).rejects.toBeDefined();
    expect(await second).toBe(1);
    expect(await log.get(id)).toBeUndefined();
    mkdirSync(join(dir, "sub"));
    expect(await log.outcome(first!, outcome())).toBe(true);
    expect((await log.get(first!))?.outcome).toEqual(outcome());
  });

  it("DHK6.4 a failed outcome write leaves the outcome out of the log", async () => {
    const dir = await tempDir();
    const file = join(dir, "sub", "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    const [id] = await fill(log, 1);
    rmSync(join(dir, "sub"), { recursive: true });
    await expect(log.outcome(id!, outcome())).rejects.toBeDefined();
    expect((await log.get(id!))?.outcome).toBeUndefined();
  });

  it("DHK6.5 after a write failed, the next write first makes sure it starts on a line of its own", async () => {
    const dir = await tempDir();
    const file = join(dir, "sub", "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    await fill(log, 1);
    rmSync(join(dir, "sub"), { recursive: true });
    const lost = await log.next();
    await expect(log.append(record(lost))).rejects.toBeDefined();
    // As if the failed write had left half a line behind.
    mkdirSync(join(dir, "sub"));
    writeFileSync(file, '{"v":1,"t":"rec');
    await log.append(record(await log.next(), { action: "next" }));
    const { seen, onError } = problems();
    const again = await FileDecisionLog.open(file, { onError });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ line: 1, torn: false });
    expect((await again.query()).map((r) => r.action)).toEqual(["next"]);
  });

  it("DHK6.6 after a failed write, a file that does not exist is written as it is, and one that ends in a newline gets no extra one", async () => {
    const dir = await tempDir();
    const file = join(dir, "sub", "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    await fill(log, 1);
    rmSync(join(dir, "sub"), { recursive: true });
    await expect(log.append(record(await log.next()))).rejects.toBeDefined();
    mkdirSync(join(dir, "sub"));
    await log.append(record(await log.next(), { action: "fresh" }));
    expect(lines(file)).toHaveLength(1);
    rmSync(join(dir, "sub"), { recursive: true });
    await expect(log.append(record(await log.next()))).rejects.toBeDefined();
    mkdirSync(join(dir, "sub"));
    writeFileSync(file, `${JSON.stringify({ v: 1, t: "meta", next: 0 })}\n`);
    await log.append(record(await log.next(), { action: "tidy" }));
    expect(lines(file)).toHaveLength(2);
    expect(readFileSync(file, "utf8")).not.toContain("\n\n");
  });

  it("DHK6.8 when the file cannot even be looked at after a failed write, the write fails and the log is unchanged", async () => {
    const dir = await tempDir();
    const file = join(dir, "sub", "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    await fill(log, 1);
    rmSync(join(dir, "sub"), { recursive: true });
    await expect(log.append(record(await log.next()))).rejects.toBeDefined();
    // A file where the directory was: the path is not a directory, which is not "missing".
    writeFileSync(join(dir, "sub"), "");
    await expect(log.append(record(await log.next()))).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(await log.size()).toBe(1);
  });

  it("DHK6.9 after a failed write, an empty file is written to without a newline first", async () => {
    const dir = await tempDir();
    const file = join(dir, "sub", "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    await fill(log, 1);
    rmSync(join(dir, "sub"), { recursive: true });
    await expect(log.append(record(await log.next()))).rejects.toBeDefined();
    mkdirSync(join(dir, "sub"));
    writeFileSync(file, "");
    await log.append(record(await log.next(), { action: "into the empty file" }));
    expect(readFileSync(file, "utf8").startsWith("{")).toBe(true);
  });

  it("DHK6.7 settled resolves once every write asked for has landed, even after one failed", async () => {
    const dir = await tempDir();
    const file = join(dir, "decisions.jsonl");
    const log = await FileDecisionLog.open(file);
    const ids = await Promise.all([log.next(), log.next(), log.next()]);
    void log.append(record(ids[0]!));
    void log.append(record(ids[1]!));
    void log.append(record(ids[1]!)).catch(() => {});
    await log.settled();
    expect(lines(file)).toHaveLength(2);
    const failing = log.append(record(ids[2]!, { at: -1 })).catch(() => {});
    await log.settled();
    await failing;
  });
});

describe("FileDecisionLog: who can read it", () => {
  const modeOf = (path: string): number => statSync(path).mode & 0o777;
  /** Runs `body` with the umask most systems start with, so the modes asked for are what decides. */
  async function underUmask022(body: () => Promise<void>): Promise<void> {
    const before = process.umask(0o022);
    try {
      await body();
    } finally {
      process.umask(before);
    }
  }

  it("DHK11.1 the log and the directory made for it are the owner's alone, whatever the umask", async () => {
    await underUmask022(async () => {
      const dir = join(await tempDir(), "nested", "decisions");
      const file = join(dir, "decisions.jsonl");
      const log = await FileDecisionLog.open(file);
      await log.append(record(await log.next(), { input: { task: "deploy with password hunter2" } }));
      expect(modeOf(file)).toBe(0o600);
      expect(modeOf(dir)).toBe(0o700);
      expect(modeOf(join(dir, ".."))).toBe(0o700);
    });
  });

  it("DHK11.2 a log written before it was private is made private when it is opened", async () => {
    await underUmask022(async () => {
      const file = join(await tempDir(), "decisions.jsonl");
      const log = await FileDecisionLog.open(file);
      await log.append(record(await log.next()));
      chmodSync(file, 0o644);
      await FileDecisionLog.open(file);
      expect(modeOf(file)).toBe(0o600);
    });
  });

  it("DHK11.3 a compacted log is the owner's alone", async () => {
    await underUmask022(async () => {
      const file = join(await tempDir(), "decisions.jsonl");
      const log = await FileDecisionLog.open(file);
      const [id] = await fill(log, 2);
      for (let i = 0; i < 10; i++) await log.outcome(id!, outcome({ at: 200 + i }));
      chmodSync(file, 0o644);
      await FileDecisionLog.open(file, { compactRatio: 2 });
      expect(lines(file)).toHaveLength(3);
      expect(modeOf(file)).toBe(0o600);
    });
  });
});
