/** A live learner over a fake store and fake session logs, for the learner's tests. */
import { readFileSync } from "node:fs";
import { foldAll, LiveLearner, parseSettings, presetOf, ScoreSchema } from "@harness/procedural";
import type { EntryId, LearnerEvent, LiveLearnerDeps, LiveSettings, LogEntryLike, OverlayState, Preset, ScoredTrajectory, ScoreSource } from "@harness/procedural";
import { call, CORE, ended, FakeStore, GRAPH, logOf, record, result, revisionOf, said, started, user } from "./learner-fixtures.ts";
import { core } from "./overlay-fixtures.ts";

const settings = parseSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));
const harness = presetOf(settings, "harness");
export const paper = presetOf(settings, "paper");

/** The harness preset with live settings changed (minSupport 2 unless given). */
export const preset = (live: Partial<LiveSettings> = {}, more: Partial<Preset> = {}): Preset => ({ ...harness, ...more, live: { ...harness.live!, minSupport: 2, ...live } });

/** turn.ended as the daemon publishes it on the hook bus. */
export const turnEnded = (sessionId: string, turnId: string, more: Partial<LearnerEvent> = {}): LearnerEvent => ({ type: "turn.ended", source: "daemon", sessionId, payload: { turnId, stopReason: "end_turn" }, ...more });

/** A turn calling these tools, with a step record before each step (overlay version `overlay`). */
export function turnOf(turnId: string, tools: readonly string[], overlay = 0, extra: { exposure?: EntryId[] } = {}): unknown[] {
  const nodes = ["Start", ...tools];
  const body = tools.flatMap((tool, i) => [call(`${turnId}-c${i}`, tool, { i }), result(`${turnId}-c${i}`, "ok"), record({ node: nodes[i + 1]!, overlay, ...(extra.exposure === undefined ? {} : { exposure: extra.exposure }) })]);
  return [started(turnId), user("Who directed the film?"), record({ node: "Start", overlay, ...(extra.exposure === undefined ? {} : { exposure: extra.exposure }) }), ...body, said("Nolan."), ended(turnId)];
}

export interface Setup {
  store: FakeStore;
  learner: LiveLearner;
  logs: Map<string, LogEntryLike[]>;
  reads: [string, number][];
  /** Append a turn's entries to a session's log. */
  add(session: string, payloads: readonly unknown[]): void;
  pin(session: string, salt?: string, overlay?: number): void;
  state(): OverlayState;
}

export function setup(options: { preset?: Preset; score?: (t: ScoredTrajectory) => Promise<{ score: number; source: ScoreSource } | null>; withCore?: boolean; reflect?: LiveLearnerDeps["reflect"] } = {}): Setup {
  const store = new FakeStore();
  if (options.withCore !== false) {
    store.records.set(CORE, revisionOf(core()));
    store.headOf.set(GRAPH, CORE);
  }
  const logs = new Map<string, LogEntryLike[]>();
  const reads: [string, number][] = [];
  const readLog = async (session: string, from: number): Promise<readonly LogEntryLike[]> => {
    reads.push([session, from]);
    return (logs.get(session) ?? []).filter((e) => e.offset >= from);
  };
  const score = options.score;
  const learner = new LiveLearner({
    store,
    settings: options.preset ?? preset(),
    readLog,
    ...(options.reflect === undefined ? {} : { reflect: options.reflect }),
    ...(score === undefined
      ? {}
      : {
          score: async (t: ScoredTrajectory) => {
            const s = await score(t);
            return s === null ? null : { score: ScoreSchema.parse(s.score), source: s.source };
          },
        }),
  });
  return {
    store,
    learner,
    logs,
    reads,
    add(session, payloads) {
      const log = logs.get(session) ?? [];
      logs.set(session, [...log, ...logOf(payloads, log.length)]);
    },
    pin(session, salt = "salt-0", overlay = 0) {
      const seed = revisionOf(core());
      store.pinOf.set(session, { graph: seed.graph, core: seed.id, overlay, salt, at: 0 });
    },
    state: () => foldAll(CORE, store.events()),
  };
}
