import { expect, it } from "vitest";
import { TaskGraph, WorkQueue, eveAgentSource, existingEveAgents } from "@harness/core";
import type { SourceConnection, SourceEvent, SourcePage } from "@harness/core";

const OUTCOME = "the release notes name the button";

class PageSource implements SourceConnection {
  readonly #events: SourceEvent[] = [];

  emit(event: SourceEvent): void {
    this.#events.push(event);
  }

  read(cursor: string | undefined): SourcePage {
    const from = cursor === undefined ? 0 : Number(cursor);
    return { open: true, cursor: String(this.#events.length), events: this.#events.slice(from) };
  }
}

it("SN1.1 a queue snapshot keeps the manual item, the kept event, and the cursor past the rejected one", async () => {
  const queue = new WorkQueue();
  expect(queue.add({ id: "manual", outcome: "keep the manual outcome" }).ok).toBe(true);
  const source = new PageSource();
  source.emit({ id: "e1", body: "keep the release notes" });
  source.emit({ id: "e2", body: "chore" });
  expect(queue.connect("issues", source, (event) => event.body.startsWith("keep")).ok).toBe(true);
  expect(queue.ingest("issues").ok).toBe(true);
  await expect(`${JSON.stringify(queue.toJSON(), null, 2)}\n`).toMatchFileSnapshot("./snapshots/work-queue.json");
});

it("SN1.2 a decision graph snapshot keeps the answer on the waiting branch only", async () => {
  const graph = new TaskGraph();
  expect(graph.addNode("implement").ok).toBe(true);
  expect(graph.addNode("ship", { decision: "Ship the button?" }).ok).toBe(true);
  expect(graph.addEdge("implement", "ship", "data").ok).toBe(true);
  expect(graph.start("implement").ok).toBe(true);
  expect(graph.complete("implement", "succeeded").ok).toBe(true);
  expect(graph.answer("ship", "yes").ok).toBe(true);
  await expect(`${JSON.stringify(graph.toJSON(), null, 2)}\n`).toMatchFileSnapshot("./snapshots/decision-graph.json");
});

it("SN1.3 the authored researcher and a generated eve agent stay characterizations of their source", async () => {
  await expect(existingEveAgents().researcher.definition).toMatchFileSnapshot("./snapshots/researcher.agent.ts.snap");
  await expect(eveAgentSource({
    description: `verification for ${OUTCOME}`,
    model: "harness/delivery",
  })).toMatchFileSnapshot("./snapshots/verification.agent.ts.snap");
});
