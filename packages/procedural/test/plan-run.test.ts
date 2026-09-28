import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TaskGraph } from "@harness/core";
import { coreView, parsePlan, parsePlanRun, parseSettings, planFromSubgraph, PlanPayloadSchema, runPlan } from "@harness/procedural";
import type { PlanPayload, PlanRunState, PlanTask, PlanTaskInput, Settings, TaskOutcome } from "@harness/procedural";
import { chainDoc, graphOf } from "./compose-fixtures.ts";

const file = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")) as Record<string, unknown>;
const settings = (concurrency = 4): Settings => parseSettings({ ...structuredClone(file), plans: { concurrency } });

const payload = (id: string): PlanPayload => PlanPayloadSchema.parse({ node: { id, type: "ACTION", description: `${id}.` }, binding: null });

/** A plan of tasks `ids` with dependencies `a -kind-> b`. */
function planOf(ids: readonly string[], edges: readonly (readonly [string, string, "data" | "control"])[]): TaskGraph<PlanPayload> {
  const plan = new TaskGraph<PlanPayload>();
  for (const id of ids) plan.addNode(id, { payload: payload(id) });
  for (const [from, to, kind] of edges) plan.addEdge(from, to, kind);
  return plan;
}

/** A task that succeeds with `<id>(<inputs>)`, recording what it was given. */
function echo(log: PlanTaskInput[] = [], fail: readonly string[] = []): PlanTask {
  return async (input) => {
    log.push(input);
    return fail.includes(input.id) ? { ok: false, error: `${input.id} broke` } : { ok: true, output: `${input.id}(${Object.values(input.inputs).join(",")})` };
  };
}

/** A diamond: a feeds b (data) and orders c (control); b and c both lead to d (data from b, control from c). */
const diamond = () =>
  planOf(
    ["a", "b", "c", "d"],
    [
      ["a", "b", "data"],
      ["a", "c", "control"],
      ["b", "d", "data"],
      ["c", "d", "control"],
    ],
  );

