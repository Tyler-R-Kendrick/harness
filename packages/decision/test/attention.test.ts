import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { attentionFork, attentionSettingsJsonSchema, parseAttentionSettings, rankInbox } from "../src/attention.ts";
import type { AttentionItem, AttentionSettings } from "../src/attention.ts";
import { answer, lazy, levels, yes } from "./loops-fixtures.ts";

const file = JSON.parse(readFileSync(new URL("../data/attention.json", import.meta.url), "utf8")) as Record<string, unknown>;
const shipped = lazy(() => parseAttentionSettings(file));
const HOUR = 3_600_000;

/** Round numbers: kinds weigh 1 to 5, age 10 over an hour, blocked 20, urgency 40. */
const round: AttentionSettings = lazy(() => parseAttentionSettings({
  ...file,
  weights: { kind: { permission: 5, failure: 4, question: 3, review: 2, idle: 1 }, age: 10, blocked: 20, urgency: 40 },
  age: { saturatesAfterMs: HOUR },
}));

const item = (patch: Partial<AttentionItem> = {}): AttentionItem => ({ id: "i1", session: "s1", kind: "review", since: 0, blocked: false, ...patch });
const rank = (items: AttentionItem[], now = 0) => rankInbox(items, round, now);

describe("attention settings (data/attention.json)", () => {
  it("ATT1.1 the shipped settings parse, and name their JSON Schema, which is generated from the parser", async () => {
    expect(shipped.weights.kind.permission).toBeGreaterThan(shipped.weights.kind.idle);
    expect(file["$schema"]).toBe("./attention.schema.json");
    await expect(`${JSON.stringify(attentionSettingsJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/attention.schema.json");
  });

  it("ATT1.2 settings that cannot be right are refused, naming where", () => {
    const edit = (path: readonly string[], value: unknown) => {
      const s = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
      let o: Record<string, unknown> = s;
      for (const key of path.slice(0, -1)) o = o[key] as Record<string, unknown>;
      if (value === undefined) delete o[path.at(-1)!];
      else o[path.at(-1)!] = value;
      return () => parseAttentionSettings(s);
    };
    expect(edit(["weights", "kind", "idle"], -1)).toThrow(/invalid attention settings[\s\S]*weights\.kind\.idle/);
    expect(edit(["weights", "kind", "review"], undefined)).toThrow(/weights\.kind\.review/);
    expect(edit(["weights", "age"], Number.NaN)).toThrow(/weights\.age/);
    expect(edit(["age", "saturatesAfterMs"], 0)).toThrow(/age\.saturatesAfterMs/);
    expect(edit(["question", "levels"], ["a", "b", "c"])).toThrow(/question\.levels/);
    expect(edit(["floors"], [{ when: { eq: ["kind", "idle"] }, atLeast: "critical" }])).toThrow(/floors\[0\]\.atLeast/);
    expect(edit(["chars"], 0)).toThrow(/chars/);
    expect(edit(["extra"], 1)).toThrow(/extra/);
  });
});

describe("rankInbox", () => {
  it("ATT2.1 a fresh item unblocked and with no urgency is worth its kind's weight", () => {
    const [r] = rank([item({ kind: "permission" })]);
    expect(r?.priority).toBe(5);
    expect(rank([item({ kind: "idle" })])[0]?.priority).toBe(1);
  });

  it("ATT2.2 waiting adds up to the age weight, in proportion to the wait, and saturates", () => {
    expect(rank([item()], HOUR / 2)[0]?.priority).toBe(2 + 5);
    expect(rank([item()], HOUR)[0]?.priority).toBe(2 + 10);
    expect(rank([item()], 100 * HOUR)[0]?.priority).toBe(2 + 10);
  });

  it("ATT2.3 a session that is blocked on it adds the blocked weight", () => {
    expect(rank([item({ blocked: true })])[0]?.priority).toBe(2 + 20);
  });

  it("ATT2.4 the urgency a model gave, from 0 to 1, adds that share of the urgency weight", () => {
    expect(rank([item({ urgency: 0.25 })])[0]?.priority).toBe(2 + 10);
    expect(rank([item({ urgency: 1 })])[0]?.priority).toBe(2 + 40);
    expect(rank([item({ urgency: 0 })])[0]?.priority).toBe(2);
    expect(rank([item({ urgency: 0 })])[0]?.reasons).toEqual(["review: 2"]); // an urgency of nothing is not a reason
  });

  it("ATT2.5 the parts add", () => {
    expect(rank([item({ kind: "failure", blocked: true, urgency: 0.5, since: 0 })], HOUR / 4)[0]?.priority).toBeCloseTo(4 + 2.5 + 20 + 20, 9);
  });

  it("ATT2.6 the highest priority is first", () => {
    const items = [item({ id: "a", kind: "idle" }), item({ id: "b", kind: "permission" }), item({ id: "c", kind: "question" })];
    expect(rank(items).map((r) => r.item.id)).toEqual(["b", "c", "a"]);
  });

  it("ATT2.7 equal priorities go to the one waiting longer, then to the lower id", () => {
    // a and b wait the same at the moment ranked and have the same weight; c is older; a's id sorts first
    const items = [item({ id: "b", since: HOUR }), item({ id: "a", since: HOUR }), item({ id: "c", since: 0, kind: "review" })];
    expect(rank(items, HOUR * 100).map((r) => r.item.id)).toEqual(["c", "a", "b"]);
    expect(rank([item({ id: "z", since: 5 }), item({ id: "y", since: 5, session: "s0" })], HOUR * 100).map((r) => r.item.id)).toEqual(["y", "z"]);
  });

  it("ATT2.8 whatever else is equal is settled by session, kind and text, so the order never depends on the input's", () => {
    const base = { id: "x", since: 0, blocked: false } as const;
    const tied = [
      { ...base, session: "s2", kind: "review" as const },
      { ...base, session: "s1", kind: "review" as const, text: "b" },
      { ...base, session: "s1", kind: "review" as const, text: "a" },
      { ...base, session: "s1", kind: "review" as const },
      { ...base, session: "s1", kind: "review" as const, text: "A" },
    ];
    const zero: AttentionSettings = parseAttentionSettings({ ...file, weights: { kind: { permission: 1, failure: 1, question: 1, review: 1, idle: 1 }, age: 0, blocked: 0, urgency: 0 } });
    const order = (items: AttentionItem[]) => rankInbox(items, zero, 0).map((r) => `${r.item.session}/${r.item.text ?? ""}`);
    expect(order(tied)).toEqual(["s1/", "s1/A", "s1/a", "s1/b", "s2/"]);
    expect(order([...tied].reverse())).toEqual(order(tied));
  });

  it("ATT2.9 each item comes with the reasons for its priority", () => {
    const [r] = rank([item({ kind: "failure", blocked: true, urgency: 0.5 })], HOUR / 2);
    expect(r?.reasons).toEqual(["failure: 4", "waiting 30 min: 5", "blocked: 20", "urgency 0.5: 20"]);
    expect(rank([item()])[0]?.reasons).toEqual(["review: 2"]);
  });

  it("ATT2.10 the item is returned as it was given, and the input is left alone", () => {
    const items = [item({ id: "a", kind: "idle" }), item({ id: "b", kind: "permission" })];
    const before = JSON.stringify(items);
    const ranked = rank(items);
    expect(ranked[0]?.item).toBe(items[1]);
    expect(JSON.stringify(items)).toBe(before);
  });

  it("ATT2.11 an empty inbox ranks to nothing", () => {
    expect(rank([])).toEqual([]);
  });

  it("ATT2.12 an item that says it is from the future has waited no time", () => {
    expect(rank([item({ since: 5000 })], 0)[0]?.priority).toBe(2);
  });

  it("ATT2.13 an item that cannot be right is refused, naming where", () => {
    expect(() => rank([item({ urgency: 1.5 })])).toThrow(/urgency/);
    expect(() => rank([item({ urgency: -0.1 })])).toThrow(/urgency/);
    expect(() => rank([item({ since: -1 })])).toThrow(/since/);
    expect(() => rank([item({ id: "" })])).toThrow(/id/);
    expect(() => rank([{ ...item(), kind: "spam" } as unknown as AttentionItem])).toThrow(/kind/);
    expect(() => rank([item()], Number.NaN)).toThrow("now must be a finite time in ms");
  });
});

// ---- the fork ---------------------------------------------------------------------------------------------

const fork = lazy(() => attentionFork(shipped));
const scored = (weights: readonly number[]) => ({ urgency: levels(weights) });

describe("attentionFork", () => {
  it("ATT3.1 asks one score question about how urgently a person should look, with four levels", () => {
    const asked = fork.ask(item({ kind: "permission", blocked: true, text: "run rm -rf build?" }));
    expect(Object.keys(asked.questions)).toEqual(["urgency"]);
    expect(asked.questions["urgency"]).toEqual({ type: "score", instructions: shipped.question.instructions, criteria: shipped.question.levels });
    expect(asked.state).toEqual({ kind: "permission", blocked: true, text: "run rm -rf build?" });
    expect(fork.ask(item()).state).toEqual({ kind: "review", blocked: false });
  });

  it("ATT3.2 is identified by its id and the version in its settings", () => {
    expect(fork.id).toBe("attention");
    expect(fork.version).toBe(shipped.version);
  });

  it("ATT3.3 the expected level is rounded to one of the four labels, at the mass on that level as confidence", () => {
    expect(fork.interpret(scored([1, 0, 0, 0]), item())).toEqual({ action: "low", confidence: 1 });
    expect(fork.interpret(scored([0, 1, 0, 0]), item())?.action).toBe("normal");
    expect(fork.interpret(scored([0, 0, 1, 0]), item())?.action).toBe("high");
    expect(fork.interpret(scored([0, 0, 0, 1]), item())?.action).toBe("urgent");
    const spread = fork.interpret(scored([0.1, 0.2, 0.5, 0.2]), item());
    expect(spread?.action).toBe("high");
    expect(spread?.confidence).toBeCloseTo(0.5, 12);
  });

  it("ATT3.4 a mean between levels rounds to the nearer, and a half goes up", () => {
    expect(fork.interpret(scored([0.5, 0, 0, 0.5]), item())?.action).toBe("high"); // mean 1.5 rounds to 2
    expect(fork.interpret(scored([0.6, 0.4, 0, 0]), item())?.action).toBe("low"); // mean 0.4
    expect(fork.interpret(scored([0.4, 0.6, 0, 0]), item())?.action).toBe("normal"); // mean 0.6
  });

  it("ATT3.5 an answer that is not a score over four levels gives no verdict", () => {
    expect(fork.interpret({}, item())).toBeUndefined();
    expect(fork.interpret({ urgency: levels([1, 1, 1]) }, item())).toBeUndefined();
    expect(fork.interpret({ urgency: levels([1, 1, 1, 1, 1]) }, item())).toBeUndefined();
    expect(fork.interpret({ urgency: yes(0.5) }, item())).toBeUndefined();
    const named = (names: string[]) => ({ urgency: answer("score", Object.fromEntries(names.map((n) => [n, 1]))) });
    expect(fork.interpret(named(["1", "2", "3", "4"]), item())).toBeUndefined();
    expect(fork.interpret(named(["0", "x", "y", "z"]), item())).toBeUndefined();
    expect(fork.interpret(named(["0", "1", "2", "3"]), item())).toBeDefined();
  });

  it("ATT3.6 the safe label when nothing decides is normal", () => {
    expect(fork.fallback(item())).toBe("normal");
  });

  it("ATT3.7 restrictiveness rises from low to normal to high to urgent", () => {
    const rank = fork.restrictiveness!;
    expect([rank("low"), rank("normal"), rank("high"), rank("urgent")]).toEqual([0, 1, 2, 3]);
  });

  it("ATT3.8 a permission is at least high and a failure at least normal, and nothing else has a floor", () => {
    expect(fork.floor?.(item({ kind: "permission" }))).toBe("high");
    expect(fork.floor?.(item({ kind: "failure" }))).toBe("normal");
    for (const kind of ["review", "question", "idle"] as const) expect(fork.floor?.(item({ kind }))).toBeUndefined();
  });

  it("ATT3.9 when several floors match the highest is the floor", () => {
    const both = attentionFork(
      parseAttentionSettings({ ...file, floors: [{ when: { eq: ["kind", "permission"] }, atLeast: "urgent" }, { when: { exists: "id" }, atLeast: "high" }, { when: { eq: ["kind", "permission"] }, atLeast: "normal" }] }),
    );
    expect(both.floor?.(item({ kind: "permission" }))).toBe("urgent");
    expect(both.floor?.(item({ kind: "idle" }))).toBe("high");
  });

  it("ATT3.10 all four labels are on offer", () => {
    expect(fork.actions?.(item())).toEqual(["low", "normal", "high", "urgent"]);
  });

  it("ATT3.11 records keep the item, its text cut to length", () => {
    const long = "y".repeat(1000);
    expect(fork.describe(item({ text: long, urgency: 0.5, blocked: true }))).toEqual({ id: "i1", session: "s1", kind: "review", since: 0, blocked: true, urgency: 0.5, text: "y".repeat(shipped.chars) });
    expect(fork.describe(item())).toStrictEqual({ id: "i1", session: "s1", kind: "review", since: 0, blocked: false });
  });
});
