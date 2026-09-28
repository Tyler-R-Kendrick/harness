import { describe, expect, it } from "vitest";
import { GraphIdSchema, logTrajectories, MemoryProceduralStore, OverlayEventSchema, RevisionIdSchema } from "@harness/procedural";
import type { SessionLog } from "@harness/procedural";
import { call, CORE, ended, GRAPH, logOf, record, result, started, user } from "./learner-fixtures.ts";

const G = GraphIdSchema.parse(GRAPH);
const OTHER_CORE = RevisionIdSchema.parse("b".repeat(64));

/** One session with a turn per [turnId, tool, core?]: a question, one tool call and its result, each turn with its step record. */
function session(id: string, turns: readonly (readonly [string, string, string?])[]): SessionLog {
  return {
    id,
    entries: logOf(turns.flatMap(([turn, tool, core]) => [started(turn), user(`question ${turn}`), record({ core: core ?? CORE }), call(`${turn}-c`, tool, { q: turn }), result(`${turn}-c`, `answer ${turn}`), ended(turn)])),
  };
}
const observed = (turnKey: string, score: number | null, rescore?: { seq: number; previous: number | null; observedAt: number }) =>
  OverlayEventSchema.parse({ kind: "observed", turnKey, path: [], unmatched: [], score, exposure: [], ...(rescore && { rescore }) });

describe("recorded trajectories for dream (logTrajectories)", () => {
  it("PD2.27 selects the turns under the revision from the session logs, scored from the overlay log (feedback is the latest)", async () => {
    const store = new MemoryProceduralStore();
    const note = OverlayEventSchema.parse({ kind: "proposed", entry: { kind: "note", on: { from: "Start", to: "End" }, text: "n" }, source: { sessions: ["s1"], by: "stats" } });
    await store.overlay(G).append([observed("s1/t1", 0.2), note, observed("s1/t2", 0.9), observed("s1/t1", 0.6, { seq: 1, previous: 0.2, observedAt: 1 })]);
    const sessions = [session("s1", [["t1", "search"], ["t2", "fetch"], ["t3", "read", OTHER_CORE]]), session("s2", [["t1", "search"]])];
    const source = logTrajectories({ store, sessions: async () => sessions });
    const picked = await source.select({ graph: G, revision: CORE, limit: 10 });
    expect(picked.map((t) => [t.id, t.score, t.scoreSource])).toEqual([
      ["s1/t2", 0.9, null],
      ["s1/t1", 0.6, "feedback"],
      ["s2/t1", null, null],
    ]);
    expect(picked[0]).toMatchObject({ graph: G, core: CORE, session: "s1", turn: "t2", query: "question t2", steps: [{ role: "user" }, { role: "assistant", call: { name: "fetch", arguments: { q: "t2" } } }, { role: "tool", content: "answer t2" }] });
    expect(await source.select({ graph: G, revision: OTHER_CORE, limit: 10 })).toMatchObject([{ id: "s1/t3" }]);
    expect(await source.select({ graph: GraphIdSchema.parse("other"), revision: CORE, limit: 10 })).toEqual([]);
  });

  it("PD2.28 within the limit the selection is balanced: highest and lowest scores alternating inward, then the unscored", async () => {
    const store = new MemoryProceduralStore();
    const scores = [0.5, 0.1, 0.9, 0.3, 0.7];
    await store.overlay(G).append(scores.map((s, i) => observed(`s${i}/t`, s)));
    const sessions = [...scores.map((_, i) => session(`s${i}`, [["t", "search"]])), session("u", [["t", "search"]])];
    const source = logTrajectories({ store, sessions: async () => sessions });
    expect((await source.select({ graph: G, revision: CORE, limit: 10 })).map((t) => t.score)).toEqual([0.9, 0.1, 0.7, 0.3, 0.5, null]);
    expect((await source.select({ graph: G, revision: CORE, limit: 3 })).map((t) => t.score)).toEqual([0.9, 0.1, 0.7]);
    // Equal scores keep the log order.
    const tied = new MemoryProceduralStore();
    await tied.overlay(G).append([observed("a/t", 0.5), observed("b/t", 0.5), observed("c/t", 0.5)]);
    const three = ["a", "b", "c"].map((id) => session(id, [["t", "search"]]));
    expect((await logTrajectories({ store: tied, sessions: async () => three }).select({ graph: G, revision: CORE, limit: 3 })).map((t) => t.session)).toEqual(["a", "c", "b"]);
  });

  it("PD2.29 a turn with no step record takes the session's pin; one with neither, or an unfinished turn, is left out", async () => {
    const store = new MemoryProceduralStore();
    await store.pins.set("pinned", { graph: G, core: CORE, overlay: 0, salt: "s", at: 1 });
    const bare = (id: string, withEnd: boolean): SessionLog => ({ id, entries: logOf([started("t"), user("q"), call("c", "search"), result("c", "a"), ...(withEnd ? [ended("t")] : [])]) });
    const source = logTrajectories({ store, sessions: async () => [bare("pinned", true), bare("loose", true), bare("open", false)] });
    expect((await source.select({ graph: G, revision: CORE, limit: 10 })).map((t) => t.id)).toEqual(["pinned/t"]);
  });
});
