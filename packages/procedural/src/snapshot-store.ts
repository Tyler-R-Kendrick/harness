/**
 * The durable `ProceduralStore`: the in-memory store's whole document, saved through
 * the core `SnapshotStorage` port after every change, so it works on every host (a file
 * on native, IndexedDB in browsers). `SnapshotStorage.save` is atomic, so a crash
 * leaves either the state before an operation or the state after it.
 *
 * Operations run one at a time, each after the one issued before it; a change is saved
 * before its promise resolves. A failed save rejects the operation and drops the
 * in-memory state, so the next operation reloads what was last saved. One process owns
 * a storage: two stores over the same storage would each overwrite the other's saves.
 */
import type { SnapshotStorage } from "@harness/core";
import { z } from "zod";
import { GraphIdSchema, RevisionIdSchema, RevisionRecordSchema } from "./graph.ts";
import type { GraphId, RevisionId, RevisionRecord } from "./graph.ts";
import { MemoryProceduralStore, STORE_FORMAT, STORE_FORMAT_V1 } from "./memory-store.ts";
import type { ProceduralStoreDocument } from "./memory-store.ts";
import { OverlayEventSchema } from "./overlay-types.ts";
import type { AppendLog, ProceduralStore } from "./store.ts";

const natural = z.int().min(0);

export const PinSchema = z.strictObject({ graph: GraphIdSchema, core: RevisionIdSchema, overlay: natural, salt: z.string(), at: natural });

/** A saved store: every record is parsed again on load, so ids are checked and branded. */
export const ProceduralStoreDocumentSchema = z.strictObject({
  format: z.literal(STORE_FORMAT),
  revisions: z.array(RevisionRecordSchema),
  heads: z.array(z.strictObject({ graph: GraphIdSchema, revision: RevisionIdSchema, history: z.array(RevisionIdSchema) })),
  overlay: z.array(z.strictObject({ graph: GraphIdSchema, events: z.array(OverlayEventSchema) })),
  dreams: z.array(z.strictObject({ graph: GraphIdSchema, events: z.array(z.unknown()) })),
  pins: z.array(z.strictObject({ session: z.string(), pin: PinSchema })),
  guidance: z.array(z.strictObject({ id: z.string(), text: z.string() })),
  leases: z.array(z.strictObject({ graph: GraphIdSchema, holder: z.string().nullable(), epoch: natural })),
});

/** A store saved before records were keyed by graph: the same fields, checked the same way. */
export const ProceduralStoreDocumentV1Schema = ProceduralStoreDocumentSchema.extend({ format: z.literal(STORE_FORMAT_V1) });
export type ProceduralStoreDocumentV1 = z.output<typeof ProceduralStoreDocumentV1Schema>;

const SavedStoreSchema = z.discriminatedUnion("format", [ProceduralStoreDocumentSchema, ProceduralStoreDocumentV1Schema]);

/**
 * The record a v1 `revert` replaced. A v1 revert took its target's id, so it replaced the
 * target's record and kept it in `evidence.replaces` (minus id, graph and document); v2
 * reverts write no record, so the replaced record comes back, through reverts of reverts.
 * A revert whose replaced record no longer parses (a redacted one) stays as it is.
 */
function unrevert(record: RevisionRecord): RevisionRecord {
  let current = record;
  while (current.origin === "revert") {
    // Anything but a record's fields (absent, a string, a scrubbed record) fails to parse.
    const replaced = RevisionRecordSchema.safeParse(Object.assign({}, current.evidence["replaces"], { id: current.id, graph: current.graph, document: current.document }));
    if (!replaced.success) break;
    current = replaced.data;
  }
  return current;
}

/**
 * A v1 store as v2 (A1). v1 kept one record per id, whichever graph wrote it last, and a
 * revert replaced its target's record. So: each revert record becomes the record it
 * replaced, every record stays under its own graph, and a graph whose head or earlier head
 * has no record of its own gets a copy of the one another graph wrote. Nothing else changes.
 */
export function migrateStoreDocument(document: ProceduralStoreDocumentV1): ProceduralStoreDocument {
  const revisions = new Map<string, RevisionRecord>();
  const byId = new Map<RevisionId, RevisionRecord>();
  for (const record of document.revisions.map(unrevert)) {
    revisions.set(`${record.id}${record.graph}`, record);
    byId.set(record.id, record);
  }
  for (const head of document.heads) {
    for (const id of [head.revision, ...head.history]) {
      const elsewhere = byId.get(id);
      const key = `${id}${head.graph}`;
      if (elsewhere !== undefined && !revisions.has(key)) revisions.set(key, { ...elsewhere, graph: head.graph });
    }
  }
  return { ...document, format: STORE_FORMAT, revisions: [...revisions.values()] };
}

