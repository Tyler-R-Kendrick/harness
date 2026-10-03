/**
 * Test doubles for the composed layer: the shipped settings, a layer wired to a memory log
 * with a manual clock and seeded entropy, members that answer whatever fork they are asked,
 * and a way to put hand-made decisions (with outcomes) into the log.
 */
import { readFileSync } from "node:fs";
import { probability } from "@harness/cognitive";
import { ManualClock, SeededEntropy } from "@harness/testkit";
import { parseAttentionSettings } from "../src/attention.ts";
import { parseCalibration } from "../src/calibration.ts";
import { createDecisionLayer } from "../src/compose.ts";
import type { DecisionLayer, DecisionLayerOptions, LayerSettings } from "../src/compose.ts";
import { parseDispatchSettings } from "../src/dispatch.ts";
import { parseEvolveSettings } from "../src/evolve.ts";
import type { DecisionEvent } from "../src/fork.ts";
import { parseLifecycleSettings } from "../src/lifecycle.ts";
import { parsePermissionAuthority, parsePermissionRiskSettings } from "../src/permission.ts";
import { parsePolicy } from "../src/policy.ts";
import { MemoryDecisionLog } from "../src/records.ts";
import { parseStuckSettings } from "../src/stuck.ts";
import type { Answers, Asked, DecisionRecord, Json, Member, Outcome } from "../src/types.ts";
import { chose, levels, memberOf, yes } from "./loops-fixtures.ts";
import { policyJson } from "./fork-fixtures.ts";
import { forkId } from "../src/types.ts";

const data = (name: string): unknown => JSON.parse(readFileSync(new URL(`../data/${name}.json`, import.meta.url), "utf8"));

/** The settings the product ships, parsed. */
export const shippedSettings = (): LayerSettings => ({
  attention: parseAttentionSettings(data("attention")),
  stuck: parseStuckSettings(data("stuck")),
  dispatch: parseDispatchSettings(data("dispatch")),
  lifecycle: parseLifecycleSettings(data("lifecycle")),
  evolve: parseEvolveSettings(data("evolve")),
  permission: parsePermissionRiskSettings(data("permission-questions")),
});

/** The shipped permission authority, parsed. */
export const shippedAuthority = () => parsePermissionAuthority(data("permission"));
export const shippedCalibration = () => parseCalibration(data("calibration"));

/** What a member says to each kind of question. */
export interface Say {
  readonly boolean?: number;
  /** Weights of a score's levels (in level order, any number of levels). */
  readonly score?: readonly number[];
  /** The top option of a choice question, with this much of the probability. */
  readonly choice?: number;
}

/** Answers to every question asked, by the question's type. */
export function answerAll(asked: Asked, say: Say): Answers {
  return Object.fromEntries(
    Object.entries(asked.questions).map(([id, q]) => {
      if (q.type === "boolean") return [id, yes(say.boolean ?? 0.5)];
      if (q.type === "score") {
        const weights = say.score ?? q.criteria.map(() => 1);
        return [id, levels(weights.length === q.criteria.length ? weights : q.criteria.map((_, i) => weights[i] ?? 0.0001))];
      }
      const keys = Object.keys(q.criteria);
      const top = say.choice ?? 1 / keys.length;
      return [id, chose(Object.fromEntries(keys.map((k, i) => [k, i === 0 ? top : (1 - top) / (keys.length - 1)])))];
    }),
  );
}

/** A member that answers every question by its type, remembering the calls. */
export const saying = (id: string, say: Say, version = "v1") => memberOf(id, (asked) => answerAll(asked, say), version);

export interface Rig {
  readonly layer: DecisionLayer;
  readonly log: MemoryDecisionLog;
  readonly clock: ManualClock;
  readonly published: DecisionEvent[];
  readonly options: DecisionLayerOptions;
}

export interface RigOptions extends Partial<Omit<DecisionLayerOptions, "log" | "clock">> {
  readonly policy?: DecisionLayerOptions["policy"];
  readonly seed?: number;
  /** The clock to share with other parts of a test (a daemon's, say); one at 10 000 ms when absent. */
  readonly clock?: ManualClock;
  readonly policyPatch?: Parameters<typeof policyJson>[0];
}

/** A layer on a memory log, a clock at 10 000 ms and seeded entropy. Everything the layer takes can be replaced. */
export function rig(overrides: RigOptions = {}): Rig {
  const log = new MemoryDecisionLog();
  const published: DecisionEvent[] = [];
  const { seed, policyPatch, clock: given, ...rest } = overrides;
  const clock = given ?? new ManualClock(10_000);
  const options: DecisionLayerOptions = {
    log,
    clock,
    entropy: new SeededEntropy(seed ?? 7),
    policy: parsePolicy(policyJson(policyPatch)),
    settings: shippedSettings(),
    members: [],
    publish: (event) => void published.push(event),
    ...rest,
  };
  return { layer: createDecisionLayer(options), log, clock, published, options };
}

/** Put a decision (with the given fields) in the log as the next id; returns it as stored. */
export async function put(log: MemoryDecisionLog, patch: Partial<Omit<DecisionRecord, "id">> = {}): Promise<DecisionRecord> {
  const id = await log.next();
  const record: DecisionRecord = {
    id,
    fork: forkId("test.gate"),
    forkVersion: "f1",
    at: 10_000,
    input: { text: id },
    rung: "model",
    policy: "policy-t",
    answers: { q: yes(0.9) },
    action: "allow",
    confidence: probability(0.9),
    propensity: probability(1),
    explored: false,
    mode: "active",
    trace: [],
    ...patch,
  };
  await log.append(record);
  return record;
}

export const humanOutcome = (kind: Outcome["kind"], extra: { readonly correct?: boolean; readonly label?: Json } = {}): Outcome => ({ at: 20_000, source: "human", kind, ...extra });

export type { Member };
