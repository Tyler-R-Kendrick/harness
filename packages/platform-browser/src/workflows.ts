import type { Ensemble } from "@harness/cognitive";
import type { SnapshotStorage } from "@harness/core";
import { askModel, parseWorkflow, quickjsCodeMode, WorkflowHost, workflowsExtension } from "@harness/workflows";
import type { CodeMode, Workflow, WorkflowLibrary } from "@harness/workflows";
import type { ToolSet } from "ai";

const WORKFLOWS = "workflows";
const RUNS = "runs";

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // A failed request aborts its transaction (unless handled), so abort covers every failure.
    tx.onabort = () => reject(tx.error ?? new Error("the transaction was aborted"));
  });
}

/**
 * Workflows kept in IndexedDB, as the native host keeps them in files: each workflow is
 * a record in the `workflows` store (by name), and each run's journal a record in the
 * `runs` store (by run id), so runs resume after the page reloads.
 */
export class IndexedDbWorkflows implements WorkflowLibrary {
  readonly #db: Promise<IDBDatabase>;

  constructor(options: { readonly name?: string; readonly factory?: IDBFactory } = {}) {
    const open = (options.factory ?? indexedDB).open(options.name ?? "harness-workflows", 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(WORKFLOWS);
      open.result.createObjectStore(RUNS);
    };
    this.#db = done(open);
  }

  async get(name: string): Promise<Workflow | undefined> {
    const saved: unknown = await done((await this.#db).transaction(WORKFLOWS, "readonly").objectStore(WORKFLOWS).get(name));
    return saved === undefined ? undefined : parseWorkflow(saved);
  }

  async put(workflow: Workflow): Promise<void> {
    const parsed = parseWorkflow(workflow);
    const tx = (await this.#db).transaction(WORKFLOWS, "readwrite");
    tx.objectStore(WORKFLOWS).put(parsed, parsed.name);
    await committed(tx);
  }

  async list(): Promise<Workflow[]> {
    // Keys come back in order, so the library lists by name.
    const all: unknown[] = await done((await this.#db).transaction(WORKFLOWS, "readonly").objectStore(WORKFLOWS).getAll());
    return all.map(parseWorkflow);
  }

  /** A run's journal. */
  journal(run: string): SnapshotStorage {
    const db = this.#db;
    return {
      load: async () => done((await db).transaction(RUNS, "readonly").objectStore(RUNS).get(run)),
      save: async (snapshot) => {
        const tx = (await db).transaction(RUNS, "readwrite");
        tx.objectStore(RUNS).put(snapshot, run);
        await committed(tx);
      },
    };
  }

  /** Delete a run's journal (none is fine). */
  async forget(run: string): Promise<void> {
    const tx = (await this.#db).transaction(RUNS, "readwrite");
    tx.objectStore(RUNS).delete(run);
    await committed(tx);
  }

  /** Close the database connection. */
  async close(): Promise<void> {
    (await this.#db).close();
  }
}

/**
 * Durable workflows for the browser host's ensemble: `workflows.list`, `workflows.get`
 * and `workflows.run`, run on QuickJS (WebAssembly; no worker threads or `eval` needed)
 * and journaled in the library, with the ensemble's chat model answering `tools.ask`.
 * The host it returns gives the library's workflows as AI SDK tools (`workflowTools`).
 */
export function browserWorkflows(
  ensemble: Ensemble,
  options: { readonly library: WorkflowLibrary & { journal(run: string): SnapshotStorage; forget?(run: string): Promise<void> }; readonly tools?: ToolSet; readonly codeMode?: CodeMode },
): WorkflowHost {
  const { library } = options;
  const host = new WorkflowHost({
    library,
    journal: (run) => library.journal(run),
    ...(library.forget ? { forget: (run: string) => library.forget!(run) } : {}),
    ask: askModel(ensemble.languageModel()),
    codeMode: options.codeMode ?? quickjsCodeMode(),
    ...(options.tools ? { tools: options.tools } : {}),
  });
  ensemble.install(workflowsExtension({ host }));
  return host;
}
