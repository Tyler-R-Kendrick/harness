import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseWorkflow } from "@harness/workflows";
import type { Workflow, WorkflowLibrary } from "@harness/workflows";
import type { SnapshotStorage } from "@harness/core";
import { FileStorage } from "./file-storage.ts";

/**
 * Workflows kept as files: `<dir>/<name>.json` for each workflow, and one journal per
 * run under `<dir>/.runs/`, so runs resume across restarts.
 */
export class WorkflowFiles implements WorkflowLibrary {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async get(name: string): Promise<Workflow | undefined> {
    if (!/^[a-z0-9-]+$/.test(name)) return undefined;
    const saved = await new FileStorage(join(this.#dir, `${name}.json`)).load();
    return saved === undefined ? undefined : parseWorkflow(saved);
  }

  async put(workflow: Workflow): Promise<void> {
    const parsed = parseWorkflow(workflow);
    await new FileStorage(join(this.#dir, `${parsed.name}.json`)).save(parsed);
  }

  async list(): Promise<Workflow[]> {
    let files: string[];
    try {
      files = await readdir(this.#dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const names = files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)).sort();
    return (await Promise.all(names.map((n) => this.get(n)))).filter((w): w is Workflow => w !== undefined);
  }

  /** A run's journal; run ids are encoded into file names, so none can address a path outside. */
  journal(run: string): SnapshotStorage {
    return new FileStorage(join(this.#dir, ".runs", `${encodeURIComponent(run).replace(/\./g, "%2E")}.json`));
  }
}