/** The store a saved value holds: nothing saved is an empty store; a v1 store is migrated; anything malformed is an error, never a silent reset. */
function storeOf(saved: unknown): MemoryProceduralStore {
  if (saved === undefined) return new MemoryProceduralStore();
  const parsed = SavedStoreSchema.safeParse(saved);
  if (!parsed.success) throw new Error(`the saved procedural store is malformed: ${z.prettifyError(parsed.error)}`);
  const document: ProceduralStoreDocument = parsed.data.format === STORE_FORMAT_V1 ? migrateStoreDocument(parsed.data) : parsed.data;
  return new MemoryProceduralStore(document);
}

type Changed<T> = (result: T) => boolean;
const always = (): boolean => true;
// Stryker disable next-line ArrowFunction: equivalent because `undefined` is as falsy as `false` for both callers.
const never = (): boolean => false;

export class SnapshotProceduralStore implements ProceduralStore {
  readonly #storage: SnapshotStorage;
  #state: Promise<MemoryProceduralStore> | undefined;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(storage: SnapshotStorage) {
    this.#storage = storage;
  }

  /** Runs `op` after every operation issued before it; saves the whole state when `changed` says it changed. */
  #run<T>(op: (store: MemoryProceduralStore) => Promise<T>, changed: Changed<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      try {
        this.#state ??= this.#storage.load().then(storeOf);
        const store = await this.#state;
        const value = await op(store);
        if (changed(value)) await this.#storage.save(store.document());
        return value;
      } catch (error) {
        // Whatever the memory holds may not be what was saved: reload on the next operation.
        this.#state = undefined;
        throw error;
      }
    });
    this.#tail = result.catch(never);
    return result;
  }

  #log<E>(of: (store: MemoryProceduralStore) => AppendLog<E>): AppendLog<E> {
    return {
      append: (events) => this.#run((s) => of(s).append(events), () => events.length > 0),
      read: (from, limit) => this.#run((s) => of(s).read(from, limit), never),
      head: () => this.#run((s) => of(s).head(), never),
    };
  }

  readonly revisions: ProceduralStore["revisions"] = {
    put: (record) => this.#run((s) => s.revisions.put(record), always),
    get: (graph, id) => this.#run((s) => s.revisions.get(graph, id), never),
    list: (graph) => this.#run((s) => s.revisions.list(graph), never),
  };

  readonly heads: ProceduralStore["heads"] = {
    get: (graph) => this.#run((s) => s.heads.get(graph), never),
    set: (graph, expected, next) => this.#run((s) => s.heads.set(graph, expected, next), (moved) => moved),
  };

  /** Every graph with a head, in the order each got its first. */
  graphs(): Promise<readonly GraphId[]> {
    return this.#run((s) => s.graphs(), never);
  }

  overlay(graph: GraphId): ReturnType<ProceduralStore["overlay"]> {
    return this.#log((s) => s.overlay(graph));
  }

  dreams(graph: GraphId): ReturnType<ProceduralStore["dreams"]> {
    return this.#log((s) => s.dreams(graph));
  }

  readonly pins: ProceduralStore["pins"] = {
    get: (session) => this.#run((s) => s.pins.get(session), never),
    set: (session, pin) => this.#run((s) => s.pins.set(session, pin), always),
  };

  readonly guidance: ProceduralStore["guidance"] = {
    put: (id, text) => this.#run((s) => s.guidance.put(id, text), always),
    get: (id) => this.#run((s) => s.guidance.get(id), never),
  };

  readonly lease: ProceduralStore["lease"] = {
    acquire: (graph, holder) => this.#run((s) => s.lease.acquire(graph, holder), (lease) => lease !== undefined),
    renew: (graph, holder, epoch) => this.#run((s) => s.lease.renew(graph, holder, epoch), never),
    release: (graph, holder, epoch) => this.#run((s) => s.lease.release(graph, holder, epoch), (released) => released),
  };

  redact(id: RevisionId): Promise<void> {
    return this.#run((s) => s.redact(id), always);
  }
}
