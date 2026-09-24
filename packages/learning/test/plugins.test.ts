import { describe, expect, it } from "vitest";
import { Learning, Plugins, TARGETS } from "@harness/learning";
import type { Materializer, Teacher } from "@harness/learning";
import { reply, settings, setup } from "./helpers.ts";

const skills = (): Materializer & { inputs: unknown[] } => {
  const inputs: unknown[] = [];
  return {
    kind: "materializer",
    id: "skills",
    target: TARGETS.agentSkill,
    inputs,
    materialize: async (input) => (inputs.push(input), { target: "agent-skill", name: "staging-deploy", description: "deploy to staging", files: [{ path: "SKILL.md", content: "# Staging deploy" }] }),
  };
};

async function withLesson() {
  const s = setup({ reflect: () => reply([{ op: "add", kind: "procedure", title: "staging deploy", text: "migrate, then deploy", steps: ["run migrations", "deploy"] }]) });
  const learning = new Learning({ reasoner: s.ensemble, memory: s.memory, settings });
  await learning.observe({ id: "t1", task: "deploy to staging", steps: [], outcome: { status: "success" } });
  return { ...s, learning };
}

describe("learning plugins", () => {
  it("PL1.1 a learned behavior becomes a skill, workflow or tool through the plugin for that target, and the lesson remembers it", async () => {
    const { learning } = await withLesson();
    const plugins = new Plugins();
    const plugin = skills();
    const remove = plugins.use(plugin);
    const before = learning.lesson("l1");
    const made = await plugins.materialize(learning, { target: TARGETS.agentSkill, lessons: ["l1"], purpose: "deploy to staging" });
    expect(made).toMatchObject({ target: "agent-skill", name: "staging-deploy", files: [{ path: "SKILL.md" }] });
    expect(plugin.inputs).toEqual([{ purpose: "deploy to staging", lessons: [before], tools: [] }]);
    expect(learning.lesson("l1").artifacts).toEqual([{ target: "agent-skill", name: "staging-deploy" }]);
    expect(plugins.list()).toEqual([{ kind: "materializer", id: "skills", target: "agent-skill" }]);
    remove();
    await expect(plugins.materialize(learning, { target: TARGETS.agentSkill, lessons: ["l1"] })).rejects.toThrow("no plugin makes agent-skill");
  });

  it("PL1.2 plugins are checked: one id at a time, and what they return must be well formed", async () => {
    const { learning } = await withLesson();
    const plugins = new Plugins();
    plugins.use(skills());
    expect(() => plugins.use(skills())).toThrow("a plugin skills is already installed");
    plugins.use({ kind: "materializer", id: "broken", target: TARGETS.workflow, materialize: async () => ({ name: "" }) });
    await expect(plugins.materialize(learning, { target: TARGETS.workflow, lessons: ["l1"] })).rejects.toThrow(/invalid broken output/);
    await expect(plugins.materialize(learning, { target: TARGETS.agentSkill, lessons: ["l9"] })).rejects.toThrow("no lesson l9");
  });

  it("PL1.3 teaching: a teacher translates a recording into a demonstration, which is learned from as a success", async () => {
    const { learning, generator } = await withLesson();
    const recorded: unknown[] = [];
    const teacher: Teacher = {
      kind: "teacher",
      id: "screen-recorder",
      modalities: ["screen"],
      demonstrate: async (recording) => (recorded.push(recording), { id: "demo-1", task: recording.task, steps: [{ role: "user", content: "clicked Export" }], outcome: { status: "success" } }),
    };
    const plugins = new Plugins();
    plugins.use(teacher);
    const recording = { task: "export the monthly report", parts: [{ modality: "screen", mediaType: "video/webm", data: "AAAA" }] };
    const result = await plugins.teach(learning, recording);
    expect(recorded).toEqual([recording]);
    expect(result.trajectory).toMatchObject({ id: "demo-1", source: "demonstration", outcome: { status: "success" } });
    expect(JSON.parse(String(generator.requests.at(-1)!.messages[1]!.content)).session).toMatchObject({ id: "demo-1", source: "demonstration" });
    await expect(plugins.teach(learning, { ...recording, parts: [{ modality: "audio", mediaType: "audio/ogg", data: "" }] })).rejects.toThrow("no teacher observes audio");
  });
});
