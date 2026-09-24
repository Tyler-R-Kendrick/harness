import { DEFAULT_MAX_STRENGTH, lineage } from "./graph.ts";
import type { BehaviorGraph, Trigger } from "./graph.ts";

export type Validation = { readonly ok: true } | { readonly ok: false; readonly problems: readonly string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function triggerProblem(when: Trigger | Record<string, unknown>, g: BehaviorGraph): string | undefined {
  const w = when as Record<string, unknown>;
  if ("sensor" in w) {
    if (typeof w["sensor"] !== "string" || !(w["sensor"] in g.sensors)) return `sensor ${String(w["sensor"])} is not defined`;
    if (w["is"] !== "on" && w["is"] !== "off") return `sensor trigger must say on or off`;
    return undefined;
  }
  if ("event" in w) return typeof w["event"] === "string" && w["event"] !== "" ? undefined : `event name must be a non-empty string`;
  if ("after" in w) return Number.isInteger(w["after"]) && (w["after"] as number) > 0 ? undefined : `after must be a positive whole number of tokens`;
  return `trigger must be a sensor, an event or an after`;
}

/** Check a graph completely; any problem means the graph is refused whole. */
export function validateGraph(graph: BehaviorGraph): Validation {
  if (!isRecord(graph)) return { ok: false, problems: ["graph must be an object"] };
  const g = graph;
  const problems: string[] = [];
  const states = isRecord(g.states) ? g.states : {};
  const sensors = isRecord(g.sensors) ? g.sensors : {};
  const features = isRecord(g.features) ? g.features : {};
  const max = g.maxStrength ?? DEFAULT_MAX_STRENGTH;

  if (g.version !== 1) problems.push(`version must be 1`);
  if (typeof g.id !== "string" || g.id === "") problems.push(`id must be a non-empty string`);
  if (!isRecord(g.model) || !Number.isInteger(g.model.layer) || g.model.layer < 0) problems.push(`model layer must be a non-negative integer`);
  if (!(g.initial in states)) problems.push(`initial state ${g.initial} is not defined`);

  const seen = new Map<number, string>();
  for (const [name, index] of Object.entries(features)) {
    if (!Number.isInteger(index) || index < 0) problems.push(`feature ${name} needs a non-negative integer index`);
    else if (seen.has(index)) problems.push(`features ${seen.get(index)} and ${name} share index ${index}`);
    else seen.set(index, name);
  }

  for (const [name, s] of Object.entries(sensors)) {
    if (!(s.feature in features)) problems.push(`sensor ${name} reads feature ${s.feature}, which is not defined`);
    if (!(Number.isFinite(s.on) && Number.isFinite(s.off) && s.on > s.off)) problems.push(`sensor ${name}: on must be greater than off`);
    if (s.hold !== undefined && !(Number.isInteger(s.hold) && s.hold >= 1)) problems.push(`sensor ${name}: hold must be a whole number of tokens, at least 1`);
  }

  for (const [name, s] of Object.entries(states)) {
    if (s.parent !== undefined && !(s.parent in states)) problems.push(`state ${name} has parent ${s.parent}, which is not defined`);
    else if (s.parent !== undefined && lineage(g, s.parent).includes(name)) problems.push(`state ${name} is in a parent cycle`);
    for (const [feature, strength] of Object.entries(s.steer ?? {})) {
      if (!(feature in features)) problems.push(`state ${name} steers with feature ${feature}, which is not defined`);
      if (!Number.isFinite(strength) || Math.abs(strength) > max) problems.push(`state ${name}: strength ${strength} for ${feature} must be finite and within ±${max}`);
    }
  }

  const transitions = Array.isArray(g.transitions) ? g.transitions : [];
  transitions.forEach((t, i) => {
    if (t.from !== "*" && !(t.from in states)) problems.push(`transition ${i} starts at ${t.from}, which is not defined`);
    if (!(t.to in states)) problems.push(`transition ${i} goes to ${t.to}, which is not defined`);
    const p = isRecord(t.when) ? triggerProblem(t.when, g) : "trigger must be an object";
    if (p) problems.push(`transition ${i}: ${p}`);
  });

  if (problems.length === 0) {
    // A transition from state A can fire in A or any descendant of A; "*" fires anywhere.
    const reached = new Set([g.initial]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of transitions) {
        if (reached.has(t.to)) continue;
        if (t.from === "*" || [...reached].some((s) => lineage(g, s).includes(t.from))) {
          reached.add(t.to);
          grew = true;
        }
      }
    }
    for (const name of Object.keys(states)) if (!reached.has(name)) problems.push(`state ${name} is unreachable from ${g.initial}`);
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
