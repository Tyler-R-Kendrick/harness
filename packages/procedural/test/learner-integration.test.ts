/** The live learner with the modules it works beside: P7's memory store, P10's step records and P12's feedback operation. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { edgeKey, foldAll, GraphIdSchema, LiveLearner, MemoryProceduralStore, parseSettings, presetOf, proceduralExtension, StepRecordSchema, turnProjection } from "@harness/procedural";
import type { LogEntryLike, StepNotice } from "@harness/procedural";
import { call, CORE, ended, GRAPH, logOf, result, revisionOf, started, user } from "./learner-fixtures.ts";
import { turnEnded, turnOf } from "./learner-setup.ts";
import { core, hexId } from "./overlay-fixtures.ts";

const settings = parseSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));
const harness = presetOf(settings, "harness");
const graph = GraphIdSchema.parse(GRAPH);

async function memory() {
  const store = new MemoryProceduralStore();
  const seed = revisionOf(core());
  await store.revisions.put(seed);
  await store.heads.set(graph, undefined, seed.id);
  const logs = new Map<string, LogEntryLike[]>();
  const learner = new LiveLearner({ store, settings: { ...harness, live: { ...harness.live!, minSupport: 2 } }, readLog: async (s, from) => (logs.get(s) ?? []).filter((e) => e.offset >= from) });
  return { store, logs, learner };
}

describe("the live learner with the landed modules", () => {
  it("PL1.60 over the memory store: turns observed once, a proposal at two sessions, and feedback as a re-observation", async () => {
    const { store, logs, learner } = await memory();
    for (const s of ["s1", "s2"]) {
      await store.pins.set(s, { graph, core: revisionOf(core()).id, overlay: 0, salt: `salt-${s}`, at: 0 });
      logs.set(s, logOf(turnOf("t1", ["first_hop_retrieve", "Bridge_Extract"])));
      expect(await learner.onHookEvent(turnEnded(s, "t1"))).toMatchObject({ kind: "observed" });
      expect(await learner.onHookEvent(turnEnded(s, "t1"))).toEqual({ kind: "duplicate", turnKey: `${s}/t1` });
    }
    expect(await learner.feedback("s1", "t1", 0.6)).toMatchObject({ kind: "rescored" });
    const events = (await store.overlay(graph).read(0)).map((e) => e.event);
    expect(events.map((e) => e.kind)).toEqual(["observed", "observed", "proposed", "observed"]);
    const state = foldAll(CORE, events);
    expect(state.transitions[edgeKey("First_Hop_Retrieve", "Bridge_Extract")]).toEqual({ sessions: ["s1", "s2"], scored: 1, scoreSum: 0.6 });
  });

  it("PL1.61 a step record as P10 writes it is read for the version pair, localization, exposure and guidance usage", () => {
    const step = StepRecordSchema.parse({
      graph: GRAPH,
      core: CORE,
      overlay: 4,
      node: "First_Hop_Retrieve",
      action: "first_hop_retrieve",
      matched: true,
      inert: true,
      others: [],
      cached: false,
      guidanceId: "a".repeat(64),
      digest: "b".repeat(64),
      exposure: [hexId("c")],
      usage: { inputTokens: 30, outputTokens: 12 },
    });
    const notice: StepNotice = { sessionUpdate: "notice", severity: "info", title: "Procedural step", description: "At First_Hop_Retrieve", _meta: { harness: { procedural: { step } } } };
    const log = logOf([started("t1"), user("q"), { update: notice }, call("c1", "first_hop_retrieve"), result("c1", "ok"), ended("t1")]);
    const p = turnProjection(log, { sessionId: "s1", turnId: "t1" })!;
    expect(p.trajectory).toMatchObject({ core: CORE, overlay: 4, localization: { matched: 0, fallback: 0, inert: 1 }, usage: { guidanceTokens: 42 } });
    expect([p.path, p.shown]).toEqual([["First_Hop_Retrieve"], [hexId("c")]]);
  });

  it("PL1.62 P12's feedback operation reaches the learner", async () => {
    const { store, logs, learner } = await memory();
    await store.pins.set("s1", { graph, core: revisionOf(core()).id, overlay: 0, salt: "salt", at: 0 });
    logs.set("s1", logOf(turnOf("t1", ["first_hop_retrieve"])));
    await learner.onHookEvent(turnEnded("s1", "t1"));
    const x = proceduralExtension({ store, settings, clock: { now: () => 0 }, feedback: (session, turn, score) => learner.feedback(session, turn, score) });
    expect(await x.operations!["feedback"]!({ session: "s1", turn: "t1", score: 0.9 })).toEqual({ status: "recorded", graph });
    const last = (await store.overlay(graph).read(0)).at(-1)!.event;
    expect(last).toMatchObject({ kind: "observed", turnKey: "s1/t1", score: 0.9, rescore: { seq: 1, previous: null } });
  });
});
