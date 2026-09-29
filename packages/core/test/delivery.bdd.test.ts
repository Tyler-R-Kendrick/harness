import { describe, expect, it } from "vitest";
import { DELIVERY_STEPS, TaskGraph, WorkQueue, finishTaskWorkflow, taskWorkflow } from "@harness/core";
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

function meeting(): Record<string, string> {
  return Object.fromEntries(DELIVERY_STEPS.map((step) => [step, step === "verification" ? `checked: ${OUTCOME}` : `done: ${step}`]));
}

describe("delivery behavior", () => {
  it("BD1.1 a kept inbox event is the work item, elicitation blocks only its branch, and delivery finishes when verification states the outcome", () => {
    // Given an empty queue whose source emits the outcome and an unrelated event
    const queue = new WorkQueue();
    const source = new PageSource();
    source.emit({ id: "release", body: OUTCOME });
    source.emit({ id: "noise", body: "unrelated chore" });
    expect(queue.connect("issues", source, (event) => event.body === OUTCOME).ok).toBe(true);

    // When the source is ingested
    const ingested = queue.ingest("issues");

    // Then only the matching event becomes the work item
    expect(ingested.ok && ingested.value.map((item) => item.id)).toEqual(["release"]);
    expect(queue.item("release")?.outcome).toBe(OUTCOME);
    expect(queue.inbox().map((item) => item.id)).toEqual(["release"]);

    // And the item's implementation graph blocks only the branch that needs a decision
    const graph = new TaskGraph();
    expect(graph.addNode("implement").ok).toBe(true);
    expect(graph.addNode("ship", { decision: "Ship the button?" }).ok).toBe(true);
    expect(graph.ready()).toEqual(["implement"]);
    expect(graph.blocked()).toEqual(["ship"]);
    expect(graph.start("implement").ok).toBe(true);
    expect(graph.complete("implement", "succeeded").ok).toBe(true);
    expect(graph.status("ship")).toBe("pending");
    expect(graph.ready()).toEqual([]);

    // And scripted delivery finishes only when verification states the outcome
    const workflow = taskWorkflow({ id: "release", outcome: OUTCOME, model: "harness/delivery" });
    const finished = finishTaskWorkflow(workflow, meeting());
    expect(finished.ok).toBe(true);
    if (finished.ok) expect(finished.value.steps.map((step) => step.step)).toEqual([...DELIVERY_STEPS]);
    const accepted = queue.check("release", `checked: ${OUTCOME}`, (outcome, result) => result.includes(outcome) && !result.includes(`not: ${outcome}`));
    expect(accepted.ok && accepted.value).toBe(true);

    const contradicted = taskWorkflow({ id: "release", outcome: OUTCOME, model: "harness/delivery" });
    const rejected = finishTaskWorkflow(contradicted, { ...meeting(), verification: `not: ${OUTCOME}` });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("contradicted");
    const refused = queue.check("release", `not: ${OUTCOME}`, (outcome, result) => result.includes(outcome) && !result.includes(`not: ${outcome}`));
    expect(refused.ok && refused.value).toBe(false);

    // And supplying the decision unblocks only the waiting branch
    expect(graph.answer("ship", "yes").ok).toBe(true);
    expect(graph.ready()).toEqual(["ship"]);
    expect(graph.status("implement")).toBe("succeeded");
  });
});
