/**
 * The lifecycle of every learned artefact (a rule, a calibration, a criteria version, a
 * head): candidate, shadow, active, retired. The dialogue's shadow, promote, retire and
 * audit lifecycle, generalized (ADR 0012, ADR 0030).
 *
 * - `candidate`: added, no evidence yet.
 * - `shadow`: has evidence. It decides and is checked against what was right, and never
 *   answers (`use` says no).
 * - `active`: enough evidence (fits, distinct sessions, and a Wilson lower bound on the
 *   fit rate). It answers, and every n-th use is an audit: the artefact does not answer
 *   and is checked in shadow instead.
 * - `retired`: misled by a margin. A tombstone: adding the same key again does nothing
 *   until `revive`.
 *
 * Evidence from the sessions an artefact was built from does not count: an artefact
 * always fits the data it was made from.
 */
import { wilsonInterval } from "@harness/cognitive";
import { z } from "zod";
import { ProbabilitySchema } from "./types.ts";

export const LIFECYCLE_STATES = ["candidate", "shadow", "active", "retired"] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

// ---- settings, as data ---------------------------------------------------------------------------

export const LifecycleSettingsSchema = z.strictObject({
  $schema: z.string().exactOptional(),
  promote: z.strictObject({
    /** Fits an artefact needs in shadow before it can be promoted. */
    fits: z.int().min(1),
    /** Distinct sessions that must have given evidence (0: no requirement). */
    sessions: z.int().min(0),
    /** The Wilson lower bound (95%) of the fit rate that must be reached. */
    lowerBound: ProbabilitySchema,
  }),
  retire: z.strictObject({
    /** Misses minus fits (in shadow, or since promotion while active) at which an artefact is retired. */
    margin: z.int().min(1),
  }),
  audit: z.strictObject({
    /** Every n-th use of an active artefact is shadowed and checked. */
    every: z.int().min(1),
  }),
});
export type LifecycleSettings = z.output<typeof LifecycleSettingsSchema>;

