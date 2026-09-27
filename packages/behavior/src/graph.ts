/**
 * A behavior state graph: the character logic a game would write, over features of a
 * sparse autoencoder (SAE) trained on one layer of the model's residual stream.
 * Sensors read features; states steer with features; transitions move between
 * states. It is data, evaluated by the engine, never by the model.
 *
 * A `BehaviorGraph` exists only as the output of parsing: `parseGraph` for JSON,
 * `defineGraph` for graphs written in TypeScript (where a misspelt state, sensor or
 * feature is a compile error). Everything downstream trusts it without re-checking.
 */
import { z } from "zod";

export const DEFAULT_MAX_STRENGTH = 8;

const name = z.string().min(1);

const Trigger = z.union([
  /** While a sensor is on (or off). */
  z.strictObject({ sensor: name, is: z.enum(["on", "off"]) }).readonly(),
  /** When the host raises an event between turns. */
  z.strictObject({ event: name }).readonly(),
  /** After this many tokens in the state. */
  z.strictObject({ after: z.int().positive() }).readonly(),
]);

/** A feature read as an on/off signal, with hysteresis and debounce. */
const Sensor = z
  .strictObject({
    feature: name,
    /** Turns on when the activation reaches this... */
    on: z.number(),
    /** ...and off only when it falls to this. */
    off: z.number(),
    /** Tokens the activation must stay past a threshold before the sensor flips (default 1). */
    hold: z.int().min(1).optional(),
  })
  .refine((s) => s.on > s.off, "on must be greater than off")
  .readonly();

const State = z
  .strictObject({
    /** Nesting: a child inherits its parent's steering (summed) and transitions. */
    parent: name.optional(),
    /** Feature name -> strength (a multiple of the feature's decoder direction). */
    steer: z.record(name, z.number()).readonly().optional(),
  })
  .readonly();

const Transition = z
  .strictObject({
    /** A state (its children inherit the transition) or "*" for any state. */
    from: name,
    to: name,
    when: Trigger,
    /** Higher wins when several transitions could fire (default 0). */
    priority: z.number().optional(),
  })
  .readonly();

const Shape = z
  .strictObject({
    /** The JSON Schema an editor checks the file against (data/graph.schema.json). */
    $schema: z.string().exactOptional(),
    version: z.literal(1),
    id: name,
    /** The model and residual-stream layer the SAE features belong to. */
    model: z.strictObject({ id: name, layer: z.int().min(0) }).readonly(),
    initial: name,
    /** Largest absolute steering strength a state may use (default 8). */
    maxStrength: z.number().positive().optional(),
    /** Named SAE features: name -> feature index in the SAE. */
    features: z.record(name, z.int().min(0)).readonly(),
    sensors: z.record(name, Sensor).readonly(),
    states: z.record(name, State).readonly(),
    transitions: z.array(Transition).readonly(),
  })
  .readonly();

type Parents = { readonly states: Readonly<Record<string, { readonly parent?: string | undefined }>> };

/** A state and its ancestors, nearest first. */
export function lineage(graph: Parents, state: string): string[] {
  const out: string[] = [];
  for (let s: string | undefined = state; s !== undefined && !out.includes(s); s = graph.states[s]?.parent) out.push(s);
  return out;
}

