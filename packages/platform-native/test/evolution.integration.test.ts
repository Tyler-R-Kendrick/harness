import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Evolution, parseSettings, StateSchema } from "@harness/evolution";
import { probability } from "@harness/cognitive";
import { scriptedJudge, SeededEntropy } from "@harness/testkit";
import { buildSplit, buildSurface, commandEvaluator, loadEvolutionConfig, parseEvolutionConfig, parseTaskRuns, readDocuments } from "../src/evolution-config.ts";
import type { EvolutionConfig } from "../src/evolution-config.ts";
import { evolutionCommand } from "../src/evolution-command.ts";
import { BASE, proposer, scenario, SETTINGS, truth } from "./evolution-world.ts";

const SIM = new URL("./fixtures/sim-evaluator.ts", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "evo-int-"));
  dirs.push(d);
  return d;
};

/** An evaluator command running a node script inline. */
const inline = (script: string, options: Partial<EvolutionConfig["evaluator"]> = {}) => {
  const dir = tmp();
  const config = parseEvolutionConfig({
    documents: { a: { path: "a.json" } },
    components: ["prompt", "config"],
    tasks: { evolve: [{ id: "t1", text: "x" }] },
    evaluator: { command: [process.execPath, "-e", script], ...options },
  });
  return commandEvaluator({ config, dir });
};
const tasks = [{ id: "t1", text: "x" }];