function parse<T>(schema: z.ZodType<T>, what: string, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(`invalid ${what}\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** Parse the lifecycle's settings file (see data/lifecycle.json). */
export const parseLifecycleSettings = (input: unknown): LifecycleSettings => parse(LifecycleSettingsSchema, "lifecycle settings", input);

/** JSON Schema for the settings file, for editors (data/lifecycle.schema.json). */
// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent; this schema's input and output JSON Schemas are the same
export const lifecycleSettingsJsonSchema = (): object => z.toJSONSchema(LifecycleSettingsSchema, { io: "input" });

// ---- artefacts -------------------------------------------------------------------------------------

/** An artefact as `list` and snapshots show it. */
export interface Artefact<K extends string = string> {
  readonly key: K;
  readonly state: LifecycleState;
  /** Where it came from (induced, fitted, authored, ...): provenance only. */
  readonly origin: string;
  /** The sessions it was built from: their evidence does not count. */
  readonly builtFrom: readonly string[];
  /** Evidence counted, in every phase. */
  readonly fits: number;
  readonly misses: number;
  /** Distinct sessions that gave evidence (as many as promotion needs). */
  readonly sessions: readonly string[];
  /** Evidence since promotion: what retires an active artefact. */
  readonly activeFits: number;
  readonly activeMisses: number;
  /** Uses of the artefact while active, audits included. */
  readonly uses: number;
}

export interface Evidence {
  /** Whether the artefact's answer was what was right. */
  readonly fit: boolean;
  /** The session the evidence comes from, when it is known. */
  readonly session?: string | undefined;
}

export interface Observation {
  /** False when the evidence was ignored (retired artefact, or from a session it was built from). */
  readonly counted: boolean;
  readonly from: LifecycleState;
  readonly to: LifecycleState;
}

export interface Use {
  /** The artefact answers (it is active and this use is not an audit). */
  readonly answer: boolean;
  /** This use is an audit: something else answers and the artefact is checked in shadow. */
  readonly audit: boolean;
}

const FORMAT = "harness.decision.lifecycle/v1";
const count = z.int().min(0);

const ArtefactSchema = z
  .strictObject({
    key: z.string().min(1),
    state: z.enum(LIFECYCLE_STATES),
    origin: z.string().min(1),
    builtFrom: z.array(z.string()),
    fits: count,
    misses: count,
    sessions: z.array(z.string()),
    activeFits: count,
    activeMisses: count,
    uses: count,
  })
  .refine((a) => new Set(a.sessions).size === a.sessions.length, "sessions are unique");

const SnapshotSchema = z
  .strictObject({ format: z.literal(FORMAT), artefacts: z.array(ArtefactSchema) })
  .refine((s) => new Set(s.artefacts.map((a) => a.key)).size === s.artefacts.length, "keys are unique");

/** What `snapshot` returns and `restore` reads. */
export interface LifecycleSnapshot {
  readonly format: typeof FORMAT;
  readonly artefacts: readonly Artefact[];
}

interface Entry {
  state: LifecycleState;
  readonly origin: string;
  readonly builtFrom: string[];
  fits: number;
  misses: number;
  sessions: string[];
  activeFits: number;
  activeMisses: number;
  uses: number;
}

export class Lifecycle<K extends string = string> {
  readonly #settings: LifecycleSettings;
  #artefacts = new Map<K, Entry>();

  constructor(settings: LifecycleSettings) {
    this.#settings = settings;
  }

  /**
   * Add a candidate. A key that is known (in any state, a retired one included) is left
   * as it is and its state returned: retired artefacts are not re-added.
   */
  add(key: K, options: { readonly origin: string; readonly builtFrom?: readonly string[] }): LifecycleState {
    const known = this.#artefacts.get(key);
    if (known !== undefined) return known.state;
    this.#artefacts.set(key, { state: "candidate", origin: options.origin, builtFrom: [...(options.builtFrom ?? [])], fits: 0, misses: 0, sessions: [], activeFits: 0, activeMisses: 0, uses: 0 });
    return "candidate";
  }

  /** Start a retired artefact over: a candidate with no evidence. Refused for one that is not retired. */
  revive(key: K): LifecycleState {
    const entry = this.#get(key);
    if (entry.state !== "retired") throw new Error(`artefact "${key}" is ${entry.state}, only a retired one is revived`);
    this.#artefacts.set(key, { ...entry, state: "candidate", fits: 0, misses: 0, sessions: [], activeFits: 0, activeMisses: 0, uses: 0 });
    return "candidate";
  }

  state(key: K): LifecycleState | undefined {
    return this.#artefacts.get(key)?.state;
  }

  /** Whether the next use of the artefact is an audit (it is active and the counter reaches `audit.every`). */
  shouldAudit(key: K): boolean {
    const entry = this.#get(key);
    return entry.state === "active" && (entry.uses + 1) % this.#settings.audit.every === 0;
  }

  /** Use the artefact: only an active one answers, and every n-th use is an audit, in which it does not. */
  use(key: K): Use {
    const entry = this.#get(key);
    if (entry.state !== "active") return { answer: false, audit: false };
    entry.uses += 1;
    const audit = entry.uses % this.#settings.audit.every === 0;
    return { answer: !audit, audit };
  }

  /**
   * Evidence: the artefact's answer fit what was right, or missed. Evidence from a
   * session the artefact was built from, and any about a retired artefact, is ignored.
   */
  observe(key: K, evidence: Evidence): Observation {
    const entry = this.#get(key);
    const from = entry.state;
    // Stryker disable next-line ConditionalExpression: equivalent; builtFrom holds strings, so it never includes an undefined session
    if (from === "retired" || (evidence.session !== undefined && entry.builtFrom.includes(evidence.session))) return { counted: false, from, to: from };
    const { promote, retire } = this.#settings;
    if (evidence.fit) entry.fits += 1;
    else entry.misses += 1;
    if (evidence.session !== undefined && !entry.sessions.includes(evidence.session) && entry.sessions.length < promote.sessions) entry.sessions.push(evidence.session);
    if (entry.state === "active") {
      if (evidence.fit) entry.activeFits += 1;
      else entry.activeMisses += 1;
      if (entry.activeMisses - entry.activeFits >= retire.margin) entry.state = "retired";
    } else {
      entry.state = "shadow";
      if (entry.misses - entry.fits >= retire.margin) entry.state = "retired";
      else if (entry.fits >= promote.fits && entry.sessions.length >= promote.sessions && wilsonInterval(entry.fits, entry.fits + entry.misses)[0] >= promote.lowerBound) entry.state = "active";
    }
    return { counted: true, from, to: entry.state };
  }

  /** Every artefact in the order added, retired ones included, as copies. */
  list(): Artefact<K>[] {
    return [...this.#artefacts].map(([key, e]) => ({ key, state: e.state, origin: e.origin, builtFrom: [...e.builtFrom], fits: e.fits, misses: e.misses, sessions: [...e.sessions], activeFits: e.activeFits, activeMisses: e.activeMisses, uses: e.uses }));
  }

  /** Everything, as JSON (`restore` reads it). */
  snapshot(): LifecycleSnapshot {
    return { format: FORMAT, artefacts: this.list() };
  }

  /**
   * Replace what is held with a snapshot. The snapshot is validated first: one that is not
   * valid is refused, naming where, and nothing changes. Keys are taken as they are saved.
   */
  restore(snapshot: unknown): void {
    const parsed = parse(SnapshotSchema, "lifecycle snapshot", snapshot);
    this.#artefacts = new Map(parsed.artefacts.map(({ key, ...entry }) => [key as K, entry]));
  }

  #get(key: K): Entry {
    const entry = this.#artefacts.get(key);
    if (entry === undefined) throw new Error(`no artefact "${key}"`);
    return entry;
  }
}
