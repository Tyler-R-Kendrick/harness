import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DECISION_LOCK, lockStore, runDecisionCli } from "@harness/platform-native";
import { cleanDirs, seedDecisionDir, tempDir } from "./decision-fixtures.ts";

afterEach(cleanDirs);

/** Runs the command in this process; what it wrote and its exit status. */
async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runDecisionCli(args, { out: (t) => (out += t), err: (t) => (err += t) });
  return { code, out, err };
}

/** A directory with a history, made once per test that needs it. */
const seeded = async (): Promise<string> => {
  const dir = await tempDir();
  await seedDecisionDir(dir);
  return dir;
};

const INDUCE = ["--run", "--fork", "attention", "--min-support", "4", "--min-purity", "0.9", "--max-rules", "5", "--max-conditions", "1", "--fields", "kind"];

describe("harness-decision status and report", () => {
  it("DCI1.1 status says what the layer is made of: its policy, its forks and how many decisions it holds", async () => {
    const dir = await seeded();
    const { code, out, err } = await cli("status", dir);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    const status = JSON.parse(out);
    expect(status).toMatchObject({ policy: "policy-1", decisions: 56, calibration: { entries: 0 }, members: [] });
    expect(status.forks.map((f: { id: string }) => f.id)).toEqual(expect.arrayContaining(["permission.risk", "attention", "stuck", "dispatch"]));
  });

  it("DCI1.2 report prints each fork's measures as JSON", async () => {
    const dir = await seeded();
    const { code, out } = await cli("report", dir);
    expect(code).toBe(0);
    const { reports } = JSON.parse(out) as { reports: { fork: string; decisions: number; withOutcome: number; accuracy: number | null; byRung: Record<string, number> }[] };
    const risk = reports.find((r) => r.fork === "permission.risk")!;
    expect(risk).toMatchObject({ decisions: 40, withOutcome: 40, accuracy: 0.75, byRung: { model: 40 } });
    expect(reports.find((r) => r.fork === "attention")).toMatchObject({ decisions: 16, byRung: { human: 16 }, accuracy: null });
  });

  it("DCI1.3 report --fork limits it to one fork", async () => {
    const dir = await seeded();
    const { reports } = JSON.parse((await cli("report", dir, "--fork", "attention")).out) as { reports: { fork: string }[] };
    expect(reports.map((r) => r.fork)).toEqual(["attention"]);
  });

  it("DCI1.4 report --text is a table with a row for each fork", async () => {
    const dir = await seeded();
    const { code, out } = await cli("report", dir, "--text");
    expect(code).toBe(0);
    const [header, ...rows] = out.trimEnd().split("\n");
    expect(header!.split(/\s+/)).toEqual(["fork", "decisions", "rule", "model", "judge", "generator", "human", "shadow", "explored", "outcomes", "accuracy", "ece"]);
    expect(rows.map((r) => r.split(/\s+/).slice(0, 3))).toEqual([
      ["permission.risk", "40", "0"],
      ["attention", "16", "0"],
    ]);
    expect(rows.find((r) => r.startsWith("permission.risk"))).toMatch(/\s75\.0%\s/);
    expect(rows.find((r) => r.startsWith("attention"))).toMatch(/\s-\s+-$/);
  });

  it("DCI1.5 a directory with no decisions has nothing to report", async () => {
    const dir = await tempDir();
    expect((await cli("report", dir, "--text")).out).toBe("no decisions\n");
    expect(JSON.parse((await cli("report", dir)).out)).toEqual({ reports: [] });
  });
});

