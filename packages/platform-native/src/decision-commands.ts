import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import { errorText, examplesToJsonl, forkId } from "@harness/decision";
import type { DecisionLayer, ForkReport, ForkId } from "@harness/decision";
import { openDecision } from "./decision-host.ts";
import { DECISION_LOCK, lockStore } from "./store-lock.ts";

/** Where the command writes: standard output and error, or a test's buffers. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const USAGE = `usage: harness-decision <command> <dir> [options]
  Works offline on a decision directory (what \`harness --decision <dir>\` keeps); the daemon must not hold it:
  while one runs on the directory (decision.lock) every command refuses; ask the daemon's decision.* operations.
  status                         what the layer is made of and how many decisions it holds
  report    [--fork <id>] [--text]
                                 per fork: decisions by rung and mode, accuracy, calibration error, reliability
  calibrate [--min-samples <n>] [--at <ms>]
                                 fit calibration from the recorded outcomes and write calibration.json
  thresholds --fork <id> --risk <p> --delta <p> [--bound hoeffding|clopper-pearson]
                                 the act threshold that keeps the share of wrong answers among acted-on ones
                                 at or under --risk, with confidence 1 - delta
  export    --holdout <share> [--fork <id>] [--salt <text>]
                                 labelled examples as JSON lines on standard output
  induce    [--fork <id>] [--text]
                                 the induced rules and their shadow evidence; with --run, first induce new ones:
            --run --fork <id> --min-support <n> --min-purity <p> --max-rules <n> --max-conditions 1|2 [--fields a,b]
exit status: 0 done, 1 failed, 2 wrong usage
`;

class UsageError extends Error {}

const OPTIONS = {
  fork: { type: "string" },
  text: { type: "boolean", default: false },
  "min-samples": { type: "string" },
  at: { type: "string" },
  risk: { type: "string" },
  delta: { type: "string" },
  bound: { type: "string" },
  holdout: { type: "string" },
  salt: { type: "string" },
  run: { type: "boolean", default: false },
  "min-support": { type: "string" },
  "min-purity": { type: "string" },
  "max-rules": { type: "string" },
  "max-conditions": { type: "string" },
  fields: { type: "string" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

function number(name: string, text: string | undefined, kind: "number" | "integer" = "number"): number {
  if (text === undefined) throw new UsageError(`--${name} is required`);
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value) || (kind === "integer" && !Number.isInteger(value))) throw new UsageError(`--${name} takes ${kind === "integer" ? "a whole number" : "a number"}, not "${text}"`);
  return value;
}

function forkOf(name: string | undefined, required: boolean): ForkId | undefined {
  if (name === undefined) {
    if (required) throw new UsageError("--fork is required");
    return undefined;
  }
  try {
    return forkId(name);
  } catch {
    throw new UsageError(`--fork takes a fork id such as permission.risk, not "${name}"`);
  }
}

/** JSON with two spaces; what has no JSON form (a threshold that does not exist) is `null`. */
const json = (value: unknown): string => `${JSON.stringify(value, (_key, v: unknown) => (v === undefined ? null : v), 2)}\n`;

const percent = (value: number | null): string => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);

/** A table of text rows, columns padded to their widest cell. */
function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()).join("\n") + "\n";
}

function reportText(reports: readonly ForkReport[]): string {
  if (reports.length === 0) return "no decisions\n";
  return table([
    ["fork", "decisions", "rule", "model", "judge", "generator", "human", "shadow", "explored", "outcomes", "accuracy", "ece"],
    ...reports.map((r) => [
      r.fork,
      String(r.decisions),
      String(r.byRung.rule),
      String(r.byRung.model),
      String(r.byRung.judge),
      String(r.byRung.generator),
      String(r.byRung.human),
      String(r.byMode.shadow),
      String(r.explored),
      String(r.withOutcome),
      percent(r.accuracy),
      percent(r.ece),
    ]),
  ]);
}

function rulesText(rules: ReturnType<DecisionLayer["rules"]>): string {
  if (rules.rules.length === 0) return "no induced rules\n";
  return table([
    ["fork", "rule", "action", "state", "support", "purity", "fits", "misses", "sessions"],
    ...rules.rules.map((r) => [r.fork, JSON.stringify(r.rule.when), JSON.stringify(r.rule.action), r.state, String(r.rule.support), r.rule.purity.toFixed(2), String(r.fits), String(r.misses), String(r.sessions.length)]),
  ]);
}

