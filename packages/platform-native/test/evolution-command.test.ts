import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyProposal, Evolution, parseSettings, ProposalSchema, StateSchema } from "@harness/evolution";
import { probability } from "@harness/cognitive";
import { scriptedJudge, scriptedModel, SeededEntropy } from "@harness/testkit";
import { buildSplit, buildSurface, loadEvolutionConfig, readDocuments } from "../src/evolution-config.ts";
import { evolutionCommand } from "../src/evolution-command.ts";
import type { EvolutionDeps } from "../src/evolution-command.ts";
import { enable, proposer, scenario, SETTINGS, simulate, truth } from "./evolution-world.ts";
import type { EvaluatorInput, Scenario } from "./evolution-world.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "evo-"));
  dirs.push(d);
  return d;
};

/** The evaluate port on the simulated suite, in this process. */
const evaluate: NonNullable<EvolutionDeps["evaluate"]> = async (documents, tasks, k) => simulate({ documents, tasks, k } as EvaluatorInput) as never;

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function cli(args: readonly string[], deps: EvolutionDeps = {}): Promise<Result> {
  let out = "";
  let err = "";
  const code = await evolutionCommand(args, { stdout: (s) => void (out += s), stderr: (s) => void (err += s) }, { evaluate, entropy: new SeededEntropy(7), ...deps });
  return { code, out, err };
}

const read = (path: string) => readFileSync(path, "utf8");
const readState = (s: Scenario) => StateSchema.parse((JSON.parse(read(s.state)) as { evolution: unknown }).evolution);

