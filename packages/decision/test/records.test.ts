import { describe, expect, it } from "vitest";
import { canonicalJson, decodeRecords, encodeRecords, MemoryDecisionLog } from "../src/records.ts";
import { DecisionError, forkId } from "../src/types.ts";
import type { DecisionId, DecisionRecord, Outcome } from "../src/types.ts";
import { answerOf } from "../src/member.ts";

const fork = forkId("permission.risk");
const other = forkId("attention");

/** A valid record for an id the log has issued. */
function record(id: DecisionId, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id,
    fork,
    forkVersion: "1",
    at: 100,
    input: { tool: "bash", nested: { list: [1, 2, { deep: true }] } },
    rung: "model",
    member: "m",
    memberVersion: "v1",
    policy: "policy-1",
    answers: { risk: answerOf("choice", { low: 1, high: 3 }) },
    action: "escalate",
    confidence: answerOf("choice", { low: 1, high: 3 }).distribution["high"]!,
    propensity: answerOf("choice", { a: 1, b: 0 }).distribution["a"]!,
    explored: false,
    mode: "active",
    trace: [{ rung: "model", member: "m", outcome: "accepted" }],
    ...overrides,
  };
}

const outcome = (overrides: Partial<Outcome> = {}): Outcome => ({ at: 200, source: "human", kind: "approved", ...overrides });

/** A log with n records appended (ids dec-0 ... dec-(n-1)). */
async function logWith(n: number, make: (id: DecisionId, i: number) => Partial<DecisionRecord> = () => ({}), options: ConstructorParameters<typeof MemoryDecisionLog>[0] = {}) {
  const log = new MemoryDecisionLog(options);
  for (let i = 0; i < n; i++) {
    const id = await log.next();
    await log.append(record(id, make(id, i)));
  }
  return log;
}

