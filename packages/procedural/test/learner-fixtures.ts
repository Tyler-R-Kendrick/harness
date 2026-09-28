/** Session logs as the daemon writes them (`{update}` and `{event, data}` payloads), for the live learner's tests. */
import { revisionId, RevisionRecordSchema } from "@harness/procedural";
import type { AppendLog, EntryId, GraphId, Head, Lease, LogEntryLike, OverlayEvent, Pin, ProceduralGraph, ProceduralStore, RevisionId, RevisionRecord } from "@harness/procedural";
import { core } from "./overlay-fixtures.ts";

export const GRAPH = "repo/harness";
export const CORE = revisionId(core());

export type Payload = { update: Record<string, unknown>; origin?: string } | { event: string; data: Record<string, unknown> };

/** Entries at consecutive offsets from `from`. */
export const logOf = (payloads: readonly unknown[], from = 0): LogEntryLike[] =>
  payloads.map((payload, i) => ({ offset: from + i, at: 1000 + i, kind: typeof payload === "object" && payload !== null && "update" in payload ? "update" : "event", payload }));

export const started = (turnId: string): Payload => ({ event: "turn.started", data: { turnId, by: "n1" } });
export const ended = (turnId: string, stopReason = "end_turn"): Payload => ({ event: "turn.ended", data: { turnId, stopReason } });
export const user = (text: string): Payload => ({ update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } }, origin: "c1" });
export const said = (text: string): Payload => ({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
export const thought = (text: string): Payload => ({ update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } } });
/** A tool call as AgentWorker emits it: the title is the tool name. */
export const call = (id: string, tool: string, input: unknown = {}): Payload => ({ update: { sessionUpdate: "tool_call", toolCallId: id, title: tool, kind: "other", status: "pending", rawInput: input } });
export const result = (id: string, output: unknown, status = "completed"): Payload => ({ update: { sessionUpdate: "tool_call_update", toolCallId: id, status, rawOutput: output } });

export interface RecordInput {
  node?: string | null;
  matched?: boolean;
  overlay?: number | null;
  exposure?: EntryId[];
  usage?: unknown;
  graph?: string;
  core?: string;
  inert?: boolean;
}

/** A step record: a notice carrying `_meta.harness.procedural.step` (plan §5.2). */
export function record(input: RecordInput = {}): Payload {
  const step = {
    graph: input.graph ?? GRAPH,
    core: input.core ?? CORE,
    overlay: input.overlay === undefined ? 0 : input.overlay,
    node: input.node === undefined ? "Start" : input.node,
    matched: input.matched ?? true,
    others: [],
    cached: false,
    guidanceId: "g1",
    digest: "d1",
    exposure: input.exposure ?? [],
    usage: input.usage ?? { inputTokens: 100, outputTokens: 20 },
    ...(input.inert === undefined ? {} : { inert: input.inert }),
  };
  return { update: { sessionUpdate: "notice", severity: "info", title: "Procedural step", _meta: { harness: { procedural: { step } } } } };
}

/** A step's model usage: a notice carrying `_meta.harness.procedural.usage`. */
export const used = (usage: unknown): Payload => ({ update: { sessionUpdate: "notice", severity: "info", title: "Procedural step usage", _meta: { harness: { procedural: { usage } } } } });

/**
 * A small in-memory `ProceduralStore` for the learner's tests (only what the learner
 * uses does anything). It counts appends so tests can see what happened.
 */
export class FakeStore implements ProceduralStore {
  readonly logs = new Map<string, OverlayEvent[]>();
  readonly records = new Map<string, RevisionRecord>();
  readonly headOf = new Map<string, RevisionId>();
  readonly pinOf = new Map<string, Pin>();
  appends = 0;

  readonly revisions = {
    put: async (r: RevisionRecord): Promise<void> => void this.records.set(r.id, r),
    get: async (id: RevisionId): Promise<RevisionRecord | undefined> => this.records.get(id),
    list: async (): Promise<readonly RevisionRecord[]> => [...this.records.values()],
  };
  readonly heads = {
    get: async (graph: GraphId): Promise<Head | undefined> => {
      const revision = this.headOf.get(graph);
      return revision === undefined ? undefined : { revision, history: [] };
    },
    set: async (graph: GraphId, _expected: RevisionId | undefined, next: RevisionId): Promise<boolean> => {
      this.headOf.set(graph, next);
      return true;
    },
  };
  readonly pins = {
    get: async (session: string): Promise<Pin | undefined> => this.pinOf.get(session),
    set: async (session: string, pin: Pin): Promise<void> => void this.pinOf.set(session, pin),
  };
  readonly guidance = { put: async (): Promise<void> => undefined, get: async (): Promise<string | undefined> => undefined };
  readonly lease = { acquire: async (): Promise<Lease | undefined> => ({ epoch: 1 }), renew: async (): Promise<boolean> => true, release: async (): Promise<boolean> => true };

  overlay(graph: GraphId): AppendLog<OverlayEvent> {
    const events = this.logs.get(graph) ?? [];
    this.logs.set(graph, events);
    return {
      append: async (more) => {
        this.appends += 1;
        events.push(...more);
        return events.length;
      },
      read: async (from, limit = Number.POSITIVE_INFINITY) => events.slice(from, from + limit).map((event, i) => ({ offset: from + i, event })),
      head: async () => events.length,
    };
  }

  dreams(): AppendLog<unknown> {
    return { append: async () => 0, read: async () => [], head: async () => 0 };
  }

  async redact(): Promise<void> {}

  /** The graph's overlay events. */
  events(graph = GRAPH): OverlayEvent[] {
    return this.logs.get(graph) ?? [];
  }
}

/** A revision record holding a graph (a seed). */
export function revisionOf(g: ProceduralGraph, graph = GRAPH): RevisionRecord {
  return RevisionRecordSchema.parse({ id: revisionId(g), graph, parents: [], document: g, edits: null, origin: "seed", evidence: {}, decision: { kind: "head" }, at: 0 });
}
