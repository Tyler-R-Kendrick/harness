import { readFileSync } from "node:fs";
import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { TaskGraph } from "@harness/core";
import { parsePlanRun, parseSettings, PlanPayloadSchema, runPlan } from "@harness/procedural";
import type { PlanPayload, PlanRunState, PlanTask } from "@harness/procedural";

const file = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")) as Record<string, unknown>;
const settings = (concurrency: number) => parseSettings({ ...structuredClone(file), plans: { concurrency } });

/** A random plan: tasks t0..tn, each depending on some earlier ones by data or control, some failing. */
const plans = fc.integer({ min: 0, max: 7 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    edges: fc.uniqueArray(fc.tuple(fc.nat({ max: Math.max(0, n - 1) }), fc.nat({ max: Math.max(0, n - 1) }), fc.constantFrom("data" as const, "control" as const)), {
      maxLength: 12,
      selector: ([a, b, kind]) => `${Math.min(a, b)}-${Math.max(a, b)}-${kind}`,
    }),
    failing: fc.uniqueArray(fc.nat({ max: Math.max(0, n - 1) }), { maxLength: 2 }),
    concurrency: fc.integer({ min: 1, max: 4 }),
  }),
);

function planOf(n: number, edges: readonly (readonly [number, number, "data" | "control"])[]): TaskGraph<PlanPayload> {
  const plan = new TaskGraph<PlanPayload>();
  for (let i = 0; i < n; i++) plan.addNode(`t${i}`, { payload: PlanPayloadSchema.parse({ node: { id: `t${i}`, type: "ACTION", description: `Task ${i}.` }, binding: null }) });
  for (const [a, b, kind] of edges) if (a !== b) plan.addEdge(`t${Math.min(a, b)}`, `t${Math.max(a, b)}`, kind);
  return plan;
}

/** A deterministic task: its output is its id over its inputs, sorted; the failing ones fail. */
const taskOf =
  (failing: readonly number[]): PlanTask =>
  async ({ id, inputs }) => {
    await Promise.resolve();
    if (failing.includes(Number(id.slice(1)))) return { ok: false, error: `${id} failed` };
    return { ok: true, output: `${id}[${Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${String(v)}`).join(";")}]` };
  };

/** Run to the end, keeping every state saved on the way (as JSON, as a host keeps it). */
async function recorded(run: { plan: TaskGraph<PlanPayload>; outcomes?: PlanRunState["outcomes"] }, task: PlanTask, concurrency: number) {
  const saved: unknown[] = [];
  const result = await runPlan({ ...run, task, settings: settings(concurrency), save: async (state) => void saved.push(JSON.parse(JSON.stringify(state))) });
  return { result, saved };
}

describe("plan run properties", () => {
  test.prop([plans, fc.array(fc.nat(), { minLength: 1, maxLength: 3 })])(
    "PC1.P5 a run's outcome is independent of where it was interrupted and resumed, however many times",
    async ({ n, edges, failing, concurrency }, cuts) => {
      const task = taskOf(failing);
      const whole = await recorded({ plan: planOf(n, edges) }, task, concurrency);
      // Interrupt after some saved state, restore it as a restarted host would, and run on; again, from the resumed run's states.
      let states = whole.saved;
      let last = whole.result;
      for (const cut of cuts) {
        if (states.length === 0) break;
        const resumed = await recorded(parsePlanRun(states[cut % states.length]), task, concurrency);
        states = resumed.saved;
        last = resumed.result;
      }
      expect(last.tasks).toEqual(whole.result.tasks);
      expect(last.status).toBe(whole.result.status);
    },
  );

  test.prop([plans])("PC1.P6 every task ends succeeded, failed or skipped; a task ran only after each of its predecessors succeeded, and was skipped only when one did not", async ({ n, edges, failing, concurrency }) => {
    const plan = planOf(n, edges);
    const { result } = await recorded({ plan }, taskOf(failing), concurrency);
    const status = new Map(result.tasks.map((t) => [t.id, t.status]));
    for (const t of result.tasks) {
      expect(["succeeded", "failed", "skipped"]).toContain(t.status);
      const preds = result.state.plan.edges.filter((e) => e.to === t.id).map((e) => status.get(e.from));
      if (t.status === "skipped") expect(preds.some((s) => s !== "succeeded")).toBe(true);
      else expect(preds.every((s) => s === "succeeded")).toBe(true);
    }
    expect(result.status).toBe(result.tasks.every((t) => t.status === "succeeded") ? "succeeded" : "failed");
  });
});