describe("harness-decision calibrate and thresholds", () => {
  it("DCI2.1 calibrate fits the recorded outcomes and writes calibration.json", async () => {
    const dir = await seeded();
    const { code, out } = await cli("calibrate", dir, "--min-samples", "10", "--at", "9000");
    expect(code).toBe(0);
    const result = JSON.parse(out) as { fitted: { fork: string; member: string; question: string; fitted: { n: number; at: number } }[]; entries: number };
    expect(result.fitted.length).toBeGreaterThan(0);
    expect(result.fitted.every((e) => e.fork === "permission.risk" && e.fitted.at === 9000)).toBe(true);
    // every question of the fork that the outcomes label: the boolean ones from all 40 decisions
    expect(result.fitted.map((e) => [e.question, e.fitted.n]).sort()).toEqual([["costs", 40], ["irreversible", 40], ["risk", 30], ["visible", 40]]);
    expect(JSON.parse(readFileSync(join(dir, "calibration.json"), "utf8")).entries).toHaveLength(result.entries);
    // the next run of the layer starts from it
    expect(JSON.parse((await cli("status", dir)).out).calibration.entries).toBe(result.entries);
  });

  it("DCI2.2 with fewer outcomes than the minimum nothing is fitted, and that is not an error", async () => {
    const dir = await seeded();
    const { code, out } = await cli("calibrate", dir, "--min-samples", "100");
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ fitted: [], entries: 0 });
  });

  it("DCI2.3 a minimum or a time that is not a whole number is a usage error", async () => {
    const dir = await seeded();
    for (const bad of [["--min-samples", "many"], ["--min-samples", "2.5"], ["--min-samples", ""], ["--at", "now"]]) {
      const { code, err } = await cli("calibrate", dir, ...bad);
      expect(code).toBe(2);
      expect(err).toContain(`harness-decision: ${bad[0]} takes a whole number, not "${bad[1]}"`);
    }
    expect(existsSync(join(dir, "calibration.json"))).toBe(false);
  });

  it("DCI3.1 thresholds prints the act threshold that holds the risk target, with the samples it is from and the one in force", async () => {
    const dir = await seeded();
    const { code, out } = await cli("thresholds", dir, "--fork", "permission.risk", "--risk", "0.5", "--delta", "0.2");
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ fork: "permission.risk", samples: 40, currentAct: 0.9 });
  });

  it("DCI3.2 a threshold that cannot be met is null, and the bound can be chosen", async () => {
    const dir = await seeded();
    const hoeffding = JSON.parse((await cli("thresholds", dir, "--fork", "permission.risk", "--risk", "0.01", "--delta", "0.01")).out);
    expect(hoeffding.threshold).toBeNull();
    const exact = JSON.parse((await cli("thresholds", dir, "--fork", "permission.risk", "--risk", "0.5", "--delta", "0.2", "--bound", "clopper-pearson")).out);
    expect(exact).toMatchObject({ fork: "permission.risk", samples: 40 });
  });

  it("DCI3.3 thresholds needs a fork, a risk and a delta; the bound is one of two; the numbers are numbers", async () => {
    const dir = await seeded();
    const cases: [string[], string][] = [
      [["--risk", "0.1", "--delta", "0.1"], "--fork is required"],
      [["--fork", "permission.risk", "--delta", "0.1"], "--risk is required"],
      [["--fork", "permission.risk", "--risk", "0.1"], "--delta is required"],
      [["--fork", "permission.risk", "--risk", "x", "--delta", "0.1"], '--risk takes a number, not "x"'],
      [["--fork", "permission.risk", "--risk", "0.1", "--delta", "0.1", "--bound", "wald"], '--bound is hoeffding or clopper-pearson, not "wald"'],
      [["--fork", "Not A Fork", "--risk", "0.1", "--delta", "0.1"], '--fork takes a fork id such as permission.risk, not "Not A Fork"'],
    ];
    for (const [args, message] of cases) {
      const { code, err } = await cli("thresholds", dir, ...args);
      expect({ code, message: err.split("\n")[0] }).toEqual({ code: 2, message: `harness-decision: ${message}` });
    }
  });

  it("DCI3.4 a risk the statistics refuse is a failure, not a usage error", async () => {
    const dir = await seeded();
    const { code, err } = await cli("thresholds", dir, "--fork", "permission.risk", "--risk", "7", "--delta", "0.1");
    expect(code).toBe(1);
    expect(err).toMatch(/^harness-decision: .*targetRisk/);
  });
});

