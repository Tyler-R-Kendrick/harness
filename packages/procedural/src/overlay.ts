/**
 * The dynamic layer (plan §4.4, §6): overlay state is a pure fold over an append-only
 * event log, and the effective graph is `core ⊕ overlay`.
 *
 * - I2: the effective graph holds every core node and edge with its core attributes. The
 *   overlay only adds nodes and edges and annotates edges; a node entry that names a
 *   core node, or an edge entry that repeats an edge, is not shown.
 * - I4: the fold is deterministic, and a redelivered `observed` event (by turn key) or
 *   `proposed` event (nothing new to support) changes nothing, not even the version. So
 *   `version` counts the events that changed the state.
 * - I6: an entry is shown only when its anchors are in the effective graph, and a rebase
 *   drops the entries whose anchors the new core lacks.
 *
 * The fold cannot see the core, so it keeps statistics and session support for every
 * observed pair of consecutive matched nodes; the policy (`overlay-policy.ts`), which
 * has the core, decides which pairs are transitions the graph lacks.
 */
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { EntryIdSchema, revisionId } from "./graph.ts";
import type { EntryId, ProceduralGraph, RevisionId } from "./graph.ts";
import type { EdgeStats, EffectiveEdge, EffectiveGraph, EffectiveNode, EntryEvidence, OverlayEntry, OverlayEvent, OverlayState, TransitionStats } from "./overlay-types.ts";

/** Turn keys kept for redelivery checks; the oldest are dropped beyond this. */
export const MAX_TURNS = 10_000;
/** Distinct sessions kept per transition and per entry's support. */
export const MAX_SESSIONS = 64;

type Recorded = OverlayState["entries"][EntryId];
type Observed = Extract<OverlayEvent, { kind: "observed" }>;

/** An entry's id: the sha256 of its canonical JSON, so equal proposals are one entry. */
export const entryId = (entry: OverlayEntry): EntryId => EntryIdSchema.parse(sha256Hex(canonicalJson(entry)));

/** The key of a pair of nodes in `stats` and `transitions`. Node names never contain the arrow. */
export const edgeKey = (from: string, to: string): string => `${from}→${to}`;

export const emptyOverlay = (base: RevisionId): OverlayState => ({ base, version: 0, entries: {}, stats: {}, transitions: {}, turns: [] });

/** The node a turn must reach for the entry to be relevant: where an edge, note or caution is shown, or the node itself. */
const anchorNode = (entry: OverlayEntry): string => {
  switch (entry.kind) {
    case "edge":
      return entry.from;
    case "node":
      return entry.id;
    default:
      return entry.on.from;
  }
};

/** Sessions with the new ones appended, keeping at most `MAX_SESSIONS`. */
function addSessions(sessions: readonly string[], more: readonly string[]): string[] {
  const out = [...sessions];
  for (const s of more) if (out.length < MAX_SESSIONS && !out.includes(s)) out.push(s);
  return out;
}

const addScore = <T extends { scored: number; scoreSum: number }>(into: T, score: number | null): T =>
  score === null ? into : { ...into, scored: into.scored + 1, scoreSum: into.scoreSum + score };

/** The score `previous` taken back out (nothing when it was null). */
const withdrawScore = <T extends { scored: number; scoreSum: number }>(from: T, previous: number | null): T =>
  previous === null ? from : { ...from, scored: from.scored - 1, scoreSum: from.scoreSum - previous };

/**
 * A re-observation (feedback): the turn's score moves from `previous` to `score` on the
 * pairs of its path and in the arm of each entry that counted it, with no new
 * traversal, session or exposure. Its key starts with "/", so it never equals a turn key.
 */
function foldRescore(state: OverlayState, event: Observed, rescore: NonNullable<Observed["rescore"]>): OverlayState {
  const key = `/${rescore.seq}/${event.turnKey}`;
  if (state.turns.includes(key)) return state;
  const swap = <T extends { scored: number; scoreSum: number }>(into: T): T => addScore(withdrawScore(into, rescore.previous), event.score);
  const stats: Record<string, EdgeStats> = { ...state.stats };
  const transitions: Record<string, TransitionStats> = { ...state.transitions };
  // Stryker disable next-line EqualityOperator: equivalent; a pair past the path's end names no node, so it is never in stats
  for (let i = 1; i < event.path.length; i += 1) {
    const pair = edgeKey(event.path[i - 1]!, event.path[i]!);
    const edge = stats[pair];
    // A pair the state never saw has nothing to update; a seen pair is in both records, which only grow.
    if (edge === undefined) continue;
    stats[pair] = swap(edge);
    transitions[pair] = swap(transitions[pair]!);
  }
  const visited = new Set<string>(event.path);
  const shown = new Set<string>(event.exposure);
  const entries: Record<string, Recorded> = { ...state.entries };
  for (const [id, recorded] of Object.entries(state.entries)) {
    if (recorded.status === "retired" || recorded.evidence.firstSeen >= rescore.observedAt || !visited.has(anchorNode(recorded.entry))) continue;
    const arm = shown.has(id) ? "exposed" : "unexposed";
    entries[id] = { ...recorded, evidence: { ...recorded.evidence, [arm]: swap(recorded.evidence[arm]) } };
  }
  const turns = [...state.turns, key].slice(-MAX_TURNS);
  return { ...state, version: state.version + 1, stats, transitions, entries, turns };
}