describe("running plans (runPlan)", () => {
  it("PC1.55 runs every task once in dependency order, each given the outputs of its data predecessors (not its control ones), and reports each task's outcome in plan order", async () => {
    const log: PlanTaskInput[] = [];
    const result = await runPlan({ plan: diamond(), task: echo(log), settings: settings() });
    expect(log.map((t) => t.id)).toEqual(["a", "b", "c", "d"]);
    expect(log.map((t) => t.inputs)).toEqual([{}, { a: "a()" }, {}, { b: "b(a())" }]);
    expect(log[0]!.payload).toStrictEqual(payload("a"));
    expect(result.status).toBe("succeeded");
    expect(result.tasks).toEqual([
      { id: "a", status: "succeeded", output: "a()" },
      { id: "b", status: "succeeded", output: "b(a())" },
      { id: "c", status: "succeeded", output: "c()" },
      { id: "d", status: "succeeded", output: "d(b(a()))" },
    ]);
    expect(await runPlan({ plan: planOf([], []), task: echo(), settings: settings() })).toMatchObject({ status: "succeeded", tasks: [] });
  });

  it("PC1.56 a task that fails, or throws, fails; what depends on it is skipped by the task graph's rules, and the run fails", async () => {
    const result = await runPlan({ plan: diamond(), task: echo([], ["b"]), settings: settings() });
    expect(result.status).toBe("failed");
    expect(result.tasks).toEqual([
      { id: "a", status: "succeeded", output: "a()" },
      { id: "b", status: "failed", error: "b broke" },
      { id: "c", status: "succeeded", output: "c()" },
      { id: "d", status: "skipped" },
    ]);
    const throwing: PlanTask = async (input) => {
      if (input.id === "c") throw new Error("c exploded");
      if (input.id === "b") throw "b gave up";
      return { ok: true, output: input.id };
    };
    expect((await runPlan({ plan: diamond(), task: throwing, settings: settings() })).tasks).toEqual([
      { id: "a", status: "succeeded", output: "a" },
      { id: "b", status: "failed", error: "b gave up" },
      { id: "c", status: "failed", error: "c exploded" },
      { id: "d", status: "skipped" },
    ]);
  });

  it("PC1.57 at most the settings' concurrency of tasks run at once; independent tasks run side by side up to it", async () => {
    const peak = async (concurrency: number) => {
      let running = 0;
      let most = 0;
      const task: PlanTask = async (input) => {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 2));
        running--;
        return { ok: true, output: input.id };
      };
      const result = await runPlan({ plan: planOf(["a", "b", "c", "d", "e"], []), task, settings: settings(concurrency) });
      expect(result.status).toBe("succeeded");
      return most;
    };
    expect(await peak(1)).toBe(1);
    expect(await peak(2)).toBe(2);
    expect(await peak(4)).toBe(4);
    expect(await peak(9)).toBe(5);
  });

  it("PC1.58 save is given the run's state after each change, a task started and a task finished, in order; each state parses back", async () => {
    const saved: PlanRunState[] = [];
    await runPlan({ plan: planOf(["a", "b"], [["a", "b", "data"]]), task: echo(), settings: settings(), save: async (state) => void saved.push(structuredClone(state)) });
    const statuses = saved.map((s) => s.plan.nodes.map((n) => n.status).join(","));
    expect(statuses).toEqual(["running,pending", "succeeded,pending", "succeeded,running", "succeeded,succeeded"]);
    expect(saved.map((s) => s.outcomes)).toEqual([{}, { a: { ok: true, output: "a()" } }, { a: { ok: true, output: "a()" } }, { a: { ok: true, output: "a()" }, b: { ok: true, output: "b(a())" } }]);
    for (const state of saved) expect(parsePlanRun(JSON.parse(JSON.stringify(state))).plan.toJSON()).toEqual(state.plan);
  });

  it("PC1.59 a save that fails stops the run: runPlan rejects with its error and starts nothing more", async () => {
    const log: PlanTaskInput[] = [];
    let saves = 0;
    const save = async () => {
      if (++saves === 2) throw new Error("disk full");
    };
    await expect(runPlan({ plan: planOf(["a", "b"], [["a", "b", "control"]]), task: echo(log), settings: settings(), save })).rejects.toThrow("disk full");
    expect(log.map((t) => t.id)).toEqual(["a"]);
    // A task still running when a save fails finishes unsaved: nothing is saved after the failure.
    let calls = 0;
    let slowDone!: () => void;
    const finished = new Promise<void>((r) => (slowDone = r));
    const task: PlanTask = async (input) => {
      if (input.id === "slow") {
        await new Promise((r) => setTimeout(r, 5));
        slowDone();
      }
      return { ok: true, output: input.id };
    };
    const failing = async () => {
      if (++calls === 3) throw new Error("disk full");
    };
    await expect(runPlan({ plan: planOf(["fast", "slow"], []), task, settings: settings(2), save: failing })).rejects.toThrow("disk full");
    await finished;
    await new Promise((r) => setTimeout(r, 1));
    expect(calls).toBe(3);
  });

  it("PC1.60 a restored run continues from its statuses: finished tasks are not run again and their outputs feed their dependents; a task restored as running runs again", async () => {
    const saved: PlanRunState[] = [];
    await runPlan({ plan: diamond(), task: echo(), settings: settings(1), save: async (state) => void saved.push(structuredClone(state)) });
    // After b started: a finished, b running.
    const midway = saved.find((s) => s.plan.nodes[1]!.status === "running")!;
    const restored = parsePlanRun(JSON.parse(JSON.stringify(midway)));
    const log: PlanTaskInput[] = [];
    const result = await runPlan({ ...restored, task: echo(log), settings: settings(1) });
    expect(log.map((t) => [t.id, t.inputs])).toEqual([
      ["b", { a: "a()" }],
      ["c", {}],
      ["d", { b: "b(a())" }],
    ]);
    expect(result.tasks.map((t) => t.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    // A plan restored by parsePlan alone runs too; outputs of tasks it has no outcome for are not known, so not given.
    const bare = parsePlan(midway.plan);
    const log2: PlanTaskInput[] = [];
    expect((await runPlan({ plan: bare, task: echo(log2), settings: settings() })).tasks[0]).toEqual({ id: "a", status: "succeeded" });
    expect(log2.map((t) => [t.id, t.inputs])).toEqual([
      ["b", {}],
      ["c", {}],
      ["d", { b: "b()" }],
    ]);
  });

  it("PC1.61 parsePlanRun refuses a state whose outcomes disagree with its plan's statuses", () => {
    const plan = planOf(["a", "b"], [["a", "b", "data"]]);
    plan.start("a");
    plan.complete("a", "succeeded");
    const state = (outcomes: Record<string, TaskOutcome>): unknown => JSON.parse(JSON.stringify({ plan: plan.toJSON(), outcomes }));
    expect(parsePlanRun(state({ a: { ok: true, output: 1 } })).outcomes).toEqual({ a: { ok: true, output: 1 } });
    expect(() => parsePlanRun(state({}))).toThrow("task a succeeded but has no outcome");
    expect(() => parsePlanRun(state({ a: { ok: false, error: "no" } }))).toThrow("task a succeeded but its outcome is a failure");
    expect(() => parsePlanRun(state({ a: { ok: true, output: 1 }, b: { ok: true, output: 2 } }))).toThrow("task b is pending but has an outcome");
    expect(() => parsePlanRun(state({ a: { ok: true, output: 1 }, z: { ok: true, output: 2 } }))).toThrow("task z is not in the plan");
    expect(() => parsePlanRun({ plan: plan.toJSON(), outcomes: { a: { ok: "yes" } } })).toThrow(/invalid plan run[\s\S]*outcomes\.a/);
    expect(() => parsePlanRun({ outcomes: {} })).toThrow(/invalid plan run[\s\S]*at plan/);
    expect(() => parsePlanRun({ plan: {}, outcomes: {} })).toThrow(/invalid task graph data/);
    const failed = planOf(["a"], []);
    failed.start("a");
    failed.complete("a", "failed");
    expect(() => parsePlanRun({ plan: failed.toJSON(), outcomes: { a: { ok: true, output: 1 } } })).toThrow("task a failed but its outcome is a success");
    expect(() => parsePlanRun({ plan: failed.toJSON(), outcomes: {} })).toThrow("task a failed but has no outcome");
  });

  it("PC1.62 a plan from a subgraph runs: the chain's tasks in order, the fetch given the search's output", async () => {
    const built = planFromSubgraph(coreView(graphOf(chainDoc())), "Start", "End");
    if (!built.ok) throw new Error("fixture");
    const log: PlanTaskInput[] = [];
    const result = await runPlan({ plan: built.plan, task: echo(log), settings: settings() });
    expect(log.map((t) => t.id)).toEqual(["search", "Fetch_Page", "summarize", "review"]);
    expect(log[1]).toMatchObject({ inputs: { search: "search()" }, payload: { binding: { kind: "tool", name: "fetch" } } });
    expect(result.status).toBe("succeeded");
  });
});
