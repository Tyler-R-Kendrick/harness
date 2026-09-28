import { describe, expect, it } from "vitest";
import { edgeKey, entryId, exposed, OverlayEventSchema, parseGraph, ScoreSchema } from "@harness/procedural";
import type { OverlayEvent } from "@harness/procedural";
import { call, CORE, ended, GRAPH, record, result, revisionOf, said, started, user } from "./learner-fixtures.ts";
import { paper, preset, setup, turnEnded, turnOf } from "./learner-setup.ts";
import { cautionOnCore, core, entry, idOf, noteOnCore, observed, proposed, saltWhere, status, toVerify, verifyNode } from "./overlay-fixtures.ts";

const observedOf = (events: readonly OverlayEvent[]) => events.filter((e): e is Extract<OverlayEvent, { kind: "observed" }> => e.kind === "observed");

describe("the live learner on turn.ended", () => {
  it("PLV1.30 a daemon turn.ended appends one observed event: the matched path, unmatched actions, and no score without a scorer", async () => {
    const t = setup();
    t.pin("s1");
    t.add("s1", turnOf("t1", ["first_hop_retrieve", "grep", "Scan_Index"]));
    const r = await t.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(t.store.events()).toEqual([{ kind: "observed", turnKey: "s1/t1", path: ["Start", "First_Hop_Retrieve", "Scan_Index"], unmatched: ["grep"], score: null, exposure: [] }]);
    expect(r).toMatchObject({ kind: "observed", turnKey: "s1/t1", graph: GRAPH, gaps: [] });
    expect(OverlayEventSchema.parse(t.store.events()[0])).toEqual(t.store.events()[0]);
  });

  it("PLV1.31 the scorer scores the projected trajectory; null or a failing scorer leaves the turn unscored", async () => {
    const seen: unknown[] = [];
    const t = setup({ score: async (tr) => (seen.push(tr), { score: 0.8, source: "judge-probability" }) });
    t.pin("s1");
    t.add("s1", turnOf("t1", ["first_hop_retrieve"]));
    await t.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(observedOf(t.store.events())[0]!.score).toBe(0.8);
    expect(seen).toMatchObject([{ id: "s1/t1", graph: GRAPH, core: CORE, score: null, query: "Who directed the film?" }]);
    const none = setup({ score: async () => null });
    none.pin("s1");
    none.add("s1", turnOf("t1", ["first_hop_retrieve"]));
    await none.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(observedOf(none.store.events())[0]!.score).toBeNull();
    const failing = setup({ score: async () => Promise.reject(new Error("judge down")) });
    failing.pin("s1");
    failing.add("s1", turnOf("t1", ["first_hop_retrieve"]));
    await failing.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(observedOf(failing.store.events())[0]!.score).toBeNull();
  });

  it("PLV1.32 other events, other sources, events without a session or turn, and presets without an overlay are ignored", async () => {
    const t = setup();
    t.pin("s1");
    t.add("s1", turnOf("t1", ["first_hop_retrieve"]));
    const ignored = [
      turnEnded("s1", "t1", { type: "turn.started" }),
      turnEnded("s1", "t1", { source: "plugin:evil" }),
      { type: "turn.ended", source: "daemon", payload: { turnId: "t1" } },
      turnEnded("s1", "t1", { payload: { stopReason: "end_turn" } }),
      turnEnded("s1", "t1", { payload: null }),
      turnEnded("s1", "t1", { payload: { turnId: "" } }),
      turnEnded("", "t1"),
    ];
    const reasons = await Promise.all(ignored.map((e) => t.learner.onHookEvent(e)));
    expect(reasons).toEqual([...Array(2).fill({ kind: "ignored", reason: "not a daemon turn.ended" }), ...Array(5).fill({ kind: "ignored", reason: "no session or turn" })]);
    const off = setup({ preset: paper });
    off.pin("s1");
    off.add("s1", turnOf("t1", ["first_hop_retrieve"]));
    expect(await off.learner.onHookEvent(turnEnded("s1", "t1"))).toEqual({ kind: "ignored", reason: "the preset has no overlay" });
    expect(await off.learner.feedback("s1", "t1", 1)).toEqual({ kind: "ignored", reason: "the preset has no overlay" });
    expect([t.store.appends, off.store.appends]).toEqual([0, 0]);
  });

  it("PLV1.33 a redelivered turn.ended is one observation, also for a new learner on the same store", async () => {
    const t = setup();
    t.pin("s1");
    t.add("s1", turnOf("t1", ["first_hop_retrieve"]));
    await t.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(await t.learner.onHookEvent(turnEnded("s1", "t1"))).toEqual({ kind: "duplicate", turnKey: "s1/t1" });
    const again = await Promise.all([t.learner.onHookEvent(turnEnded("s1", "t1")), t.learner.onHookEvent(turnEnded("s1", "t1"))]);
    expect(again.map((r) => r.kind)).toEqual(["duplicate", "duplicate"]);
    expect(t.store.events()).toHaveLength(1);
  });

  it("PLV1.34 concurrent first deliveries are serialized into one observation", async () => {
    const t = setup();
    t.pin("s1");
    t.add("s1", turnOf("t1", ["first_hop_retrieve"]));
    const results = await Promise.all([t.learner.onHookEvent(turnEnded("s1", "t1")), t.learner.onHookEvent(turnEnded("s1", "t1")), t.learner.feedback("s1", "t1", 0.5)]);
    expect(results.map((r) => r.kind)).toEqual(["observed", "duplicate", "rescored"]);
    expect(observedOf(t.store.events())).toHaveLength(2);
  });

  it("PLV1.35 exposure is drawn from the pin's salt over the entries on probation at the version the turn read", async () => {
    const note = idOf(noteOnCore);
    const later = idOf(cautionOnCore);
    const salt = [...Array(10_000).keys()].map((i) => `salt-${i}`).find((s) => exposed(s, note, 0.2) && exposed(s, later, 0.2))!;
    const t = setup();
    t.store.logs.set(GRAPH, [proposed(noteOnCore, ["s9"]), proposed(cautionOnCore, ["s9"])]);
    t.pin("s1", salt, 1);
    // The records claim other exposure; only the salt counts, and the caution came after version 1.
    t.add("s1", turnOf("t1", ["first_hop_retrieve"], 1, { exposure: [idOf(verifyNode)] }));
    await t.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(observedOf(t.store.events())[0]!.exposure).toEqual([note]);
    const hidden = setup();
    hidden.store.logs.set(GRAPH, [proposed(noteOnCore, ["s9"])]);
    hidden.pin("s1", saltWhere(note, 0.2, false), 1);
    hidden.add("s1", turnOf("t1", ["first_hop_retrieve"], 1));
    await hidden.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(observedOf(hidden.store.events())[0]!.exposure).toEqual([]);
  });

  it("PLV1.36 active entries are shown to everyone, so they are no exposure; no pin or no overlay version means no exposure", async () => {
    const note = idOf(noteOnCore);
    const salt = saltWhere(note, 0.2, true);
    const active = setup();
    active.store.logs.set(GRAPH, [proposed(noteOnCore, ["s9"]), status(note, "active")]);
    active.pin("s1", salt, 2);
    active.add("s1", turnOf("t1", ["first_hop_retrieve"], 2));
    await active.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(observedOf(active.store.events())[0]!.exposure).toEqual([]);
    const unpinned = setup();
    unpinned.store.logs.set(GRAPH, [proposed(noteOnCore, ["s9"])]);
    unpinned.add("s1", turnOf("t1", ["first_hop_retrieve"], 1));
    await unpinned.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(observedOf(unpinned.store.events())[0]!.exposure).toEqual([]);
    const coreOnly = setup();
    coreOnly.store.logs.set(GRAPH, [proposed(noteOnCore, ["s9"])]);
    coreOnly.pin("s1", salt, 1);
    coreOnly.add("s1", [started("t1"), record({ overlay: null }), call("c1", "first_hop_retrieve"), ended("t1")]);
    await coreOnly.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(observedOf(coreOnly.store.events())[0]).toMatchObject({ exposure: [], path: ["Start", "First_Hop_Retrieve"] });
  });

  it("PLV1.37 actions are located in the graph the session saw: an overlay node it was shown matches, one it was not shown does not", async () => {
    const [node, edge] = [idOf(verifyNode), idOf(toVerify)];
    const events = [proposed(verifyNode, ["s9"]), proposed(toVerify, ["s9"]), status(node, "active"), status(edge, "active")];
    const t = setup();
    t.store.logs.set(GRAPH, [...events]);
    t.pin("s1", "salt-0", 4);
    t.add("s1", turnOf("t1", ["Bridge_Extract", "Verify"], 4));
    await t.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(observedOf(t.store.events())[0]).toMatchObject({ path: ["Start", "Bridge_Extract", "Verify"], unmatched: [] });
    // At version 0 the session saw the core alone.
    const before = setup();
    before.store.logs.set(GRAPH, [...events]);
    before.pin("s1", "salt-0", 0);
    before.add("s1", turnOf("t1", ["Bridge_Extract", "Verify"], 0));
    await before.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(observedOf(before.store.events())[0]).toMatchObject({ path: ["Start", "Bridge_Extract"], unmatched: ["Verify"] });
  });

  it("PLV1.55 an overlay node on probation locates actions only for sessions whose salt exposes it", async () => {
    const node = idOf(verifyNode);
    const run = async (salt: string | undefined) => {
      const t = setup();
      t.store.logs.set(GRAPH, [proposed(verifyNode, ["s9"])]);
      if (salt !== undefined) t.pin("s1", salt, 1);
      t.add("s1", turnOf("t1", ["Verify"], 1));
      await t.learner.onHookEvent(turnEnded("s1", "t1"));
      return observedOf(t.store.events())[0]!;
    };
    expect(await run(saltWhere(node, 0.2, true))).toMatchObject({ path: ["Start", "Verify"], exposure: [node] });
    expect(await run(saltWhere(node, 0.2, false))).toMatchObject({ path: ["Start"], unmatched: ["Verify"], exposure: [] });
    // Without a pin no draw was made for the session: it saw no probationary entry, whatever the salt would be.
    expect(await run(undefined)).toMatchObject({ path: ["Start"], unmatched: ["Verify"], exposure: [] });
    const everyone = setup({ preset: preset({ probationShare: ScoreSchema.parse(1) }) });
    everyone.store.logs.set(GRAPH, [proposed(verifyNode, ["s9"])]);
    everyone.add("s1", turnOf("t1", ["Verify"], 1));
    await everyone.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(observedOf(everyone.store.events())[0]).toMatchObject({ path: ["Start"], unmatched: ["Verify"], exposure: [] });
  });

  it("PLV1.38 the preset's match mode locates actions", async () => {
    const exact = setup();
    exact.pin("s1");
    exact.add("s1", turnOf("t1", ["scan_index"]));
    await exact.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(observedOf(exact.store.events())[0]!.unmatched).toEqual(["scan_index"]);
    const loose = setup({ preset: preset({}, { match: "case-insensitive" }) });
    loose.pin("s1");
    loose.add("s1", turnOf("t1", ["scan_index"]));
    await loose.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(observedOf(loose.store.events())[0]!.path).toEqual(["Start", "Scan_Index"]);
  });

  it("PLV1.77 under a state-tracker preset a result's declared node counts only for a tool the core trusts to declare: an unbound grep's is ignored", async () => {
    const declared = { stdout: "Nolan", _meta: { harness: { procedural: { node: "Bridge_Extract" } } } };
    const turn = [started("t1"), user("q"), record({ node: "Start" }), call("t1-c0", "grep", { q: "film" }), result("t1-c0", declared), ended("t1")];
    const tracker = setup({ preset: preset({}, { match: "state-tracker" }) });
    tracker.pin("s1");
    tracker.add("s1", turn);
    await tracker.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(observedOf(tracker.store.events())[0]).toMatchObject({ path: ["Start"], unmatched: ["grep"] });
    const exact = setup();
    exact.pin("s1");
    exact.add("s1", turn);
    await exact.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(observedOf(exact.store.events())[0]).toMatchObject({ path: ["Start"], unmatched: ["grep"] });
  });

  it("PLV1.39 a missing transition seen in minSupport distinct sessions is proposed after the observation; one session's many turns are not support", async () => {
    const t = setup();
    for (const turn of ["t1", "t2", "t3"]) {
      t.add("s1", turnOf(turn, ["first_hop_retrieve", "Bridge_Extract"]));
      await t.learner.onHookEvent(turnEnded("s1", turn));
    }
    expect(t.store.events().filter((e) => e.kind === "proposed")).toEqual([]);
    t.add("s2", turnOf("t1", ["first_hop_retrieve", "Bridge_Extract"]));
    const r = await t.learner.onHookEvent(turnEnded("s2", "t1"));
    const proposals = t.store.events().filter((e) => e.kind === "proposed");
    expect(proposals).toMatchObject([{ entry: { kind: "edge", from: "First_Hop_Retrieve", to: "Bridge_Extract" }, source: { sessions: ["s1", "s2"], by: "stats" } }]);
    expect(r).toMatchObject({ kind: "observed", appended: [{ kind: "observed" }, { kind: "proposed" }] });
    expect(t.state().transitions[edgeKey("First_Hop_Retrieve", "Bridge_Extract")]!.sessions).toEqual(["s1", "s2"]);
  });

  it("PLV1.56 without a head the turn's core makes the proposals, and status changes see them: a new entry can displace an old one", async () => {
    const t = setup({ preset: preset({ maxEntries: 1 }) });
    t.store.headOf.clear();
    t.store.logs.set(GRAPH, [proposed(noteOnCore, ["s9"])]);
    for (const s of ["s1", "s2"]) {
      t.add(s, turnOf("t1", ["first_hop_retrieve", "Bridge_Extract"], 1));
      await t.learner.onHookEvent(turnEnded(s, "t1"));
    }
    const tail = t.store.events().slice(-3);
    expect(tail).toMatchObject([{ kind: "observed" }, { kind: "proposed", entry: { kind: "edge" } }, { kind: "status", entry: idOf(noteOnCore), to: "retired" }]);
  });

  it("PLV1.40 status changes follow the proposals: a stale entry retires", async () => {
    const t = setup({ preset: preset({ halfLifeDays: 1 }) });
    t.store.logs.set(GRAPH, [proposed(cautionOnCore, ["s9"]), observed("s9/x", ["Start"])]);
    t.pin("s1", "salt-0", 2);
    t.add("s1", turnOf("t1", ["first_hop_retrieve"], 2));
    await t.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(t.store.events().at(-1)).toMatchObject({ kind: "status", entry: idOf(cautionOnCore), to: "retired" });
    expect(t.store.appends).toBe(1);
  });

  it("PLV1.41 proposals are made against the head core, which may have moved past the turn's", async () => {
    const t = setup();
    // The head has the shortcut First_Hop_Retrieve → Bridge_Extract, so it is not missing there.
    const g = core();
    const moved = parseGraph({ ...g, edges: [...g.edges, { from: "First_Hop_Retrieve", relation: "LEADS_TO", to: "Bridge_Extract", condition: null, guidance: "", pitfalls: "" }] });
    if (!moved.ok) throw new Error("fixture");
    const head = revisionOf(moved.graph);
    t.store.records.set(head.id, head);
    t.store.headOf.set(GRAPH, head.id);
    for (const s of ["s1", "s2"]) {
      t.add(s, turnOf("t1", ["first_hop_retrieve", "Bridge_Extract"]));
      await t.learner.onHookEvent(turnEnded(s, "t1"));
    }
    expect(t.store.events().filter((e) => e.kind === "proposed")).toEqual([]);
  });

  it("PLV1.42 a turn the log does not hold, or one naming no graph, is skipped; so is a session id a turn key cannot hold", async () => {
    const t = setup();
    const missing = { kind: "skipped", code: "unknown-turn", reason: "the log does not hold the turn, or it names no graph" };
    expect(await t.learner.onHookEvent(turnEnded("s1", "t1"))).toEqual(missing);
    // No cursor yet, so one read from the start is all there is to try.
    expect(t.reads).toEqual([["s1", 0]]);
    t.add("s1", [started("t1"), user("q"), call("c1", "first_hop_retrieve"), ended("t1")]);
    expect(await t.learner.onHookEvent(turnEnded("s1", "t1"))).toEqual(missing);
    t.add("a/b", turnOf("t1", ["first_hop_retrieve"]));
    expect(await t.learner.onHookEvent(turnEnded("a/b", "t1"))).toEqual({ kind: "skipped", code: "invalid", reason: "a session id with '/' cannot key a turn" });
    expect(t.store.appends).toBe(0);
  });

  it("PLV1.43 with no step record the pin names the graph and version the turn read", async () => {
    const t = setup();
    t.pin("s1");
    t.add("s1", [started("t1"), user("q"), call("c1", "first_hop_retrieve"), ended("t1")]);
    expect(await t.learner.onHookEvent(turnEnded("s1", "t1"))).toMatchObject({ kind: "observed" });
    expect(observedOf(t.store.events())[0]).toMatchObject({ path: ["First_Hop_Retrieve"] });
  });

  it("PLV1.44 each read starts after the session's last observed turn; an older turn is found again from the start", async () => {
    const t = setup();
    t.pin("s1");
    t.add("s1", turnOf("t1", ["first_hop_retrieve"]));
    t.add("s1", turnOf("t2", ["first_hop_retrieve"]));
    await t.learner.onHookEvent(turnEnded("s1", "t2"));
    await t.learner.onHookEvent(turnEnded("s1", "t1"));
    const end = t.logs.get("s1")!.length;
    t.add("s1", turnOf("t3", ["first_hop_retrieve"]));
    await t.learner.onHookEvent(turnEnded("s1", "t3"));
    expect(t.reads).toEqual([["s1", 0], ["s1", end], ["s1", 0], ["s1", end]]);
    expect(observedOf(t.store.events()).map((e) => e.turnKey)).toEqual(["s1/t2", "s1/t1", "s1/t3"]);
  });

  it("PLV1.45 gaps in the turn's entries are reported with the observation", async () => {
    const t = setup();
    t.pin("s1");
    const turn = turnOf("t1", ["first_hop_retrieve", "Scan_Index"]);
    t.add("s1", turn);
    t.logs.set("s1", t.logs.get("s1")!.filter((e) => e.offset !== 4));
    expect(await t.learner.onHookEvent(turnEnded("s1", "t1"))).toMatchObject({ kind: "observed", gaps: [{ from: 4, to: 5 }] });
  });

  it("PLV1.46 without the turn's core revision every action is unmatched and no policy runs", async () => {
    const t = setup({ withCore: false });
    t.pin("s1");
    t.add("s1", turnOf("t1", ["first_hop_retrieve"]));
    await t.learner.onHookEvent(turnEnded("s1", "t1"));
    expect(t.store.events()).toEqual([{ kind: "observed", turnKey: "s1/t1", path: ["Start"], unmatched: ["first_hop_retrieve"], score: null, exposure: [] }]);
  });
});

