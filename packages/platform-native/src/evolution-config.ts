import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { exponential } from "@harness/dialogue";
import { defineSurface, ScoreSchema, TokensSchema } from "@harness/evolution";
import type { DocumentInput, Documents, EvolutionPorts, Split, Surface, TaskRun } from "@harness/evolution";
import { HAS_GROUPS, killGroup, runInGroup } from "./process-group.ts";

const text = z.string().min(1);

/** The most an evaluator's stdout may be capped at (a string this long is about all a process can hold): 256 MiB. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
/** What an evaluator may write to stdout unless its configuration says more: 64 MiB. */
const DEFAULT_OUTPUT_BYTES = 64 * 1024 * 1024;
const pointer = z.string().regex(/^(\/.*)?$/, "a JSON Pointer (empty, or starting with /)");

/** A regular expression that compiles and cannot take exponential time (the dialogue's guard, which refuses the patterns models write; a config's are checked the same way). */
const PatternSchema = z
  .string()
  .min(1)
  .superRefine((source, ctx) => {
    try {
      new RegExp(source);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: `not a regular expression: ${(e as Error).message}` });
      return;
    }
    if (exponential(source)) ctx.addIssue({ code: "custom", message: `can take exponential time: ${source}` });
  });

/** The variables a command's environment has of the parent's unless its `env` says more: enough to find programs and behave in the locale, and none of the credentials the harness itself holds. */
const DEFAULT_ENV: readonly string[] = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM"];
/** What a Windows program cannot start without. */
const WINDOWS_ENV: readonly string[] = ["SystemRoot", "PATHEXT", "COMSPEC"];

const EnvNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an environment variable name (letters, digits and _, not starting with a digit)");

/**
 * The environment of a command that runs model-edited documents (an evaluator, a check). It
 * gets none of the parent's environment (AI_GATEWAY_API_KEY and the like) except PATH, HOME,
 * LANG, LC_ALL, TMPDIR and TERM, plus the variables named in `allow`, copied from the parent
 * when it has them; `set` gives literal values and wins over a copy.
 */
export const EnvSchema = z
  .strictObject({
    /** Names of parent variables to pass on, in addition to PATH, HOME, LANG, LC_ALL, TMPDIR and TERM. */
    allow: z.array(EnvNameSchema).exactOptional(),
    /** Variables given literal values. */
    set: z.record(EnvNameSchema, z.string()).exactOptional(),
  }).describe("The command's whole environment: never the parent's. Only PATH, HOME, LANG, LC_ALL, TMPDIR and TERM are copied from the parent (so credentials such as AI_GATEWAY_API_KEY are not visible to the command); allow names more variables to copy, set gives literal values.");
export type CommandEnv = z.output<typeof EnvSchema>;

/** The whole environment a child gets: never the parent's, only what `env` allows and sets. */
export function childEnvironment(env: CommandEnv | undefined, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const names = [...DEFAULT_ENV, ...(HAS_GROUPS ? [] : WINDOWS_ENV), ...(env?.allow ?? [])];
  const result: Record<string, string> = {};
  for (const name of names) {
    // Windows names its variables without regard to case.
    const key = HAS_GROUPS ? name : Object.keys(parent).find((k) => k.toLowerCase() === name.toLowerCase());
    const value = key === undefined ? undefined : parent[key];
    if (key !== undefined && value !== undefined) result[key] = value;
  }
  return { ...result, ...env?.set };
}

/** A JSON document: a file of JSON, the schema it must keep satisfying (a JSON Schema file), and which paths are which component (see `classify`). */
const JsonDocumentSchema = z.strictObject({ kind: z.literal("json").exactOptional(), path: text, schema: text.exactOptional() });

/**
 * A text document (`kind: "text"`): a file that is raw text, such as source code or prose,
 * edited by replacing text that occurs exactly once, and written back verbatim. Each changed
 * region (the text an edit replaced and what it wrote) belongs to the component of the first
 * of `regions` whose pattern matches either, else to `component` (else `prompt`). `check` is
 * a liveness command: it gets the whole text on stdin, exits 0 when the text is fine, and
 * otherwise says why on stderr (its first line is the problem the proposer is shown).
 */
