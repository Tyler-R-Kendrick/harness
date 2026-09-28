/**
 * One turn of a session log, projected into what the live learner and dream read
 * (plan §4.5, §6.1): learning's steps, the version pair guidance read (from the turn's
 * first step record, I3), how its steps localized, the path of matched nodes and the
 * actions that matched none.
 *
 * The entries are the daemon's own log entries, `{update}` (an ACP `SessionUpdate`) and
 * `{event, data}` payloads. A turn runs from its `turn.started` event to its
 * `turn.ended`. A tool call's title is the tool name (as `AgentWorker` emits it), a
 * step record is any update carrying `_meta.harness.procedural.step`, and a step's model
 * usage any update carrying `_meta.harness.procedural.usage`.
 *
 * Logs are compacted and read in ranges, so a turn may arrive without its start or with
 * holes: the projection never throws, it reports the missing offsets as gaps, and it
 * skips whatever it cannot read.
 */
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { EntryIdSchema, GraphIdSchema, NodeNameSchema, RevisionIdSchema, TrajectoryIdSchema } from "./graph.ts";
import type { EntryId, GraphId, NodeName, RevisionId, Score } from "./graph.ts";
import type { ScoredTrajectory } from "./trajectory.ts";

/** What a session log entry needs to be for projection: the daemon's `LogEntry` is one. */
export interface LogEntryLike {
  readonly offset: number;
  readonly payload: unknown;
  readonly at?: number;
  readonly kind?: string;
}

/** The pair a turn's guidance read (I3): a core revision and an overlay version (null without an overlay). */
export interface VersionPair {
  readonly graph: GraphId;
  readonly core: RevisionId;
  readonly overlay: number | null;
}

export type ScoreSource = NonNullable<ScoredTrajectory["scoreSource"]>;

export interface ProjectionContext {
  readonly sessionId: string;
  readonly turnId: string;
  /** The offset the entries were read from, so a compacted start shows as a gap. */
  readonly from?: number | undefined;
  /** The pair to use when the turn holds no step record (the session's pin). */
  readonly pin?: VersionPair | undefined;
  /** The node an action (a tool name) matches, as guidance matched it. Without it every action is unmatched. */
  readonly locate?: ((action: string) => NodeName | undefined) | undefined;
  /**
   * The terminal an edge from a node leads to (`terminalAfter` on the graph the session
   * saw). A turn that ends with a final answer where it stood walks on to that terminal.
   */
  readonly terminal?: ((node: NodeName) => NodeName | undefined) | undefined;
  readonly score?: { readonly score: Score; readonly source: ScoreSource } | null | undefined;
}

/** Offsets `[from, to)` that the entries lack. */
export interface LogGap {
  readonly from: number;
  readonly to: number;
}

export interface TurnProjection {
  readonly trajectory: ScoredTrajectory;
  /**
   * Matched nodes in order: where the turn began (when its first step record shows it),
   * then each action's node, then the terminal it answered into (see `turnProjection`).
   */
  readonly path: NodeName[];
  /** Actions that matched no node, in order. */
  readonly unmatched: string[];
  /** Probationary entries the step records say this turn was shown. */
  readonly shown: EntryId[];
  readonly gaps: LogGap[];
  /** Whether the turn's `turn.started` and `turn.ended` were among the entries. */
  readonly started: boolean;
  readonly ended: boolean;
  /** The offset after `turn.ended`, when it was seen. */
  readonly next: number | undefined;
}

type Step = ScoredTrajectory["steps"][number];

/** A trajectory id is at most 200 characters; longer `session/turn` keys are hashed. */
const MAX_ID = 200;

const count = z.int().min(0);
const tokens = count.optional().catch(undefined);
/** The fields of a step record the learner reads (plan §5.2); others are ignored. */
const StepRecordSchema = z.object({
  graph: GraphIdSchema,
  core: RevisionIdSchema,
  overlay: count.nullable(),
  node: NodeNameSchema.nullish().catch(undefined),
  matched: z.boolean(),
  inert: z.boolean().optional().catch(undefined),
  exposure: z.array(EntryIdSchema).catch([]),
  usage: z.object({ inputTokens: tokens, outputTokens: tokens }).optional().catch(undefined),
});
type StepRecord = z.output<typeof StepRecordSchema>;
/** A step's model usage, reported once the step ended (`StepUsageSchema` in step.ts). */
const UsageRecordSchema = z.object({ inputTokens: count, outputTokens: count });

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const field = (x: unknown, key: string): unknown => (isRecord(x) ? x[key] : undefined);
const text = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