describe("transitions into a terminal", () => {
  it("PLV1.73 a turn that answers after a node with an edge to End is observed walking into End, so that edge gets statistics and cautions", async () => {
    // Answers straight from Bridge_Extract score 0; turns that retrieve first score 1.
    const t = setup({ score: async (tr) => ({ score: tr.steps.some((s) => s.call !== undefined) ? 1 : 0, source: "judge-probability" }) });
    for (let i = 0; i < 8; i += 1) {
      const session = `s${i}`;
      t.pin(session);
      t.add(session, i < 4 ? [started("t1"), user("q"), record({ node: "Bridge_Extract" }), said("Nolan."), ended("t1")] : turnOf("t1", ["first_hop_retrieve"]));
      await t.learner.onHookEvent(turnEnded(session, "t1"));
    }
    expect(observedOf(t.store.events()).map((e) => e.path)).toEqual([...Array(4).fill(["Bridge_Extract", "End"]), ...Array(4).fill(["Start", "First_Hop_Retrieve"])]);
    const state = t.state();
    expect(state.stats[edgeKey("Bridge_Extract", "End")]).toMatchObject({ traversals: 4, scored: 4, scoreSum: 0 });
    expect(Object.values(state.entries).map((r) => r.entry)).toContainEqual(expect.objectContaining({ kind: "caution", on: { from: "Bridge_Extract", to: "End" } }));
  });
});