async function run(command: string, layer: DecisionLayer, values: Values, io: CliIo): Promise<void> {
  switch (command) {
    case "status":
      io.out(json(await layer.status()));
      return;
    case "report": {
      const reports = await layer.report(forkOf(values.fork, false));
      io.out(values.text ? reportText(reports) : json({ reports }));
      return;
    }
    case "calibrate": {
      const fitted = await layer.calibrate({
        ...(values["min-samples"] === undefined ? {} : { minSamples: number("min-samples", values["min-samples"], "integer") }),
        ...(values.at === undefined ? {} : { at: number("at", values.at, "integer") }),
      });
      io.out(json({ fitted, entries: layer.calibration().entries.length }));
      return;
    }
    case "thresholds": {
      const fork = forkOf(values.fork, true)!;
      const bound = values.bound ?? "hoeffding";
      if (bound !== "hoeffding" && bound !== "clopper-pearson") throw new UsageError(`--bound is hoeffding or clopper-pearson, not "${bound}"`);
      io.out(json(await layer.thresholds({ fork, targetRisk: number("risk", values.risk), delta: number("delta", values.delta), bound })));
      return;
    }
    case "export": {
      const fork = forkOf(values.fork, false);
      const examples = await layer.distill({ holdout: number("holdout", values.holdout), ...(fork === undefined ? {} : { fork }), ...(values.salt === undefined ? {} : { salt: values.salt }) });
      io.out(examplesToJsonl(examples));
      return;
    }
    case "induce": {
      const fork = forkOf(values.fork, values.run);
      if (values.run) {
        const maxConditions = number("max-conditions", values["max-conditions"], "integer");
        if (maxConditions !== 1 && maxConditions !== 2) throw new UsageError("--max-conditions is 1 or 2");
        await layer.induce({
          fork: fork!,
          minSupport: number("min-support", values["min-support"], "integer"),
          minPurity: number("min-purity", values["min-purity"]),
          maxRules: number("max-rules", values["max-rules"], "integer"),
          maxConditions,
          ...(values.fields === undefined ? {} : { fields: values.fields.split(",").filter((f) => f !== "") }),
        });
      }
      const rules = layer.rules(fork);
      io.out(values.text ? rulesText(rules) : json(rules));
      return;
    }
  }
}

const COMMANDS = ["status", "report", "calibrate", "thresholds", "export", "induce"];

/**
 * `harness-decision`: reports and loops over a decision directory, offline. Returns the exit
 * status: 0 done, 1 failed (the directory cannot be read, a computation refused its input),
 * 2 wrong usage (nothing is changed).
 */
export async function runDecisionCli(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true });
  } catch (e) {
    io.err(`harness-decision: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const [command, dir, ...extra] = parsed.positionals;
  if (command === undefined || !COMMANDS.includes(command) || dir === undefined || extra.length > 0) {
    io.err(USAGE);
    return 2;
  }
  try {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      io.err(`harness-decision: ${dir} is not a decision directory (a daemon started with --decision ${dir} makes one)\n`);
      return 1;
    }
    // One process owns a decision directory: opening it may compact or truncate the log, so even a
    // read-only command refuses while a daemon (or another run of this command) holds it.
    const locked = await lockStore(dir, "harness-decision", { file: DECISION_LOCK });
    if (locked.status === "held") {
      const { holder, pid } = locked.owner;
      const advice = holder === "harness-decision" ? "wait for it to finish" : "stop it first";
      io.err(`harness-decision: the decision directory ${dir} is in use by ${holder} (pid ${pid}); ${advice}\n`);
      return 1;
    }
    try {
      const opened = await openDecision({ dir, log: (message) => io.err(`${message}\n`) });
      try {
        await run(command, opened.layer, parsed.values, io);
      } finally {
        await opened.settled();
      }
    } finally {
      await locked.lock.release();
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`harness-decision: ${e.message}\n${USAGE}`);
      return 2;
    }
    io.err(`harness-decision: ${errorText(e)}\n`);
    return 1;
  }
}
