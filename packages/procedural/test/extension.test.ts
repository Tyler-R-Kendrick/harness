import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GraphIdSchema, MemoryProceduralStore, parseGraph, parseSettings, proceduralExtension, revisionId, seedGraph } from "@harness/procedural";
import type { ApprovalNotice, GraphId, LearnerResult, ProceduralAction, ProceduralExtensionOptions } from "@harness/procedural";
import { hotpot } from "./fixtures.ts";
import { paper, setup, turnOf } from "./learner-setup.ts";
import { proposed, shortcut } from "./overlay-fixtures.ts";
import { FakeStore } from "./store-fake.ts";

const settings = parseSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));
const clock = { now: () => 5 };
const graph = GraphIdSchema.parse("team/search");
const core = () => {
  const parsed = parseGraph(hotpot());
  if (!parsed.ok) throw new Error("fixture");
  return parsed.graph;
};

function extension(options: Partial<ProceduralExtensionOptions> = {}) {
  const store = options.store ?? new FakeStore();
  const x = proceduralExtension({ store, settings, clock, ...options });
  const op = (name: string, input?: unknown) => x.operations![name]!(input);
  return { x, op, store: store as FakeStore };
}

describe("proceduralExtension", () => {
  it("PX2.28 is a cognitive extension with id procedural, no models, and its operations", () => {
    const { x } = extension();
    expect(x.id).toBe("procedural");
    expect(x.models).toEqual([]);
    expect(Object.keys(x.operations!).sort()).toEqual(["approvals", "approve", "decline", "dream", "export", "feedback", "graph", "history", "import", "revert"]);
  });

  it("PX2.29 import, graph, export and history work on the store", async () => {
    const { op } = extension();
    expect(await op("import", { graph, document: hotpot() })).toEqual({ status: "head", revision: revisionId(core()) });
    const view = (await op("graph", { graph })) as { status: string; head: string; origin: string; document: unknown; effective: { overlay: number } };
    expect(view).toMatchObject({ status: "ok", head: revisionId(core()), revision: revisionId(core()), origin: "import", document: core() });
    expect(view.effective.overlay).toBe(0);
    expect(await op("export", { graph })).toEqual({ status: "ok", revision: revisionId(core()), text: `${JSON.stringify(core(), null, 2)}\n` });
    expect(await op("export", { graph, format: "json" })).toEqual(await op("export", { graph }));
    expect(await op("export", { graph, format: "mermaid" })).toMatchObject({ status: "ok", text: expect.stringMatching(/^flowchart TD\n/) });
    expect(await op("history", { graph })).toMatchObject({ head: revisionId(core()), heads: [revisionId(core())], revisions: [{ origin: "import", at: 5 }] });
  });

  it("PX2.30 import without a document seeds the skeleton; import onto a head proposes to dream", async () => {
    const { op } = extension();
    expect(await op("import", { graph })).toEqual({ status: "head", revision: revisionId(seedGraph()) });
    expect(await op("import", { graph, document: hotpot() })).toEqual({ status: "proposed", revision: revisionId(core()), head: revisionId(seedGraph()) });
  });

  it("PX2.31 graph and export take a revision and whether to fold the overlay; a missing graph is a value", async () => {
    const { op, store } = extension();
    await op("import", { graph, document: hotpot() });
    await store.overlay(graph).append([proposed(shortcut, ["s1"])]);
    expect(await op("graph", { graph, overlay: false })).toMatchObject({ effective: { overlay: null } });
    expect(await op("graph", { graph, revision: revisionId(core()) })).toMatchObject({ effective: { overlay: 1 } });
    expect(await op("export", { graph, format: "mermaid", overlay: false })).toMatchObject({ text: expect.not.stringContaining("-.->") });
    expect(await op("export", { graph, revision: revisionId(core()), format: "mermaid" })).toMatchObject({ text: expect.stringContaining("-.->") });
    expect(await op("graph", { graph: "none" })).toEqual({ status: "missing", reason: "graph none has no head" });
  });

  it("PX2.32 revert moves the head back and says so", async () => {
    const { op, store } = extension();
    await op("import", { graph });
    const next = revisionId(core());
    await store.revisions.put({ ...store.records.get(revisionId(seedGraph()))!, id: next, document: core() });
    await store.heads.set(graph, revisionId(seedGraph()), next);
    expect(await op("revert", { graph })).toEqual({ status: "reverted", from: next, to: revisionId(seedGraph()) });
    expect(await op("revert", { graph, to: revisionId(seedGraph()) })).toEqual({ status: "refused", reason: `${revisionId(seedGraph())} is already the head of graph team/search` });
  });

  it("PX2.33 dream runs the host's dream for the graph; without one it is unavailable", async () => {
    const dream = vi.fn(async (g: GraphId) => ({ rounds: 1, graph: g }));
    expect(await extension({ dream }).op("dream", { graph })).toEqual({ status: "done", result: { rounds: 1, graph } });
    expect(dream).toHaveBeenCalledWith(graph);
    expect(await extension().op("dream", { graph })).toEqual({ status: "unavailable", reason: "no dream runner is configured" });
  });

  it("PX2.34 feedback scores a session's turn through the live learner, on the graph the session is pinned to", async () => {
    const feedback = vi.fn(async (): Promise<LearnerResult> => ({ kind: "rescored", turnKey: "s1/t3", graph, appended: [] }));
    const store = new FakeStore();
    await store.pins.set("s1", { graph, core: revisionId(core()), overlay: 0, salt: "x", at: 0 });
    const { op } = extension({ store, feedback });
    expect(await op("feedback", { session: "s1", turn: "t3", score: 0.25 })).toEqual({ status: "recorded", graph });
    expect(feedback).toHaveBeenCalledWith("s1", "t3", 0.25);
    expect(await op("feedback", { session: "s2", turn: "t1", score: 1 })).toEqual({ status: "no-pin", reason: "session s2 is not pinned to a graph" });
    expect(await extension({ store }).op("feedback", { session: "s1", turn: "t3", score: 1 })).toEqual({ status: "unavailable", reason: "no live learner is configured" });
  });

  it("PX2.66 feedback answers what the learner did with the score: recorded, unknown-turn, no-pin or invalid", async () => {
    const t = setup();
    t.pin("s1");
    t.add("s1", turnOf("t1", ["first_hop_retrieve"]));
    const pinned = (await t.store.pins.get("s1"))!.graph;
    const { op } = extension({ store: t.store, feedback: (session, turn, score) => t.learner.feedback(session, turn, score) });
    expect(await op("feedback", { session: "s1", turn: "t1", score: 0.5 })).toEqual({ status: "recorded", graph: pinned });
    // A rescore, and the same score again, are recorded too.
    expect(await op("feedback", { session: "s1", turn: "t1", score: 0.75 })).toEqual({ status: "recorded", graph: pinned });
    expect(await op("feedback", { session: "s1", turn: "t1", score: 0.75 })).toEqual({ status: "recorded", graph: pinned });
    expect(await op("feedback", { session: "s1", turn: "absent", score: 0.5 })).toEqual({ status: "unknown-turn", graph: pinned, reason: "the log does not hold the turn, or it names no graph" });
    t.pin("a/b");
    expect(await op("feedback", { session: "a/b", turn: "t1", score: 0.5 })).toEqual({ status: "invalid", reason: "a session id with '/' cannot key a turn" });
    // The pin went between the operation's check and the learner's.
    const racing = extension({ store: t.store, feedback: async (session, turn, score) => (t.store.pinOf.delete(session), t.learner.feedback(session, turn, score)) });
    expect(await racing.op("feedback", { session: "s1", turn: "t1", score: 0.5 })).toEqual({ status: "no-pin", reason: "the session has no pin, so no graph" });
  });

  it("PX2.67 feedback is unavailable when no learner answers, or the learner's preset keeps no overlay", async () => {
    const t = setup({ preset: paper });
    t.pin("s1");
    const pinned = (await t.store.pins.get("s1"))!.graph;
    expect(await extension({ store: t.store, feedback: (session, turn, score) => t.learner.feedback(session, turn, score) }).op("feedback", { session: "s1", turn: "t1", score: 0.5 })).toEqual({ status: "unavailable", graph: pinned, reason: "the preset has no overlay" });
    expect(await extension({ store: t.store, feedback: async () => undefined }).op("feedback", { session: "s1", turn: "t1", score: 0.5 })).toEqual({ status: "unavailable", graph: pinned, reason: "no live learner is running" });
  });

  it("PX2.117 feedback the learner skips or ignores is not reported as recorded, and a learner that is not running is unavailable", async () => {
    const store = new FakeStore();
    await store.pins.set("s1", { graph, core: revisionId(core()), overlay: 0, salt: "x", at: 0 });
    const skipping = extension({ store, feedback: async () => ({ kind: "skipped", code: "unknown-turn", reason: "the log does not hold the turn, or it names no graph" }) });
    expect(await skipping.op("feedback", { session: "s1", turn: "typo", score: 1 })).toEqual({ status: "unknown-turn", graph, reason: "the log does not hold the turn, or it names no graph" });
    const ignoring = extension({ store, feedback: async () => ({ kind: "ignored", reason: "the preset has no overlay" }) });
    expect(await ignoring.op("feedback", { session: "s1", turn: "t", score: 1 })).toEqual({ status: "unavailable", graph, reason: "the preset has no overlay" });
    const recorded: LearnerResult[] = [{ kind: "rescored", turnKey: "s1/t", graph, appended: [] }, { kind: "unchanged", turnKey: "s1/t" }, { kind: "duplicate", turnKey: "s1/t" }];
    for (const result of recorded) {
      expect(await extension({ store, feedback: async () => result }).op("feedback", { session: "s1", turn: "t", score: 1 })).toEqual({ status: "recorded", graph });
    }
    // A host whose learner has not started yet answers nothing.
    expect(await extension({ store, feedback: async () => undefined }).op("feedback", { session: "s1", turn: "t", score: 1 })).toEqual({ status: "unavailable", graph, reason: "no live learner is running" });
  });

  it("PX2.35 every operation checks the policy for its action on its graph first; a refusal throws and nothing runs", async () => {
    const asked: [ProceduralAction, string][] = [];
    const dream = vi.fn(async () => ({}));
    const feedback = vi.fn(async () => undefined);
    const store = new FakeStore();
    await store.pins.set("s1", { graph, core: revisionId(core()), overlay: 0, salt: "x", at: 0 });
    const { op } = extension({ store, dream, feedback, authorize: (action, g) => (asked.push([action, g]), false) });
    const calls: [string, unknown, ProceduralAction][] = [
      ["graph", { graph }, "read"],
      ["history", { graph }, "read"],
      ["export", { graph }, "read"],
      ["feedback", { session: "s1", turn: "t", score: 1 }, "write"],
      ["dream", { graph }, "dream"],
      ["revert", { graph }, "revert"],
      ["import", { graph }, "import"],
    ];
    for (const [name, input, action] of calls) {
      await expect(op(name, input)).rejects.toThrow(`procedural.${name}: ${action} on graph team/search is not allowed`);
      expect(asked.at(-1)).toEqual([action, graph]);
    }
    expect(dream).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();
    expect(store.records.size).toBe(0);
  });

  it("PX2.36 the policy allows by default, and a policy that allows lets the operation run", async () => {
    expect(await extension({ authorize: () => true }).op("import", { graph })).toMatchObject({ status: "head" });
  });

  it("PX2.37 malformed input throws, naming the operation and where", async () => {
    const { op } = extension();
    await expect(op("graph", { graph: "Not A Graph" })).rejects.toThrow(/invalid procedural\.graph input[\s\S]*graph/);
    await expect(op("history")).rejects.toThrow(/invalid procedural\.history input/);
    await expect(op("export", { graph, format: "svg" })).rejects.toThrow(/invalid procedural\.export input[\s\S]*format/);
    await expect(op("feedback", { session: "s", turn: "t", score: 2 })).rejects.toThrow(/invalid procedural\.feedback input[\s\S]*score/);
    await expect(op("revert", { graph, to: "abc" })).rejects.toThrow(/invalid procedural\.revert input[\s\S]*to/);
    await expect(op("import", { graph, extra: 1 })).rejects.toThrow(/invalid procedural\.import input/);
    await expect(op("dream", {})).rejects.toThrow(/invalid procedural\.dream input/);
  });

  it("PX2.38 import checks cycles under the preset's dream policy", async () => {
    const harness = settings.presets.harness;
    const presets = { ...settings.presets, strict: { ...harness, dream: { ...harness.dream, cycles: "forbidden" as const } } };
    const cyclic = hotpot();
    cyclic.edges.push({ from: "Scan_Index", relation: "LEADS_TO", to: "Start", condition: "retry", guidance: "", pitfalls: "" });
    const strict = extension({ settings: { ...settings, presets }, preset: "strict" });
    expect(await strict.op("import", { graph, document: cyclic })).toMatchObject({ status: "invalid", diagnostics: [{ code: "cycle" }] });
    expect(await extension().op("import", { graph, document: cyclic })).toMatchObject({ status: "head" });
    expect(() => extension({ preset: "absent" })).toThrow(RangeError);
  });

  describe("the approvals inbox", () => {
    /** The hotpot core with another description: an expert's document proposed onto the head. */
    const expert = () => {
      const d = hotpot();
      d.nodes[2]!.description = "Scan every passage.";
      return d;
    };
    const expertId = () => {
      const parsed = parseGraph(expert());
      if (!parsed.ok) throw new Error("fixture");
      return revisionId(parsed.graph);
    };

    it("PX2.108 approvals lists what waits (an import proposal announced as requested), approve commits it and decline rejects it, each announced as decided", async () => {
      const notices: ApprovalNotice[] = [];
      const { op, store } = extension({ notify: (n) => void notices.push(n) });
      await op("import", { graph, document: hotpot() });
      expect(notices).toEqual([]);
      expect(await op("import", { graph, document: expert() })).toMatchObject({ status: "proposed" });
      const requested = { type: "procedural.approval.requested", payload: { graph, candidate: expertId(), origin: "import", parent: revisionId(core()), tools: [] } };
      expect(notices).toEqual([requested]);
      expect(await op("approvals", { graph })).toEqual({ graph, head: revisionId(core()), approvals: [{ candidate: expertId(), graph, origin: "import", parent: revisionId(core()), onHead: true, at: 5, edits: null, tools: [] }] });
      expect(await op("approve", { graph, candidate: expertId() })).toEqual({ status: "committed", graph, candidate: expertId(), revision: expertId(), previous: revisionId(core()) });
      expect(notices.at(-1)).toEqual({ type: "procedural.approval.decided", payload: { graph, candidate: expertId(), decision: "approved", revision: expertId() } });
      expect(store.headOf.get(graph)?.revision).toBe(expertId());
      // Deciding it again is refused, and nothing is announced.
      expect(await op("decline", { graph, candidate: expertId() })).toMatchObject({ status: "refused", reason: expect.stringContaining("not waiting for approval") });
      expect(await op("approve", { graph, candidate: expertId() })).toMatchObject({ status: "refused" });
      expect(notices).toHaveLength(2);
      // Another proposal, declined.
      const shorter = hotpot();
      shorter.edges[0]!.guidance = "Go.";
      const parsed = parseGraph(shorter);
      if (!parsed.ok) throw new Error("fixture");
      const other = revisionId(parsed.graph);
      await op("import", { graph, document: shorter });
      expect(await op("decline", { graph, candidate: other })).toEqual({ status: "declined", graph, candidate: other });
      expect(notices.at(-1)).toEqual({ type: "procedural.approval.decided", payload: { graph, candidate: other, decision: "declined" } });
      expect(store.records.get(other)?.decision).toEqual({ kind: "rejected-gate", gate: "approval", reason: "declined by the approver" });
      const unknown = "0".repeat(64);
      expect(await op("approve", { graph, candidate: unknown })).toEqual({ status: "missing", reason: `no candidate ${unknown} is recorded in graph team/search` });
      expect(await op("decline", { graph, candidate: unknown })).toEqual({ status: "missing", reason: `no candidate ${unknown} is recorded in graph team/search` });
      // Without a notifier the operations work the same.
      const quiet = extension();
      await quiet.op("import", { graph, document: hotpot() });
      await quiet.op("import", { graph, document: expert() });
      expect(await quiet.op("approve", { graph, candidate: expertId() })).toMatchObject({ status: "committed" });
    });

    it("PX2.109 approvals, approve and decline are the approve action, on the graph they name; a refusal throws and nothing is decided", async () => {
      const asked: [ProceduralAction, string][] = [];
      const store = new FakeStore();
      const setup = extension({ store });
      await setup.op("import", { graph, document: hotpot() });
      await setup.op("import", { graph, document: expert() });
      const notices: ApprovalNotice[] = [];
      const { op } = extension({ store, notify: (n) => void notices.push(n), authorize: (action, g) => (asked.push([action, g]), action !== "approve") });
      for (const [name, input] of [["approvals", { graph }], ["approve", { graph, candidate: expertId() }], ["decline", { graph, candidate: expertId() }]] as const) {
        await expect(op(name, input)).rejects.toThrow(`procedural.${name}: approve on graph team/search is not allowed`);
        expect(asked.at(-1)).toEqual(["approve", graph]);
      }
      expect(store.records.get(expertId())?.decision).toEqual({ kind: "pending-approval" });
      expect(notices).toEqual([]);
      await expect(op("import", { graph, document: hotpot() })).resolves.toMatchObject({ status: "known" });
    });

    it("PX2.113 approve and decline name the candidate's graph: the same document waiting in two graphs is decided in the named graph only", async () => {
      const other = GraphIdSchema.parse("team/web");
      const store = new MemoryProceduralStore();
      const { op } = extension({ store });
      for (const g of [graph, other]) {
        await op("import", { graph: g, document: hotpot() });
        expect(await op("import", { graph: g, document: expert() })).toMatchObject({ status: "proposed" });
      }
      expect(await op("approve", { graph: other, candidate: expertId() })).toMatchObject({ status: "committed", graph: other, revision: expertId() });
      expect((await store.heads.get(other))?.revision).toBe(expertId());
      expect((await store.heads.get(graph))?.revision).toBe(revisionId(core()));
      expect((await store.revisions.get(graph, expertId()))?.decision).toEqual({ kind: "pending-approval" });
      expect(await op("decline", { graph, candidate: expertId() })).toEqual({ status: "declined", graph, candidate: expertId() });
      expect((await store.revisions.get(other, expertId()))?.decision.kind).not.toBe("rejected-gate");
      // A candidate of another graph is not recorded under this one.
      expect(await op("approve", { graph: GraphIdSchema.parse("team/none"), candidate: expertId() })).toEqual({ status: "missing", reason: `no candidate ${expertId()} is recorded in graph team/none` });
    });

    it("PX2.110 their malformed input throws, naming the operation", async () => {
      const { op } = extension();
      await expect(op("approvals", {})).rejects.toThrow(/invalid procedural\.approvals input/);
      await expect(op("approve", { graph, candidate: "abc" })).rejects.toThrow(/invalid procedural\.approve input[\s\S]*candidate/);
      await expect(op("decline", { candidate: expertId() })).rejects.toThrow(/invalid procedural\.decline input[\s\S]*graph/);
      await expect(op("decline", { graph, candidate: expertId(), extra: 1 })).rejects.toThrow(/invalid procedural\.decline input/);
    });
  });
});