/** The turn a boundary event names, and whether it starts or ends it. */
function boundary(payload: unknown): { event: string; turnId: unknown } | undefined {
  const event = field(payload, "event");
  if (event !== "turn.started" && event !== "turn.ended" && event !== "turn.interrupted") return undefined;
  return { event, turnId: field(field(payload, "data"), "turnId") };
}

/** Anything as text: strings verbatim, other values as canonical JSON, and what cannot be written as nothing. */
function render(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return value === undefined ? "" : canonicalJson(value);
  } catch {
    return "";
  }
}

/** The index range of the turn's entries (after its start, before its end), or undefined when the entries do not hold it. */
function window(entries: readonly LogEntryLike[], turnId: string): { begin: number; end: number; started: boolean; ended: boolean } | undefined {
  const marks = entries.map((e) => boundary(e.payload));
  const isEnd = (m: ReturnType<typeof boundary>): boolean => m?.event === "turn.ended" && m.turnId === turnId;
  const start = marks.findIndex((m) => m?.event === "turn.started" && m.turnId === turnId);
  if (start >= 0) {
    const rest = marks.slice(start + 1);
    const stop = rest.findIndex(isEnd);
    // Without its end, the turn runs to the next turn's start (one turn runs at a time).
    const next = rest.findIndex((m) => m?.event === "turn.started");
    const length = stop >= 0 ? stop : next >= 0 ? next : rest.length;
    return { begin: start + 1, end: start + 1 + length, started: true, ended: stop >= 0 };
  }
  const stop = marks.findIndex(isEnd);
  if (stop < 0) return undefined;
  let begin = stop;
  while (begin > 0 && marks[begin - 1] === undefined) begin -= 1;
  return { begin, end: stop, started: false, ended: true };
}

/** Offsets missing between consecutive entries (and before the first, when the read's start is known). */
function gapsIn(entries: readonly LogEntryLike[], from: number | undefined): LogGap[] {
  const gaps: LogGap[] = [];
  // With no known start, nothing before the first entry counts as missing.
  let expected = from ?? Number.POSITIVE_INFINITY;
  for (const e of entries) {
    if (!Number.isSafeInteger(e.offset)) continue;
    if (e.offset > expected) gaps.push({ from: expected, to: e.offset });
    expected = e.offset + 1;
  }
  return gaps;
}

/**
 * Project one turn. Undefined when the entries do not hold the turn, when the session or
 * turn id is empty, or when no version pair is known (no step record and no pin).
 *
 * Transitions into a terminal have no action of their own, so the path records one by
 * rule: when the turn ended (`turn.ended` in view, with stop reason `end_turn` or none),
 * its last update of substance is agent text that is not blank (after its last tool call
 * and result), and the node it answered from is known (its last action matched, or, with
 * no action, it began at a matched node), the path walks on to `context.terminal` of that
 * node, if any.
 */
