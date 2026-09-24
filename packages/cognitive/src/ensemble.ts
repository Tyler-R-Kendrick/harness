import type { EmbedInput } from "./embedding.ts";
import type { ModelDescriptor, Platform, PortKind, TaskCategory } from "./models.ts";
import type {
  Compression,
  CompressRequest,
  GenerateRequest,
  GenerationEvent,
  JudgeAnswer,
  JudgeRequest,
  ParsedPage,
  ParseRequest,
  PortMap,
  Ports,
  RouteRequest,
  Routing,
} from "./ports.ts";
import { rankForTask } from "./selection.ts";
import type { Ranked, SelectionOptions } from "./selection.ts";

export type MemberState = "offline" | "loading" | "ready" | "failed" | "revoked";

export interface MemberEvent {
  readonly id: string;
  readonly state: MemberState;
  readonly reason?: string;
}

export class CognitiveError extends Error {
  readonly code: "no_member";
  constructor(code: "no_member", message: string) {
    super(message);
    this.name = "CognitiveError";
    this.code = code;
  }
}

interface Member {
  readonly descriptor: ModelDescriptor;
  readonly load: () => Promise<Ports>;
  state: MemberState;
  reason?: string;
  ports?: Ports;
  loading?: Promise<Ports | undefined>;
  /** Bumped on revoke/reset so a load that finishes afterwards is discarded. */
  generation: number;
}

export interface EnsembleOptions {
  readonly platform: Platform;
  readonly selection?: Omit<SelectionOptions, "platform" | "pin" | "prefer">;
  /** Per-task tie-break order for models that benchmarks cannot separate. */
  readonly preferences?: Partial<Record<TaskCategory, readonly string[]>>;
  /** Per-task model pins, e.g. to force a model while evaluating it. */
  readonly pins?: Partial<Record<TaskCategory, string>>;
}

/**
 * The cognitive core's model ensemble. Members are registered with a descriptor and
 * a loader; they load on first use, and a member that fails to load, or is revoked
 * by the platform, is skipped in favour of the next-best model for the task. Every
 * state change is published so the daemon can offer and withdraw capabilities.
 */
export class Ensemble {
  readonly #options: EnsembleOptions;
  readonly #members = new Map<string, Member>();
  readonly #listeners = new Set<(event: MemberEvent) => void>();

  constructor(options: EnsembleOptions) {
    this.#options = options;
  }

  get platform(): Platform {
    return this.#options.platform;
  }

  register(descriptor: ModelDescriptor, load: () => Promise<Ports>): void {
    if (this.#members.has(descriptor.id)) throw new Error(`model ${descriptor.id} is already registered`);
    if (!descriptor.platforms.includes(this.#options.platform)) {
      throw new Error(`model ${descriptor.id} does not run on ${this.#options.platform}`);
    }
    this.#members.set(descriptor.id, { descriptor, load, state: "offline", generation: 0 });
  }

  state(id: string): MemberState | undefined {
    return this.#members.get(id)?.state;
  }

  members(): { id: string; state: MemberState; reason?: string; descriptor: ModelDescriptor }[] {
    return [...this.#members.values()].map((m) => ({ id: m.descriptor.id, state: m.state, descriptor: m.descriptor, ...(m.reason === undefined ? {} : { reason: m.reason }) }));
  }

  onChange(listener: (event: MemberEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Take a member out of service, e.g. when the platform withdraws the hardware it needs. */
  revoke(id: string, reason: string): void {
    const m = this.#require(id);
    m.generation++;
    delete m.ports;
    delete m.loading;
    this.#set(m, "revoked", reason);
  }

  /** Return a revoked member to service; it reloads on next use. */
  restore(id: string): void {
    const m = this.#require(id);
    if (m.state === "revoked") this.#set(m, "offline");
  }

  /** Clear a failure so the member is tried again. */
  reset(id: string): void {
    const m = this.#require(id);
    if (m.state === "failed") {
      m.generation++;
      this.#set(m, "offline");
    }
  }

  /** Ranked candidates for a task among members that are in service. */
  candidates(task: TaskCategory): Ranked[] {
    const usable = [...this.#members.values()].filter((m) => m.state !== "revoked" && m.state !== "failed").map((m) => m.descriptor);
    const pin = this.#options.pins?.[task];
    const prefer = this.#options.preferences?.[task];
    return rankForTask(task, usable, {
      ...this.#options.selection,
      platform: this.#options.platform,
      ...(pin === undefined ? {} : { pin }),
      ...(prefer === undefined ? {} : { prefer }),
    });
  }

  async judge(request: JudgeRequest): Promise<Record<string, JudgeAnswer>> {
    return (await this.#use("judgment", "judge")).port.evaluate(request);
  }

  async route(request: RouteRequest): Promise<Routing> {
    return (await this.#use("tool-calling", "router")).port.route(request);
  }

  async embed(inputs: readonly EmbedInput[], options?: { readonly dimensions?: number }): Promise<Float32Array[]> {
    return (await this.#use("text-embedding", "embedder")).port.embed(inputs, options);
  }

  async compress(request: CompressRequest): Promise<Compression> {
    return (await this.#use("prompt-compression", "compressor")).port.compress(request);
  }

  async parseDocument(request: ParseRequest, task: TaskCategory = "document-parsing"): Promise<{ readonly pages: readonly ParsedPage[] }> {
    return (await this.#use(task, "document-parser")).port.parse(request);
  }

  async *generate(request: GenerateRequest, task: TaskCategory = "chat"): AsyncIterable<GenerationEvent> {
    const { port } = await this.#use(task, "generator");
    yield* port.generate(request);
  }

  /** The member and port that would serve `task` now, loading it if needed. */
  async resolve<K extends PortKind>(task: TaskCategory, kind: K): Promise<{ id: string; port: PortMap[K] }> {
    return this.#use(task, kind);
  }

  async #use<K extends PortKind>(task: TaskCategory, kind: K): Promise<{ id: string; port: PortMap[K] }> {
    for (const candidate of this.candidates(task)) {
      if (!candidate.descriptor.ports.includes(kind)) continue;
      const m = this.#members.get(candidate.id)!;
      const ports = await this.#ensure(m);
      const port = ports?.[kind];
      if (port) return { id: candidate.id, port: port as PortMap[K] };
      if (ports) this.#set(m, "failed", `adapter does not provide the ${kind} port it declared`);
    }
    throw new CognitiveError("no_member", `no ${kind} member available for ${task} on ${this.#options.platform}`);
  }

  async #ensure(m: Member): Promise<Ports | undefined> {
    if (m.state === "ready") return m.ports;
    if (m.loading) return m.loading;
    const generation = m.generation;
    this.#set(m, "loading");
    m.loading = m.load().then(
      (ports) => {
        if (m.generation !== generation) return undefined;
        delete m.loading;
        m.ports = ports;
        this.#set(m, "ready");
        return ports;
      },
      (error: unknown) => {
        if (m.generation !== generation) return undefined;
        delete m.loading;
        this.#set(m, "failed", error instanceof Error ? error.message : String(error));
        return undefined;
      },
    );
    return m.loading;
  }

  #set(m: Member, state: MemberState, reason?: string): void {
    m.state = state;
    if (reason === undefined) delete m.reason;
    else m.reason = reason;
    const event: MemberEvent = { id: m.descriptor.id, state, ...(reason === undefined ? {} : { reason }) };
    for (const listener of this.#listeners) listener(event);
  }

  #require(id: string): Member {
    const m = this.#members.get(id);
    if (!m) throw new Error(`no model ${id} is registered`);
    return m;
  }
}
