import { z } from "zod";
import type { SnapshotStorage } from "@harness/core";
import { ConstraintSchema } from "@harness/cognitive";
import type { Constraint } from "@harness/cognitive";
import { evaluate } from "./sandbox.ts";
import type { EffectOp } from "./sandbox.ts";

/** What a workflow can do outside its sandbox. The host decides what a tool call reaches. */
export interface Effects {
  tool(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
  /** A question to a model; with a constraint (a template, JSON Schema...) the answer follows it where the model can enforce it. */
  ask(prompt: string, constraint?: Constraint): Promise<string>;
}

const FORMAT = "harness.workflow-run/v1";
const Entry = z.strictObject({ op: z.enum(["tool", "ask"]), request: z.unknown(), result: z.unknown() });
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
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );
}

/**
 * Run a workflow durably. Every effect's result is journaled before the code sees it,
 * so a run that stops (a failing effect, a crash, a restart) resumes by running the
 * code again: effects already in the journal are replayed, not performed, and the
 * run continues from the first one that is not. Replay is sound because workflow code
 * is deterministic (see sandbox.ts); a journal that no longer matches what the code
 * asks for is refused. A finished run returns its recorded result.
 */
export async function runWorkflow(options: {
  readonly name: string;
  readonly code: string;
  readonly input: unknown;
  readonly effects: Effects;
  /** Where this run's journal is kept; one journal per run. */
  readonly journal: SnapshotStorage;
  readonly budget?: number;
}): Promise<RunResult> {
  const { code, effects } = options;
  const input = JSON.parse(JSON.stringify(options.input ?? null)) as unknown;
  const loaded = await options.journal.load();
  let journal: Journal;
  if (loaded === undefined) journal = { format: FORMAT, workflow: options.name, code, input, entries: [], status: "running" };
  else {
    const parsed = Journal.safeParse(loaded);
    if (!parsed.success) throw new Error(`invalid workflow journal\n${z.prettifyError(parsed.error)}`);
    journal = parsed.data;
    if (journal.code !== code || canonical(journal.input) !== canonical(input)) throw new Error("this run was started with other code or input; start a new run");
  }
  const recorded = journal.entries.length;
  if (journal.status === "completed") return { status: "completed", output: journal.output, replayed: recorded, performed: 0 };

  let seq = 0;
  let performed = 0;
  const effect = async (op: EffectOp, request: unknown): Promise<unknown> => {
    const entry = journal.entries[seq++];
    if (entry) {
      if (entry.op !== op || canonical(entry.request) !== canonical(request)) {
        throw new Error(`step ${seq} diverged: the journal has ${entry.op} ${canonical(entry.request)}, the code asked for ${op} ${canonical(request)}`);
      }
      return entry.result;
    }
    const r = request as { name: string; args: Record<string, unknown> } & { prompt: string; constraint?: unknown };
    const perform = async () => {
      if (op === "tool") return effects.tool(r.name, r.args);
      if (r.constraint === undefined) return effects.ask(r.prompt);
      const constraint = ConstraintSchema.safeParse(r.constraint);
      if (!constraint.success) throw new Error(`ctx.ask was given a constraint that is not one: ${JSON.stringify(r.constraint)}`);
      return effects.ask(r.prompt, constraint.data);
    };
    const result = JSON.parse(JSON.stringify((await perform()) ?? null)) as unknown;
    journal = { ...journal, entries: [...journal.entries, { op, request, result }] };
    await options.journal.save(journal);
    performed++;
    return result;
  };

  const outcome = await evaluate(code, input, effect, options.budget);
  const replayed = Math.min(seq, recorded);
  if (outcome.ok) {
    await options.journal.save({ ...journal, status: "completed", output: outcome.value });
    return { status: "completed", output: outcome.value, replayed, performed };
  }
  await options.journal.save({ ...journal, status: "failed", error: outcome.error });
  return { status: "failed", error: outcome.error, replayed, performed };
}
