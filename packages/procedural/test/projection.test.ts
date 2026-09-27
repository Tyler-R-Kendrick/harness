import { describe, expect, it } from "vitest";
import { coreView, GraphIdSchema, match, NodeNameSchema, projectTurn, RevisionIdSchema, ScoreSchema, sha256Hex, turnProjection } from "@harness/procedural";
import type { NodeName, ProjectionContext } from "@harness/procedural";
import { call, CORE, ended, GRAPH, logOf, record, result, said, started, thought, user } from "./learner-fixtures.ts";
import { core, hexId } from "./overlay-fixtures.ts";

const view = coreView(core());
const locate = (action: string): NodeName | undefined => match(action, view, "case-insensitive");
const ctx = (more: Partial<ProjectionContext> = {}): ProjectionContext => ({ sessionId: "s1", turnId: "t1", locate, ...more });
const pin = { graph: GraphIdSchema.parse(GRAPH), core: RevisionIdSchema.parse(CORE), overlay: 3 };

/** A turn: the prompt, a first step record at Start, two tool calls and an answer. */
const turn = () => [
  started("t1"),
  user("Who directed "),
  user("the film?"),
  record({ node: "Start", overlay: 2 }),
  thought("Retrieve first."),
  call("c1", "first_hop_retrieve", { q: "film" }),
  result("c1", "passages"),
  record({ node: "First_Hop_Retrieve", overlay: 2 }),
  call("c2", "Scan_Index", { page: 1 }),
  result("c2", { hits: 2, best: "p1" }),
  record({ node: "Scan_Index", overlay: 2 }),
  said("It was "),
  said("Nolan."),
  ended("t1"),
];