describe("harness-evolution start, round and run", () => {
  it("EH4.1 start measures the base harness on the evolve tasks and the holdout, and saves a run in the state file", async () => {
    const s = scenario(tmp(), { holdout: 8 });
    const r = await cli(["start", "--config", s.config]);
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(r.out).toMatch(/measuring the base harness: 24 evolve tasks and 8 holdout tasks, 2 trials each/);
    expect(r.out).toMatch(/base score 0\.\d{4}, 1000 tokens a trial; on the holdout 0\.\d{4}/);
    expect(r.out).toContain(`run started in ${s.state}: 3 rounds`);
    const state = readState(s);
    expect(state.round).toBe(0);
    expect(state.holdout?.incumbent).toBeDefined();
    expect((JSON.parse(read(s.state)) as { base: unknown }).base).toEqual({ policy: { rules: {}, prompt: { system: "Work carefully." } } });
  });

  it("EH4.2 start does not discard a run in progress unless --force, and says so", async () => {
    const s = scenario(tmp());
    await cli(["start", "--config", s.config]);
    const before = read(s.state);
    const again = await cli(["start", "--config", s.config]);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/holds a run: `run` continues it, `start --force` begins again/);
    expect(read(s.state)).toBe(before);
    expect(await cli(["start", "--config", s.config, "--force"])).toMatchObject({ code: 0 });
  });

  it("EH4.3 round runs one round on the proposer's model and saves it; a real gain is accepted", async () => {
    const s = scenario(tmp(), { holdout: 8 });
    await cli(["start", "--config", s.config]);
    const asked: string[] = [];
    const p = proposer();
    const r = await cli(["round", "--config", s.config, "--model", "some/proposer"], { languageModel: (id) => (asked.push(id), p.model) });
    expect(r.code).toBe(0);
    expect(asked).toEqual(["some/proposer"]);
    expect(r.out).toMatch(/round 1 of 3: accepted A \(edit budget 1, test level 0\.0\d+\)/);
    expect(r.out).toMatch(/0A change accepted\s+gain \+0\.\d{4} \[\+0\.\d{4}, \+0\.\d{4}\] supported: /);
    expect(r.out).toContain("1 of 3 rounds done");
    const state = readState(s);
    expect(state.round).toBe(1);
    expect(state.documents["policy"]).toEqual({ rules: { verify: true }, prompt: { system: "Work carefully." } });
    expect(state.mechanisms.map((m) => m.id)).toEqual(["r0A.e1"]);
  });

  it("EH4.4 run starts a run when there is none, goes on to the end, and only reports when it is run again", async () => {
    const s = scenario(tmp(), { holdout: 8 });
    const p = proposer();
    const r = await cli(["run", "--config", s.config, "--model", "m"], { languageModel: () => p.model });
    expect(r.code).toBe(0);
    expect(r.out).toContain("run started in");
    expect(r.out.match(/^round \d of 3:/gm)).toHaveLength(3);
    expect(r.out).toMatch(/the run is over: 3 rounds; `documents` compares/);
    expect(readState(s).round).toBe(3);
    const calls = p.calls();
    const again = await cli(["run", "--config", s.config, "--model", "m"], { languageModel: () => p.model });
    expect(again).toMatchObject({ code: 0, out: "the run is over: 3 of 3 rounds\n" });
    expect(p.calls()).toBe(calls);
    expect(await cli(["round", "--config", s.config, "--model", "m"], { languageModel: () => p.model })).toMatchObject({ code: 1, err: "the run is over: 3 rounds\n" });
  });

  it("EH4.5 --max-rounds stops a run early; the next run resumes where it stopped", async () => {
    const s = scenario(tmp());
    const p = proposer();
    const deps = { languageModel: () => p.model };
    const first = await cli(["run", "--config", s.config, "--model", "m", "--max-rounds", "1"], deps);
    expect(first.out).toContain("1 of 3 rounds done");
    expect(readState(s).round).toBe(1);
    const second = await cli(["run", "--config", s.config, "--model", "m"], deps);
    expect(second.out.match(/^round \d of 3:/gm)).toEqual(["round 2 of 3:", "round 3 of 3:"]);
    expect(readState(s).round).toBe(3);
  });

  it("EH4.6 a round that fails leaves the state file as it was, says how to resume, and the next command resumes at the same round", async () => {
    const s = scenario(tmp());
    const p = proposer();
    await cli(["round", "--config", s.config, "--model", "m"], { languageModel: () => p.model }).then((r) => expect(r.code).toBe(1));
    await cli(["start", "--config", s.config]);
    await cli(["round", "--config", s.config, "--model", "m"], { languageModel: () => p.model });
    const before = read(s.state);
    let calls = 0;
    const flaky: NonNullable<EvolutionDeps["evaluate"]> = async (documents, tasks, k) => {
      if (++calls === 2) throw new Error("the suite is unreachable");
      return evaluate(documents, tasks, k);
    };
    const failed = await cli(["run", "--config", s.config, "--model", "m"], { languageModel: () => p.model, evaluate: flaky });
    expect(failed.code).toBe(1);
    expect(failed.err).toMatch(/round 1 failed: the suite is unreachable\nthe run is unchanged at 1 of 3 rounds; run the command again to resume/);
    expect(read(s.state)).toBe(before);
    const resumed = await cli(["run", "--config", s.config, "--model", "m"], { languageModel: () => p.model });
    expect(resumed).toMatchObject({ code: 0, err: "" });
    expect(resumed.out.match(/^round \d of 3:/gm)).toEqual(["round 2 of 3:", "round 3 of 3:"]);
    expect(readState(s).round).toBe(3);
  });

  it("EH4.7 a failing base measurement saves nothing", async () => {
    const s = scenario(tmp());
    const down = await cli(["start", "--config", s.config], { evaluate: async () => Promise.reject(new Error("no evaluator")) });
    expect(down).toMatchObject({ code: 1, err: "no evaluator\n" });
    expect(await cli(["status", "--config", s.config])).toMatchObject({ code: 1, err: expect.stringMatching(/no run in .*: `start` one first/) as string });
  });

  it("EH4.8 --critic-model gives the round a critic on the judge model named; a refused proposal is screened with the critic's reason", async () => {
    const s = scenario(tmp());
    await cli(["start", "--config", s.config]);
    const asked: string[] = [];
    const judge = scriptedJudge(() => ({ type: "boolean", probability: probability(0.9) }));
    const p = proposer();
    const r = await cli(["round", "--config", s.config, "--model", "m", "--critic-model", "other/judge"], { languageModel: () => p.model, evaluationModel: (id) => (asked.push(id), judge) });
    expect(r.code).toBe(0);
    expect(asked).toEqual(["other/judge"]);
    expect(judge.requests.length).toBeGreaterThan(0);
    expect(r.out).toMatch(/0A change screened: critic: it reads as specific to the evolve tasks \(p = 0\.90\)/);
    expect(r.out).toContain("nothing accepted");
    expect(readState(s).documents["policy"]).toEqual({ rules: {}, prompt: { system: "Work carefully." } });
  });

  it("EH4.9 the run's tasks must be the tasks it was measured on", async () => {
    const s = scenario(tmp());
    await cli(["start", "--config", s.config]);
    const config = JSON.parse(read(s.config)) as { tasks: { evolve: unknown[] } };
    config.tasks.evolve.pop();
    writeFileSync(s.config, JSON.stringify(config));
    const r = await cli(["status", "--config", s.config]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/the tasks in the config are not the tasks .* was measured on; use another --state, or start again with --force/);
    expect(await cli(["start", "--config", s.config, "--force"])).toMatchObject({ code: 0 });
  });

  it("EH4.11 by default the proposer and the critic are AI Gateway models: without a credential the round fails, or the proposal is refused by a critic that cannot judge, and nothing is saved", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    const s = scenario(tmp());
    await cli(["start", "--config", s.config]);
    const before = read(s.state);
    const noModel = await cli(["round", "--config", s.config, "--model", "openai/gpt-oss-20b"]);
    expect(noModel.code).toBe(1);
    expect(noModel.err).toMatch(/round 0 failed: [\s\S]*Unauthenticated request to AI Gateway[\s\S]*the run is unchanged at 0 of 3 rounds/);
    expect(read(s.state)).toBe(before);
    const p = proposer();
    const noJudge = await cli(["round", "--config", s.config, "--model", "m", "--critic-model", "openai/gpt-oss-20b"], { languageModel: () => p.model });
    expect(noJudge.code).toBe(0);
    expect(noJudge.out).toMatch(/0A change screened: critic: the critic could not judge it: /);
  });

  it("EH4.10 --settings replaces the config's settings file, and the config's settings replace the shipped ones; --state and the config's state say where the run lives", async () => {
    const dir = tmp();
    const s = scenario(dir, { config: { state: "sub/mine.json" } });
    writeFileSync(join(dir, "short.json"), JSON.stringify({ ...SETTINGS, rounds: 1 }));
    expect((await cli(["start", "--config", s.config, "--settings", join(dir, "short.json")])).out).toContain(`run started in ${join(dir, "sub/mine.json")}: 1 rounds`);
    const elsewhere = join(dir, "elsewhere.json");
    expect((await cli(["start", "--config", s.config, "--state", elsewhere])).out).toContain(`run started in ${elsewhere}: 3 rounds`);
    const shipped = scenario(tmp(), { config: { settings: undefined } });
    const config = JSON.parse(read(shipped.config)) as Record<string, unknown>;
    delete config["settings"];
    writeFileSync(shipped.config, JSON.stringify(config));
    expect((await cli(["start", "--config", shipped.config])).out).toContain(`run started in ${shipped.state}: 20 rounds`);
  });
});

