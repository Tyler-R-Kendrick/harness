/**
 * Small stand-ins for the step hook's dependencies while their phases land: an
 * in-memory `ProceduralStore` (P7's port) and a pin function with `pinSession`'s
 * contract (P9): pin the head once, keep the pin across restarts, re-pin at a turn
 * boundary when the head moved (under `repinOnDream: "turn"`) or the pinned core was
 * reverted.
 */
import { readFileSync } from "node:fs";
import { emptyOverlay, foldOverlay, GraphIdSchema, parseGraph, parseSettings, revisionId, RevisionRecordSchema } from "@harness/procedural";
import type { AppendLog, GraphId, OverlayEvent, Pin, ProceduralGraph, ProceduralStepDeps, ProceduralStore, RevisionId, RevisionRecord, Settings } from "@harness/procedural";
import { hotpot } from "./fixtures.ts";

export const settingsFile: Settings = parseSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));

export const GRAPH: GraphId = GraphIdSchema.parse("team/retrieval");

export function hotpotGraph(): ProceduralGraph {
  const parsed = parseGraph(hotpot());
  if (!parsed.ok) throw new Error("fixture");
  return parsed.graph;
}

function log<E>(): AppendLog<E> & { readonly events: E[] } {
  const events: E[] = [];
  return {
    events,
    async append(more) {
      events.push(...more);
      return events.length;
    },
    async read(from, limit = Number.POSITIVE_INFINITY) {
      return events.slice(from, from + limit).map((event, i) => ({ offset: from + i, event }));
    },
    async head() {
      return events.length;
    },
  };
}

export type FakeStore = ProceduralStore & { readonly texts: Map<string, string>; readonly pinsSet: Map<string, Pin>; overlayLog(graph: GraphId): AppendLog<OverlayEvent> & { readonly events: OverlayEvent[] } };

export function fakeStore(): FakeStore {
  const revisions = new Map<string, RevisionRecord>();
  const heads = new Map<string, { revision: RevisionId; history: RevisionId[] }>();
  const overlays = new Map<string, ReturnType<typeof log<OverlayEvent>>>();
  const pins = new Map<string, Pin>();
  const texts = new Map<string, string>();
  const overlayLog = (graph: GraphId) => {
    let l = overlays.get(graph);
    if (!l) overlays.set(graph, (l = log<OverlayEvent>()));
    return l;
  };
  return {
    texts,
    pinsSet: pins,
    overlayLog,
    revisions: {
      put: async (r) => void revisions.set(r.id, r),
      get: async (id) => revisions.get(id),
      list: async (graph) => [...revisions.values()].filter((r) => r.graph === graph),
    },
    heads: {
      get: async (graph) => heads.get(graph),
      async set(graph, expected, next) {
        const now = heads.get(graph);
        if (now?.revision !== expected) return false;
        heads.set(graph, { revision: next, history: now ? [now.revision, ...now.history] : [] });
        return true;
      },
    },
    overlay: overlayLog,
    dreams: () => log<unknown>(),
    pins: { get: async (s) => pins.get(s), set: async (s, p) => void pins.set(s, p) },
    guidance: { put: async (id, text) => void texts.set(id, text), get: async (id) => texts.get(id) },
    lease: { acquire: async () => ({ epoch: 1 }), renew: async () => true, release: async () => true },
    redact: async () => undefined,
  };
}

/** Seed (or move) a graph's head to `g`. */
export async function seed(store: ProceduralStore, g: ProceduralGraph, graph: GraphId = GRAPH, origin: RevisionRecord["origin"] = "seed"): Promise<RevisionId> {
  const id = revisionId(g);
  const head = await store.heads.get(graph);
  await store.revisions.put(RevisionRecordSchema.parse({ id, graph, parents: head ? [head.revision] : [], document: g, edits: null, origin, evidence: {}, decision: { kind: "head" }, at: 0 }));
  await store.heads.set(graph, head?.revision, id);
  return id;
}

/** The overlay version of a graph's log on `base`. */
async function version(store: ProceduralStore, graph: GraphId, base: RevisionId): Promise<number> {
  const events = await store.overlay(graph).read(0);
  return events.reduce((s, e) => foldOverlay(s, e.event), emptyOverlay(base)).version;
}

/** `pinSession`'s contract, in small. */
export const fakePin: ProceduralStepDeps["pin"] = async ({ store, session, graph, entropy, clock, repinOnDream }) => {
  const head = await store.heads.get(graph);
  if (!head) throw new Error(`graph ${graph} has no head`);
  const existing = await store.pins.get(session);
  const reverted = existing !== undefined && head.revision !== existing.core && !head.history.includes(existing.core);
  if (existing && existing.graph === graph && !reverted && (repinOnDream === "never" || existing.core === head.revision)) return existing;
  const salt = [...entropy.bytes(8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const pin: Pin = { graph, core: head.revision, overlay: await version(store, graph, head.revision), salt: existing?.salt ?? salt, at: clock.now() };
  await store.pins.set(session, pin);
  return pin;
};