export function turnProjection(entries: readonly LogEntryLike[], context: ProjectionContext): TurnProjection | undefined {
  const { sessionId, turnId } = context;
  if (sessionId === "" || turnId === "") return undefined;
  const span = window(entries, turnId);
  if (span === undefined) return undefined;
  const steps: Step[] = [];
  const actions: string[] = [];
  /** Tool call ids seen (undefined for calls without one, which never repeat). */
  const calls = new Set<string | undefined>();
  const records: StepRecord[] = [];
  /** The turn's model tokens, from its steps' usage records. */
  const model = { inputTokens: 0, outputTokens: 0 };
  let start: NodeName | undefined;
  /** Whether the turn's latest update of substance is a final answer: agent text after its last tool call and result. */
  let answered = false;
  const say = (role: "user" | "assistant", content: string): void => {
    const last = steps.at(-1);
    if (last !== undefined && last.role === role && last.call === undefined) steps[steps.length - 1] = { role, content: last.content + content };
    else steps.push({ role, content });
  };
  for (const entry of entries.slice(span.begin, span.end)) {
    const update = field(entry.payload, "update");
    const procedural = field(field(field(update, "_meta"), "harness"), "procedural");
    const used = field(procedural, "usage");
    if (used !== undefined) {
      const parsed = UsageRecordSchema.safeParse(used);
      if (parsed.success) {
        model.inputTokens += parsed.data.inputTokens;
        model.outputTokens += parsed.data.outputTokens;
      }
      continue;
    }
    const step = field(procedural, "step");
    if (step !== undefined) {
      const parsed = StepRecordSchema.safeParse(step);
      if (!parsed.success) continue;
      // The turn began where its first record localized, when nothing came before that record.
      if (records.length === 0 && actions.length === 0 && span.started && parsed.data.matched) start = parsed.data.node ?? undefined;
      records.push(parsed.data);
      continue;
    }
    const kind = field(update, "sessionUpdate");
    const chunk = text(field(field(update, "content"), "text"));
    if (kind === "user_message_chunk" && chunk !== undefined) say("user", chunk);
    else if ((kind === "agent_message_chunk" || kind === "agent_thought_chunk") && chunk !== undefined) {
      say("assistant", chunk);
      if (kind === "agent_message_chunk" && chunk.trim() !== "") answered = true;
    } else if (kind === "tool_call") {
      const name = text(field(update, "title"));
      const id = text(field(update, "toolCallId"));
      if (name === undefined || name === "" || (id !== undefined && calls.has(id))) continue;
      calls.add(id);
      const input = field(update, "rawInput");
      const args = isRecord(input) ? input : input === undefined ? {} : { input };
      steps.push({ role: "assistant", content: "", call: { name, arguments: args } });
      actions.push(name);
      answered = false;
    } else if (kind === "tool_call_update") {
      const status = field(update, "status");
      if (status === "completed" || status === "failed") {
        steps.push({ role: "tool", content: render(field(update, "rawOutput")) });
        answered = false;
      }
    }
  }

  const first = records[0];
  const pair: VersionPair | undefined = first === undefined ? context.pin : { graph: first.graph, core: first.core, overlay: first.overlay };
  if (pair === undefined) return undefined;

  const path: NodeName[] = start === undefined ? [] : [start];
  const unmatched: string[] = [];
  /** Where the turn stands: its last action's node, or where it began; undefined once an action matched nothing. */
  let at = start;
  for (const action of actions) {
    at = context.locate?.(action);
    if (at === undefined) unmatched.push(action);
    else path.push(at);
  }
  const stopReason = field(field(entries[span.end]?.payload, "data"), "stopReason");
  const finished = span.ended && (stopReason === undefined || stopReason === "end_turn");
  const terminal = finished && answered && at !== undefined ? context.terminal?.(at) : undefined;
  if (terminal !== undefined) path.push(terminal);
  const shown: EntryId[] = [];
  for (const r of records) for (const id of r.exposure) if (!shown.includes(id)) shown.push(id);
  const localization = { matched: 0, fallback: 0, inert: 0 };
  let guidanceTokens = 0;
  for (const r of records) {
    localization[r.inert ? "inert" : r.matched ? "matched" : "fallback"] += 1;
    guidanceTokens += (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
  }

  const key = `${sessionId}/${turnId}`;
  const score = context.score ?? null;
  const trajectory: ScoredTrajectory = {
    id: TrajectoryIdSchema.parse(key.length > MAX_ID ? sha256Hex(key) : key),
    graph: pair.graph,
    core: pair.core,
    overlay: pair.overlay,
    session: sessionId,
    turn: turnId,
    query: steps.filter((s) => s.role === "user").map((s) => s.content).join(""),
    steps,
    score: score?.score ?? null,
    scoreSource: score?.source ?? null,
    localization,
    usage: { steps: steps.length, ...model, guidanceTokens },
  };
  // The turn's entries with the boundary before them (its start, or another turn's), so a hole there counts;
  // with no boundary in view, the read's start is where the turn could have begun.
  const inTurn = entries.slice(Math.max(0, span.begin - 1), span.end + (span.ended ? 1 : 0));
  const gaps = gapsIn(inTurn, !span.started && span.begin === 0 ? context.from : undefined);
  const endOffset = entries[span.end]?.offset;
  const next = span.ended && Number.isSafeInteger(endOffset) ? endOffset! + 1 : undefined;
  return { trajectory, path, unmatched, shown, gaps, started: span.started, ended: span.ended, next };
}

/** The turn's scored trajectory (see `turnProjection`). */
export const projectTurn = (entries: readonly LogEntryLike[], context: ProjectionContext): ScoredTrajectory | undefined => turnProjection(entries, context)?.trajectory;