describe("transitions into a terminal, without the core", () => {
  it("PLV1.75 a turn whose core revision the store lacks walks into no terminal: the path is where its record began", async () => {
    const t = setup({ withCore: false });
    t.pin("s1");
    t.add("s1", [started("t1"), user("q"), record({ node: "Bridge_Extract" }), said("Nolan."), ended("t1")]);
    expect(await t.learner.onHookEvent(turnEnded("s1", "t1"))).toMatchObject({ kind: "observed" });
    expect(observedOf(t.store.events()).map((e) => e.path)).toEqual([["Bridge_Extract"]]);
  });
});

describe("the live learner on logs it did not write", () => {
  it("PLV1.47 a stray re-observation of a turn never observed does not make that turn a duplicate", async () => {
    const t = setup();
    t.store.logs.set(GRAPH, [OverlayEventSchema.parse({ kind: "observed", turnKey: "s1/t1", path: ["Start"], unmatched: [], score: 1, exposure: [], rescore: { seq: 1, previous: null, observedAt: 1 } })]);
    t.add("s1", turnOf("t1", ["first_hop_retrieve"]));
    expect(await t.learner.onHookEvent(turnEnded("s1", "t1"))).toMatchObject({ kind: "observed" });
  });

  it("PLV1.48 a turn whose end is not in the log is observed, and the next read starts where the last one did", async () => {
    const t = setup();
    t.add("s1", turnOf("t1", ["first_hop_retrieve"]).slice(0, -1));
    expect(await t.learner.onHookEvent(turnEnded("s1", "t1"))).toMatchObject({ kind: "observed" });
    t.add("s1", turnOf("t2", ["first_hop_retrieve"]));
    await t.learner.onHookEvent(turnEnded("s1", "t2"));
    expect(t.reads).toEqual([["s1", 0], ["s1", 0]]);
  });

  it("PLV1.49 a store failure rejects that delivery (so the bus redelivers it) and the learner goes on", async () => {
    const t = setup();
    t.add("s1", turnOf("t1", ["first_hop_retrieve"]));
    const read = t.store.pins.get;
    t.store.pins.get = () => Promise.reject(new Error("disk"));
    await expect(t.learner.onHookEvent(turnEnded("s1", "t1"))).rejects.toThrow("disk");
    t.store.pins.get = read;
    expect(await t.learner.onHookEvent(turnEnded("s1", "t1"))).toMatchObject({ kind: "observed" });
  });
});