function foldObserved(state: OverlayState, event: Observed): OverlayState {
  if (event.rescore !== undefined) return foldRescore(state, event, event.rescore);
  if (state.turns.includes(event.turnKey)) return state;
  const version = state.version + 1;
  const session = event.turnKey.slice(0, event.turnKey.indexOf("/"));
  const stats: Record<string, EdgeStats> = { ...state.stats };
  const transitions: Record<string, TransitionStats> = { ...state.transitions };
  for (let i = 1; i < event.path.length; i += 1) {
    const key = edgeKey(event.path[i - 1]!, event.path[i]!);
    const edge = stats[key] ?? { traversals: 0, scored: 0, scoreSum: 0, lastSeen: 0 };
    stats[key] = { ...addScore(edge, event.score), traversals: edge.traversals + 1, lastSeen: version };
    const t = transitions[key] ?? { sessions: [], scored: 0, scoreSum: 0 };
    transitions[key] = { ...addScore(t, event.score), sessions: addSessions(t.sessions, [session]) };
  }
  const visited = new Set<string>(event.path);
  const shown = new Set<string>(event.exposure);
  const entries: Record<string, Recorded> = { ...state.entries };
  for (const [id, recorded] of Object.entries(state.entries)) {
    if (recorded.status === "retired" || !visited.has(anchorNode(recorded.entry))) continue;
    const arm = shown.has(id) ? "exposed" : "unexposed";
    const evidence: EntryEvidence = { ...recorded.evidence, [arm]: { ...addScore(recorded.evidence[arm], event.score), n: recorded.evidence[arm].n + 1 }, lastSeen: version };
    entries[id] = { ...recorded, evidence };
  }
  const turns = [...state.turns, event.turnKey].slice(-MAX_TURNS);
  return { ...state, version, stats, transitions, entries, turns };
}

/**
 * Fold one event. Pure: the input is never mutated. `observed` is ignored for a turn
 * key already seen, `proposed` when it adds no support, `status` when the entry is
 * unknown or already there; each ignored event leaves `version` as it was.
 */
export function foldOverlay(state: OverlayState, event: OverlayEvent): OverlayState {
  const version = state.version + 1;
  switch (event.kind) {
    case "observed":
      return foldObserved(state, event);
    case "proposed": {
      const id = entryId(event.entry);
      const known = state.entries[id];
      if (known === undefined) {
        const evidence: EntryEvidence = { exposed: { n: 0, scored: 0, scoreSum: 0 }, unexposed: { n: 0, scored: 0, scoreSum: 0 }, support: addSessions([], event.source.sessions), firstSeen: version, lastSeen: version };
        return { ...state, version, entries: { ...state.entries, [id]: { entry: event.entry, status: "probation", evidence } } };
      }
      const support = addSessions(known.evidence.support, event.source.sessions);
      if (support.length === known.evidence.support.length) return state;
      return { ...state, version, entries: { ...state.entries, [id]: { ...known, evidence: { ...known.evidence, support, lastSeen: version } } } };
    }
    case "status": {
      const known = state.entries[event.entry];
      if (known === undefined || known.status === event.to) return state;
      return { ...state, version, entries: { ...state.entries, [event.entry]: { ...known, status: event.to } } };
    }
    case "rebased": {
      const entries: Record<string, Recorded> = {};
      const absorbed = new Set<string>(event.absorbed);
      const dropped = new Set<string>(event.dropped);
      for (const [id, recorded] of Object.entries(state.entries)) {
        if (dropped.has(id)) continue;
        entries[id] = absorbed.has(id) ? { ...recorded, status: "retired" } : recorded;
      }
      return { ...state, base: event.core, version, entries };
    }
  }
}

/** The state a log folds to, from the empty overlay on `base`. */
export const foldAll = (base: RevisionId, events: readonly OverlayEvent[]): OverlayState => events.reduce(foldOverlay, emptyOverlay(base));

/**
 * Whether a session (by its pin's salt) is shown a probationary entry: the first 8 hex
 * digits of sha256(salt + id), over 2³², fall below the share. Deterministic, so a
 * session sees the same entries at every step; uniform, so a share of sessions do.
 */
