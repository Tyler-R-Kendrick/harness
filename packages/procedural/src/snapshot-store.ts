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
import type { GraphId, RevisionId } from "./graph.ts";
import { MemoryProceduralStore, STORE_FORMAT } from "./memory-store.ts";
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

/** The store a saved value holds: nothing saved is an empty store; anything malformed is an error, never a silent reset. */
function storeOf(saved: unknown): MemoryProceduralStore {
  if (saved === undefined) return new MemoryProceduralStore();
  const parsed = ProceduralStoreDocumentSchema.safeParse(saved);
  if (!parsed.success) throw new Error(`the saved procedural store is malformed: ${z.prettifyError(parsed.error)}`);
  const document: ProceduralStoreDocument = parsed.data;
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
    get: (id) => this.#run((s) => s.revisions.get(id), never),
    list: (graph) => this.#run((s) => s.revisions.list(graph), never),
  };

  readonly heads: ProceduralStore["heads"] = {
    get: (graph) => this.#run((s) => s.heads.get(graph), never),
    set: (graph, expected, next) => this.#run((s) => s.heads.set(graph, expected, next), (moved) => moved),
  };

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