describe("harness-decision export", () => {
  it("DCI4.1 export writes one example per line to standard output, with a deterministic holdout", async () => {
    const dir = await seeded();
    const first = await cli("export", dir, "--holdout", "0.25");
    expect(first.code).toBe(0);
    const lines = first.out.trimEnd().split("\n").map((l) => JSON.parse(l) as { fork: string; split: string });
    expect(lines.length).toBeGreaterThan(0);
    expect(new Set(lines.map((l) => l.split))).toEqual(new Set(["train", "holdout"]));
    expect((await cli("export", dir, "--holdout", "0.25")).out).toBe(first.out);
    expect((await cli("export", dir, "--holdout", "0.25", "--salt", "other")).out).not.toBe(first.out);
  });

  it("DCI4.2 export --fork limits the examples to one fork", async () => {
    const dir = await seeded();
    // decisions that ended at a person have no answers to learn from: only the model's are examples
    const all = new Set((await cli("export", dir, "--holdout", "0.25")).out.trimEnd().split("\n").map((l) => (JSON.parse(l) as { fork: string }).fork));
    expect([...all]).toEqual(["permission.risk"]);
    expect((await cli("export", dir, "--holdout", "0.25", "--fork", "attention")).out).toBe("");
    const one = (await cli("export", dir, "--holdout", "0.25", "--fork", "permission.risk")).out;
    expect(one).toBe((await cli("export", dir, "--holdout", "0.25")).out);
  });

  it("DCI4.3 export needs the holdout share, which is a number", async () => {
    const dir = await seeded();
    expect((await cli("export", dir)).err).toContain("--holdout is required");
    expect((await cli("export", dir, "--holdout", "a quarter")).code).toBe(2);
    expect((await cli("export", dir, "--holdout", "2")).code).toBe(1);
  });
});

describe("harness-decision induce", () => {
  it("DCI5.1 without --run it lists the rules induced so far and their evidence (none at first)", async () => {
    const dir = await seeded();
    const { code, out } = await cli("induce", dir);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ rules: [], counts: { candidate: 0, shadow: 0, active: 0, retired: 0 } });
    expect((await cli("induce", dir, "--text")).out).toBe("no induced rules\n");
  });

  it("DCI5.2 --run induces rules from the recorded decisions as shadow candidates, and the next run lists them with their evidence", async () => {
    const dir = await seeded();
    const run = await cli("induce", dir, ...INDUCE);
    expect(run.code).toBe(0);
    const { rules, counts } = JSON.parse(run.out) as { rules: { fork: string; state: string; rule: { when: unknown; action: string; support: number }; fits: number; misses: number; sessions: string[] }[]; counts: Record<string, number> };
    expect(rules.map((r) => [r.fork, r.rule.action, r.rule.support, r.state])).toEqual([
      ["attention", "urgent", 8, "candidate"],
      ["attention", "low", 8, "candidate"],
    ]);
    expect(rules[0]).toMatchObject({ fits: 0, misses: 0, sessions: [] });
    expect(counts["candidate"]).toBe(2);
    // kept in the directory: another run lists them without inducing
    expect(JSON.parse((await cli("induce", dir)).out).rules).toHaveLength(2);
    expect(JSON.parse((await cli("induce", dir, "--fork", "stuck")).out).rules).toEqual([]);
    expect(JSON.parse((await cli("status", dir)).out).lifecycle.candidate).toBe(2);
  });

  it("DCI5.6 without --fields the rules may be over any field of the decisions", async () => {
    const dir = await seeded();
    const args = INDUCE.slice(0, INDUCE.indexOf("--fields"));
    const { code, out } = await cli("induce", dir, ...args);
    expect(code).toBe(0);
    expect(JSON.parse(out).rules.length).toBeGreaterThan(0);
  });

  it("DCI5.3 --text lists the rules in a table", async () => {
    const dir = await seeded();
    await cli("induce", dir, ...INDUCE);
    const [header, ...rows] = (await cli("induce", dir, "--text")).out.trimEnd().split("\n");
    expect(header!.split(/\s+/)).toEqual(["fork", "rule", "action", "state", "support", "purity", "fits", "misses", "sessions"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('{"eq":["kind","permission"]}');
    expect(rows[0]).toContain('"urgent"');
  });

  it("DCI5.4 --run needs the fork and every limit; the conditions are one or two", async () => {
    const dir = await seeded();
    const without = (flag: string): string[] => {
      const at = INDUCE.indexOf(flag);
      return [...INDUCE.slice(0, at), ...INDUCE.slice(at + 2)];
    };
    for (const flag of ["--fork", "--min-support", "--min-purity", "--max-rules", "--max-conditions"]) {
      const { code, err } = await cli("induce", dir, ...without(flag));
      expect({ code, message: err.split("\n")[0] }).toEqual({ code: 2, message: `harness-decision: ${flag} is required` });
    }
    const three = INDUCE.map((a, i) => (INDUCE[i - 1] === "--max-conditions" ? "3" : a));
    expect((await cli("induce", dir, ...three)).err).toContain("--max-conditions is 1 or 2");
    expect((await cli("induce", dir, "--run", "--fork", "attention", "--min-support", "four", "--min-purity", "0.9", "--max-rules", "5", "--max-conditions", "1")).code).toBe(2);
  });

  it("DCI5.5 an unknown fork is a failure", async () => {
    const dir = await seeded();
    const { code, err } = await cli("induce", dir, ...INDUCE.map((a) => (a === "attention" ? "nope" : a)));
    expect(code).toBe(1);
    expect(err).toContain("no fork is registered as nope");
  });
});