describe("harness-evolution status", () => {
  it("EH5.1 status reports the round, the incumbent's score against the base, the holdout's budget, the mechanisms and the last records", async () => {
    const s = scenario(tmp(), { holdout: 8 });
    const p = proposer();
    await cli(["run", "--config", s.config, "--model", "m"], { languageModel: () => p.model });
    const r = await cli(["status", "--config", s.config]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`run ${s.state}: round 3 of 3 (over)`);
    expect(r.out).toMatch(/base score 0\.\d{4}; incumbent 0\.\d{4} \(\+0\.\d{4}\)/);
    expect(r.out).toMatch(/holdout: \d of 2 overfitting answers left after \d queries/);
    expect(r.out).toMatch(/mechanisms: 1\n {2}r0A\.e1 \(round 0, lower bound \+0\.\d{4}\) \[config\]: verify helps/);
    expect(r.out).toContain("last 3 records:");
    expect(r.out).toMatch(/0A change accepted/);
    expect((await cli(["status", "--config", s.config, "--last", "1"])).out).toContain("last 1 records:");
  });
});

describe("harness-evolution documents", () => {
  async function finished() {
    const s = scenario(tmp(), { holdout: 8 });
    const p = proposer();
    await cli(["run", "--config", s.config, "--model", "m"], { languageModel: () => p.model });
    return s;
  }

  it("EH6.1 documents compares the incumbent's documents with their files and writes nothing unless asked", async () => {
    const s = await finished();
    const before = read(s.policy);
    const r = await cli(["documents", "--config", s.config]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`policy (${s.policy}): differs: the incumbent's would replace the file`);
    expect(r.out).toContain("nothing was written; --write replaces the files that differ");
    expect(read(s.policy)).toBe(before);
  });

  it("EH6.2 --write replaces the files that still hold what the run started from; then there is nothing to write", async () => {
    const s = await finished();
    const r = await cli(["documents", "--config", s.config, "--write"]);
    expect(r.out).toContain(`wrote ${s.policy}`);
    expect(JSON.parse(read(s.policy))).toEqual({ rules: { verify: true }, prompt: { system: "Work carefully." } });
    expect(read(s.policy)).toBe(`${JSON.stringify({ rules: { verify: true }, prompt: { system: "Work carefully." } }, null, 2)}\n`);
    const again = await cli(["documents", "--config", s.config, "--write"]);
    expect(again.out).toContain("policy (" + s.policy + "): the file holds the incumbent's");
    expect(again.out).toContain("nothing to write");
  });

  it("EH6.3 --write refuses, writing nothing, a file that changed since the run started; --force replaces it anyway", async () => {
    const s = await finished();
    const edited = `${JSON.stringify({ rules: { mine: true }, prompt: { system: "Edited by hand." } })}\n`;
    writeFileSync(s.policy, edited);
    const refused = await cli(["documents", "--config", s.config, "--write"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toBe(`nothing was written: ${s.policy} changed since the run started; --force replaces it anyway\n`);
    expect(refused.out).toContain("differs, and the file is not what the run started from");
    expect(read(s.policy)).toBe(edited);
    expect(await cli(["documents", "--config", s.config, "--write", "--force"])).toMatchObject({ code: 0 });
    expect(JSON.parse(read(s.policy))).toMatchObject({ rules: { verify: true } });
  });

  it("EH6.4 a run that changed nothing has nothing to write", async () => {
    const s = scenario(tmp());
    await cli(["start", "--config", s.config]);
    const r = await cli(["documents", "--config", s.config, "--write"]);
    expect(r.out).toContain("policy (" + s.policy + "): unchanged");
    expect(r.out).toContain("nothing to write");
  });

  it("EH6.5 the incumbent's documents are what the run measured: the true score of what --write would write is the base's plus the mechanism's effect", async () => {
    const s = await finished();
    const config = loadEvolutionConfig(s.config);
    const evolution = new Evolution({ surface: buildSurface(config), settings: parseSettings(SETTINGS), split: buildSplit(config), saved: (JSON.parse(read(s.state)) as { evolution: unknown }).evolution });
    expect(truth(evolution.documents)).toBeCloseTo(0.8);
    expect(truth({ policy: { rules: {} } })).toBeCloseTo(0.3);
  });
});

describe("harness-evolution usage and errors", () => {
  it("EH7.1 misuse exits 2 with the usage, naming what is wrong", async () => {
    const s = scenario(tmp());
    const misuse = async (args: string[], message: RegExp) => {
      const r = await cli(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err).toMatch(message);
      expect(r.err).toContain("usage: harness-evolution <command>");
      expect(r.out).toBe("");
    };
    await misuse([], /^usage/);
    await misuse(["explode", "--config", s.config], /^usage/);
    await misuse(["start", "extra", "--config", s.config], /^usage/);
    await misuse(["start"], /--config is required/);
    await misuse(["round", "--config", s.config], /round needs --model/);
    await misuse(["run", "--config", s.config], /run needs --model/);
    await misuse(["status", "--config", s.config, "--critic-model", "j"], /--critic-model is for round and run/);
    await misuse(["status", "--config", s.config, "--write"], /--write is for documents/);
    await misuse(["run", "--config", s.config, "--model", "m", "--max-rounds", "0"], /--max-rounds takes a positive whole number, not "0"/);
    await misuse(["status", "--config", s.config, "--last", "two"], /--last takes a positive whole number, not "two"/);
    await misuse(["start", "--config", s.config, "--bogus"], /bogus/);
  });

  it("EH7.2 a config that cannot be read, is not JSON, is invalid, or names a broken document or schema fails with exit 1 and says which", async () => {
    const dir = tmp();
    const s = scenario(dir);
    expect(await cli(["start", "--config", join(dir, "absent.json")])).toMatchObject({ code: 1, err: expect.stringMatching(/cannot read the evolution config .*absent\.json/) as string });
    writeFileSync(join(dir, "bad.json"), "{");
    expect(await cli(["start", "--config", join(dir, "bad.json")])).toMatchObject({ code: 1, err: expect.stringMatching(/the evolution config .*bad\.json is not JSON/) as string });
    writeFileSync(join(dir, "empty.json"), "{}");
    expect(await cli(["start", "--config", join(dir, "empty.json")])).toMatchObject({ code: 1, err: expect.stringMatching(/invalid evolution config/) as string });
    writeFileSync(s.policy, JSON.stringify({ rules: { a: "yes" }, prompt: { system: "x" } }));
    expect(await cli(["start", "--config", s.config])).toMatchObject({ code: 1, err: expect.stringMatching(/the base harness's policy does not parse/) as string });
    writeFileSync(s.policy, "not json");
    expect(await cli(["start", "--config", s.config])).toMatchObject({ code: 1, err: expect.stringMatching(/document policy .*policy\.json is not JSON/) as string });
    writeFileSync(join(dir, "policy.schema.json"), JSON.stringify({ type: "banana" }));
    writeFileSync(s.policy, JSON.stringify({ rules: {}, prompt: { system: "x" } }));
    expect(await cli(["start", "--config", s.config])).toMatchObject({ code: 1, err: expect.stringMatching(/cannot use .*policy\.schema\.json as the schema of document policy/) as string });
  });

  it("EH7.3 a state file that is not a run is refused, not overwritten by round or status", async () => {
    const s = scenario(tmp());
    writeFileSync(s.state, JSON.stringify({ something: "else" }));
    expect(await cli(["status", "--config", s.config])).toMatchObject({ code: 1, err: expect.stringContaining("is not an evolution run") as string });
    expect(JSON.parse(read(s.state))).toEqual({ something: "else" });
    writeFileSync(s.state, "{");
    expect(await cli(["status", "--config", s.config])).toMatchObject({ code: 1, err: expect.stringContaining("corrupt snapshot") as string });
  });

  it("EH7.4 a proposal the surface refuses (a path outside the vocabulary) is screened with its reason, not crashed on", async () => {
    const s = scenario(tmp(), { config: { classify: { rules: [{ prefix: "/rules", component: "config" }], fallback: "skill" } } });
    await cli(["start", "--config", s.config]);
    const bad = scriptedModel(() => JSON.stringify(enable("verify")).replace("/rules/verify", "/nowhere/x"));
    const r = await cli(["round", "--config", s.config, "--model", "m"], { languageModel: () => bad });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/screened: .*does not apply|screened: .*nowhere/);
  });
});

describe("the surface a config names", () => {
  it("EH8.1 a path is classified by the longest matching prefix on whole segments, a rule may name its document, and the rest falls back", () => {
    const dir = tmp();
    const s = scenario(dir, {
      config: {
        documents: { policy: { path: "policy.json", schema: "policy.schema.json" }, notes: { path: "notes.json" } },
        classify: {
          rules: [
            { prefix: "", component: "config" },
            { prefix: "/rules", component: "skill" },
            { prefix: "/rules/style", component: "prompt" },
            { document: "notes", prefix: "/prompt", component: "skill" },
          ],
          fallback: "config",
        },
      },
    });
    writeFileSync(join(dir, "notes.json"), JSON.stringify({ prompt: { system: "n" }, other: {} }));
    const config = loadEvolutionConfig(s.config);
    const surface = buildSurface(config);
    const documents = readDocuments(config);
    const components = (document: string, path: string, value: unknown) => {
      const proposal = { summary: "s", edits: [{ id: "e", hypothesis: "h", targets: "t", predicted: [], ops: [{ op: "add", document, path, value }] }] };
      const applied = applyProposal(surface, documents, ProposalSchema.parse(proposal), 1);
      if (applied.kind === "refused") throw new Error(applied.problems.join("; "));
      return applied.edits[0]!.components;
    };
    expect(components("policy", "/rules/verify", true)).toEqual(["skill"]);
    expect(components("policy", "/rules/style", true)).toEqual(["prompt"]);
    expect(components("policy", "/rules/styleguide", true)).toEqual(["skill"]);
    expect(components("policy", "/prompt/system", "y")).toEqual(["config"]);
    expect(components("notes", "/prompt/system", "y")).toEqual(["skill"]);
    expect(components("notes", "/other/x", 1)).toEqual(["config"]);
  });

  it("EH8.2 without rules, a string is a prompt and anything else configuration", async () => {
    const s = scenario(tmp(), { config: { classify: undefined } });
    const config = JSON.parse(read(s.config)) as Record<string, unknown>;
    delete config["classify"];
    writeFileSync(s.config, JSON.stringify(config));
    await cli(["start", "--config", s.config]);
    const p = proposer();
    const r = await cli(["round", "--config", s.config, "--model", "m"], { languageModel: () => p.model });
    expect(r.out).toMatch(/0A change accepted/);
    expect(readState(s).mechanisms[0]?.components).toEqual(["config"]);
  });
});
