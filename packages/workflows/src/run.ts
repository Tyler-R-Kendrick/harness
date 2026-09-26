import { experimental_runCodeMode as runCodeMode } from "@ai-sdk/code-mode";
import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";
import type { SnapshotStorage } from "@harness/core";
import { ConstraintSchema, validatedSchema } from "@harness/cognitive";
import type { Constraint } from "@harness/cognitive";

/** What a workflow can do outside its sandbox. The host decides what a tool call reaches. */
export interface Effects {
  tool(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
  /** A question to a model; with a constraint (a template, JSON Schema...) the answer follows it where the model can enforce it. */
  ask(prompt: string, constraint?: Constraint): Promise<string>;
}

/** A tool a workflow can call: its input schema checks each call (the description is for whoever writes the code). */
export interface ToolSpec {
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

export type EffectOp = "tool" | "ask";

/** `tools.ask` is the model; a tool of that name cannot be offered. */
export const ASK = "ask";

const FORMAT = "harness.workflow-run/v2";
const Entry = z.strictObject({ seq: z.int().nonnegative(), op: z.enum(["tool", "ask"]), request: z.unknown(), result: z.unknown() });
const Journal = z.strictObject({
  format: z.literal(FORMAT),
  workflow: z.string().min(1),
  code: z.string(),
  input: z.unknown(),
  entries: z.array(Entry),
  status: z.enum(["running", "completed", "failed"]),
  output: z.unknown().optional(),
  error: z.string().optional(),
});
type Journal = z.output<typeof Journal>;

export type RunResult =
  | { readonly status: "completed"; readonly output: unknown; readonly replayed: number; readonly performed: number }
  | { readonly status: "failed"; readonly error: string; readonly replayed: number; readonly performed: number };

/** JSON with object keys sorted, so equal values compare equal as text. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    // Stryker disable next-line EqualityOperator: equivalent; an object's keys are never equal, so < and <= order them alike
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );
}

const Ask = z.strictObject({ prompt: z.string(), constraint: z.unknown().optional() });
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null)) as unknown;
// Code mode rejects with an Error whatever the code throws; its text is "name: message".
const message = (e: unknown) => String(e);

/**
 * Run a workflow durably. The code runs in AI SDK code mode (an isolated QuickJS
 * worker with time, memory and stack limits); its only way out is `tools`, and every
 * call's result is journaled before the code sees it. A run that stops (a failing
 * effect, a crash, a restart) resumes by running the code again: calls already in the
 * journal are replayed, not performed, and the run continues from the first that is
 * not. Calls are numbered in the order the code makes them, so parallel calls replay
 * too; a call that does not match its journal entry (the code is not deterministic,
 * or the journal was edited) is refused, never performed again. A failing effect stops
 * the run at once, so the code cannot swallow it and resume retries it. A finished run
 * returns its recorded result.
 */
export async function runWorkflow(options: {
  readonly name: string;
  readonly code: string;
  readonly input: unknown;
  readonly effects: Effects;
  /** The tools the code may call, besides `tools.ask`. */
  readonly tools?: Readonly<Record<string, ToolSpec>>;
  /** Where this run's journal is kept; one journal per run. */
  readonly journal: SnapshotStorage;
  /** Wall-clock limit for the code between effects (code mode's timeout), in milliseconds. */
  readonly timeoutMs?: number;
}): Promise<RunResult> {
  const { code, effects } = options;
  if (options.tools && Object.hasOwn(options.tools, ASK)) throw new Error(`a tool cannot be named ${ASK}: tools.ask is the model`);
  const input = json(options.input);
  const loaded = await options.journal.load();
  let journal: Journal;
  if (loaded === undefined) journal = { format: FORMAT, workflow: options.name, code, input, entries: [], status: "running" };
  else {
    const parsed = Journal.safeParse(loaded);
    if (!parsed.success) throw new Error(`invalid workflow journal\n${z.prettifyError(parsed.error)}`);
    journal = parsed.data;
    if (journal.code !== code || canonical(journal.input) !== canonical(input)) throw new Error("this run was started with other code or input; start a new run");
  }
  const recorded = new Map(journal.entries.map((e) => [e.seq, e]));
  if (journal.status === "completed") return { status: "completed", output: journal.output, replayed: recorded.size, performed: 0 };

  let seq = 0;
  let replayed = 0;
  let performed = 0;
  const abort = new AbortController();
  let failure: { error: unknown } | undefined;
  // Code mode reports a host tool's error without its message; the last one is kept to say why a run failed.
  // (Once the run is aborted, code mode performs no further calls.)
  let toolError: string | undefined;
  /** Stop the run on a failed effect: the abort ends the code, and this call never settles, so the code cannot catch it. */
  const stop = (error: unknown): Promise<never> => {
    failure ??= { error };
    abort.abort();
    return new Promise<never>(() => {});
  };
  // Journal writes are serialized: entries are saved in the order they complete.
  let saving: Promise<void> = Promise.resolve();

  const effect = async (op: EffectOp, request: unknown): Promise<unknown> => {
    const n = seq++;
    const entry = recorded.get(n);
    if (entry) {
      if (canonical({ op: entry.op, request: entry.request }) !== canonical({ op, request })) {
        return stop(new Error(`step ${n + 1} diverged: the journal has ${entry.op} ${canonical(entry.request)}, the code asked for ${op} ${canonical(request)}`));
      }
      replayed++;
      return entry.result;
    }
    try {
      const r = request as { name: string; args: Record<string, unknown> } & { prompt: string; constraint?: Constraint };
      const result = json(op === "tool" ? await effects.tool(r.name, r.args) : await effects.ask(r.prompt, r.constraint));
      journal = { ...journal, entries: [...journal.entries, { seq: n, op, request, result }] };
      const snapshot = journal;
      await (saving = saving.then(() => options.journal.save(snapshot)));
      performed++;
      return result;
    } catch (error) {
      return stop(error);
    }
  };

  const tools: Record<string, Tool> = {
    [ASK]: tool({
      inputSchema: Ask,
      execute: async ({ prompt, constraint }) => {
        if (constraint === undefined) return effect("ask", { prompt });
        const parsed = ConstraintSchema.safeParse(constraint);
        if (!parsed.success) throw new Error((toolError = `tools.ask was given a constraint that is not one: ${JSON.stringify(constraint)}`));
        return effect("ask", { prompt, constraint: parsed.data });
      },
    }),
    ...Object.fromEntries(
      Object.entries(options.tools ?? {}).map(([name, spec]) => [
        name,
        tool({
          inputSchema: validatedSchema(spec.inputSchema ?? {}),
          execute: async (args: unknown) => effect("tool", { name, args: args ?? {} }),
        }),
      ]),
    ),
  };

  let outcome: { ok: true; value: unknown } | { ok: false; error: string };
  try {
    const value = await runCodeMode({
      js: `const input = ${JSON.stringify(input)};\n${code}`,
      tools,
      toolExecutionOptions: { abortSignal: abort.signal },
      // Stryker disable next-line ConditionalExpression: equivalent; code mode reads an undefined limit as its default
      ...(options.timeoutMs === undefined ? {} : { options: { executionPolicy: { timeoutMs: options.timeoutMs } } }),
    });
    outcome = { ok: true, value: json(value) };
  } catch (e) {
    const error = message(e);
    outcome = { ok: false, error: toolError && /Host tool failed/.test(error) ? `${error} ${toolError}` : error };
  }
  await saving;
  // A failed effect leaves the run resumable: nothing is recorded as its outcome.
  if (failure) throw failure.error;
  if (outcome.ok) {
    await options.journal.save({ ...journal, status: "completed", output: outcome.value });
    return { status: "completed", output: outcome.value, replayed, performed };
  }
  await options.journal.save({ ...journal, status: "failed", error: outcome.error });
  return { status: "failed", error: outcome.error, replayed, performed };
}

