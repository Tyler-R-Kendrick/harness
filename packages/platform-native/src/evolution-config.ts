import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { defineSurface, ScoreSchema, TokensSchema } from "@harness/evolution";
import type { Documents, EvolutionPorts, Split, Surface, TaskRun } from "@harness/evolution";

const text = z.string().min(1);
const pointer = z.string().regex(/^(\/.*)?$/, "a JSON Pointer (empty, or starting with /)");

const TaskSchema = z.strictObject({
  id: text,
  text,
  /** A reference answer, if the task has one: the leakage screen keeps edits from repeating it. */
  reference: text.exactOptional(),
  /** The cluster the task was drawn with (a practice area, a repository). */
  group: text.exactOptional(),
});

/**
 * The configuration of a host-driven evolution run (`harness-evolution --config`): the
 * surface (the JSON documents the harness is made of, which paths are which component),
 * the tasks, the evaluator that runs the harness, and where the evolution settings live.
 * Relative paths are relative to the configuration file.
 */
export const EvolutionConfigSchema = z
  .strictObject({
    $schema: z.string().exactOptional(),
    description: text.exactOptional(),
    /** The evolvable harness: document name (what edits and the evaluator call it) to its JSON file, and the JSON Schema that file must keep satisfying. */
    documents: z.record(text, z.strictObject({ path: text, schema: text.exactOptional() })),
    /** The component vocabulary K. */
    components: z.array(text).min(1),
    /** Components that add machinery rather than change text or constants (K_str). */
    structural: z.array(text).default([]),
    /**
     * Which component a changed path belongs to: the rule with the longest matching JSON
     * Pointer prefix wins (a prefix matches whole segments: `/rules` is `/rules/x`, not
     * `/rulesX`); a rule may name one document. What no rule matches is `fallback`, else
     * `prompt` for a string and `config` for anything else.
     */
    classify: z
      .strictObject({
        rules: z.array(z.strictObject({ document: text.exactOptional(), prefix: pointer, component: text })).default([]),
        fallback: text.exactOptional(),
      })
      .default({ rules: [] }),
    tasks: z.strictObject({
      /** The tasks the search sees. */
      evolve: z.array(TaskSchema).min(1),
      /** Tasks the proposer never sees, queried only through Thresholdout. */
      holdout: z.array(TaskSchema).exactOptional(),
    }),
    /** A command (argv) that runs the harness the documents describe: `{documents, tasks, k}` as JSON on stdin, the task runs as JSON on stdout. */
    evaluator: z.strictObject({
      command: z.array(text).min(1),
      /** Where it runs; by default the configuration file's directory. */
      cwd: text.exactOptional(),
      /** One evaluation's time limit. */
      timeoutMs: z.int().positive().default(600_000),
      /** Evaluations that run at once (a round measures several harnesses in one window). */
      concurrency: z.int().positive().default(2),
    }),
    /** The evolution settings file; by default @harness/evolution's data/settings.json. */
    settings: text.exactOptional(),
    /** Where the run's state is kept; by default beside the configuration file. */
    state: text.exactOptional(),
  })
  .superRefine((c, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    if (Object.keys(c.documents).length === 0) issue(["documents"], "name at least one document");
    for (const [i, s] of c.structural.entries()) if (!c.components.includes(s)) issue(["structural", i], `structural components must be components: ${s}`);
    for (const [i, r] of c.classify.rules.entries()) {
      if (!c.components.includes(r.component)) issue(["classify", "rules", i, "component"], `not one of the components: ${r.component}`);
      if (r.document !== undefined && !(r.document in c.documents)) issue(["classify", "rules", i, "document"], `not a document: ${r.document}`);
    }
    if (c.classify.fallback !== undefined && !c.components.includes(c.classify.fallback)) issue(["classify", "fallback"], `not one of the components: ${c.classify.fallback}`);
    const seen = new Set<string>();
    for (const set of ["evolve", "holdout"] as const)
      for (const [i, t] of (c.tasks[set] ?? []).entries()) {
        if (seen.has(t.id)) issue(["tasks", set, i, "id"], `task ids are unique across the evolve set and the holdout: ${t.id}`);
        seen.add(t.id);
      }
  });
export type EvolutionConfig = z.output<typeof EvolutionConfigSchema>;

