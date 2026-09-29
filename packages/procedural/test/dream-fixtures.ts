/** Dream fixtures: presets, the hotpot core, edit sets and a helper that answers the reducer's commands. */
import { readFileSync } from "node:fs";
import { dreamStep, DreamIdSchema, EditSetSchema, GraphIdSchema, parseGraph, parseSettings, presetOf } from "@harness/procedural";
import type { DreamCommand, DreamEvent, DreamInput, DreamSettings, DreamState, EditSet, LiveSettings, ProceduralGraph, Settings } from "@harness/procedural";
import { hotpot } from "./fixtures.ts";
import type { DocInput } from "./fixtures.ts";

export const settings: Settings = parseSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));
export const paperDream: DreamSettings = presetOf(settings, "paper").dream;
export const harnessDream: DreamSettings = presetOf(settings, "harness").dream;
export const harnessLive: LiveSettings = presetOf(settings, "harness").live!;

export function graphOf(doc: DocInput): ProceduralGraph {
  const parsed = parseGraph(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.graph;
}
export const core = (): ProceduralGraph => graphOf(hotpot());
export const edits = (input: unknown): EditSet => EditSetSchema.parse(input);

/** Adds a Verify step before End: a valid candidate. */
export const addVerify = edits({
  add_nodes: [{ id: "Verify", type: "REASONING", description: "Check the answer." }],
  delete_edges: [{ source: "Bridge_Extract", target: "End" }],
  add_edges: [
    { source: "Bridge_Extract", target: "Verify", relation: "LEADS_TO", condition: null, guidance: "Check the bridge.", pitfalls: "Do not answer early." },
    { source: "Verify", target: "End", relation: "LEADS_TO", condition: null, guidance: "Answer.", pitfalls: "" },
  ],
});
/** A second, different valid candidate: a note-like rewrite of Start's edge. */
export const renameGuidance = (guidance: string): EditSet =>
  edits({
    delete_edges: [{ source: "Start", target: "First_Hop_Retrieve" }],
    add_edges: [{ source: "Start", target: "First_Hop_Retrieve", relation: "LEADS_TO", condition: null, guidance, pitfalls: "" }],
  });
/** Names a node that does not exist: a structural failure. */
export const toGhost = edits({ add_edges: [{ source: "Scan_Index", target: "Ghost", relation: "LEADS_TO", condition: null, guidance: "g", pitfalls: "p" }] });

export const GRAPH = GraphIdSchema.parse("team/web");
export const DREAM = DreamIdSchema.parse("dream-1");

export function input(overrides: Partial<DreamInput> = {}): DreamInput {
  return {
    dream: DREAM,
    graph: GRAPH,
    head: core(),
    settings: paperDream,
    evaluator: true,
    approver: false,
    train: ["t0", "t1", "t2", "t3", "t4"],
    stride: 2,
    task: "Answer multi-hop questions.",
    tools: ["first_hop_retrieve", "Scan_Index"],
    sideEffectFree: [],
    rejections: [],
    ...overrides,
  };
}

type Body = DreamEvent extends infer E ? (E extends DreamEvent ? Omit<E, "command" | "at"> : never) : never;

/** Answers the single pending command with `body`, at time `at`. */
export function answer(state: DreamState, body: Body, at = 1000): { state: DreamState; commands: DreamCommand[] } {
  const [command] = state.pending;
  if (command === undefined || state.pending.length !== 1) throw new Error(`expected one pending command, got ${state.pending.length}`);
  const event = { ...body, command: command.id, at } as DreamEvent;
  return dreamStep(state, event);
}

/** The single pending command, of the expected kind. */
export function pending<K extends DreamCommand["kind"]>(state: DreamState, kind: K): Extract<DreamCommand, { kind: K }> {
  const [command] = state.pending;
  if (command?.kind !== kind) throw new Error(`expected a pending ${kind}, got ${command?.kind ?? "nothing"}`);
  return command as Extract<DreamCommand, { kind: K }>;
}

export const scores = (values: readonly number[], prefix = "v"): { task: string; score: number }[] => values.map((score, i) => ({ task: `${prefix}${i}`, score }));
