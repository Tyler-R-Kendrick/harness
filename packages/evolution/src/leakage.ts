import type { Change } from "./surface.ts";

/** A task of the evolve set, as the leakage screen sees it: its id, its text, and a reference answer if it has one. */
export interface Task {
  readonly id: string;
  readonly text: string;
  readonly reference?: string;
  /** The cluster it was drawn with (see TaskRun.group). */
  readonly group?: string;
}

const CREDENTIAL = /AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{20,}|api_key\s*=\s*["'][^"']{8,}/;

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) yield* strings(v);
}

const escape = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/**
 * The deterministic half of the paper's critic, and stricter than a denylist: the text an
 * edit adds must not name an evolve task, repeat a run of `ngram` words from any task's
 * text or reference answer, or carry a credential. Screening happens before evaluation,
 * so a leaking candidate never earns the inflated score that would make later rounds
 * build on it. What it cannot see is fitting that copies no words (a rule tuned to the
 * suite's habits); only data the search never saw can catch that (the holdout). The text
 * an edit adds is screened like an added JSON string: a text edit's `new`, a replaced whole
 * text; what it removes adds nothing.
 */
export function leaks(changes: readonly Change[], tasks: readonly Task[], settings: { readonly ngram: number }): string[] {
  const added = changes.flatMap((c) => c.wrote.flatMap((op) => (op.op === "remove" ? [] : op.op === "edit" ? [op.new] : [...strings(op.value)])));
  const reasons: string[] = [];
  if (added.some((s) => CREDENTIAL.test(s))) reasons.push("it carries a credential");
  const grams = new Map<string, string>();
  for (const t of tasks) {
    const ws = words(`${t.text} ${t.reference ?? ""}`);
    for (let i = 0; i + settings.ngram <= ws.length; i++) {
      const g = ws.slice(i, i + settings.ngram).join(" ");
      if (!grams.has(g)) grams.set(g, t.id);
    }
  }
  const leaked = new Map<string, string>();
  for (const s of added) {
    for (const t of tasks) if (new RegExp(`(?<![\\p{L}\\p{N}])${escape(t.id)}(?![\\p{L}\\p{N}])`, "iu").test(s) && !reasons.includes(`it names task ${t.id}`)) reasons.push(`it names task ${t.id}`);
    const ws = words(s);
    for (let i = 0; i + settings.ngram <= ws.length; i++) {
      const g = ws.slice(i, i + settings.ngram).join(" ");
      const task = grams.get(g);
      if (task !== undefined && !leaked.has(task)) leaked.set(task, g);
    }
  }
  for (const [task, g] of leaked) reasons.push(`it repeats "${g}" from task ${task}`);
  return reasons;
}
