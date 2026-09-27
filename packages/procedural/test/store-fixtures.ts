/** Store fixtures: records over small chain documents, and a SnapshotStorage that counts and can fail. */
import { CandidateDocumentSchema, GraphIdSchema, revisionId, RevisionRecordSchema } from "@harness/procedural";
import type { GraphId, RevisionRecord } from "@harness/procedural";
import type { SnapshotStorage } from "@harness/core";
import { MemoryStorage } from "@harness/testkit";

export const graphA: GraphId = GraphIdSchema.parse("team/alpha");

/** `Start → …steps → End`, every text carrying `text`. */
export function chain(steps: readonly string[], text = "t") {
  const ids = ["Start", ...steps, "End"];
  return CandidateDocumentSchema.parse({
    format: "harness.procedural-graph/v1",
    nodeTypes: ["ACTION", "STATUS"],
    relations: ["LEADS_TO"],
    nodes: ids.map((id) => ({ id, type: "STATUS", description: `${text}-${id}` })),
    edges: ids.slice(1).map((to, i) => ({ from: ids[i], relation: "LEADS_TO", to, condition: i === 0 ? null : `${text}-if`, guidance: `${text}-go`, pitfalls: `${text}-avoid` })),
  });
}

export function record(steps: readonly string[], overrides: Record<string, unknown> = {}, text = "t"): RevisionRecord {
  const document = chain(steps, text);
  return RevisionRecordSchema.parse({
    id: revisionId(document),
    graph: graphA,
    parents: [],
    document,
    edits: null,
    origin: "seed",
    evidence: {},
    decision: { kind: "head" },
    at: 0,
    ...overrides,
  });
}

/** MemoryStorage that counts loads and saves, and fails the saves or loads it is told to. */
export class ProbeStorage implements SnapshotStorage {
  readonly inner: MemoryStorage;
  loads = 0;
  saves = 0;
  failSaves = 0;
  failLoads = 0;

  constructor(inner = new MemoryStorage()) {
    this.inner = inner;
  }

  async load(): Promise<unknown> {
    this.loads += 1;
    if (this.failLoads > 0) {
      this.failLoads -= 1;
      throw new Error("load failed");
    }
    return this.inner.load();
  }

  async save(snapshot: unknown): Promise<void> {
    if (this.failSaves > 0) {
      this.failSaves -= 1;
      throw new Error("save failed");
    }
    this.saves += 1;
    await this.inner.save(snapshot);
  }
}