/** Every name a graph uses must be defined, parents must not loop, and every state must be reachable. */
function references(g: z.output<typeof Shape>, ctx: z.RefinementCtx): void {
  const issue = (message: string, ...path: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });
  const has = (o: object, key: string) => Object.hasOwn(o, key);
  const max = g.maxStrength ?? DEFAULT_MAX_STRENGTH;

  if (!has(g.states, g.initial)) issue(`initial state ${g.initial} is not defined`, "initial");
  const byIndex = new Map<number, string>();
  for (const [feature, index] of Object.entries(g.features)) {
    const other = byIndex.get(index);
    if (other !== undefined) issue(`features ${other} and ${feature} share index ${index}`, "features", feature);
    byIndex.set(index, feature);
  }
  for (const [sensor, s] of Object.entries(g.sensors)) {
    if (!has(g.features, s.feature)) issue(`sensor ${sensor} reads feature ${s.feature}, which is not defined`, "sensors", sensor, "feature");
  }
  for (const [state, s] of Object.entries(g.states)) {
    if (s.parent !== undefined && !has(g.states, s.parent)) issue(`state ${state} has parent ${s.parent}, which is not defined`, "states", state, "parent");
    else if (s.parent !== undefined && lineage(g, s.parent).includes(state)) issue(`state ${state} is in a parent cycle`, "states", state, "parent");
    for (const [feature, strength] of Object.entries(s.steer ?? {})) {
      if (!has(g.features, feature)) issue(`state ${state} steers with feature ${feature}, which is not defined`, "states", state, "steer", feature);
      if (Math.abs(strength) > max) issue(`state ${state}: strength ${strength} for ${feature} must be within ±${max}`, "states", state, "steer", feature);
    }
  }
  g.transitions.forEach((t, i) => {
    if (t.from !== "*" && !has(g.states, t.from)) issue(`transition ${i} starts at ${t.from}, which is not defined`, "transitions", i, "from");
    if (!has(g.states, t.to)) issue(`transition ${i} goes to ${t.to}, which is not defined`, "transitions", i, "to");
    if ("sensor" in t.when && !has(g.sensors, t.when.sensor)) issue(`transition ${i}: sensor ${t.when.sensor} is not defined`, "transitions", i, "when", "sensor");
  });
  // Reachability is only meaningful for an otherwise sound graph.
  if (ctx.issues.length > 0) return;
  // A transition from state A can fire in A or any descendant of A; "*" fires anywhere.
  const reached = new Set([g.initial]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of g.transitions) {
      if (reached.has(t.to)) continue;
      if (t.from === "*" || [...reached].some((s) => lineage(g, s).includes(t.from))) {
        reached.add(t.to);
        grew = true;
      }
    }
  }
  for (const state of Object.keys(g.states)) if (!reached.has(state)) issue(`state ${state} is unreachable from ${g.initial}`, "states", state);
}

export const BehaviorGraphSchema = Shape.superRefine(references).brand<"BehaviorGraph">();

export type BehaviorGraph = z.output<typeof BehaviorGraphSchema>;
export type Sensor = z.output<typeof Sensor>;
export type State = z.output<typeof State>;
export type Trigger = z.output<typeof Trigger>;
export type Transition = z.output<typeof Transition>;

/** The JSON Schema for graph files, for editors (data/graph.schema.json). */
export const graphJsonSchema = (): object => z.toJSONSchema(Shape, { io: "input" });

/** Parse a graph from untrusted data (a JSON file, a pack); any problem refuses it whole. */
export function parseGraph(input: unknown): BehaviorGraph {
  const result = BehaviorGraphSchema.safeParse(input);
  if (!result.success) throw new Error(`invalid behavior graph\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** A graph written in TypeScript: states, sensors and features are checked by name at compile time. */
export interface GraphSpec<S extends string, F extends string, N extends string> {
  readonly version: 1;
  readonly id: string;
  readonly model: { readonly id: string; readonly layer: number };
  readonly initial: NoInfer<S>;
  readonly maxStrength?: number;
  readonly features: Readonly<Record<F, number>>;
  readonly sensors: Readonly<Record<N, { readonly feature: NoInfer<F>; readonly on: number; readonly off: number; readonly hold?: number }>>;
  readonly states: Readonly<Record<S, { readonly parent?: NoInfer<S>; readonly steer?: Readonly<Partial<Record<NoInfer<F>, number>>> }>>;
  readonly transitions: readonly {
    readonly from: NoInfer<S> | "*";
    readonly to: NoInfer<S>;
    readonly when: { readonly sensor: NoInfer<N>; readonly is: "on" | "off" } | { readonly event: string } | { readonly after: number };
    readonly priority?: number;
  }[];
}

export function defineGraph<const S extends string, const F extends string, const N extends string = never>(spec: GraphSpec<S, F, N>): BehaviorGraph {
  return parseGraph(spec);
}