const TextDocumentSchema = z.strictObject({
  kind: z.literal("text"),
  path: text,
  component: text.exactOptional(),
  regions: z.array(z.strictObject({ pattern: PatternSchema, component: text })).default([]),
  check: z
    .strictObject({
      command: z.array(text).min(1),
      /** Where it runs; by default the configuration file's directory. */
      cwd: text.exactOptional(),
      /** The check's time limit; a check that takes longer fails the candidate. */
      timeoutMs: z.int().positive().default(10_000),
      /** Its environment: by default only PATH, HOME, LANG, LC_ALL, TMPDIR and TERM of the parent's (never its credentials); `allow` names more, `set` gives values. */
      env: EnvSchema.exactOptional(),
    })
    .describe("A liveness command run synchronously (it blocks the run for at most timeoutMs). It runs in a process group of its own, which is killed at the time limit and after every run; the direct child is killed with SIGKILL and its output is bounded to 64 KiB. Limits: a process that made its own session or process group (setsid) escapes, on Windows only the direct child is killed, and a signal to the harness-evolution process is handled only after the check returns.")
    .exactOptional(),
});

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
    /** The evolvable harness: document name (what edits and the evaluator call it) to its file: JSON (with the JSON Schema it must keep satisfying) or, with `kind: "text"`, raw text. */
    documents: z.record(text, z.discriminatedUnion("kind", [JsonDocumentSchema, TextDocumentSchema])),
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
      command: z.array(text).min(1).describe("The evaluator's argv. It runs in a process group of its own, which is killed (SIGTERM, then SIGKILL) when it times out, overflows its output limit, or the harness-evolution process exits or is signalled; a process that made its own session escapes, and on Windows only the direct child is killed."),
      /** Where it runs; by default the configuration file's directory. */
      cwd: text.exactOptional(),
      /** One evaluation's time limit. */
      timeoutMs: z.int().positive().default(600_000),
      /** Evaluations that run at once (a round measures several harnesses in one window). */
      concurrency: z.int().positive().default(2),
      /** The most it may write to stdout, in bytes: an evaluator that writes more is killed and the evaluation fails. Default 64 MiB. */
      maxOutputBytes: z.int().positive().max(MAX_OUTPUT_BYTES).describe("The most the evaluator may write to stdout, in bytes (default 67108864, 64 MiB; at most 268435456). An evaluator that writes more is killed with its process group and the evaluation fails.").exactOptional(),
      /** Its environment: by default only PATH, HOME, LANG, LC_ALL, TMPDIR and TERM of the parent's (never its credentials, such as AI_GATEWAY_API_KEY); `allow` names more, `set` gives values. */
      env: EnvSchema.exactOptional(),
    }),
    /** The evolution settings file; by default @harness/evolution's data/settings.json. */
    settings: text.exactOptional(),
    /** Where the run's state is kept; by default beside the configuration file. */
    state: text.exactOptional(),
  })
  .superRefine((c, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    if (Object.keys(c.documents).length === 0) issue(["documents"], "name at least one document");
    for (const [name, d] of Object.entries(c.documents)) {
      if (d.kind !== "text") continue;
      if (d.component !== undefined && !c.components.includes(d.component)) issue(["documents", name, "component"], `not one of the components: ${d.component}`);
      if (d.component === undefined && !c.components.includes("prompt")) issue(["documents", name, "component"], "a text document without a component is a prompt, which is not one of the components");
      for (const [i, r] of d.regions.entries()) if (!c.components.includes(r.component)) issue(["documents", name, "regions", i, "component"], `not one of the components: ${r.component}`);
    }
    for (const [i, s] of c.structural.entries()) if (!c.components.includes(s)) issue(["structural", i], `structural components must be components: ${s}`);
    for (const [i, r] of c.classify.rules.entries()) {
      if (!c.components.includes(r.component)) issue(["classify", "rules", i, "component"], `not one of the components: ${r.component}`);
      if (r.document !== undefined && !Object.hasOwn(c.documents, r.document)) issue(["classify", "rules", i, "document"], `not a document: ${r.document}`);
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

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A text file's text, exactly: line endings and a byte order mark kept; bytes that are not UTF-8 would not survive being written back, so they are refused. */
const readText = (path: string, what: string): string => {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    throw new Error(`cannot read ${what} ${path}: ${(e as Error).message}`);
  }
  try {
    return utf8.decode(bytes);
  } catch {
    throw new Error(`${what} ${path} is not UTF-8 text`);
  }
};

/** Whether a document is text (a file written back verbatim) rather than JSON. */
export const isTextDocument = ({ config }: LoadedConfig, name: string): boolean => config.documents[name]!.kind === "text";

/** The files of the surface's documents: JSON parsed, text as it is. */
export function readDocuments(loaded: LoadedConfig): Documents {
  const { config, dir } = loaded;
  return Object.fromEntries(Object.entries(config.documents).map(([name, d]) => [name, d.kind === "text" ? readText(resolve(dir, d.path), `document ${name}`) : readJson(resolve(dir, d.path), `document ${name}`)]));
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

/** The first line of a check's stderr, trimmed and bounded: the problem the proposer is shown. */
const firstLine = (stderr: string) => {
  const line = stderr.trim().split("\n")[0]!.trim();
  return line.length > 300 ? `${line.slice(0, 300)}...` : line;
};

/** The most a check may write, on either stream. */
const CHECK_OUTPUT_LIMIT = 64 * 1024;

/**
 * A text document's liveness check as the surface declares it: a synchronous function of
 * the text. `Surface.check` is synchronous (applying a proposal is), so this runs the
 * command with `spawnSync`, which blocks this process for at most `timeoutMs`; nothing
 * else in a round runs meanwhile, and evaluations are child processes, not this thread.
 * Exit 0 is fine. A nonzero exit, a time out and output past the bound are the candidate's
 * problem (a change can hang or flood a compiler). A command that cannot start is not:
 * it throws, so the round fails instead of every candidate being refused for the host's fault.
 *
 * The command runs in a process group of its own and only the environment `env` allows
 * (see EnvSchema). `spawnSync` kills only the direct child (with SIGKILL, which cannot be
 * ignored) at the time limit or the output bound; the group is then killed too, and it is
 * killed after every run, so no process the check started is left behind. Limits: a process
 * that made its own session or group (`setsid`) escapes; on Windows there are no groups and
 * only the direct child is killed; and a check cannot be interrupted by a signal to this
 * process while it runs (a synchronous call blocks the event loop), only stopped by its
 * time limit.
 */
export function textCheck({ command, cwd, timeoutMs, env }: { readonly command: readonly string[]; readonly cwd?: string; readonly timeoutMs: number; readonly env?: CommandEnv }, dir: string): (text: string) => string | undefined {
  const [file, ...args] = command as [string, ...string[]];
  const where = cwd === undefined ? dir : resolve(dir, cwd);
  return (input) => {
    // `detached` makes the child a group leader; spawnSync honors it although its typings do not list it.
    const options: SpawnSyncOptionsWithStringEncoding = { cwd: where, env: childEnvironment(env), input, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: CHECK_OUTPUT_LIMIT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...{ detached: HAS_GROUPS } };
    const r = spawnSync(file, args, options);
    // Whatever the check started and left running goes with it (the leader is gone by now; its group id is its pid).
    if (HAS_GROUPS && r.pid) killGroup(r.pid, "SIGKILL");
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ETIMEDOUT") return `the check took longer than ${timeoutMs} ms and was stopped`;
    if (code === "ENOBUFS") return `the check wrote more than ${CHECK_OUTPUT_LIMIT} bytes and was stopped`;
    // A child that exits before reading its input closes the pipe: its exit code says why.
    if (r.error && code !== "EPIPE") throw new Error(`cannot start the check ${file}: ${r.error.message}`);
    if (r.status === 0) return undefined;
    if (r.status === null) return `the check was stopped by signal ${r.signal}`;
    return firstLine(r.stderr) || `the check exited with code ${r.status}`;
  };
}

/** A text document's classifier of a changed region: the component of the first region whose pattern matches its old or its new text; none when no region does (the document's component then applies). */
function regionClassifier(regions: readonly { readonly pattern: string; readonly component: string }[]): (before: string, after: string) => readonly string[] {
  const patterns = regions.map((r) => ({ test: new RegExp(r.pattern), component: r.component }));
  return (before, after) => {
    const hit = patterns.find((p) => p.test.test(before) || p.test.test(after));
    return hit === undefined ? [] : [hit.component];
  };
}

/**
 * The surface the configuration names. A JSON document's schema is a JSON Schema file,
 * turned into a zod schema by zod's own `fromJSONSchema` (no validator of ours); a
 * document without one only has to be a JSON object or array. A text document is the
 * surface's own text document, with its regions as `classifyText` and its `check` command.
 */
export function buildSurface({ config, dir }: LoadedConfig): Surface {
  const documents = Object.fromEntries(
    Object.entries(config.documents).map(([name, d]): [string, DocumentInput] => {
      if (d.kind === "text")
        return [
          name,
          {
            kind: "text",
            ...(d.component === undefined ? {} : { component: d.component }),
            ...(d.regions.length ? { classifyText: regionClassifier(d.regions) } : {}),
            ...(d.check === undefined ? {} : { check: textCheck(d.check, dir) }),
          },
        ];
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
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly input: string;
}

/**
 * Run a command with `input` on stdin and answer its stdout; it fails with the command's
 * stderr when it exits badly, cannot start, takes too long or writes too much. It runs in
 * its own process group, which is killed when it is stopped (see runInGroup).
 */
async function run({ command, ...rest }: Command): Promise<string> {
  const file = command[0]!;
  const r = await runInGroup({ command, ...rest });
  switch (r.kind) {
    case "timeout":
      throw new Error(`the evaluator took longer than ${rest.timeoutMs} ms and was stopped`);
    case "overflow":
      throw new Error(`the evaluator wrote more than ${rest.maxOutputBytes} bytes on stdout and was stopped`);
    case "spawn-error":
      throw new Error(`cannot start the evaluator ${file}: ${r.error.message}`);
    default:
      if (r.code !== 0) throw new Error(`the evaluator exited with ${r.code === null ? `signal ${r.signal}` : `code ${r.code}`}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}`);
      return r.stdout.toString("utf8");
  }
}

/**
 * The evaluate port on a child process: each evaluation starts the configured command,
 * sends it `{documents, tasks, k}` and parses the task runs it writes (see TaskRunsSchema).
 * At most `concurrency` run at once.
 */
export function commandEvaluator({ config, dir }: LoadedConfig): EvolutionPorts["evaluate"] {
  const { command, cwd, timeoutMs, concurrency, env } = config.evaluator;
  const maxOutputBytes = config.evaluator.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
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
      // The environment is read now, not when the config was parsed: it is the parent's at the time of the run.
      return parseTaskRuns(await run({ command, cwd: where, env: childEnvironment(env), timeoutMs, maxOutputBytes, input: JSON.stringify({ documents, tasks, k }) }));
    } finally {
      release();
    }
  };
}
