/**
 * Doubles for the criteria evolution's tests: a small fork whose one boolean question
 * is answered by a member that reads the question's wording, so that a change of wording
 * changes the answers (which is what the evolver is there to find), and records to
 * replay.
 */
import { readFileSync } from "node:fs";
import { probability } from "@harness/cognitive";
import { holdoutSplit, stableJson } from "../src/distill.ts";
import { parseEvolveSettings } from "../src/evolve.ts";
import type { EvolveSettings } from "../src/evolve.ts";
import { forkId } from "../src/types.ts";
import type { Answers, Asked, DecisionRecord, Fork, Json, Member } from "../src/types.ts";
import { chose, levels, memberOf, outcome, record, yes } from "./loops-fixtures.ts";

export interface In {
  readonly kind: string;
  readonly note?: string;
}
export type Act = "allow" | "deny";

/** The kinds a call can be of; those in `RISKY` should be denied. */
export const RISKY = ["disk", "net", "proc"] as const;
export const SAFE = ["read", "list", "stat"] as const;
export const expectedFor = (kind: string): Act => ((RISKY as readonly string[]).includes(kind) ? "deny" : "allow");

/** The gate's wording at the start: it names only `disk` as risky. */
export const INSTRUCTIONS = "Is the call risky? Watch for: disk.";

/**
 * A fork over {kind, note?}: one boolean question `risky` (true denies), a floor that never
 * lets a `root` kind be allowed, a rule for `halt`, and a verify question that is not part
 * of the criteria.
 */
export function gate(extra: Partial<Fork<In, Act>> = {}): Fork<In, Act> {
  return {
    id: forkId("evo.gate"),
    version: "f1",
    ask: (input) => ({
      state: { kind: input.kind, ...(input.note === undefined ? {} : { note: input.note }) },
      questions: { risky: { type: "boolean", instructions: INSTRUCTIONS, criteria: { true: "the call touches something it should not", false: "the call is harmless" } } },
    }),
    interpret: (answers) => {
      const a = answers["risky"];
      if (a === undefined) throw new Error("no answer to risky");
      const p = a.distribution["true"]!;
      if (p === 0.5) return undefined;
      return { action: p > 0.5 ? "deny" : "allow", confidence: probability(Math.max(p, 1 - p)) };
    },
    describe: (input) => ({ kind: input.kind, ...(input.note === undefined ? {} : { note: input.note }) }),
    fallback: () => "deny",
    rule: (input) => (input.kind === "halt" ? "deny" : undefined),
    floor: (input) => (input.kind === "root" ? "deny" : undefined),
    restrictiveness: (action) => (action === "deny" ? 1 : 0),
    ...extra,
  };
}

const wordsIn = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== "");

/**
 * A member that reads the wording: it says the call is risky (0.9) when the kind it is shown
 * appears as a word in the question's instructions or criteria, and not risky (0.1) otherwise.
 */
export function reader(id = "reader", version = "v1"): Member & { readonly calls: Asked[] } {
  return memberOf(
    id,
    (asked): Answers => {
      const kind = (asked.state as { kind: string }).kind;
      const q = asked.questions["risky"]!;
      const text = [q.instructions, ...(q.type === "boolean" ? [q.criteria?.true ?? "", q.criteria?.false ?? ""] : [])].join(" ");
      return { risky: yes(wordsIn(text).includes(kind) ? 0.9 : 0.1) };
    },
    version,
  );
}

export const shipped: unknown = JSON.parse(readFileSync(new URL("../data/evolve.json", import.meta.url), "utf8"));

export const settings = (patch: Partial<EvolveSettings> = {}): EvolveSettings => parseEvolveSettings({ ...(shipped as Record<string, unknown>), minHoldout: 6, ...patch });

export const SALT = "evo-salt";

/** Which side of the holdout a gate input is on: the evolver splits by the input, so every decision of one input is on one side. */
export const sideOf = (input: Json, share = settings().holdout, salt = SALT): "train" | "holdout" => holdoutSplit(stableJson(input), share, salt);

/**
 * Records of the gate with a chosen make-up: for each place in the quota an input is made
 * (the kind, and the note when `note` gives one; a try that lands on the wrong side of the
 * holdout is made again with " v1", " v2", ... on its note) until the input (as `shape`
 * gives it, when it does) is on the side wanted. Ids are taken in order, held-out records first. Every record carries the label
 * its kind should get.
 */
export function records(quota: { readonly held?: Readonly<Record<string, number>>; readonly train?: Readonly<Record<string, number>> }, options: { readonly share?: number; readonly salt?: string; readonly note?: (kind: string, n: number) => string | undefined; readonly shape?: (input: { readonly kind: string; readonly note?: string }) => Json } = {}): DecisionRecord[] {
  const share = options.share ?? settings().holdout;
  const salt = options.salt ?? SALT;
  const wanted = [
    ...Object.entries(quota.held ?? {}).flatMap(([kind, count]) => Array.from({ length: count }, () => ["holdout", kind] as const)),
    ...Object.entries(quota.train ?? {}).flatMap(([kind, count]) => Array.from({ length: count }, () => ["train", kind] as const)),
  ];
  return wanted.map(([side, kind], id) => {
    const base = options.note?.(kind, id);
    for (let again = 0; ; again++) {
      const note = again === 0 ? base : `${base ?? "try"} v${again}`;
      const made = { kind, ...(note === undefined ? {} : { note }) };
      const input: Json = options.shape === undefined ? made : options.shape(made);
      if (sideOf(input, share, salt) === side) return record({ id, fork: gate().id, input, action: "allow", outcome: outcome("overridden", { label: expectedFor(kind) }) });
    }
  });
}

export const labelOf = (r: DecisionRecord): Act | undefined => {
  const label = r.outcome?.label;
  return label === "allow" || label === "deny" ? label : undefined;
};

export { chose, levels, yes };
