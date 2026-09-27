import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { guidancePromptOf, HOPS, parseSettings, PLACEHOLDERS, presetOf, SettingsSchema, settingsJsonSchema, WINDOW } from "@harness/procedural";

const file = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")) as Record<string, unknown>;
const settings = () => parseSettings(structuredClone(file));

/** The shipped file with one value replaced. */
const edit = (path: readonly string[], value: unknown) => {
  const s = structuredClone(file);
  let o: Record<string, unknown> = s;
  for (const key of path.slice(0, -1)) o = o[key] as Record<string, unknown>;
  if (value === undefined) delete o[path.at(-1)!];
  else o[path.at(-1)!] = value;
  return () => parseSettings(s);
};

/** The paper's App. B.5 guidance prompt, and the sentence the harness variant leaves out (plan §9). */
const INCLUDE_SPECIFICS = " You must include any specific command patterns, file paths, tools, or arguments defined in the graph context if they are relevant to the next steps.";

describe("procedural settings (data/settings.json)", () => {
  it("PG1.35 the shipped settings parse, and name their JSON Schema, which is generated from the parser", async () => {
    expect(Object.keys(settings().presets)).toEqual(["paper", "harness"]);
    expect(file["$schema"]).toBe("./settings.schema.json");
    await expect(`${JSON.stringify(settingsJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/settings.schema.json");
  });

  it("PG1.36 the paper preset is the paper's mechanism: no overlay, exact match, reset at each turn, guidance in the system slot, the paper's gate", () => {
    const paper = presetOf(settings(), "paper");
    expect(paper).toMatchObject({ overlay: false, match: "exact", turnBoundary: "start", delivery: "system", guidancePrompt: "paper", guidanceCache: false });
    expect(paper.live).toBeUndefined();
    expect(paper.dream).toMatchObject({
      mode: "incremental",
      context: "tail-concatenated",
      gate: ["evaluator-at-least-retained"],
      rejections: { dedupe: false, show: "all" },
      enforceToolCatalog: false,
      editFilter: false,
    });
    // Greedy decoding and the paper's output limits (App. D).
    expect(settings().decoding).toEqual({ temperature: 0, topK: 1, solverMaxTokens: 2048, refinerMaxTokens: 8192 });
    expect([HOPS, WINDOW]).toEqual([2, 3]);
  });

  it("PG1.37 the harness preset learns live under probation and gates dream on structure, evidence and approval", () => {
    const harness = presetOf(settings(), "harness");
    expect(harness).toMatchObject({ overlay: true, turnBoundary: "carry", delivery: "trailing-message", guidancePrompt: "harness", guidanceCache: true, overlayRefresh: "turn", repinOnDream: "turn" });
    expect(harness.live).toEqual({ reflection: "off", probationShare: 0.2, minSupport: 3, promote: { confidence: 0.9 }, halfLifeDays: 30, maxEntries: 64 });
    expect(harness.dream).toMatchObject({
      context: "tail-per-trajectory",
      gate: ["structure", "evidence", "evaluator-anchored-noninferiority?", "approval-for-side-effects"],
      rejections: { dedupe: true, show: "recent-and-similar", limit: 8 },
      enforceToolCatalog: true,
      editFilter: true,
    });
  });

  it("PG1.38 the paper's App. B.5 prompts are stored verbatim", () => {
    const { prompts } = settings();
    expect(prompts.solver.startsWith("{system_prompt}\n\nProcedural Graph Guidance: {procedural_graph_guidance}\nYou must interleave Thought and Action.")).toBe(true);
    expect(prompts.solver.endsWith("Do NOT simulate the environment’s responses.\nCurrent Trajectory: {trajectory}\nThought:")).toBe(true);
    expect(prompts.guidance).toBe(
      "You are an expert cognitive architect and execution guide for an AI agent solving the task: {task_description}\n" +
        "Here is {graph_context_desc}: {subgraph_summary}\n" +
        "Here is the current active query / observation: {query}\n" +
        "Here is the agent’s recent execution trajectory: {recent_context}\n" +
        "Analyze this {graph_source} in the context of the agent’s current progress. Using the condition, guidance, and pitfalls attributes carried by the edges in the graph context, generate clear, detailed, and actionable guidance advising the agent on exactly what step or strategy to pursue next, what pitfalls to avoid, and how to recover from recent failures if any." +
        INCLUDE_SPECIFICS,
    );
    expect(prompts.refiner.startsWith("You are an expert cognitive architect optimizing a Procedural Graph for an intelligent agent.")).toBe(true);
    for (const rule of ["1. Action Nodes.", "2. Transition Conditions.", "3. Execution Guidance.", "4. Pitfalls.", "5. Generality & Leak Prevention.", "6. Node ID Compatibility.", "7. Graph Structure."]) expect(prompts.refiner).toContain(`\n${rule} `);
    expect(prompts.refiner).toContain("(the graph contains only Start → End)");
    expect(prompts.refiner.endsWith('"delete_edges": [{"source":..., "target":...}] }\n\nMake sure to output ONLY the raw JSON block.')).toBe(true);
    // The full-graph variant only rebinds the context slots (App. B.5).
    expect(settings().graphContext.full).toEqual({ desc: "the complete Procedural Graph governing the task structure and strategic guidance", source: "complete Procedural Graph" });
  });

  it("PG1.39 the harness guidance prompt is the paper's without the sentence asking for command patterns and file paths", () => {
    const { prompts } = settings();
    expect(prompts.guidanceHarness).toBe(prompts.guidance.replace(INCLUDE_SPECIFICS, ""));
    expect(prompts.guidanceHarness).not.toContain("file paths");
    expect(guidancePromptOf(settings(), presetOf(settings(), "paper"))).toBe(prompts.guidance);
    expect(guidancePromptOf(settings(), presetOf(settings(), "harness"))).toBe(prompts.guidanceHarness);
  });

  it("PG1.40 the dream prompt is the refiner prompt plus a consolidation section; reflection proposes entries without specifics", () => {
    const { prompts } = settings();
    expect(prompts.dream.startsWith(`${prompts.refiner}\n\n`)).toBe(true);
    const consolidation = prompts.dream.slice(prompts.refiner.length);
    for (const slot of ["{overlay_entries_block}", "{cautioned_edges_block}", "{rejection_reasons_block}"]) expect(consolidation).toContain(slot);
    expect(prompts.reflection).toContain("{graph_context}");
    expect(prompts.reflection).toContain("{trajectory}");
    expect(prompts.reflection).toMatch(/file paths/);
  });

  it("PG1.41 every prompt keeps the placeholders its caller fills", () => {
    const { prompts } = settings();
    for (const [name, slots] of Object.entries(PLACEHOLDERS)) for (const slot of slots) expect(prompts[name as keyof typeof prompts]).toContain(`{${slot}}`);
    expect(PLACEHOLDERS.dream).toEqual([...PLACEHOLDERS.refiner, "overlay_entries_block", "cautioned_edges_block", "rejection_reasons_block"]);
    expect(edit(["prompts", "guidance"], "Guide the agent: {task_description}")).toThrow(/missing placeholders \{graph_context_desc\}, \{subgraph_summary\}, \{query\}, \{recent_context\}, \{graph_source\}\n.*at prompts\.guidance$/);
    expect(edit(["prompts", "refiner"], "")).toThrow(/prompts\.refiner/);
  });

  it("PG1.42 settings that cannot be right are refused, naming where", () => {
    expect(edit(["presets", "harness", "live", "probationShare"], 1.5)).toThrow(/presets\.harness\.live\.probationShare/);
    expect(edit(["presets", "harness", "live", "minSupport"], 0)).toThrow(/presets\.harness\.live\.minSupport/);
    expect(edit(["presets", "harness", "live"], undefined)).toThrow(/an overlay needs live settings[\s\S]*presets\.harness\.live/);
    expect(edit(["presets", "harness", "dream", "gate"], ["structure", "vibes"])).toThrow(/presets\.harness\.dream\.gate\[1\]/);
    expect(edit(["presets", "harness", "dream", "gate"], ["structure?"])).toThrow(/presets\.harness\.dream\.gate\[0\]/);
    expect(edit(["presets", "harness", "dream", "gate"], [])).toThrow(/presets\.harness\.dream\.gate/);
    expect(edit(["presets", "harness", "dream", "rejections", "limit"], undefined)).toThrow(/recent-and-similar needs a limit[\s\S]*presets\.harness\.dream\.rejections\.limit/);
    expect(edit(["presets", "harness", "dream", "noninferiority"], undefined)).toThrow(/needs noninferiority settings[\s\S]*presets\.harness\.dream\.noninferiority/);
    expect(edit(["presets", "paper", "match"], "fuzzy")).toThrow(/presets\.paper\.match/);
    expect(edit(["presets", "paper"], undefined)).toThrow(/presets\.paper/);
    expect(edit(["decoding", "temperature"], -1)).toThrow(/decoding\.temperature/);
    expect(edit(["decoding", "topK"], 0)).toThrow(/decoding\.topK/);
    expect(edit(["extra"], 1)).toThrow(/extra/);
  });

  it("PG1.46 the cross-field checks are custom issues at the field that is missing", () => {
    const issue = (path: readonly string[], value: unknown) => {
      const s = structuredClone(file);
      let o: Record<string, unknown> = s;
      for (const key of path.slice(0, -1)) o = o[key] as Record<string, unknown>;
      if (value === undefined) delete o[path.at(-1)!];
      else o[path.at(-1)!] = value;
      const { code, path: at } = SettingsSchema.safeParse(s).error!.issues[0]!;
      return { code, at };
    };
    expect(issue(["presets", "harness", "live"], undefined)).toEqual({ code: "custom", at: ["presets", "harness", "live"] });
    expect(issue(["presets", "harness", "dream", "rejections", "limit"], undefined)).toEqual({ code: "custom", at: ["presets", "harness", "dream", "rejections", "limit"] });
    expect(issue(["presets", "harness", "dream", "noninferiority"], undefined)).toEqual({ code: "custom", at: ["presets", "harness", "dream", "noninferiority"] });
    expect(issue(["prompts", "solver"], "no slots")).toEqual({ code: "custom", at: ["prompts", "solver"] });
  });

  it("PG1.43 a deployment may add its own presets, and presetOf names a missing one", () => {
    const s = structuredClone(file) as { presets: Record<string, unknown> };
    s.presets["careful"] = { ...(s.presets["harness"] as object), match: "case-insensitive", guidanceCache: false };
    const parsed = parseSettings(s);
    expect(presetOf(parsed, "careful")).toMatchObject({ match: "case-insensitive", guidanceCache: false, overlay: true });
    expect(() => presetOf(parsed, "missing")).toThrow(/no procedural preset named missing/);
    expect(() => presetOf(parsed, "toString")).toThrow(/no procedural preset named toString/);
    // Unset refresh policies default to re-reading at each turn.
    const bare = structuredClone(file) as { presets: { harness: Record<string, unknown> } };
    delete bare.presets.harness["overlayRefresh"];
    delete bare.presets.harness["repinOnDream"];
    expect(presetOf(parseSettings(bare), "harness")).toMatchObject({ overlayRefresh: "turn", repinOnDream: "turn" });
  });
});