export function parseEvolutionConfig(input: unknown): EvolutionConfig {
  const result = EvolutionConfigSchema.safeParse(input);
  if (!result.success) throw new Error(`invalid evolution config\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** JSON Schema for the configuration file, for editors (data/evolution.schema.json). */
export const evolutionConfigJsonSchema = (): object => z.toJSONSchema(EvolutionConfigSchema, { io: "input" });

/** A configuration file, parsed, with the directory its relative paths are relative to. */
export interface LoadedConfig {
  readonly config: EvolutionConfig;
  readonly dir: string;
}

const readJson = (path: string, what: string): unknown => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read ${what} ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (e) {
    throw new Error(`${what} ${path} is not JSON: ${(e as Error).message}`);
  }
};

export function loadEvolutionConfig(file: string): LoadedConfig {
  const path = resolve(file);
  return { config: parseEvolutionConfig(readJson(path, "the evolution config")), dir: dirname(path) };
}

const isContainer = (value: unknown) => typeof value === "object" && value !== null;

/** The files of the surface's documents, parsed. */
export function readDocuments({ config, dir }: LoadedConfig): Documents {
  return Object.fromEntries(Object.entries(config.documents).map(([name, d]) => [name, readJson(resolve(dir, d.path), `document ${name}`)]));
}

/** A document's path in its file. */
export const documentPath = ({ config, dir }: LoadedConfig, name: string): string => resolve(dir, config.documents[name]!.path);

/** Whether a JSON Pointer is at or under a prefix, by whole segments. */
const under = (prefix: string, path: string) => prefix === "" || path === prefix || path.startsWith(`${prefix}/`);

type Classify = (path: string, value: unknown) => string;

function classifier(config: EvolutionConfig, name: string): Classify {
  const rules = config.classify.rules.filter((r) => r.document === undefined || r.document === name);
  return (path, value) => {
    let best: (typeof rules)[number] | undefined;
    for (const r of rules) if (under(r.prefix, path) && (best === undefined || r.prefix.length > best.prefix.length)) best = r;
    return best?.component ?? config.classify.fallback ?? (typeof value === "string" ? "prompt" : "config");
  };
}

/**
 * The surface the configuration names. A document's schema is a JSON Schema file, turned
 * into a zod schema by zod's own `fromJSONSchema` (no validator of ours); a document
 * without one only has to be a JSON object or array.
 */
export function buildSurface({ config, dir }: LoadedConfig): Surface {
  const documents = Object.fromEntries(
    Object.entries(config.documents).map(([name, d]): [string, { schema: z.ZodType; classify: Classify }] => {
      let schema: z.ZodType = z.json().refine(isContainer, "a JSON object or array");
      if (d.schema !== undefined) {
        const file = resolve(dir, d.schema);
        try {
          schema = z.fromJSONSchema(readJson(file, `the JSON Schema of ${name}`) as z.core.JSONSchema.JSONSchema);
        } catch (e) {
          throw new Error(`cannot use ${file} as the schema of document ${name}: ${(e as Error).message}`);
        }
      }
      return [name, { schema, classify: classifier(config, name) }];
    }),
  );
  return defineSurface({ documents, components: config.components, structural: config.structural });
}

export function buildSplit({ config }: LoadedConfig): Split {
  const { evolve, holdout } = config.tasks;
  return { evolve, ...(holdout?.length ? { holdout } : {}) };
}

const TrialSchema = z.strictObject({ reward: ScoreSchema, tokens: TokensSchema.exactOptional(), feedback: z.string().exactOptional() });

/** What an evaluator writes on stdout: one run per task, its trials' rewards (in [0, 1]), the tokens they spent, and what the verifier said. Fewer trials than k are missing trials. */
export const TaskRunsSchema = z.array(z.strictObject({ task: text, group: text.exactOptional(), weight: z.number().positive().exactOptional(), trials: z.array(TrialSchema) }));

export function parseTaskRuns(output: string): readonly TaskRun[] {
  let json: unknown;
  try {
    json = JSON.parse(output);
  } catch (e) {
    throw new Error(`the evaluator's output is not JSON: ${(e as Error).message}`);
  }
  const result = TaskRunsSchema.safeParse(json);
  if (!result.success) throw new Error(`the evaluator's output is not a list of task runs\n${z.prettifyError(result.error)}`);
  return result.data;
}

interface Command {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly input: string;
}

/** Run a command with `input` on stdin and answer its stdout; it fails with the command's stderr when it exits badly, cannot start, or takes too long. */
function run({ command, cwd, timeoutMs, input }: Command): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const [file, ...args] = command as [string, ...string[]];
    const child = spawn(file, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    // A child that exits before reading its input is reported by its exit code.
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`cannot start the evaluator ${file}: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`the evaluator took longer than ${timeoutMs} ms and was stopped`));
      else if (code !== 0) reject(new Error(`the evaluator exited with ${code === null ? `signal ${signal}` : `code ${code}`}${err.trim() ? `: ${err.trim()}` : ""}`));
      else resolvePromise(Buffer.concat(out).toString("utf8"));
    });
    child.stdin.end(input);
  });
}

/**
 * The evaluate port on a child process: each evaluation starts the configured command,
 * sends it `{documents, tasks, k}` and parses the task runs it writes (see TaskRunsSchema).
 * At most `concurrency` run at once.
 */
export function commandEvaluator({ config, dir }: LoadedConfig): EvolutionPorts["evaluate"] {
  const { command, cwd, timeoutMs, concurrency } = config.evaluator;
  const where = cwd === undefined ? dir : resolve(dir, cwd);
  let active = 0;
  const waiting: (() => void)[] = [];
  // A finished evaluation hands its slot to the next waiting one, so no more than `concurrency` ever run.
  const slot = async () => {
    if (active < concurrency) active++;
    else await new Promise<void>((r) => waiting.push(r));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return async (documents, tasks, k) => {
    await slot();
    try {
      return parseTaskRuns(await run({ command, cwd: where, timeoutMs, input: JSON.stringify({ documents, tasks, k }) }));
    } finally {
      release();
    }
  };
}