export const exposed = (salt: string, id: string, share: number): boolean => Number.parseInt(sha256Hex(salt + id).slice(0, 8), 16) / 2 ** 32 < share;

/** The nodes and node pairs the core and some overlay entries provide as anchors. */
function anchors(core: ProceduralGraph, providers: readonly OverlayEntry[]): { nodes: Set<string>; pairs: Set<string> } {
  const nodes = new Set(core.nodes.map((n) => n.id));
  // Stryker disable next-line ConditionalExpression: equivalent; other kinds have no id, and the undefined it would add equals no name
  for (const e of providers) if (e.kind === "node") nodes.add(e.id);
  const pairs = new Set(core.edges.map((e) => edgeKey(e.from, e.to)));
  for (const e of providers) if (e.kind === "edge" && nodes.has(e.from) && nodes.has(e.to)) pairs.add(edgeKey(e.from, e.to));
  return { nodes, pairs };
}

/** A node needs nothing; an edge needs both endpoints; a note or caution needs an edge between its endpoints. */
function isAnchored(e: OverlayEntry, { nodes, pairs }: { nodes: ReadonlySet<string>; pairs: ReadonlySet<string> }): boolean {
  switch (e.kind) {
    case "node":
      return true;
    case "edge":
      return nodes.has(e.from) && nodes.has(e.to);
    default:
      return pairs.has(edgeKey(e.on.from, e.on.to));
  }
}

/**
 * `core ⊕ overlay` for one session: the whole core (I2), active entries, and
 * probationary ones the session is exposed to; never retired entries, and never an
 * entry whose anchors are missing (I6). Overlay items carry `origin: "overlay"` and their
 * status, so serialization can label them. Notes and cautions attach to every edge
 * between their endpoints, in the order the entries were proposed.
 */
export function effectiveGraph(core: ProceduralGraph, overlay: OverlayState, view: { salt: string; probationShare: number }): EffectiveGraph {
  const visible = Object.entries(overlay.entries)
    .filter(([id, r]) => r.status === "active" || (r.status === "probation" && exposed(view.salt, id, view.probationShare)))
    .map(([, r]) => r);
  const nodes: EffectiveNode[] = core.nodes.map((n) => ({ ...n, origin: "core" }));
  const ids = new Set(core.nodes.map((n) => n.id));
  for (const { entry: e, status } of visible) {
    if (e.kind !== "node" || ids.has(e.id)) continue;
    ids.add(e.id);
    nodes.push({ id: e.id, type: e.type, description: e.description, origin: "overlay", status });
  }
  const edges: EffectiveEdge[] = core.edges.map((e) => ({ ...e, origin: "core", notes: [], cautions: [] }));
  const triple = (e: { from: string; relation: string; to: string }): string => `${edgeKey(e.from, e.to)}:${e.relation}`;
  const triples = new Set(core.edges.map(triple));
  for (const { entry: e, status } of visible) {
    if (e.kind !== "edge" || !ids.has(e.from) || !ids.has(e.to) || triples.has(triple(e))) continue;
    triples.add(triple(e));
    edges.push({ from: e.from, relation: e.relation, to: e.to, condition: e.condition, guidance: e.guidance, pitfalls: e.pitfalls, origin: "overlay", status, notes: [], cautions: [] });
  }
  for (const { entry: e, status } of visible) {
    if (e.kind !== "note" && e.kind !== "caution") continue;
    for (const edge of edges) if (edge.from === e.on.from && edge.to === e.on.to) (e.kind === "note" ? edge.notes : edge.cautions).push({ text: e.text, status });
  }
  return { core: revisionId(core), overlay: overlay.version, nodes, edges };
}

/**
 * Move the overlay onto a new core (after a dream commit). Absorbed entries retire.
 * Entries whose anchors the new core lacks are dropped, and the event names them (I6);
 * only live overlay entries (neither retired nor absorbed) count as anchors. Everything
 * else carries over, statistics included. The returned state is the event folded, so
 * replaying the log reproduces it.
 */
export function rebaseOverlay(state: OverlayState, core: ProceduralGraph, absorbed: readonly EntryId[]): { state: OverlayState; event: OverlayEvent } {
  const gone = new Set<string>(absorbed);
  const rest = Object.entries(state.entries).filter(([id]) => !gone.has(id));
  const present = anchors(
    core,
    rest.filter(([, r]) => r.status !== "retired").map(([, r]) => r.entry),
  );
  const dropped = rest.filter(([, r]) => !isAnchored(r.entry, present)).map(([id]) => EntryIdSchema.parse(id));
  const event: OverlayEvent = { kind: "rebased", core: revisionId(core), absorbed: [...absorbed], dropped, frozenAt: state.version };
  return { state: foldOverlay(state, event), event };
}
