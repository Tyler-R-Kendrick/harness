/**
 * Dream's `Evaluator` port (plan §7.4, §10): a contract every evaluator must keep, and a
 * scripted environment that keeps it, so dream runs Algorithm 1 against a task set with
 * no model and no benchmark.
 */
import { describe, expect, it } from "vitest";
import { RolloutResultSchema } from "@harness/procedural";
import type { Evaluator, ProceduralGraph, RolloutResult } from "@harness/procedural";

/** A scripted task: its query, and the route of node names a graph must hold, edge by edge, in order. */
export interface ScriptedTask {
  readonly id: string;
  readonly query: string;
  readonly route: readonly string[];
}

/**
 * A deterministic environment of tasks with known routes. A graph scores a task by the
 * share of the route's consecutive pairs it has as edges (1 for a route of one node the
 * graph has); a training rollout also returns the query and, for each pair it walks,
 * the call of the pair's target and that call's observation, as a solver guided by the
 * graph would have made them.
 */
export class ScriptedEnvironment implements Evaluator {
  readonly #train: readonly ScriptedTask[];
  readonly #validation: readonly ScriptedTask[];
  /** Each evaluation, in order: the split and the task ids. */
  readonly calls: { split: "train" | "validation"; tasks: string[] }[] = [];

  constructor(tasks: { train: readonly ScriptedTask[]; validation: readonly ScriptedTask[] }) {
    this.#train = tasks.train;
    this.#validation = tasks.validation;
  }

  async tasks(split: "train" | "validation"): Promise<readonly string[]> {
    return this.#of(split).map((t) => t.id);
  }

  async evaluate(graph: ProceduralGraph, split: "train" | "validation", batch?: readonly string[]): Promise<readonly RolloutResult[]> {
    const all = this.#of(split);
    const tasks = batch === undefined ? all : batch.map((id) => all.find((t) => t.id === id) ?? unknown(id, split));
    this.calls.push({ split, tasks: tasks.map((t) => t.id) });
    return tasks.map((task) => {
      const walked = pairs(task.route).filter(([from, to]) => graph.edges.some((e) => e.from === from && e.to === to));
      const score = task.route.length === 1 ? Number(graph.nodes.some((n) => n.id === task.route[0])) : walked.length / pairs(task.route).length;
      if (split === "validation") return { task: task.id, score };
      const steps = walked.flatMap(([, to]) => [
        { role: "assistant" as const, content: "", call: { name: to, arguments: {} } },
        { role: "tool" as const, content: `${to} done` },
      ]);
      return { task: task.id, score, query: task.query, steps };
    });
  }

  #of(split: "train" | "validation"): readonly ScriptedTask[] {
    return split === "train" ? this.#train : this.#validation;
  }
}

const pairs = (route: readonly string[]): [string, string][] => route.slice(1).map((to, i) => [route[i]!, to]);
const unknown = (id: string, split: string): never => {
  throw new RangeError(`no ${split} task ${id}`);
};

export interface EvaluatorFixture {
  readonly evaluator: Evaluator;
  /** Graphs to evaluate, at least two that score differently on some task. */
  readonly graphs: readonly ProceduralGraph[];
}

/** The contract of dream's `Evaluator`: stable task lists, one score in [0, 1] per task asked, replayable results, graphs left as they are. */
export function evaluatorContract(name: string, make: () => EvaluatorFixture): void {
  describe(`Evaluator contract: ${name}`, () => {
    it("PD3.1 the task lists are stable, with no duplicates, and there are validation tasks", async () => {
      const { evaluator } = make();
      for (const split of ["train", "validation"] as const) {
        const tasks = await evaluator.tasks(split);
        expect(await evaluator.tasks(split)).toEqual(tasks);
        expect(new Set(tasks).size).toBe(tasks.length);
      }
      expect((await evaluator.tasks("validation")).length).toBeGreaterThan(0);
    });

    it("PD3.2 validation scores every validation task once, in order, each in [0, 1]", async () => {
      const { evaluator, graphs } = make();
      const tasks = await evaluator.tasks("validation");
      for (const g of graphs) {
        const results = await evaluator.evaluate(g, "validation");
        expect(results.map((r) => r.task)).toEqual([...tasks]);
        for (const r of results) expect(RolloutResultSchema.parse(r)).toEqual(r);
      }
    });

    it("PD3.3 a training rollout scores exactly the batch asked, in order (every training task without one)", async () => {
      const { evaluator, graphs } = make();
      const train = await evaluator.tasks("train");
      const g = graphs[0]!;
      expect((await evaluator.evaluate(g, "train")).map((r) => r.task)).toEqual([...train]);
      const batch = [...train].reverse().slice(0, 2);
      const results = await evaluator.evaluate(g, "train", batch);
      expect(results.map((r) => r.task)).toEqual(batch);
      for (const r of results) expect(RolloutResultSchema.parse(r)).toEqual(r);
    });

    it("PD3.4 results are replayable: the same graph scores the same, and graphs are not changed", async () => {
      const { evaluator, graphs } = make();
      for (const g of graphs) {
        const before = JSON.stringify(g);
        const first = await evaluator.evaluate(g, "validation");
        expect(await evaluator.evaluate(g, "validation")).toEqual(first);
        expect(JSON.stringify(g)).toBe(before);
      }
      const [a, b] = await Promise.all(graphs.slice(0, 2).map((g) => evaluator.evaluate(g, "validation")));
      expect(a).not.toEqual(b);
    });
  });
}
