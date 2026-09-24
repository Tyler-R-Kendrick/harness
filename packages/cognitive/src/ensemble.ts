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
import type { Dimensions } from "./units.ts";

export type MemberState = "offline" | "loading" | "ready" | "failed" | "revoked";

export interface MemberEvent {
  /** A member's id; for "installed" and "uninstalled", an extension's. */
  readonly id: string;
  /** "removed" when an extension that brought the member is uninstalled. */
  readonly state: MemberState | "removed" | "installed" | "uninstalled";
  readonly reason?: string;
}

/**
 * A bundle the cognitive core can take on at runtime, such as memory with its
 * embedding model. Installing registers its models; uninstalling takes them away.
 */
export interface CognitiveExtension {
  /** Also the capability the daemon offers while the extension can serve. */
  readonly id: string;
  readonly models: readonly { readonly descriptor: ModelDescriptor; readonly load: () => Promise<Ports> }[];
  /** Extensions it builds on: it installs only after them, and serves only while they serve. */
  readonly requires?: readonly string[];
  /** Operations served as `<id>.<name>` through `_harness/cognitive/invoke`. */
  readonly operations?: Readonly<Record<string, (input: unknown) => Promise<unknown>>>;
}

/** AI SDK call errors carry these: a status other than a rejected request, or retryable (e.g. the connection failed). */
function serviceUnavailable(e: unknown): boolean {
  const { statusCode, isRetryable } = (typeof e === "object" && e !== null ? e : {}) as { statusCode?: unknown; isRetryable?: unknown };
  return isRetryable === true || (typeof statusCode === "number" && statusCode !== 400 && statusCode !== 422);
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
  readonly #extensions = new Map<string, CognitiveExtension>();

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

  /** Take on an extension's models, all or none; returns a function that removes them again. */
  install(extension: CognitiveExtension): () => void {
    if (this.#extensions.has(extension.id)) throw new Error(`extension ${extension.id} is already installed`);
    for (const r of extension.requires ?? []) if (!this.#extensions.has(r)) throw new Error(`extension ${extension.id} requires ${r}, which is not installed`);
    const added: string[] = [];
    try {
      for (const m of extension.models) added.push((this.register(m.descriptor, m.load), m.descriptor.id));
    } catch (e) {
      for (const id of added) this.#members.delete(id);
      throw e;
    }
    this.#extensions.set(extension.id, extension);
    for (const m of extension.models) this.#emit({ id: m.descriptor.id, state: "offline" });
    this.#emit({ id: extension.id, state: "installed" });
    return () => {
      if (this.#extensions.get(extension.id) !== extension) return;
      const dependent = [...this.#extensions.values()].find((x) => x.requires?.includes(extension.id));
      if (dependent) throw new Error(`extension ${extension.id} is required by ${dependent.id}; uninstall it first`);
      this.#extensions.delete(extension.id);
      for (const { descriptor } of extension.models) {
        this.#members.get(descriptor.id)!.generation++;
        this.#members.delete(descriptor.id);
        this.#emit({ id: descriptor.id, state: "removed" });
      }
      this.#emit({ id: extension.id, state: "uninstalled" });
    };
  }

  /** Installed extensions that can serve: one of their models is in service (if they bring any), and so is every extension they require. */
  extensions(): string[] {
    const inService = (id: string) => ["offline", "loading", "ready"].includes(this.#members.get(id)?.state ?? "");
    const serves = (x: CognitiveExtension): boolean =>
      (x.models.length === 0 || x.models.some((m) => inService(m.descriptor.id))) && (x.requires ?? []).every((r) => serves(this.#extensions.get(r)!));
    return [...this.#extensions.values()].filter(serves).map((x) => x.id);
  }

  /** An installed extension's operation, by its `<extension>.<name>` name. */
  operation(name: string): ((input: unknown) => Promise<unknown>) | undefined {
    const [extension = "", op = ""] = name.split(".");
    const operations = this.#extensions.get(extension)?.operations;
    return operations && Object.hasOwn(operations, op) ? operations[op] : undefined;
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
    return this.#call("judgment", "judge", (port) => port.evaluate(request));
  }

  async route(request: RouteRequest): Promise<Routing> {
    return this.#call("tool-calling", "router", (port) => port.route(request));
  }

  async embed(inputs: readonly EmbedInput[], options?: { readonly dimensions?: Dimensions }): Promise<Float32Array[]> {
    return this.#call("text-embedding", "embedder", (port) => port.embed(inputs, options));
  }

  async compress(request: CompressRequest): Promise<Compression> {
    return this.#call("prompt-compression", "compressor", (port) => port.compress(request));
  }

  async parseDocument(request: ParseRequest, task: TaskCategory = "document-parsing"): Promise<{ readonly pages: readonly ParsedPage[] }> {
    return this.#call(task, "document-parser", (port) => port.parse(request));
  }

  /** A constrained request goes first to generators that enforce that kind of constraint. */
  async *generate(request: GenerateRequest, task: TaskCategory = "chat"): AsyncIterable<GenerationEvent> {
    const kind = request.constraint?.type;
    const { port } = await this.#use(task, "generator", kind ? (d) => d.constraints?.includes(kind) === true : undefined);
    yield* port.generate(request);
  }

  /** The member and port that would serve `task` now, loading it if needed. */
  async resolve<K extends PortKind>(task: TaskCategory, kind: K): Promise<{ id: string; port: PortMap[K] }> {
    return this.#use(task, kind);
  }

  /**
   * Run a call on the best member, moving to the next when the member's service is
   * unavailable (out of budget, unauthorized, down); a rejected request is the caller's.
   */
  async #call<K extends PortKind, T>(task: TaskCategory, kind: K, call: (port: PortMap[K]) => Promise<T>): Promise<T> {
    let unavailable: unknown;
    for (;;) {
      let chosen: { id: string; port: PortMap[K] };
      try {
        chosen = await this.#use(task, kind);
      } catch (e) {
        throw unavailable ?? e;
      }
      try {
        return await call(chosen.port);
      } catch (e) {
        if (!serviceUnavailable(e)) throw e;
        unavailable = e;
        this.#set(this.#members.get(chosen.id)!, "failed", e instanceof Error ? e.message : String(e));
      }
    }
  }

  async #use<K extends PortKind>(task: TaskCategory, kind: K, prefer?: (d: ModelDescriptor) => boolean): Promise<{ id: string; port: PortMap[K] }> {
    const ranked = this.candidates(task);
    const ordered = prefer ? [...ranked.filter((c) => prefer(c.descriptor)), ...ranked.filter((c) => !prefer(c.descriptor))] : ranked;
    for (const candidate of ordered) {
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
    this.#emit({ id: m.descriptor.id, state, ...(reason === undefined ? {} : { reason }) });
  }

  #emit(event: MemberEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #require(id: string): Member {
    const m = this.#members.get(id);
    if (!m) throw new Error(`no model ${id} is registered`);
    return m;
  }
}
