import { describe, expect, it } from "vitest";
import { invokeCognitive, mirrorCapabilities } from "@harness/cognitive";
import { memoryExtension } from "@harness/memory";
import { Learning, learningExtension, Plugins, TARGETS } from "@harness/learning";
import { reply, settings, setup } from "./helpers.ts";

function installed() {
  const s = setup({ reflect: () => reply([{ op: "add", kind: "procedure", title: "staging deploy", text: "migrate, then deploy" }]), judge: () => ({ type: "boolean", probability: 0.95 }) });
  const offered = new Set<string>();
  mirrorCapabilities(s.ensemble, { offer: (n) => offered.add(n), withdraw: (n) => offered.delete(n) });
  const learning = new Learning({ reasoner: s.ensemble, memory: s.memory, settings });
  const plugins = new Plugins();
  plugins.use({ kind: "materializer", id: "workflows", target: TARGETS.workflow, materialize: async () => ({ target: "workflow", name: "deploy", description: "", files: [] }) });
  const extension = learningExtension({ learning, reasoner: s.ensemble, plugins });
  return { ...s, offered, learning, extension };
}

describe("learning as a cognitive-core extension", () => {
  it("LX1.1 it requires memory, brings no models, and is offered while memory serves", () => {
    const { ensemble, extension, offered } = installed();
    expect(extension).toMatchObject({ id: "learning", requires: ["memory"], models: [] });
    expect(() => ensemble.install(extension)).toThrow("extension learning requires memory, which is not installed");
    ensemble.install(memoryExtension({ memory: installed().memory, models: [], load: async () => ({}) }));
    ensemble.install(extension);
    expect(offered.has("learning")).toBe(true);
  });

  it("LX1.2 its operations are served through the cognitive invoke operation, with inputs parsed", async () => {
    const { ensemble, extension, memory } = installed();
    ensemble.install(memoryExtension({ memory, models: [], load: async () => ({}) }));
    ensemble.install(extension);
    const observed = await invokeCognitive(ensemble, "learning.observe", { id: "t1", task: "deploy to staging", steps: [], outcome: { status: "success" } });
    expect(observed).toEqual({ changes: [{ op: "added", id: "l1" }], rejected: [] });
    expect(await invokeCognitive(ensemble, "learning.recall", { task: "deploy to staging", limit: 3 })).toMatchObject({ lessons: [{ id: "l1" }] });
    expect(await invokeCognitive(ensemble, "learning.feedback", { id: "l1", helpful: true })).toEqual({ changes: [{ op: "helpful", id: "l1" }] });
    expect(await invokeCognitive(ensemble, "learning.plan", { task: "summarize a note" })).toMatchObject({ rung: "native" });
    expect(await invokeCognitive(ensemble, "learning.materialize", { target: "workflow", lessons: ["l1"] })).toMatchObject({ name: "deploy" });
    expect(await invokeCognitive(ensemble, "learning.consolidate", {})).toEqual({ changes: [] });
    expect(await invokeCognitive(ensemble, "learning.status", undefined)).toEqual({ lessons: 1, plugins: [{ kind: "materializer", id: "workflows", target: "workflow" }] });
    await expect(invokeCognitive(ensemble, "learning.build-tool", { task: "x" })).rejects.toThrow("no plugin makes tool");
    await expect(invokeCognitive(ensemble, "learning.teach", { task: "x", parts: [{ modality: "screen", mediaType: "video/webm", data: "" }] })).rejects.toThrow("no teacher observes screen");
    await expect(invokeCognitive(ensemble, "learning.feedback", { id: "l1" })).rejects.toThrow(/invalid learning.feedback input/);
    await expect(invokeCognitive(ensemble, "learning.recall", undefined)).rejects.toThrow(/invalid learning.recall input/);
    await expect(invokeCognitive(ensemble, "learning.observe", { task: "no id" })).rejects.toThrow(/invalid trajectory/);
  });
});
