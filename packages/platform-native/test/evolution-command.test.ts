import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyProposal, Evolution, parseSettings, ProposalSchema, StateSchema } from "@harness/evolution";
import { Ensemble, probability } from "@harness/cognitive";
import type { ModelDescriptor } from "@harness/cognitive";
import { scriptedJudge, scriptedModel, SeededEntropy } from "@harness/testkit";
import { buildSplit, buildSurface, loadEvolutionConfig, readDocuments } from "../src/evolution-config.ts";
import { loadCatalog } from "../src/catalog-files.ts";
import { evolutionCommand } from "../src/evolution-command.ts";
import type { EvolutionDeps } from "../src/evolution-command.ts";
import { AGENT, enable, proposer, proposing, rewrite, scenario, SETTINGS, simulate, simulateText, textScenario, textTruth, truth } from "./evolution-world.ts";
import type { EvaluatorInput, Scenario, TextScenario } from "./evolution-world.ts";

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

/** The evaluate port on the simulated text suite, in this process. */
const evaluateText: NonNullable<EvolutionDeps["evaluate"]> = async (documents, tasks, k) => simulateText({ documents, tasks, k } as EvaluatorInput) as never;

async function cli(args: readonly string[], deps: EvolutionDeps = {}): Promise<Result> {
  let out = "";
  let err = "";
  const code = await evolutionCommand(args, { stdout: (s) => void (out += s), stderr: (s) => void (err += s) }, { evaluate, entropy: new SeededEntropy(7), ...deps });
  return { code, out, err };
}

const read = (path: string) => readFileSync(path, "utf8");
const readState = (s: Scenario) => StateSchema.parse((JSON.parse(read(s.state)) as { evolution: unknown }).evolution);