describe("feedback", () => {
  const observedTurn = async (score?: number) => {
    const t = setup(score === undefined ? {} : { score: async () => ({ score, source: "judge-probability" }) });
    t.pin("s1");
    t.add("s1", turnOf("t1", ["first_hop_retrieve", "Scan_Index"]));
    await t.learner.onHookEvent(turnEnded("s1", "t1"));
    return t;
  };

  it("PLV1.50 feedback on an observed turn appends a re-observation that moves its score, with no new traversal", async () => {
    const t = await observedTurn();
    const r = await t.learner.feedback("s1", "t1", 0.9);
    const last = t.store.events().at(-1);
    expect(last).toEqual({ kind: "observed", turnKey: "s1/t1", path: ["Start", "First_Hop_Retrieve", "Scan_Index"], unmatched: [], score: 0.9, exposure: [], rescore: { seq: 1, previous: null, observedAt: 1 } });
    expect(r).toMatchObject({ kind: "rescored", turnKey: "s1/t1" });
    expect(t.state().stats[edgeKey("Start", "First_Hop_Retrieve")]).toMatchObject({ traversals: 1, scored: 1, scoreSum: 0.9 });
  });

  it("PLV1.51 later feedback replaces the earlier score (the next sequence); the same score again changes nothing", async () => {
    const t = await observedTurn(0.2);
    await t.learner.feedback("s1", "t1", 0.9);
    await t.learner.feedback("s1", "t1", 0.4);
    expect(observedOf(t.store.events()).map((e) => e.rescore)).toEqual([undefined, { seq: 1, previous: 0.2, observedAt: 1 }, { seq: 2, previous: 0.9, observedAt: 1 }]);
    expect(await t.learner.feedback("s1", "t1", 0.4)).toEqual({ kind: "unchanged", turnKey: "s1/t1" });
    const stats = t.state().stats[edgeKey("Start", "First_Hop_Retrieve")]!;
    expect([stats.traversals, stats.scored]).toEqual([1, 1]);
    expect(stats.scoreSum).toBeCloseTo(0.4);
  });

  it("PLV1.52 feedback on a turn not yet observed observes it with the feedback score, and turn.ended then is a duplicate", async () => {
    const t = setup({ score: async () => ({ score: 0.1, source: "judge-probability" }) });
    t.pin("s1");
    t.add("s1", turnOf("t1", ["first_hop_retrieve"]));
    expect(await t.learner.feedback("s1", "t1", 1)).toMatchObject({ kind: "observed", trajectory: { score: 1, scoreSource: "feedback" } });
    expect(await t.learner.onHookEvent(turnEnded("s1", "t1"))).toEqual({ kind: "duplicate", turnKey: "s1/t1" });
    expect(observedOf(t.store.events()).map((e) => e.score)).toEqual([1]);
  });

  it("PLV1.53 feedback without a pin, or with a score outside [0, 1], is skipped", async () => {
    const t = await observedTurn();
    expect(await t.learner.feedback("s2", "t1", 0.5)).toEqual({ kind: "skipped", code: "no-pin", reason: "the session has no pin, so no graph" });
    for (const bad of [1.5, -0.1, Number.NaN]) expect(await t.learner.feedback("s1", "t1", bad)).toEqual({ kind: "skipped", code: "invalid", reason: "a score is a probability in [0, 1]" });
    expect(t.store.events()).toHaveLength(1);
  });

  it("PLV1.70 feedback says why it skipped a score: a turn the log does not hold, no pin, or an input no turn key or score can hold", async () => {
    const t = await observedTurn();
    expect(await t.learner.feedback("s1", "absent", 0.5)).toMatchObject({ kind: "skipped", code: "unknown-turn" });
    expect(await t.learner.feedback("s2", "t1", 0.5)).toMatchObject({ kind: "skipped", code: "no-pin" });
    t.pin("a/b");
    expect(await t.learner.feedback("a/b", "t1", 0.5)).toMatchObject({ kind: "skipped", code: "invalid" });
    expect(await t.learner.feedback("s1", "t1", 2)).toMatchObject({ kind: "skipped", code: "invalid" });
    expect(t.store.events()).toHaveLength(1);
  });

  it("PLV1.54 feedback counts in the arm each entry counted the turn in, and the policy runs after it", async () => {
    const t = setup();
    t.store.logs.set(GRAPH, [proposed(noteOnCore, ["s9"])]);
    t.pin("s1", saltWhere(idOf(noteOnCore), 0.2, true), 1);
    t.add("s1", turnOf("t1", ["first_hop_retrieve"], 1));
    await t.learner.onHookEvent(turnEnded("s1", "t1"));
    await t.learner.feedback("s1", "t1", 0.7);
    expect(t.state().entries[entryId(entry(noteOnCore))]!.evidence.exposed).toEqual({ n: 1, scored: 1, scoreSum: 0.7 });
    expect(observedOf(t.store.events()).at(-1)!.rescore).toEqual({ seq: 1, previous: null, observedAt: 2 });
  });
});