describe("projecting a turn from the session log", () => {
  it("PL1.10 the turn's prompt, text, tool calls and results become learning steps in order, with chunks merged", () => {
    const p = turnProjection(logOf(turn()), ctx())!;
    expect(p.trajectory.steps).toEqual([
      { role: "user", content: "Who directed the film?" },
      { role: "assistant", content: "Retrieve first." },
      { role: "assistant", content: "", call: { name: "first_hop_retrieve", arguments: { q: "film" } } },
      { role: "tool", content: "passages" },
      { role: "assistant", content: "", call: { name: "Scan_Index", arguments: { page: 1 } } },
      { role: "tool", content: '{"best":"p1","hits":2}' },
      { role: "assistant", content: "It was Nolan." },
    ]);
    expect(p.trajectory.query).toBe("Who directed the film?");
    expect(p.trajectory.usage).toEqual({ steps: 7, inputTokens: 0, outputTokens: 0, guidanceTokens: 360 });
  });

  it("PL1.11 the version pair is the first step record's; the score is the context's, null without one", () => {
    const p = turnProjection(logOf(turn()), ctx())!;
    expect(p.trajectory).toMatchObject({ id: "s1/t1", graph: GRAPH, core: CORE, overlay: 2, session: "s1", turn: "t1", score: null, scoreSource: null });
    expect(p.trajectory.localization).toEqual({ matched: 3, fallback: 0, inert: 0 });
    const scored = turnProjection(logOf(turn()), ctx({ score: { score: ScoreSchema.parse(0.75), source: "judge-probability" } }))!;
    expect([scored.trajectory.score, scored.trajectory.scoreSource]).toEqual([0.75, "judge-probability"]);
    expect(turnProjection(logOf(turn()), ctx({ score: null }))!.trajectory.score).toBeNull();
    // A later record naming another pair does not change the turn's.
    const mixed = [...turn().slice(0, 4), record({ node: "Start", overlay: 9, core: "b".repeat(64) }), ...turn().slice(4)];
    expect(turnProjection(logOf(mixed), ctx())!.trajectory).toMatchObject({ core: CORE, overlay: 2 });
  });

  it("PL1.12 localization counts matched, fallback and inert steps from the records", () => {
    const log = [started("t1"), record({ node: "Start" }), record({ node: null, matched: false }), record({ node: null, matched: false, inert: true }), record({ node: "Scan_Index", inert: false }), ended("t1")];
    const p = turnProjection(logOf(log), ctx())!;
    expect(p.trajectory.localization).toEqual({ matched: 2, fallback: 1, inert: 1 });
    // Only the first record says where the turn began.
    expect(p.path).toEqual(["Start"]);
  });

  it("PL1.13 the path starts at the first record's node and follows each tool call's node in emission order; unmatched actions are listed", () => {
    const log = [started("t1"), record({ node: "Start" }), call("c1", "first_hop_retrieve"), call("c2", "grep"), call("c3", "scan_index"), call("c4", "scan_index"), ended("t1")];
    const p = turnProjection(logOf(log), ctx())!;
    expect(p.path).toEqual(["Start", "First_Hop_Retrieve", "Scan_Index", "Scan_Index"]);
    expect(p.unmatched).toEqual(["grep"]);
  });

  it("PL1.14 a re-emitted tool call (the same id) is one action and one step; calls without an id each count", () => {
    const log = [started("t1"), record(), call("c1", "first_hop_retrieve"), call("c1", "first_hop_retrieve"), { update: { sessionUpdate: "tool_call", title: "Scan_Index" } }, { update: { sessionUpdate: "tool_call", title: "Scan_Index" } }, ended("t1")];
    const p = turnProjection(logOf(log), ctx())!;
    expect(p.path).toEqual(["Start", "First_Hop_Retrieve", "Scan_Index", "Scan_Index"]);
    expect(p.trajectory.steps.filter((s) => s.call !== undefined)).toHaveLength(3);
  });

  it("PL1.15 without locate every action is unmatched; without a matched first record the path has no start node", () => {
    const { locate: _, ...unlocated } = ctx();
    const p = turnProjection(logOf(turn()), unlocated)!;
    expect(p.path).toEqual(["Start"]);
    expect(p.unmatched).toEqual(["first_hop_retrieve", "Scan_Index"]);
    const unmatchedStart = [started("t1"), record({ node: null, matched: false }), call("c1", "scan_index"), ended("t1")];
    expect(turnProjection(logOf(unmatchedStart), ctx())!.path).toEqual(["Scan_Index"]);
    const late = [started("t1"), call("c1", "first_hop_retrieve"), record({ node: "First_Hop_Retrieve" }), call("c2", "scan_index"), ended("t1")];
    expect(turnProjection(logOf(late), ctx())!.path).toEqual(["First_Hop_Retrieve", "Scan_Index"]);
    const nodeless = [started("t1"), record({ node: null, matched: true }), call("c1", "scan_index"), ended("t1")];
    expect(turnProjection(logOf(nodeless), ctx())!.path).toEqual(["Scan_Index"]);
    const named = [started("t1"), record({ node: "First_Hop_Retrieve", matched: false }), call("c1", "scan_index"), ended("t1")];
    expect(turnProjection(logOf(named), ctx())!.path).toEqual(["Scan_Index"]);
  });

  it("PL1.16 only the turn's own entries count: earlier and later turns are left out", () => {
    const log = [started("t0"), user("old"), call("c0", "grep"), ended("t0"), ...turn(), started("t2"), user("next"), call("c9", "grep"), ended("t2")];
    const p = turnProjection(logOf(log), ctx())!;
    expect(p.trajectory.query).toBe("Who directed the film?");
    expect(p.unmatched).toEqual([]);
    expect(p.next).toBe(4 + turn().length);
    expect(p.started && p.ended).toBe(true);
  });

  it("PL1.28 a turn's bounds: an end before its start is not its end, an empty turn ends at once, and the next turn's start cuts an unended one", () => {
    const stale = turnProjection(logOf([ended("t1"), started("t1"), user("q"), ended("t1")]), ctx({ pin }))!;
    expect([stale.trajectory.steps, stale.next]).toEqual([[{ role: "user", content: "q" }], 4]);
    const empty = turnProjection(logOf([started("t1"), ended("t1")]), ctx({ pin }))!;
    expect([empty.ended, empty.next, empty.trajectory.steps]).toEqual([true, 2, []]);
    const cut = turnProjection(logOf([started("t1"), started("t2"), user("x")]), ctx({ pin }))!;
    expect([cut.ended, cut.trajectory.steps]).toEqual([false, []]);
    const endOnly = turnProjection(logOf([ended("t1")]), ctx({ pin }))!;
    expect([endOnly.started, endOnly.ended, endOnly.next, endOnly.trajectory.steps]).toEqual([false, true, 1, []]);
  });

  it("PL1.29 the query is all the turn's user text; holes outside the turn are not its gaps", () => {
    expect(turnProjection(logOf([started("t1"), user("a"), said("x"), user("b"), ended("t1")]), ctx({ pin }))!.trajectory.query).toBe("ab");
    const log = [...logOf([started("t0"), user("old")]), ...logOf([ended("t0"), ...turn(), started("t2")], 9)];
    expect(turnProjection(log, ctx({ from: 0 }))!.gaps).toEqual([]);
  });

  it("PL1.17 a turn the entries do not hold projects to nothing", () => {
    expect(turnProjection(logOf([started("t0"), user("old"), ended("t0")]), ctx())).toBeUndefined();
    expect(turnProjection([], ctx())).toBeUndefined();
  });

  it("PL1.18 with no step record the pin's pair is used; with neither, or an empty session or turn, nothing is projected", () => {
    const bare = [started("t1"), user("hi"), call("c1", "scan_index"), ended("t1")];
    const p = turnProjection(logOf(bare), ctx({ pin }))!;
    expect(p.trajectory).toMatchObject({ graph: GRAPH, core: CORE, overlay: 3, localization: { matched: 0, fallback: 0, inert: 0 } });
    expect(p.path).toEqual(["Scan_Index"]);
    expect(turnProjection(logOf(bare), ctx())).toBeUndefined();
    expect(turnProjection(logOf(turn()), ctx({ sessionId: "" }))).toBeUndefined();
    expect(turnProjection(logOf([started(""), record(), ended("")]), ctx({ turnId: "" }))).toBeUndefined();
  });

  it("PL1.19 a compacted start is reported as a gap: the turn is what follows the last other turn's boundary", () => {
    // Offsets 0-5 were compacted; the log resumes mid-turn.
    const log = logOf([said("partial "), call("c2", "Scan_Index"), result("c2", "x"), record({ node: "Scan_Index" }), said("done"), ended("t1")], 6);
    const p = turnProjection(log, ctx({ from: 0 }))!;
    expect(p.started).toBe(false);
    expect(p.gaps).toEqual([{ from: 0, to: 6 }]);
    expect(turnProjection(log, ctx({ from: 3 }))!.gaps).toEqual([{ from: 3, to: 6 }]);
    // The first record seen is mid-turn, so it is not where the turn began.
    expect(p.path).toEqual(["Scan_Index"]);
    expect(p.trajectory.steps[0]).toEqual({ role: "assistant", content: "partial " });
    // An earlier turn's end bounds the window.
    const after = logOf([user("old"), ended("t0"), said("mine"), ended("t1")], 10);
    const bounded = turnProjection(after, ctx({ from: 4, pin }))!;
    expect(bounded.ended).toBe(true);
    expect(bounded.trajectory.steps).toEqual([{ role: "assistant", content: "mine" }]);
    expect([bounded.gaps, bounded.started]).toEqual([[], false]);
    // An interrupted turn is a boundary too.
    const interrupted = logOf([user("old"), { event: "turn.interrupted", data: { turnId: "t0" } }, said("mine"), ended("t1")]);
    expect(turnProjection(interrupted, ctx({ pin }))!.trajectory.steps).toEqual([{ role: "assistant", content: "mine" }]);
  });

  it("PL1.20 holes inside the turn are gaps; a gap before a turn that started in view is not the turn's", () => {
    const log = [...logOf([started("t1"), user("q"), record()], 5), ...logOf([call("c1", "scan_index"), ended("t1")], 12)];
    const p = turnProjection(log, ctx({ from: 0 }))!;
    expect(p.gaps).toEqual([{ from: 8, to: 12 }]);
    expect(p.started).toBe(true);
    const whole = turnProjection(logOf(turn(), 20), ctx({ from: 0 }))!;
    expect(whole.gaps).toEqual([]);
    // A hole just before the end, and one around an entry whose offset is not a number.
    const beforeEnd = [...logOf([started("t1"), user("q")]), ...logOf([ended("t1")], 5)];
    expect(turnProjection(beforeEnd, ctx({ pin }))!.gaps).toEqual([{ from: 2, to: 5 }]);
    const odd = [...logOf([started("t1"), record()]), { offset: Number.NaN, payload: user("q") }, ...logOf([ended("t1")], 4)];
    expect(turnProjection(odd, ctx())!.gaps).toEqual([{ from: 2, to: 4 }]);
    // Without a starting offset nothing before the first entry is known to be missing.
    expect(turnProjection(logOf(turn().slice(1), 20), ctx())!.gaps).toEqual([]);
    expect(turnProjection(logOf(turn().slice(1), 20), ctx({ from: 20 }))!.gaps).toEqual([]);
  });

  it("PL1.21 a turn without its end runs to the next turn's start or the last entry", () => {
    const open = turnProjection(logOf([started("t1"), user("q"), call("c1", "scan_index")]), ctx({ pin }))!;
    expect([open.ended, open.next, open.path]).toEqual([false, undefined, ["Scan_Index"]]);
    const cut = turnProjection(logOf([started("t1"), user("q"), started("t2"), call("c1", "scan_index")]), ctx({ pin }))!;
    expect(cut.path).toEqual([]);
    expect(cut.trajectory.steps).toEqual([{ role: "user", content: "q" }]);
  });

  it("PL1.22 shown lists the probationary entries the records say this turn saw, once each", () => {
    const [a, b] = [hexId("a"), hexId("b")];
    const log = [started("t1"), record({ exposure: [a] }), record({ exposure: [b, a] }), { update: { _meta: { harness: { procedural: { step: { graph: GRAPH, core: CORE, overlay: 0, matched: true, exposure: "junk" } } } } } }, ended("t1")];
    expect(turnProjection(logOf(log), ctx())!.shown).toEqual([a, b]);
  });

  it("PL1.23 tool inputs that are not objects are wrapped; outputs render as text, JSON or nothing", () => {
    const log = [
      started("t1"),
      record(),
      call("c1", "a", ["x"]),
      call("c2", "b", 3),
      { update: { sessionUpdate: "tool_call", toolCallId: "c3", title: "c" } },
      { update: { sessionUpdate: "tool_call", toolCallId: "c4", title: "d", rawInput: null } },
      result("c1", undefined),
      result("c2", 10n),
      result("c3", "boom", "failed"),
      result("c3", "later", "in_progress"),
      ended("t1"),
    ];
    const steps = turnProjection(logOf(log), ctx())!.trajectory.steps;
    expect(steps).toStrictEqual([
      { role: "assistant", content: "", call: { name: "a", arguments: { input: ["x"] } } },
      { role: "assistant", content: "", call: { name: "b", arguments: { input: 3 } } },
      { role: "assistant", content: "", call: { name: "c", arguments: {} } },
      { role: "assistant", content: "", call: { name: "d", arguments: { input: null } } },
      { role: "tool", content: "" },
      { role: "tool", content: "" },
      { role: "tool", content: "boom" },
    ]);
  });

  it("PL1.24 what it cannot read is skipped: malformed records, other updates, non-text content, untitled calls", () => {
    const log = [
      started("t1"),
      { update: { sessionUpdate: "notice", _meta: { harness: { procedural: { step: { graph: "Bad Graph", matched: true } } } } } },
      { update: { sessionUpdate: "notice", severity: "info", title: "Behavior: calm" } },
      { update: { sessionUpdate: "plan", entries: [] } },
      { update: { sessionUpdate: "user_message_chunk", content: { type: "image", data: "…" } } },
      { update: { sessionUpdate: "agent_message_chunk", content: "bare" } },
      { update: { sessionUpdate: "tool_call", toolCallId: "c1", title: "" } },
      { update: { sessionUpdate: "tool_call", toolCallId: "c2" } },
      { update: "text" },
      null,
      { update: null },
      { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: 5 } } },
      { update: { sessionUpdate: "tool_call", toolCallId: "c3", title: 5 } },
      { update: { sessionUpdate: "plan", content: { type: "text", text: "a plan" } } },
      { update: { sessionUpdate: "notice", status: "completed", rawOutput: "x" } },
      { event: "behavior.changed", data: {} },
      record({ usage: { inputTokens: -1, outputTokens: 1.5 } }),
      record({ usage: "none" }),
      ended("t1"),
    ];
    const p = turnProjection(logOf(log), ctx())!;
    expect(p.trajectory.steps).toEqual([]);
    expect(p.trajectory.localization).toEqual({ matched: 2, fallback: 0, inert: 0 });
    // A call id that is not a string is no id: such calls each count.
    const ids = [started("t1"), record(), { update: { sessionUpdate: "tool_call", toolCallId: 7, title: "grep" } }, { update: { sessionUpdate: "tool_call", toolCallId: 7, title: "grep" } }, ended("t1")];
    expect(turnProjection(logOf(ids), ctx())!.unmatched).toEqual(["grep", "grep"]);
    expect(p.trajectory.usage.guidanceTokens).toBe(0);
  });

  it("PL1.25 the trajectory id is session/turn, or its sha256 when that is too long for an id", () => {
    const long = "t".repeat(300);
    const p = turnProjection(logOf([started(long), record(), ended(long)]), ctx({ turnId: long }))!;
    expect(p.trajectory.id).toBe(sha256Hex(`s1/${long}`));
    expect(p.trajectory.turn).toBe(long);
    const edge = "t".repeat(197);
    expect(turnProjection(logOf([started(edge), record(), ended(edge)]), ctx({ turnId: edge }))!.trajectory.id).toBe(`s1/${edge}`);
  });

  it("PL1.27 text after a tool call is a step of its own; an end without a whole-number offset gives no next offset", () => {
    const p = turnProjection(logOf([started("t1"), record(), call("c1", "grep"), said("x"), ended("t1")]), ctx())!;
    expect(p.trajectory.steps).toEqual([{ role: "assistant", content: "", call: { name: "grep", arguments: {} } }, { role: "assistant", content: "x" }]);
    expect(p.next).toBe(5);
    const odd = [...logOf([started("t1"), record()]), { offset: 2.5, payload: ended("t1") }];
    expect(turnProjection(odd, ctx())!).toMatchObject({ ended: true, next: undefined });
  });

  it("PL1.26 projectTurn is the projection's trajectory", () => {
    expect(projectTurn(logOf(turn()), ctx())).toEqual(turnProjection(logOf(turn()), ctx())!.trajectory);
    expect(projectTurn([], ctx())).toBeUndefined();
    expect(NodeNameSchema.parse(turnProjection(logOf(turn()), ctx())!.path[0])).toBe("Start");
  });
});