describe("harness-evolution start, round and run", () => {
  it("EH4.1 start measures the base harness on the evolve tasks only (the holdout is kept for confirming winners), and saves a run in the state file", async () => {
    const s = scenario(tmp(), { holdout: 12 });
    const r = await cli(["start", "--config", s.config]);
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(r.out).toMatch(/measuring the base harness: 24 evolve tasks, 2 trials each; 12 holdout tasks are kept for confirming winners/);
    expect(r.out).toMatch(/base score 0\.\d{4}, 1000 tokens a trial\n/);
    expect(r.out).not.toMatch(/on the holdout/);
    expect(r.out).toContain(`run started in ${s.state}: 3 rounds`);
    const state = readState(s);
    expect(state.round).toBe(0);
    expect(state.holdout).toEqual({ queries: 0 });
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
    const s = scenario(tmp(), { holdout: 12 });
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
    const s = scenario(tmp(), { holdout: 12 });
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
  it("EH5.1 status reports the round, the incumbent's score against the base, the holdout's queries left, the mechanisms and the last records", async () => {
    const s = scenario(tmp(), { holdout: 12 });
    const p = proposer();
    await cli(["run", "--config", s.config, "--model", "m"], { languageModel: () => p.model });
    const r = await cli(["status", "--config", s.config]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`run ${s.state}: round 3 of 3 (over)`);
    expect(r.out).toMatch(/base score 0\.\d{4}; incumbent 0\.\d{4} \(\+0\.\d{4}\)/);
    expect(r.out).toMatch(/holdout: [012] of 2 queries left after [012] made/);
    expect(r.out).toMatch(/mechanisms: 1\n {2}r0A\.e1 \(round 0, lower bound \+0\.\d{4}\) \[config\]: verify helps/);
    expect(r.out).toContain("last 3 records:");
    expect(r.out).toMatch(/0A change accepted/);
    expect((await cli(["status", "--config", s.config, "--last", "1"])).out).toContain("last 1 records:");
  });
});

describe("harness-evolution documents", () => {
  async function finished() {
    const s = scenario(tmp(), { holdout: 12 });
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

// ---- text documents ------------------------------------------------------------------------------

const NODE = process.execPath;
const textCli = (args: readonly string[], deps: EvolutionDeps = {}) => cli(args, { evaluate: evaluateText, ...deps });
const readEvolution = (s: TextScenario) => StateSchema.parse((JSON.parse(read(s.state)) as { evolution: unknown }).evolution);

describe("harness-evolution on text documents", () => {
  it("EH11.14 a scripted proposer's edit to a text file is accepted when it really helps; the state holds the text, not JSON", async () => {
    const s = textScenario(tmp(), { holdout: 12 });
    const p = proposing(() => rewrite("verify: off", "verify: on"));
    await textCli(["start", "--config", s.config]);
    const r = await textCli(["round", "--config", s.config, "--model", "m"], { languageModel: () => p.model });
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(r.out).toMatch(/round 1 of 3: accepted A /);
    expect(r.out).toMatch(/0A change accepted\s+gain \+0\.\d{4} \[\+0\.\d{4}, \+0\.\d{4}\] supported: /);
    const state = readEvolution(s);
    expect(state.documents["agent"]).toBe("You are an agent.\nverify: on\nbe brief\n");
    expect(state.mechanisms.map((m) => [m.id, m.components])).toEqual([["r0A.e1", ["prompt"]]]);
    expect(textTruth(state.documents)).toBeCloseTo(0.8);
    expect((JSON.parse(read(s.state)) as { base: unknown }).base).toEqual({ agent: AGENT, policy: { rules: {}, prompt: { system: "Work carefully." } } });
  });

  it("EH11.15 documents --write writes the incumbent's text back verbatim: the trailing newline, CRLF line endings and a missing final newline exactly as they were", async () => {
    for (const [name, text] of [
      ["trailing newline", AGENT],
      ["CRLF", "You are an agent.\r\nverify: off\r\nbe brief\r\n"],
      ["no final newline", "You are an agent.\nverify: off\nbe brief"],
      ["byte order mark", "\uFEFFYou are an agent.\nverify: off\n"],
      ["JSON-looking", '{"verify": "verify: off"}'],
    ] as const) {
      const s = textScenario(tmp(), { text });
      const p = proposing(() => rewrite("verify: off", "verify: on"));
      await textCli(["run", "--config", s.config, "--model", "m"], { languageModel: () => p.model });
      const r = await textCli(["documents", "--config", s.config, "--write"]);
      expect(r, name).toMatchObject({ code: 0, err: "" });
      expect(r.out, name).toContain(`agent (${s.agent}): differs: the incumbent's would replace the file`);
      expect(r.out, name).toContain(`wrote ${s.agent}`);
      expect(readFileSync(s.agent), name).toEqual(Buffer.from(text.replace("verify: off", "verify: on")));
      const again = await textCli(["documents", "--config", s.config, "--write"]);
      expect(again.out, name).toContain(`agent (${s.agent}): the file holds the incumbent's`);
      expect(again.out).toContain("nothing to write");
    }
  });

  it("EH11.16 documents without --write compares and writes nothing; a text file the run did not change is unchanged", async () => {
    const s = textScenario(tmp());
    await textCli(["start", "--config", s.config]);
    const same = await textCli(["documents", "--config", s.config, "--write"]);
    expect(same.out).toContain(`agent (${s.agent}): unchanged`);
    expect(same.out).toContain("nothing to write");
    const p = proposing(() => rewrite("verify: off", "verify: on"));
    await textCli(["run", "--config", s.config, "--model", "m"], { languageModel: () => p.model });
    const r = await textCli(["documents", "--config", s.config]);
    expect(r.out).toContain("nothing was written; --write replaces the files that differ");
    expect(read(s.agent)).toBe(AGENT);
  });

  it("EH11.17 --write refuses, writing nothing, a text file that changed since the run started (even by a line ending); --force replaces it", async () => {
    const s = textScenario(tmp());
    const p = proposing(() => rewrite("verify: off", "verify: on"));
    await textCli(["run", "--config", s.config, "--model", "m"], { languageModel: () => p.model });
    // Only the line endings differ from what the run started from.
    const crlf = AGENT.replaceAll("\n", "\r\n");
    writeFileSync(s.agent, crlf);
    const refused = await textCli(["documents", "--config", s.config, "--write"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toBe(`nothing was written: ${s.agent} changed since the run started; --force replaces it anyway\n`);
    expect(refused.out).toContain(`agent (${s.agent}): differs, and the file is not what the run started from`);
    expect(read(s.agent)).toBe(crlf);
    expect(await textCli(["documents", "--config", s.config, "--write", "--force"])).toMatchObject({ code: 0 });
    expect(read(s.agent)).toBe("You are an agent.\nverify: on\nbe brief\n");
  });

  it("EH11.18 a text document and a JSON document written together: each in its own form, and one changed file blocks the write of both", async () => {
    const s = textScenario(tmp());
    const both = (n: number) => ({
      summary: "both",
      edits: [
        { id: "a", hypothesis: "verify helps", targets: "failures", ops: [{ op: "edit", document: "agent", old: "verify: off", new: "verify: on" }] },
        ...(n < 0 ? [] : [{ id: "b", hypothesis: "b", targets: "t", ops: [{ op: "add", document: "policy", path: "/rules/x", value: true }] }]),
      ],
    });
    const settings = JSON.parse(read(join(s.dir, "settings.json"))) as typeof SETTINGS;
    writeFileSync(join(s.dir, "settings.json"), JSON.stringify({ ...settings, budget: { min: 2, max: 2 }, candidates: 1 }));
    const p = proposing(() => both(0));
    await textCli(["run", "--config", s.config, "--model", "m", "--max-rounds", "1"], { languageModel: () => p.model });
    const state = readEvolution(s);
    expect(state.documents["agent"]).toBe("You are an agent.\nverify: on\nbe brief\n");
    expect(state.documents["policy"]).toEqual({ rules: { x: true }, prompt: { system: "Work carefully." } });
    writeFileSync(s.agent, "edited by hand\n");
    const refused = await textCli(["documents", "--config", s.config, "--write"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(s.agent);
    expect(read(join(s.dir, "policy.json"))).toBe(`${JSON.stringify({ rules: {}, prompt: { system: "Work carefully." } }, null, 2)}\n`);
    await textCli(["documents", "--config", s.config, "--write", "--force"]);
    expect(read(s.agent)).toBe("You are an agent.\nverify: on\nbe brief\n");
    expect(JSON.parse(read(join(s.dir, "policy.json")))).toEqual({ rules: { x: true }, prompt: { system: "Work carefully." } });
  });

  it("EH11.19 regions decide a text edit's component, and the mechanism records it", async () => {
    const s = textScenario(tmp(), { document: { component: "prompt", regions: [{ pattern: "^verify", component: "skill" }] } });
    const p = proposing(() => rewrite("verify: off", "verify: on"));
    await textCli(["start", "--config", s.config]);
    await textCli(["round", "--config", s.config, "--model", "m"], { languageModel: () => p.model });
    expect(readEvolution(s).mechanisms.map((m) => m.components)).toEqual([["skill"]]);
  });

  it("EH11.20 a proposal that fails the document's check is screened with the check's problem; one the check passes goes on", async () => {
    const check = { command: [NODE, "-e", `const s = require("fs").readFileSync(0, "utf8"); if (s.includes("BROKEN")) { console.error("agent.txt: BROKEN marker\\nmore"); process.exit(1) }`] };
    const s = textScenario(tmp(), { document: { check } });
    await textCli(["start", "--config", s.config]);
    const broken = proposing(() => rewrite("verify: off", "BROKEN"));
    const r = await textCli(["round", "--config", s.config, "--model", "m"], { languageModel: () => broken.model });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/0A change screened: .*agent fails its check: agent\.txt: BROKEN marker/);
    expect(r.out).not.toContain("more");
    expect(r.out).toContain("nothing accepted");
    const fine = proposing(() => rewrite("verify: off", "verify: on"));
    expect((await textCli(["round", "--config", s.config, "--model", "m"], { languageModel: () => fine.model })).out).toMatch(/1A change accepted/);
  });

  it("EH11.21 a check that takes too long screens the proposal naming the limit; a check that cannot start stops the run (the host's fault, not the proposal's)", async () => {
    // The base text passes at once; text with the edit in it hangs. The limit is generous so that starting Node for the
    // base text's check never races it on a loaded machine (a 300 ms limit failed start when the host was busy).
    const slow = { command: [NODE, "-e", `if (require("fs").readFileSync(0, "utf8").includes("verify: on")) setTimeout(() => {}, 60000)`], timeoutMs: 2500 };
    const s = textScenario(tmp(), { document: { check: slow } });
    await textCli(["start", "--config", s.config]);
    const p = proposing(() => rewrite("verify: off", "verify: on"));
    const r = await textCli(["round", "--config", s.config, "--model", "m"], { languageModel: () => p.model });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/0A change screened: .*agent fails its check: the check took longer than 2500 ms and was stopped/);
    // Start measures the base, which must pass the check too; a check that cannot start fails the round or start, whichever meets it first.
    const missing = textScenario(tmp(), { document: { check: { command: ["/no/such/check"] } } });
    const noStart = await textCli(["start", "--config", missing.config]);
    expect(noStart.code).toBe(1);
    expect(noStart.err).toMatch(/^cannot start the check \/no\/such\/check: /);
    expect(() => readFileSync(missing.state)).toThrow(/ENOENT/);
  });

  it("EH11.24 a base text that fails its check stops start, saying so; nothing is saved", async () => {
    const failing = { command: [NODE, "-e", `console.error("cannot compile"); process.exit(1)`] };
    const s = textScenario(tmp(), { document: { check: failing } });
    expect(await textCli(["start", "--config", s.config])).toMatchObject({ code: 1, err: "the base harness's agent fails its check: cannot compile\n" });
    expect(() => readFileSync(s.state)).toThrow(/ENOENT/);
  });

  it("EH11.22 an edit whose old text is not in the file, or occurs twice, is screened with that reason", async () => {
    const s = textScenario(tmp(), { text: "a\nb\na\n" });
    await textCli(["start", "--config", s.config]);
    const twice = proposing(() => rewrite("a", "c"));
    expect((await textCli(["round", "--config", s.config, "--model", "m"], { languageModel: () => twice.model })).out).toMatch(/screened: .*the old text occurs 2 times in agent, not exactly once/);
    const absent = proposing(() => rewrite("zzz", "c"));
    expect((await textCli(["round", "--config", s.config, "--model", "m"], { languageModel: () => absent.model })).out).toMatch(/screened: .*the old text is not in agent: "zzz"/);
  });

  it("EH11.23 a text file that is not UTF-8 stops start with the file's name", async () => {
    const s = textScenario(tmp());
    writeFileSync(s.agent, Buffer.from([0x61, 0xff]));
    expect(await textCli(["start", "--config", s.config])).toMatchObject({ code: 1, err: `document agent ${s.agent} is not UTF-8 text\n` });
  });
});

// ---- the critic from the ensemble ----------------------------------------------------------------

/** A catalog model that is a judge on this host: tests pick models by the port they serve, never by name. */
const judgeModel = loadCatalog().models.find((m) => m.platforms.includes("native") && m.tasks.includes("judgment") && m.ports.includes("judge")) as ModelDescriptor;

/** An ensemble factory for the command: what it was asked for, what it closed, and an ensemble whose one judge is `load`. */
function ensembles(load: () => Promise<{ judge?: ReturnType<typeof scriptedJudge> }>, options: { members?: boolean; descriptor?: ModelDescriptor } = {}) {
  const asked: unknown[] = [];
  let closed = 0;
  const factory: NonNullable<EvolutionDeps["ensemble"]> = (o) => {
    asked.push(o);
    const ensemble = new Ensemble({ platform: "native" });
    if (options.members !== false) ensemble.register(options.descriptor ?? judgeModel, load as never);
    return { ensemble, close: async () => void closed++ };
  };
  return { factory, asked, closed: () => closed };
}

describe("harness-evolution --critic ensemble", () => {
  it("EH12.1 the critic is the ensemble's judge: the round screens with it, exactly as it answers, and the ensemble is closed afterwards", async () => {
    const s = scenario(tmp());
    await cli(["start", "--config", s.config]);
    const judge = scriptedJudge(() => ({ type: "boolean", probability: probability(0.9) }));
    const e = ensembles(async () => ({ judge }));
    const p = proposer();
    const r = await cli(["round", "--config", s.config, "--model", "m", "--critic", "ensemble"], { languageModel: () => p.model, ensemble: e.factory });
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(judge.requests.length).toBeGreaterThan(0);
    expect(r.out).toMatch(/0A change screened: critic: it reads as specific to the evolve tasks \(p = 0\.90\)/);
    expect(e.closed()).toBe(1);
    // A critic that finds nothing specific lets the real gain through.
    const fair = scriptedJudge(() => ({ type: "boolean", probability: probability(0.1) }));
    const again = await cli(["round", "--config", s.config, "--model", "m", "--critic", "ensemble"], { languageModel: () => p.model, ensemble: ensembles(async () => ({ judge: fair })).factory });
    expect(again.code).toBe(0);
    expect(fair.requests.length).toBeGreaterThan(0);
  });

  it("EH12.2 the ensemble is built where the host builds its own: --model-cache and --llama-server, else HARNESS_MODEL_CACHE and LLAMA_SERVER, else the host's default cache", async () => {
    const s = scenario(tmp());
    await cli(["start", "--config", s.config]);
    const asked = async (args: readonly string[]) => {
      await cli(["start", "--config", s.config, "--force"]);
      const e = ensembles(async () => ({ judge: scriptedJudge() }));
      await cli(["round", "--config", s.config, "--model", "m", "--critic", "ensemble", ...args], { languageModel: () => proposer().model, ensemble: e.factory });
      return e.asked;
    };
    expect(await asked(["--model-cache", "/models", "--llama-server", "/bin/llama-server"])).toEqual([{ cacheDir: "/models", llamaServer: "/bin/llama-server" }]);
    vi.stubEnv("HARNESS_MODEL_CACHE", "/env/models");
    vi.stubEnv("LLAMA_SERVER", "/env/llama-server");
    expect(await asked([])).toEqual([{ cacheDir: "/env/models", llamaServer: "/env/llama-server" }]);
    expect(await asked(["--model-cache", "/models"])).toEqual([{ cacheDir: "/models", llamaServer: "/env/llama-server" }]);
    vi.stubEnv("HARNESS_MODEL_CACHE", "");
    vi.stubEnv("LLAMA_SERVER", "");
    expect(await asked([])).toEqual([{ cacheDir: join(homedir(), ".cache", "harness", "models") }]);
  });

  it("EH12.3 with no judge reachable the command fails with exit 1 saying so and why, before any round, saves nothing and closes the ensemble; it never runs without the critic", async () => {
    const s = scenario(tmp());
    await cli(["start", "--config", s.config]);
    const before = read(s.state);
    const p = proposer();
    const none = ensembles(async () => ({}), { members: false });
    const r = await cli(["round", "--config", s.config, "--model", "m", "--critic", "ensemble"], { languageModel: () => p.model, ensemble: none.factory });
    expect(r).toMatchObject({ code: 1, out: "", err: "--critic ensemble: no judge could be reached\n" });
    expect(none.closed()).toBe(1);
    expect(p.calls()).toBe(0);
    expect(read(s.state)).toBe(before);
    // A member that does not declare the judge port is never tried, so it leaves no reason to give.
    const mute = ensembles(async () => ({}), { descriptor: { ...judgeModel, ports: judgeModel.ports.filter((port) => port !== "judge") } as ModelDescriptor });
    expect(await cli(["round", "--config", s.config, "--model", "m", "--critic", "ensemble"], { languageModel: () => p.model, ensemble: mute.factory })).toMatchObject({ code: 1, err: "--critic ensemble: no judge could be reached\n" });
    // One that declares it and does not deliver says so.
    const liar = ensembles(async () => ({}));
    expect((await cli(["round", "--config", s.config, "--model", "m", "--critic", "ensemble"], { languageModel: () => p.model, ensemble: liar.factory })).err).toBe(`--critic ensemble: no judge could be reached: ${judgeModel.id}: adapter does not provide the judge port it declared\n`);
    const down = ensembles(() => Promise.reject(new Error("no credential for the gateway")));
    const why = await cli(["run", "--config", s.config, "--model", "m", "--critic", "ensemble"], { languageModel: () => p.model, ensemble: down.factory });
    expect(why).toMatchObject({ code: 1, out: "" });
    expect(why.err).toBe(`--critic ensemble: no judge could be reached: ${judgeModel.id}: no credential for the gateway\n`);
    expect(down.closed()).toBe(1);
    expect(p.calls()).toBe(0);
    expect(read(s.state)).toBe(before);
  });

  it("EH12.3b anything else that goes wrong reaching the judge is not disguised as an unreachable judge; the ensemble is still closed", async () => {
    const s = scenario(tmp());
    await cli(["start", "--config", s.config]);
    let closed = 0;
    const broken = { ensemble: { resolve: () => Promise.reject(new TypeError("the ensemble is broken")) } as unknown as Ensemble, close: async () => void closed++ };
    expect(await cli(["round", "--config", s.config, "--model", "m", "--critic", "ensemble"], { languageModel: () => proposer().model, ensemble: () => broken })).toMatchObject({ code: 1, err: "the ensemble is broken\n" });
    expect(closed).toBe(1);
  });

  it("EH12.3c by default the ensemble is the native host's own, built on --model-cache: with every fetch refused and no credential, no judge is reached and the run says so (nothing is downloaded)", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => (fetched.push(String(input)), new Response("offline", { status: 503 })));
    const dir = tmp();
    const s = scenario(dir);
    await cli(["start", "--config", s.config]);
    const p = proposer();
    const r = await cli(["round", "--config", s.config, "--model", "m", "--critic", "ensemble", "--model-cache", join(dir, "models")], { languageModel: () => p.model });
    vi.unstubAllGlobals();
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^--critic ensemble: no judge could be reached/);
    expect(p.calls()).toBe(0);
  });

  it("EH12.4 a run that is already over builds no ensemble: nothing to screen, nothing to load", async () => {
    const s = scenario(tmp());
    const p = proposer();
    await cli(["run", "--config", s.config, "--model", "m"], { languageModel: () => p.model });
    const e = ensembles(async () => ({ judge: scriptedJudge() }));
    expect(await cli(["run", "--config", s.config, "--model", "m", "--critic", "ensemble"], { languageModel: () => p.model, ensemble: e.factory })).toMatchObject({ code: 0, out: "the run is over: 3 of 3 rounds\n" });
    expect(e.asked).toEqual([]);
  });

  it("EH12.5 --critic ensemble and --critic-model together, an unknown critic, and ensemble options without --critic ensemble are usage errors (exit 2), before any file is read", async () => {
    const s = scenario(tmp());
    const misuse = async (args: string[], message: RegExp) => {
      const r = await cli(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err).toMatch(message);
      expect(r.err).toContain("usage: harness-evolution <command>");
      expect(r.out).toBe("");
    };
    const round = ["round", "--config", s.config, "--model", "m"];
    await misuse([...round, "--critic", "ensemble", "--critic-model", "j"], /^--critic and --critic-model are alternatives: give one, the ensemble's judge or a gateway model\n/);
    await misuse([...round, "--critic", "gateway"], /^--critic takes "ensemble", not "gateway"\n/);
    await misuse(["status", "--config", s.config, "--critic", "ensemble"], /^--critic is for round and run\n/);
    await misuse([...round, "--model-cache", "/x"], /^--model-cache is for --critic ensemble\n/);
    await misuse([...round, "--critic-model", "j", "--llama-server", "/x"], /^--llama-server is for --critic ensemble\n/);
    // Nothing was built or measured.
    expect(() => readFileSync(s.state)).toThrow(/ENOENT/);
  });

  it("EH12.6 --critic-model still gives the gateway's judge, and no critic still runs without one", async () => {
    const s = scenario(tmp());
    await cli(["start", "--config", s.config]);
    const asked: string[] = [];
    const judge = scriptedJudge(() => ({ type: "boolean", probability: probability(0.9) }));
    const e = ensembles(async () => ({ judge: scriptedJudge() }));
    const p = proposer();
    const r = await cli(["round", "--config", s.config, "--model", "m", "--critic-model", "other/judge"], { languageModel: () => p.model, evaluationModel: (id) => (asked.push(id), judge), ensemble: e.factory });
    expect(asked).toEqual(["other/judge"]);
    expect(e.asked).toEqual([]);
    expect(r.out).toMatch(/screened: critic: /);
    const none = await cli(["round", "--config", s.config, "--model", "m"], { languageModel: () => proposer().model, ensemble: e.factory });
    expect(none.code).toBe(0);
    expect(e.asked).toEqual([]);
  });
});