describe("the evaluator command, as a real child process", () => {
  it("EH9.1 receives {documents, tasks, k} as JSON on stdin and its stdout is parsed into task runs", async () => {
    const evaluate = inline(`
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const { documents, tasks, k } = JSON.parse(s);
        process.stdout.write(JSON.stringify(tasks.map((t) => ({ task: t.id, weight: 2, trials: Array.from({ length: k }, () => ({ reward: documents.a.reward, tokens: 10, feedback: "echo" })) }))));
      });`);
    const runs = await evaluate({ a: { reward: 0.5 } }, tasks, 2);
    expect(runs).toEqual([{ task: "t1", weight: 2, trials: [{ reward: 0.5, tokens: 10, feedback: "echo" }, { reward: 0.5, tokens: 10, feedback: "echo" }] }]);
  });

  it("EH9.2 a command that exits badly fails the evaluation with its exit code and stderr; one that cannot start says so", async () => {
    await expect(inline(`console.error("suite is down"); process.exit(3)`)({}, tasks, 1)).rejects.toThrow(/the evaluator exited with code 3: suite is down/);
    await expect(inline(`process.kill(process.pid, "SIGKILL")`)({}, tasks, 1)).rejects.toThrow(/the evaluator exited with signal SIGKILL/);
    const dir = tmp();
    const config = parseEvolutionConfig({ documents: { a: { path: "a.json" } }, components: ["prompt"], tasks: { evolve: [{ id: "t1", text: "x" }] }, evaluator: { command: ["/no/such/evaluator"] } });
    await expect(commandEvaluator({ config, dir })({}, tasks, 1)).rejects.toThrow(/cannot start the evaluator \/no\/such\/evaluator/);
  });

  it("EH9.3 a command that takes longer than its limit is stopped and the evaluation fails", async () => {
    await expect(inline(`setTimeout(() => {}, 60000)`, { timeoutMs: 200 })({}, tasks, 1)).rejects.toThrow(/took longer than 200 ms and was stopped/);
  });

  it("EH9.4 output that is not task runs is refused, saying what is wrong with it", async () => {
    await expect(inline(`process.stdout.write("hello")`)({}, tasks, 1)).rejects.toThrow(/the evaluator's output is not JSON/);
    await expect(inline(`process.stdout.write(JSON.stringify([{ task: "t1", trials: [{ reward: 1.5 }] }]))`)({}, tasks, 1)).rejects.toThrow(/not a list of task runs[\s\S]*trials\[0\]\.reward/);
    expect(() => parseTaskRuns(JSON.stringify([{ task: "t1", trials: [{ reward: 1, cost: 3 }] }]))).toThrow(/cost/);
    expect(() => parseTaskRuns(JSON.stringify([{ task: "t1", weight: 0, trials: [] }]))).toThrow(/weight/);
    expect(parseTaskRuns("[]")).toEqual([]);
  });

  it("EH9.5 at most `concurrency` evaluations run at once; the rest wait their turn", async () => {
    const script = `setTimeout(() => process.stdout.write("[]"), 300)`;
    const measure = async (concurrency: number) => {
      const evaluate = inline(script, { concurrency });
      const start = Date.now();
      await Promise.all([1, 2, 3, 4].map(() => evaluate({}, tasks, 1)));
      return Date.now() - start;
    };
    // Four evaluations of 300 ms in waves of two take two waves; a wave of four takes one.
    expect(await measure(2)).toBeGreaterThanOrEqual(590);
    expect(await measure(1)).toBeGreaterThanOrEqual(1190);
  });

  it("EH9.6 the command runs in the config's directory, or in the cwd it names", async () => {
    const dir = tmp();
    const where = (cwd?: string) =>
      commandEvaluator({
        config: parseEvolutionConfig({ documents: { a: { path: "a.json" } }, components: ["prompt"], tasks: { evolve: [{ id: "t1", text: "x" }] }, evaluator: { command: [process.execPath, "-e", `process.stdout.write(JSON.stringify([{ task: process.cwd(), trials: [] }]))`], ...(cwd === undefined ? {} : { cwd }) } }),
        dir,
      })({}, tasks, 1);
    mkdirSync(join(dir, "sub"));
    expect((await where())[0]!.task).toBe(realpathSync(dir));
    expect((await where("sub"))[0]!.task).toBe(realpathSync(join(dir, "sub")));
  });
});

describe("a full run against a real suite", () => {
  it("EH10.1 runs to the end with a holdout, accepts the real gain (a gain the child-process evaluator's suite really has), and the run restores from its state file", async () => {
    const s = scenario(tmp(), { holdout: 12, evaluator: [process.execPath, SIM] });
    const p = proposer();
    let out = "";
    let err = "";
    const judge = scriptedJudge(() => ({ type: "boolean", probability: probability(0.1) }));
    const started = Date.now();
    const code = await evolutionCommand(["run", "--config", s.config, "--model", "proposer", "--critic-model", "unused"], { stdout: (t) => void (out += t), stderr: (t) => void (err += t) }, {
      languageModel: () => p.model,
      // The critic is asked once per proposal; nothing in these edits is specific to a task.
      evaluationModel: () => judge,
      entropy: new SeededEntropy(3),
    });
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(out).toMatch(/round 1 of 3: accepted A/);
    expect(out).toMatch(/the run is over: 3 rounds/);

    // The state file restores an Evolution holding the accepted mechanism, and its documents have the real effect.
    const file = JSON.parse(readFileSync(s.state, "utf8")) as { base: unknown; evolution: unknown };
    const config = loadEvolutionConfig(s.config);
    const restored = new Evolution({ surface: buildSurface(config), settings: parseSettings(SETTINGS), split: buildSplit(config), saved: file.evolution });
    expect(restored.completed).toBe(3);
    expect(restored.done).toBe(true);
    expect(restored.mechanisms.map((m) => m.id)).toEqual(["r0A.e1"]);
    expect(restored.documents["policy"]).toEqual({ rules: { verify: true }, prompt: { system: "Work carefully." } });
    expect(truth(restored.documents)).toBeGreaterThan(truth(file.base as Record<string, unknown>) + 0.4);
    const state = StateSchema.parse(restored.save());
    expect(state.base.score).toBeLessThan(0.55);
    expect(state.base.score).toBeGreaterThan(BASE - 0.25);
    expect(state.holdout?.state.queries).toBeGreaterThanOrEqual(1);
    const accepted = restored.records.filter((r) => r.outcome === "accepted");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.measured).toMatchObject({ verdict: "supported", holdout: { exhausted: false } });
    expect(accepted[0]!.measured!.lower).toBeGreaterThan(0);

    // Status reads it back; `documents --write` puts the incumbent's documents in the file, which still satisfies its schema.
    const status = await evolutionCommand(["status", "--config", s.config], { stdout: (t) => void (out += t), stderr: () => {} });
    expect(status).toBe(0);
    expect(out).toContain(`round 3 of 3 (over)`);
    expect(await evolutionCommand(["documents", "--config", s.config, "--write"], { stdout: () => {}, stderr: () => {} })).toBe(0);
    expect(readDocuments(loadEvolutionConfig(s.config))).toEqual(restored.documents);

    expect(judge.requests.length).toBeGreaterThanOrEqual(3);
    // Resuming a finished run measures nothing.
    const evaluator = async () => Promise.reject(new Error("measured"));
    expect(await evolutionCommand(["run", "--config", s.config, "--model", "proposer"], { stdout: () => {}, stderr: () => {} }, { languageModel: () => p.model, evaluate: evaluator })).toBe(0);
  });
});