describe("harness-decision usage and failures", () => {
  it("DCI6.1 without a command, with an unknown one, without a directory or with more than one is a usage error that prints the usage", async () => {
    const dir = await tempDir();
    for (const args of [[], ["status"], ["frobnicate", dir], ["status", dir, "extra"], [dir]]) {
      const { code, out, err } = await cli(...args);
      expect({ code, out }).toEqual({ code: 2, out: "" });
      expect(err).toMatch(/^usage: harness-decision <command> <dir>/);
    }
  });

  it("DCI6.2 an option it does not know is a usage error that says which", async () => {
    const dir = await tempDir();
    const { code, err } = await cli("status", dir, "--frobnicate");
    expect(code).toBe(2);
    expect(err).toMatch(/^harness-decision: .*--frobnicate[\s\S]*usage: harness-decision/);
  });

  it("DCI6.3 a directory that is not there, or is a file, is a failure that says so, and nothing is made", async () => {
    const dir = await tempDir();
    const missing = join(dir, "missing");
    const status = await cli("status", missing);
    expect(status).toEqual({ code: 1, out: "", err: `harness-decision: ${missing} is not a decision directory (a daemon started with --decision ${missing} makes one)\n` });
    expect(existsSync(missing)).toBe(false);
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    expect((await cli("status", file)).code).toBe(1);
  });

  it("DCI6.4 a data file that is not valid is a failure that names the file", async () => {
    const dir = await tempDir();
    writeFileSync(join(dir, "policy.json"), '{"version":""}');
    const { code, err } = await cli("status", dir);
    expect(code).toBe(1);
    expect(err).toContain(join(dir, "policy.json"));
  });

  it("DCI6.5 lines of the log that cannot be read are reported on standard error and the rest is used", async () => {
    const dir = await seeded();
    const file = join(dir, "decisions.jsonl");
    writeFileSync(file, `${readFileSync(file, "utf8")}garbage\n`);
    const { code, err, out } = await cli("status", dir);
    expect(code).toBe(0);
    expect(err).toContain(`decision: ${file} line 113:`);
    expect(JSON.parse(out).decisions).toBe(56);
  });

  it("DCI6.6 an empty directory is a layer with no history", async () => {
    const dir = await tempDir();
    mkdirSync(join(dir, "nested"));
    expect(JSON.parse((await cli("status", dir)).out)).toMatchObject({ decisions: 0, lifecycle: { candidate: 0 } });
  });
});

