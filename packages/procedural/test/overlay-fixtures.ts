/** Overlay fixtures: the hotpot core, entries on it, and helpers that fold events. */
import { EntryIdSchema, entryId, exposed, OverlayEntrySchema, OverlayEventSchema, parseGraph } from "@harness/procedural";
import type { EntryId, OverlayEntry, OverlayEvent, ProceduralGraph } from "@harness/procedural";
import { hotpot } from "./fixtures.ts";

/** Start → First_Hop_Retrieve → Scan_Index → Bridge_Extract → End. */
export function core(): ProceduralGraph {
  const parsed = parseGraph(hotpot());
  if (!parsed.ok) throw new Error("fixture");
  return parsed.graph;
}

export const entry = (input: unknown): OverlayEntry => OverlayEntrySchema.parse(input);
export const event = (input: unknown): OverlayEvent => OverlayEventSchema.parse(input);
export const idOf = (input: unknown): EntryId => entryId(entry(input));
export const hexId = (hex: string): EntryId => EntryIdSchema.parse(hex.repeat(64 / hex.length));

/** A transition the core lacks (a shortcut), a node, and an edge that needs the node. */
export const shortcut = { kind: "edge", from: "Scan_Index", relation: "LEADS_TO", to: "End", condition: null, guidance: "Answer directly.", pitfalls: "" };
export const verifyNode = { kind: "node", id: "Verify", type: "REASONING", description: "Check the answer." };
export const toVerify = { kind: "edge", from: "Bridge_Extract", relation: "LEADS_TO", to: "Verify", condition: null, guidance: "Check first.", pitfalls: "" };
export const noteOnCore = { kind: "note", on: { from: "Start", to: "First_Hop_Retrieve" }, text: "Retrieve before reasoning." };
export const cautionOnCore = { kind: "caution", on: { from: "Bridge_Extract", to: "End" }, text: "This edge preceded failures." };
export const noteOnShortcut = { kind: "note", on: { from: "Scan_Index", to: "End" }, text: "Only when the passage names the answer." };

export const observed = (turnKey: string, path: string[], score: number | null = null, exposure: EntryId[] = [], unmatched: string[] = []): OverlayEvent =>
  event({ kind: "observed", turnKey, path, unmatched, score, exposure });
export const proposed = (input: unknown, sessions: string[], by: "stats" | "reflection" = "stats"): OverlayEvent =>
  event({ kind: "proposed", entry: input, source: { sessions, by } });
export const status = (id: EntryId, to: "active" | "retired", reason = "test"): OverlayEvent => event({ kind: "status", entry: id, to, reason });

/** The first salt `salt-<i>` for which the entry is (or is not) exposed at the share. */
export function saltWhere(id: EntryId, share: number, want: boolean): string {
  for (let i = 0; i < 10_000; i += 1) if (exposed(`salt-${i}`, id, share) === want) return `salt-${i}`;
  throw new Error("no salt");
}

/** Freeze a value and everything in it, so a mutation throws. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
