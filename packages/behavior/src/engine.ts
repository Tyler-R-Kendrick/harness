import { lineage } from "./graph.ts";
import type { Transition } from "./graph.ts";
import type { BehaviorPack } from "./pack.ts";

export interface TransitionTaken {
  readonly from: string;
  readonly to: string;
  readonly cause: string;
}

export interface StepResult {
  readonly state: string;
  readonly transition?: TransitionTaken;
  /** Steering for the next token: the (possibly new) state's vector. */
  readonly steering: Float32Array | undefined;
  /** Activation of each sensed feature for this token. */
  readonly activations: Readonly<Record<string, number>>;
}

export interface EngineSnapshot {
  readonly graph: string;
  readonly state: string;
  readonly tokensInState: number;
  readonly sensors: Readonly<Record<string, { readonly on: boolean; readonly run: number }>>;
}

/**
 * Runs a behavior pack token by token. Each step reads the residual stream at the
 * graph's layer, updates the sensors (with hysteresis and hold times), takes at most
 * one transition, and returns the steering vector for the next token. Deterministic:
 * the same inputs always give the same timeline.
 */
export class BehaviorEngine {
  readonly #pack: BehaviorPack;
  #state: string;
  #tokensInState: number;
  #sensors: Record<string, { on: boolean; run: number }>;

  constructor(pack: BehaviorPack, snapshot?: EngineSnapshot) {
    this.#pack = pack;
    const g = pack.graph;
    if (snapshot && snapshot.graph !== g.id) throw new Error(`snapshot is for graph ${snapshot.graph}, not ${g.id}`);
    if (snapshot && !(snapshot.state in g.states)) throw new Error(`snapshot state ${snapshot.state} is not in graph ${g.id}`);
    this.#state = snapshot?.state ?? g.initial;
    this.#tokensInState = snapshot?.tokensInState ?? 0;
    this.#sensors = Object.fromEntries(Object.keys(g.sensors).map((name) => [name, { ...(snapshot?.sensors[name] ?? { on: false, run: 0 }) }]));
  }

  get state(): string {
    return this.#state;
  }

  steering(): Float32Array | undefined {
    return this.#pack.steering[this.#state];
  }

  step(residual: Float32Array): StepResult {
    if (residual.length !== this.#pack.dims) throw new Error(`residual has ${residual.length} values, expected ${this.#pack.dims}`);
    const activations: Record<string, number> = {};
    for (const f of this.#pack.sense) {
      let pre = f.bias;
      for (let i = 0; i < residual.length; i++) pre += f.weights[i]! * residual[i]!;
      activations[f.feature] = pre > f.threshold ? pre : 0;
    }
    for (const [name, sensor] of Object.entries(this.#pack.graph.sensors)) {
      const s = this.#sensors[name]!;
      const a = activations[sensor.feature]!;
      const pushing = s.on ? a <= sensor.off : a >= sensor.on;
      s.run = pushing ? s.run + 1 : 0;
      if (s.run >= (sensor.hold ?? 1)) {
        s.on = !s.on;
        s.run = 0;
      }
    }
    this.#tokensInState++;
    const transition = this.#take((t) => {
      const w = t.when;
      if ("sensor" in w) return this.#sensors[w.sensor]!.on === (w.is === "on") ? `sensor ${w.sensor} ${w.is}` : undefined;
      if ("after" in w) return this.#tokensInState >= w.after ? `after ${w.after} tokens` : undefined;
      return undefined;
    });
    return { state: this.#state, ...(transition ? { transition } : {}), steering: this.steering(), activations };
  }

  /** A host event between turns; returns the transition it caused, if any. */
  event(name: string): TransitionTaken | undefined {
    return this.#take((t) => ("event" in t.when && t.when.event === name ? `event ${name}` : undefined));
  }

  snapshot(): EngineSnapshot {
    return {
      graph: this.#pack.graph.id,
      state: this.#state,
      tokensInState: this.#tokensInState,
      sensors: Object.fromEntries(Object.entries(this.#sensors).map(([k, v]) => [k, { ...v }])),
    };
  }

  /** Take the best transition whose trigger holds: highest priority, then most specific source, then first declared. */
  #take(holds: (t: Transition) => string | undefined): TransitionTaken | undefined {
    const g = this.#pack.graph;
    const line = lineage(g, this.#state);
    let best: { t: Transition; cause: string; rank: [number, number, number] } | undefined;
    g.transitions.forEach((t, i) => {
      if (t.to === this.#state) return;
      const depth = t.from === "*" ? line.length : line.indexOf(t.from);
      if (depth < 0) return;
      const cause = holds(t);
      if (cause === undefined) return;
      const rank: [number, number, number] = [-(t.priority ?? 0), depth, i];
      if (!best || rank[0] < best.rank[0] || (rank[0] === best.rank[0] && (rank[1] < best.rank[1] || (rank[1] === best.rank[1] && rank[2] < best.rank[2])))) best = { t, cause, rank };
    });
    if (!best) return undefined;
    const taken = { from: this.#state, to: best.t.to, cause: best.cause };
    this.#state = best.t.to;
    this.#tokensInState = 0;
    return taken;
  }
}

export type ReplayItem = { readonly residual: Float32Array } | { readonly event: string };

export interface TimelineEntry {
  readonly at: number;
  readonly state: string;
  readonly transition?: TransitionTaken;
}

/** Run a recorded transcript (residuals and host events) and return the state timeline. */
export function replay(pack: BehaviorPack, items: readonly ReplayItem[], snapshot?: EngineSnapshot): TimelineEntry[] {
  const engine = new BehaviorEngine(pack, snapshot);
  return items.map((item, at) => {
    if ("event" in item) {
      const transition = engine.event(item.event);
      return { at, state: engine.state, ...(transition ? { transition } : {}) };
    }
    const r = engine.step(item.residual);
    return { at, state: r.state, ...(r.transition ? { transition: r.transition } : {}) };
  });
}