describe("harness-decision and the daemon's hold on a directory", () => {
  const deadPid = (): number => spawnSync(process.execPath, ["-e", ""], { env: { NODE_OPTIONS: "" } }).pid!;
  const COMMANDS: string[][] = [
    ["status"],
    ["report"],
    ["thresholds", "--fork", "permission.risk", "--risk", "0.5", "--delta", "0.2"],
    ["export", "--holdout", "0.25"],
    ["calibrate"],
    ["induce"],
  ];

  it("DCI7.1 while a daemon holds the directory, every command refuses with the holder and its pid, and changes nothing", async () => {
    const dir = await seeded();
    const before = readFileSync(join(dir, "decisions.jsonl"), "utf8");
    const held = await lockStore(dir, "harness", { file: DECISION_LOCK });
    expect(held.status).toBe("acquired");
    for (const [command, ...rest] of COMMANDS) {
      const { code, out, err } = await cli(command!, dir, ...rest);
      expect({ command, code, out }).toEqual({ command, code: 1, out: "" });
      expect(err).toBe(`harness-decision: the decision directory ${dir} is in use by harness (pid ${process.pid}); stop it first\n`);
    }
    expect(readFileSync(join(dir, "decisions.jsonl"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "calibration.json"))).toBe(false);
    // the daemon's lock is untouched by the refusals
    expect(JSON.parse(readFileSync(join(dir, DECISION_LOCK), "utf8"))).toEqual({ pid: process.pid, holder: "harness" });
  });

  it("DCI7.2 another run of the command holding the directory says to wait for it", async () => {
    const dir = await seeded();
    await lockStore(dir, "harness-decision", { file: DECISION_LOCK });
    const { code, err } = await cli("status", dir);
    expect(code).toBe(1);
    expect(err).toContain(`in use by harness-decision (pid ${process.pid}); wait for it to finish`);
  });

  it("DCI7.3 the command releases the lock after it, whether it finished, was misused, or failed", async () => {
    const dir = await seeded();
    expect((await cli("status", dir)).code).toBe(0);
    expect(existsSync(join(dir, DECISION_LOCK))).toBe(false);
    expect((await cli("thresholds", dir, "--risk", "0.1", "--delta", "0.1")).code).toBe(2);
    expect(existsSync(join(dir, DECISION_LOCK))).toBe(false);
    expect((await cli("thresholds", dir, "--fork", "permission.risk", "--risk", "7", "--delta", "0.1")).code).toBe(1);
    expect(existsSync(join(dir, DECISION_LOCK))).toBe(false);
    writeFileSync(join(dir, "policy.json"), '{"version":""}');
    expect((await cli("status", dir)).code).toBe(1);
    expect(existsSync(join(dir, DECISION_LOCK))).toBe(false);
  });

  it("DCI7.4 a lock left by a daemon that is gone does not stop the command, which takes it over and releases it", async () => {
    const dir = await seeded();
    writeFileSync(join(dir, DECISION_LOCK), JSON.stringify({ pid: deadPid(), holder: "harness" }));
    const { code, out } = await cli("status", dir);
    expect(code).toBe(0);
    expect(JSON.parse(out).decisions).toBe(56);
    expect(existsSync(join(dir, DECISION_LOCK))).toBe(false);
  });

  it("DCI7.5 a directory that is not there is refused before the lock could make it", async () => {
    const dir = await tempDir();
    const missing = join(dir, "missing");
    expect((await cli("status", missing)).code).toBe(1);
    expect(existsSync(missing)).toBe(false);
  });
});
