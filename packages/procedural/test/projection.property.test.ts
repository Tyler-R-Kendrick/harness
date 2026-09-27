import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { coreView, GraphIdSchema, match, RevisionIdSchema, ScoredTrajectorySchema, turnProjection } from "@harness/procedural";
import type { LogEntryLike, ProjectionContext } from "@harness/procedural";
import { call, CORE, ended, GRAPH, record, result, said, started, thought, user } from "./learner-fixtures.ts";
import type { Payload } from "./learner-fixtures.ts";
import { core, hexId } from "./overlay-fixtures.ts";

const view = coreView(core());
const pin = { graph: GraphIdSchema.parse(GRAPH), core: RevisionIdSchema.parse(CORE), overlay: 1 };
const ctx = (from?: number): ProjectionContext => ({ sessionId: "s1", turnId: "t1", pin, locate: (a) => match(a, view, "exact"), ...(from === undefined ? {} : { from }) });

const KINDS = ["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "notice", "plan", "available_commands_update"];
const turnIds = fc.oneof(fc.constantFrom("t1", "t2", "", "t1 "), fc.jsonValue());
/** A step record's fields, well formed or not. */
const step = fc.record(
  {
    graph: fc.oneof(fc.constant(GRAPH), fc.jsonValue()),
    core: fc.oneof(fc.constant(CORE), fc.jsonValue()),
    overlay: fc.oneof(fc.nat(9), fc.constant(null), fc.jsonValue()),
    node: fc.oneof(fc.constantFrom("Start", "Scan_Index", "bad name", null), fc.jsonValue()),
    matched: fc.oneof(fc.boolean(), fc.jsonValue()),
    inert: fc.oneof(fc.boolean(), fc.jsonValue()),
    exposure: fc.oneof(fc.constant([hexId("a")]), fc.jsonValue()),
    usage: fc.oneof(fc.record({ inputTokens: fc.oneof(fc.nat(), fc.double()), outputTokens: fc.jsonValue() }), fc.jsonValue()),
  },
  { requiredKeys: [] },
);
/** Any update shape: ACP kinds with arbitrary fields, step records, and arbitrary JSON. */
const update = fc.record(
  {
    sessionUpdate: fc.oneof(fc.constantFrom(...KINDS), fc.jsonValue()),
    content: fc.oneof(fc.record({ type: fc.constantFrom("text", "image"), text: fc.oneof(fc.string(), fc.jsonValue()) }), fc.jsonValue()),
    title: fc.oneof(fc.constantFrom("first_hop_retrieve", "Scan_Index", "grep", ""), fc.jsonValue()),
    toolCallId: fc.oneof(fc.constantFrom("c1", "c2"), fc.jsonValue()),
    rawInput: fc.jsonValue(),
    rawOutput: fc.jsonValue(),
    status: fc.oneof(fc.constantFrom("pending", "in_progress", "completed", "failed"), fc.jsonValue()),
    _meta: fc.oneof(step.map((s) => ({ harness: { procedural: { step: s } } })), fc.jsonValue()),
  },
  { requiredKeys: [] },
);
const payload: fc.Arbitrary<unknown> = fc.oneof(
  fc.jsonValue(),
  fc.record({ update: fc.oneof(update, fc.jsonValue()) }),
  fc.record({ event: fc.constantFrom("turn.started", "turn.ended", "turn.interrupted", "behavior.changed"), data: fc.oneof(fc.record({ turnId: turnIds }), fc.jsonValue()) }),
);
/** Offsets that climb with holes (compaction, lost ranges), and now and then one that is not an offset at all. */
const offsets = (n: number) =>
  fc.tuple(fc.nat(50), fc.array(fc.oneof(fc.constant(1), fc.integer({ min: 2, max: 9 }), fc.constant(Number.NaN), fc.constant(-3)), { minLength: n, maxLength: n })).map(([first, steps]) => {
    let at = first;
    return steps.map((s) => (Number.isNaN(s) || s < 0 ? s : (at += s)));
  });
/** Arbitrary entries around (often) the turn's own start and end, so the turn is found and its insides are arbitrary too. */
const entries: fc.Arbitrary<LogEntryLike[]> = fc
  .tuple(fc.array(payload, { maxLength: 6 }), fc.boolean(), fc.array(payload, { maxLength: 14 }), fc.boolean(), fc.array(payload, { maxLength: 6 }))
  .map(([before, start, inside, end, after]) => [...before, ...(start ? [started("t1")] : []), ...inside, ...(end ? [ended("t1")] : []), ...after])
  .chain((payloads) => offsets(payloads.length).map((os) => payloads.map((p, i) => ({ offset: os[i]!, payload: p }))));

/** A well-formed turn's pieces (no turn boundaries among them). */
const piece: fc.Arbitrary<Payload> = fc.oneof(
  fc.string().map(user),
  fc.string().map(said),
  fc.string().map(thought),
  fc.tuple(fc.constantFrom("c1", "c2", "c3"), fc.constantFrom("first_hop_retrieve", "Scan_Index", "grep")).map(([id, tool]) => call(id, tool)),
  fc.constantFrom("c1", "c2", "c3").map((id) => result(id, "out")),
  fc.constantFrom("Start", "Scan_Index").map((node) => record({ node })),
);

describe("projection never throws on a daemon log", () => {
  test.prop([entries, fc.option(fc.nat(60), { nil: undefined })], { numRuns: 300 })("PL1.P1 any entries: nothing thrown, and a projection is a valid scored trajectory with ordered gaps", (log, from) => {
    const p = turnProjection(log, ctx(from));
    if (p === undefined) return;
    expect(ScoredTrajectorySchema.safeParse(p.trajectory).success).toBe(true);
    for (const g of p.gaps) expect(g.from).toBeLessThan(g.to);
    expect(p.path.length).toBeLessThanOrEqual(1 + p.trajectory.steps.filter((s) => s.call !== undefined).length);
    expect(p.path.length + p.unmatched.length).toBeGreaterThanOrEqual(p.trajectory.steps.filter((s) => s.call !== undefined).length);
  });

  test.prop([fc.array(piece, { minLength: 1, maxLength: 12 }), fc.nat(), fc.nat()], { numRuns: 300 })("PL1.P2 a hole cut from a well-formed turn is reported as exactly that gap, and a lost start as not started", (pieces, i, n) => {
    const whole = [started("t1"), ...pieces, ended("t1")].map((p, k) => ({ offset: k, payload: p }));
    const at = i % (whole.length - 1);
    const len = n % (whole.length - 1 - at);
    const cut = [...whole.slice(0, at), ...whole.slice(at + len)];
    const p = turnProjection(cut, ctx(0))!;
    expect(p.gaps).toEqual(len === 0 ? [] : [{ from: at, to: at + len }]);
    expect(p.started).toBe(!(at === 0 && len > 0));
    expect([p.ended, p.next]).toEqual([true, whole.length]);
  });
});
