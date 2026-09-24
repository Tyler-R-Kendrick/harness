/**
 * A behavior state graph: the character logic a game would write, over features of a
 * sparse autoencoder (SAE) trained on one layer of the model's residual stream.
 * Sensors read features; states steer with features; transitions move between
 * states. It is data, evaluated by the engine, never by the model.
 */

export interface BehaviorGraph {
  readonly version: 1;
  readonly id: string;
  /** The model and residual-stream layer the SAE features belong to. */
  readonly model: { readonly id: string; readonly layer: number };
  readonly initial: string;
  /** Largest absolute steering strength a state may use (default 8). */
  readonly maxStrength?: number;
  /** Named SAE features: name -> feature index in the SAE. */
  readonly features: Readonly<Record<string, number>>;
  readonly sensors: Readonly<Record<string, Sensor>>;
  readonly states: Readonly<Record<string, State>>;
  readonly transitions: readonly Transition[];
}

/** A feature read as an on/off signal, with hysteresis and debounce. */
export interface Sensor {
  readonly feature: string;
  /** Turns on when the activation reaches this... */
  readonly on: number;
  /** ...and off only when it falls to this (must be below `on`). */
  readonly off: number;
  /** Tokens the activation must stay past a threshold before the sensor flips (default 1). */
  readonly hold?: number;
}

export interface State {
  /** Nesting: a child inherits its parent's steering (summed) and transitions. */
  readonly parent?: string;
  /** Feature name -> strength (a multiple of the feature's decoder direction). */
  readonly steer?: Readonly<Record<string, number>>;
}

export type Trigger =
  /** While a sensor is on (or off). */
  | { readonly sensor: string; readonly is: "on" | "off" }
  /** When the host raises an event between turns. */
  | { readonly event: string }
  /** After this many tokens in the state. */
  | { readonly after: number };

export interface Transition {
  /** A state (its children inherit the transition) or "*" for any state. */
  readonly from: string;
  readonly to: string;
  readonly when: Trigger;
  /** Higher wins when several transitions could fire (default 0). */
  readonly priority?: number;
}

export const DEFAULT_MAX_STRENGTH = 8;

/** A state and its ancestors, nearest first. */
export function lineage(graph: BehaviorGraph, state: string): string[] {
  const out: string[] = [];
  for (let s: string | undefined = state; s !== undefined && !out.includes(s); s = graph.states[s]?.parent) out.push(s);
  return out;
}