describe("MemoryDecisionLog ids", () => {
  it("DLG1.1 next assigns dec-0, dec-1, ... in call order", async () => {
    const log = new MemoryDecisionLog();
    expect(await log.next()).toBe("dec-0");
    expect(await log.next()).toBe("dec-1");
    expect(await log.next()).toBe("dec-2");
  });

  it("DLG1.2 an id that was issued and never used is not issued again", async () => {
    const log = new MemoryDecisionLog();
    await log.next();
    const second = await log.next();
    await log.append(record(second));
    expect(await log.next()).toBe("dec-2");
  });

  it("DLG1.3 ids issued together are all distinct", async () => {
    const log = new MemoryDecisionLog();
    const ids = await Promise.all([log.next(), log.next(), log.next()]);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("MemoryDecisionLog append and get", () => {
  it("DLG2.1 an appended record comes back equal", async () => {
    const log = new MemoryDecisionLog();
    const id = await log.next();
    await log.append(record(id));
    expect(await log.get(id)).toEqual(record(id));
    expect(await log.size()).toBe(1);
  });

  it("DLG2.2 an id no next() call issued is refused", async () => {
    const log = new MemoryDecisionLog();
    await expect(log.append(record("dec-7"))).rejects.toThrow(/dec-7 was not issued by next/);
    await expect(log.append(record("dec-7"))).rejects.toMatchObject({ code: "refused" });
    await log.next();
    await expect(log.append(record("dec-1"))).rejects.toMatchObject({ name: "DecisionError", code: "refused" });
    expect(await log.size()).toBe(0);
  });

  it("DLG2.3 a second record with the same id is refused and the first stays", async () => {
    const log = new MemoryDecisionLog();
    const id = await log.next();
    await log.append(record(id, { action: "first" }));
    await expect(log.append(record(id, { action: "second" }))).rejects.toThrow(/dec-0 is already in the log/);
    await expect(log.append(record(id, { action: "second" }))).rejects.toMatchObject({ code: "refused" });
    expect((await log.get(id))?.action).toBe("first");
  });

  it("DLG2.4 a record that does not parse is refused, naming the field", async () => {
    const log = new MemoryDecisionLog();
    const id = await log.next();
    const bad = { ...record(id), at: -1 };
    const refused = log.append(bad);
    await expect(refused).rejects.toBeInstanceOf(DecisionError);
    await expect(refused).rejects.toThrow(/not a decision record[\s\S]*at/);
    await expect(refused).rejects.toMatchObject({ code: "invalid" });
    // the id is still usable
    await log.append(record(id));
    expect(await log.size()).toBe(1);
  });

  it("DLG2.5 a record the caller changes after appending is not changed in the log", async () => {
    const log = new MemoryDecisionLog();
    const id = await log.next();
    const mine = record(id);
    await log.append(mine);
    (mine.input as { nested: { list: unknown[] } }).nested.list.push(99);
    mine.trace.push({ rung: "human", outcome: "x" });
    expect(await log.get(id)).toEqual(record(id));
  });

  it("DLG2.6 a record read from the log can be changed without changing the log", async () => {
    const log = new MemoryDecisionLog();
    const id = await log.next();
    await log.append(record(id));
    const read = (await log.get(id))!;
    (read.input as { nested: { list: unknown[] } }).nested.list.length = 0;
    read.trace.length = 0;
    read.answers["risk"]!.distribution["low"] = read.answers["risk"]!.distribution["high"]!;
    expect(await log.get(id)).toEqual(record(id));
    const [listed] = await log.query();
    listed!.trace.length = 0;
    expect(await log.get(id)).toEqual(record(id));
  });

  it("DLG2.7 an unknown id is undefined", async () => {
    expect(await new MemoryDecisionLog().get("dec-0")).toBeUndefined();
  });
});

describe("MemoryDecisionLog outcomes", () => {
  it("DLG3.1 an outcome attaches to its decision and says true", async () => {
    const log = await logWith(2);
    expect(await log.outcome("dec-1", outcome({ correct: true }))).toBe(true);
    expect((await log.get("dec-1"))?.outcome).toEqual(outcome({ correct: true }));
    expect((await log.get("dec-0"))?.outcome).toBeUndefined();
  });

  it("DLG3.2 a second outcome replaces the first", async () => {
    const log = await logWith(1);
    await log.outcome("dec-0", outcome({ kind: "approved" }));
    await log.outcome("dec-0", outcome({ kind: "denied", at: 300 }));
    expect((await log.get("dec-0"))?.outcome).toEqual(outcome({ kind: "denied", at: 300 }));
  });

  it("DLG3.3 an outcome for an unknown decision is false and changes nothing", async () => {
    const log = await logWith(1);
    expect(await log.outcome("dec-9", outcome())).toBe(false);
    expect(await log.size()).toBe(1);
  });

  it("DLG3.4 an outcome that does not parse is refused", async () => {
    const log = await logWith(1);
    await expect(log.outcome("dec-0", { at: 1, source: "nobody", kind: "approved" } as unknown as Outcome)).rejects.toThrow(/not an outcome[\s\S]*source/);
    await expect(log.outcome("dec-0", { at: 1, source: "nobody", kind: "approved" } as unknown as Outcome)).rejects.toMatchObject({ code: "invalid" });
    expect((await log.get("dec-0"))?.outcome).toBeUndefined();
  });

  it("DLG3.5 an outcome does not change where the record sits in id order", async () => {
    const log = await logWith(3);
    await log.outcome("dec-0", outcome());
    expect((await log.query()).map((r) => r.id)).toEqual(["dec-0", "dec-1", "dec-2"]);
  });
});

describe("MemoryDecisionLog query", () => {
  const mixed = () =>
    logWith(6, (_id, i) => ({
      fork: i % 2 === 0 ? fork : other,
      session: i < 3 ? "s1" : "s2",
      mode: i === 1 || i === 4 ? "shadow" : "active",
      at: 100 + i * 10,
    }));

  it("DLG4.1 with no filter every record comes back in id order, whatever order they were appended in", async () => {
    const log = new MemoryDecisionLog();
    const a = await log.next();
    const b = await log.next();
    const c = await log.next();
    for (const id of [c, a, b]) await log.append(record(id));
    expect((await log.query()).map((r) => r.id)).toEqual(["dec-0", "dec-1", "dec-2"]);
  });

  it("DLG4.2 fork, session and mode each select their records", async () => {
    const log = await mixed();
    expect((await log.query({ fork: other })).map((r) => r.id)).toEqual(["dec-1", "dec-3", "dec-5"]);
    expect((await log.query({ session: "s2" })).map((r) => r.id)).toEqual(["dec-3", "dec-4", "dec-5"]);
    expect((await log.query({ mode: "shadow" })).map((r) => r.id)).toEqual(["dec-1", "dec-4"]);
  });

  it("DLG4.3 hasOutcome selects labelled or unlabelled records", async () => {
    const log = await mixed();
    await log.outcome("dec-2", outcome());
    expect((await log.query({ hasOutcome: true })).map((r) => r.id)).toEqual(["dec-2"]);
    expect((await log.query({ hasOutcome: false })).map((r) => r.id)).toEqual(["dec-0", "dec-1", "dec-3", "dec-4", "dec-5"]);
  });

  it("DLG4.4 since includes its instant and until excludes it", async () => {
    const log = await mixed();
    expect((await log.query({ since: 120 })).map((r) => r.id)).toEqual(["dec-2", "dec-3", "dec-4", "dec-5"]);
    expect((await log.query({ until: 120 })).map((r) => r.id)).toEqual(["dec-0", "dec-1"]);
    expect((await log.query({ since: 110, until: 130 })).map((r) => r.id)).toEqual(["dec-1", "dec-2"]);
  });

  it("DLG4.5 after excludes its own id and earlier ones", async () => {
    const log = await mixed();
    expect((await log.query({ after: "dec-3" })).map((r) => r.id)).toEqual(["dec-4", "dec-5"]);
    expect((await log.query({ after: "dec-5" }))).toEqual([]);
  });

  it("DLG4.6 limit keeps the first records, and zero keeps none", async () => {
    const log = await mixed();
    expect((await log.query({ limit: 2 })).map((r) => r.id)).toEqual(["dec-0", "dec-1"]);
    expect(await log.query({ limit: 0 })).toEqual([]);
    expect(await log.query({ limit: 100 })).toHaveLength(6);
  });

  it("DLG4.7 filters compose, and limit counts records that matched", async () => {
    const log = await mixed();
    expect((await log.query({ fork, session: "s1", mode: "active" })).map((r) => r.id)).toEqual(["dec-0", "dec-2"]);
    expect((await log.query({ fork, after: "dec-0", limit: 1 })).map((r) => r.id)).toEqual(["dec-2"]);
    expect(await log.query({ fork: other, session: "s1", mode: "active" })).toEqual([]);
  });

  it("DLG4.8 a limit that is not a whole number from zero is refused", async () => {
    const log = await mixed();
    await expect(log.query({ limit: -1 })).rejects.toThrow(/limit/);
    await expect(log.query({ limit: -1 })).rejects.toMatchObject({ code: "invalid" });
    await expect(log.query({ limit: 1.5 })).rejects.toThrow(/limit/);
  });

  it("DLG4.9 an empty log has no records", async () => {
    const log = new MemoryDecisionLog();
    expect(await log.query()).toEqual([]);
    expect(await log.size()).toBe(0);
  });
});

describe("MemoryDecisionLog cap", () => {
  it("DLG5.1 past the cap the oldest records without an outcome go first", async () => {
    const log = await logWith(3, () => ({}), { maxRecords: 3 });
    await log.outcome("dec-0", outcome());
    const id = await log.next();
    await log.append(record(id));
    expect((await log.query()).map((r) => r.id)).toEqual(["dec-0", "dec-2", "dec-3"]);
  });

  it("DLG5.2 when every older record has an outcome the oldest goes", async () => {
    const log = await logWith(2, () => ({}), { maxRecords: 2 });
    await log.outcome("dec-0", outcome());
    await log.outcome("dec-1", outcome());
    const id = await log.next();
    await log.append(record(id));
    expect((await log.query()).map((r) => r.id)).toEqual(["dec-1", "dec-2"]);
  });

  it("DLG5.3 a cap of one keeps the newest record even when it is the only one without an outcome", async () => {
    const log = await logWith(1, () => ({}), { maxRecords: 1 });
    await log.outcome("dec-0", outcome());
    const id = await log.next();
    await log.append(record(id));
    expect((await log.query()).map((r) => r.id)).toEqual(["dec-1"]);
  });

  it("DLG5.4 the newest appended record stays even when it has the lowest id", async () => {
    const log = new MemoryDecisionLog({ maxRecords: 2 });
    const a = await log.next();
    const b = await log.next();
    const c = await log.next();
    await log.append(record(b));
    await log.append(record(c));
    await log.append(record(a));
    expect((await log.query()).map((r) => r.id)).toEqual(["dec-0", "dec-2"]);
  });

  it("DLG5.5 the id of a dropped record is not issued again and cannot be appended again", async () => {
    const log = await logWith(2, () => ({}), { maxRecords: 1 });
    expect(await log.get("dec-0")).toBeUndefined();
    await expect(log.append(record("dec-0"))).rejects.toThrow(/not issued by next/);
    expect(await log.next()).toBe("dec-2");
  });

  it("DLG5.6 a cap that is not a whole number from one is refused", () => {
    expect(() => new MemoryDecisionLog({ maxRecords: 0 })).toThrow(/maxRecords/);
    expect(() => new MemoryDecisionLog({ maxRecords: 0 })).toThrowError(expect.objectContaining({ code: "invalid" }));
    expect(() => new MemoryDecisionLog({ maxRecords: 1.5 })).toThrow(DecisionError);
  });

  it("DLG5.7 without a cap nothing is dropped", async () => {
    expect(await (await logWith(50)).size()).toBe(50);
  });
});

describe("MemoryDecisionLog snapshot and restore", () => {
  it("DLG6.1 a snapshot restores into another log with the same records, outcomes and next id", async () => {
    const log = await logWith(3);
    await log.outcome("dec-1", outcome({ correct: false }));
    await log.next();
    const copyOf = new MemoryDecisionLog();
    copyOf.restore(log.snapshot());
    expect(await copyOf.query()).toEqual(await log.query());
    expect(await copyOf.next()).toBe("dec-4");
  });

  it("DLG6.2 a snapshot is a copy: later appends do not change it", async () => {
    const log = await logWith(1);
    const snap = log.snapshot();
    const id = await log.next();
    await log.append(record(id));
    expect(snap.records).toHaveLength(1);
    snap.records[0]!.trace.length = 0;
    expect((await log.get("dec-0"))?.trace).toHaveLength(1);
  });

  it("DLG6.3 a snapshot lists records in id order", async () => {
    const log = new MemoryDecisionLog();
    const a = await log.next();
    const b = await log.next();
    await log.append(record(b));
    await log.append(record(a));
    expect(log.snapshot().records.map((r) => r.id)).toEqual(["dec-0", "dec-1"]);
    expect(log.snapshot().next).toBe(2);
  });

  it("DLG6.4 restoring replaces what the log held", async () => {
    const log = await logWith(2);
    const other = await logWith(1);
    log.restore(other.snapshot());
    expect((await log.query()).map((r) => r.id)).toEqual(["dec-0"]);
  });

  it("DLG6.5 ids issued before a restore can no longer be appended", async () => {
    const log = new MemoryDecisionLog();
    const id = await log.next();
    log.restore({ next: 5, records: [] });
    await expect(log.append(record(id))).rejects.toThrow(/not issued/);
    expect(await log.next()).toBe("dec-5");
  });

  it("DLG6.6 something that is not a snapshot is refused and the log stays as it was", async () => {
    const log = await logWith(1);
    expect(() => log.restore({ next: -1, records: [] })).toThrow(/not a decision log snapshot/);
    expect(() => log.restore("nope")).toThrow(DecisionError);
    expect(() => log.restore("nope")).toThrowError(expect.objectContaining({ code: "invalid" }));
    expect(await log.size()).toBe(1);
  });

  it("DLG6.7 a snapshot that lists a decision twice is refused", () => {
    const log = new MemoryDecisionLog();
    expect(() => log.restore({ next: 3, records: [record("dec-0"), record("dec-0")] })).toThrow(/twice/);
    expect(() => log.restore({ next: 3, records: [record("dec-0"), record("dec-0")] })).toThrowError(expect.objectContaining({ code: "invalid" }));
  });

  it("DLG6.8 a snapshot with an id at or above its next id is refused", () => {
    const log = new MemoryDecisionLog();
    expect(() => log.restore({ next: 1, records: [record("dec-1")] })).toThrow(/at or above its next id, dec-1/);
    expect(() => log.restore({ next: 1, records: [record("dec-1")] })).toThrowError(expect.objectContaining({ code: "invalid" }));
    expect(() => log.restore({ next: 1, records: [record("dec-0")] })).not.toThrow();
  });

  it("DLG6.9 restoring more records than the cap keeps the newest", async () => {
    const big = await logWith(4);
    const log = new MemoryDecisionLog({ maxRecords: 2 });
    log.restore(big.snapshot());
    expect((await log.query()).map((r) => r.id)).toEqual(["dec-2", "dec-3"]);
  });

  it("DLG6.10 an empty snapshot restores an empty log", async () => {
    const log = await logWith(2);
    log.restore({ next: 0, records: [] });
    expect(await log.size()).toBe(0);
    expect(await log.next()).toBe("dec-0");
  });
});

/** The message JSON.parse gives for text it cannot read. */
function jsonError(text: string): string {
  try {
    JSON.parse(text);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("that text is JSON");
}

describe("JSON lines", () => {
  const two = [record("dec-0"), record("dec-1", { action: { calls: [{ name: "x" }] } })];

  it("DLG7.1 each record is one line ending in a newline", () => {
    const text = encodeRecords(two);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n")).toHaveLength(3);
    expect(JSON.parse(text.split("\n")[0]!)).toEqual(two[0]);
    expect(encodeRecords([])).toBe("");
  });

  it("DLG7.2 decoding what was encoded gives the records back with no errors", () => {
    expect(decodeRecords(encodeRecords(two))).toEqual({ records: two, errors: [] });
    expect(decodeRecords("")).toEqual({ records: [], errors: [] });
  });

  it("DLG7.3 a last line cut short is reported as truncated and the records before it are kept", () => {
    const text = encodeRecords(two);
    const cut = text.slice(0, text.length - 20);
    const decoded = decodeRecords(cut);
    expect(decoded.records).toEqual([two[0]]);
    expect(decoded.errors).toHaveLength(1);
    expect(decoded.errors[0]!.line).toBe(2);
    expect(decoded.errors[0]!.message).toBe(`truncated last line: ${jsonError(cut.split("\n")[1]!)}`);
  });

  it("DLG7.4 a complete last line without its newline is still a record", () => {
    const text = encodeRecords(two).trimEnd();
    expect(decodeRecords(text)).toEqual({ records: two, errors: [] });
  });

  it("DLG7.5 a bad line in the middle is reported by its number and the others are kept", () => {
    const [a, b] = encodeRecords(two).split("\n");
    const decoded = decodeRecords(`${a}\nnot json\n${b}\n`);
    expect(decoded.records).toEqual(two);
    expect(decoded.errors).toHaveLength(1);
    expect(decoded.errors[0]!.line).toBe(2);
    expect(decoded.errors[0]!.message).toBe(jsonError("not json"));
  });

  it("DLG7.6 a line that is JSON but not a record says which field is wrong", () => {
    const decoded = decodeRecords('{"id":"dec-0"}\n');
    expect(decoded.records).toEqual([]);
    expect(decoded.errors[0]).toMatchObject({ line: 1 });
    expect(decoded.errors[0]!.message).toMatch(/fork/);
  });

  it("DLG7.7 blank lines are ignored and carriage returns are tolerated", () => {
    const [a, b] = encodeRecords(two).split("\n");
    expect(decodeRecords(`\n${a}\r\n\n  \n${b}\r\n`)).toEqual({ records: two, errors: [] });
  });

  it("DLG7.8 a truncated last line that ends in a newline is a plain error, not a truncation", () => {
    const decoded = decodeRecords('{"id":\n');
    expect(decoded.errors).toHaveLength(1);
    expect(decoded.errors[0]!.message).toBe(jsonError('{"id":'));
  });

  it("DLG7.9 a line that is not JSON at all reports the parser's message", () => {
    const decoded = decodeRecords("{\n");
    expect(decoded.errors[0]!.message).toBe(jsonError("{"));
  });
});

describe("canonicalJson", () => {
  it("DLG8.1 objects with the same members in another order have the same text", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("DLG8.2 arrays keep their order and values keep their types", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(canonicalJson(1)).not.toBe(canonicalJson("1"));
    expect(canonicalJson([1, [2, 3]])).toBe("[1,[2,3]]");
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson("a\"b")).toBe('"a\\"b"');
  });

  it("DLG8.3 keys that need escaping are escaped", () => {
    expect(canonicalJson({ 'k"ey': true })).toBe('{"k\\"ey":true}');
  });
});
