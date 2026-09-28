import { getRandomValues } from "node:crypto";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Daemon, DaemonSnapshot, HookEvent, LogEntry } from "@harness/core";
import { authorize, composition, LiveLearner, logTrajectories, modelRefiner, presetOf, proceduralStep, runDream, SnapshotProceduralStore, staging } from "@harness/procedural";
import type {
  AccessPolicy,
  Action,
  ApprovalInbox,
  ApprovalNotice,
  Approver,
  Composer,
  CompositionSettings,
  DreamPorts,
  DreamResult,
  Evaluator,
  GraphId,
  HostComposition,
  ProceduralStepHook,
  ProceduralStore,
  Reflector,
  Resolver,
  SessionLog,
  Settings,
} from "@harness/procedural";
import type { DaemonRuntime } from "@harness/runtime";
import type { Effects } from "@harness/workflows";
import { aiCodeMode } from "@harness/workflows/node";
import type { LanguageModel, ToolSet } from "ai";
import { FileStorage } from "./file-storage.ts";
import { WorkflowFiles } from "./workflow-files.ts";

/** This host's clock and entropy, for pinning and the step hook. */
export const hostPorts = {
  clock: { now: (): number => Date.now() },
  entropy: { bytes: (length: number): Uint8Array => getRandomValues(new Uint8Array(length)) },
};

/**
 * The procedural step hook for this host's sessions (plan §5): each session resolves to a
 * graph through the resolver (the host's principal as the owner) and is pinned by P9's
 * `pinSession`. It goes to `sessionAgent({ step })` and, with a guidance model,
 * `harnessSessions({ step })`.
 */
export function nativeProceduralStep(options: {
  readonly store: ProceduralStore;
  readonly settings: Settings;
  readonly resolver: Resolver;
  readonly principal?: string;
  readonly preset?: string;
  /** The guidance model; a step's own model when not given. Turn-level guidance (harness workers) needs one. */
  readonly model?: LanguageModel;
}): ProceduralStepHook {
  const { store, settings, resolver, principal, preset, model } = options;
  return proceduralStep({
    store,
    settings,
    resolver,
    ...(principal === undefined ? {} : { principal }),
    ...hostPorts,
    ...(preset === undefined ? {} : { preset }),
    ...(model === undefined ? {} : { model }),
  });
}

/** The access policy bound to the host's principal, as the extension's `authorize`. With no policy, everything is allowed. */
export const hostAuthorizer =
  (policy: AccessPolicy | undefined, principal: string) =>
  (action: Action, graph: GraphId): boolean =>
    authorize(policy, action, graph, { principal });

/** The procedural store kept in `dir`: one file, saved atomically after every change. One process owns it. */
export function proceduralStore(dir: string): ProceduralStore {
  return new SnapshotProceduralStore(new FileStorage(join(dir, "procedural.json")));
}

/**
 * Host plumbing for procedural graphs on the native host (plan §6.1, P12): the live
 * learner reacts to the daemon's hook events and reads the session log. It runs in this
 * process, so it is a plugin connection of the daemon runtime's own, with a durable
 * cursor on the hook bus (the bus's subscription and cursor are in the daemon snapshot).
 */

export interface HookPump {
  /** Deliver every event past the cursor, in order, acknowledging each once it is handled. */
  drain(): Promise<void>;
  close(): void;
}

interface Reply {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message: string };
}

/**
 * Subscribe `plugin` to hook events of `types` and hand each to `onEvent`, in order, every
 * `intervalMs` (and on `drain()`). An event is acknowledged after `onEvent` resolves, so a
 * failure (reported to `log`) leaves it and those after it for the next drain: delivery is
 * at least once, as the bus promises, and handlers are idempotent.
 */
export function pumpHookEvents(
  runtime: Pick<DaemonRuntime, "connect">,
  options: { readonly plugin: string; readonly types: readonly string[]; readonly onEvent: (event: HookEvent) => Promise<void>; readonly intervalMs?: number; readonly log?: (message: string) => void },
): HookPump {
  let next = 0;
  const replies = new Map<unknown, Reply>();
  // The daemon answers these methods synchronously, through `send`, while `receive` runs.
  const connection = runtime.connect({ principal: options.plugin, kind: "plugin" }, (message) => void replies.set((message as Reply).id, message as Reply));
  const call = (method: string, params: Record<string, unknown>): unknown => {
    const id = (next += 1);
    connection.receive({ jsonrpc: "2.0", id, method, params });
    const answer = replies.get(id)!;
    replies.delete(id);
    if (answer.error) throw new Error(`${method}: ${answer.error.message}`);
    return answer.result;
  };
  call("initialize", { protocolVersion: 1 });
  call("_harness/hooks/subscribe", { types: [...options.types] });
  let running: Promise<void> = Promise.resolve();
  const drainOnce = async () => {
    const { events } = call("_harness/hooks/poll", {}) as { events: HookEvent[] };
    for (const event of events) {
      await options.onEvent(event);
      call("_harness/hooks/ack", { offset: event.offset });
    }
  };
  const drain = () =>
    (running = running.then(drainOnce).catch((e: unknown) => {
      (options.log ?? (() => {}))(`${options.plugin}: ${e instanceof Error ? e.message : String(e)}`);
    }));
  const timer = setInterval(() => void drain(), options.intervalMs ?? 1_000);
  timer.unref();
  return {
    drain,
    close: () => {
      clearInterval(timer);
      connection.disconnect();
    },
  };
}

/**
 * The live learner (P11) on this host: subscribed in process to the daemon's `turn.ended`
 * events (plugin `procedural-learner`, with its durable cursor), reading each session's log
 * from the daemon. A failure is logged and the event redelivered on the next drain.
 */
export function nativeLiveLearner(options: {
  readonly runtime: Pick<DaemonRuntime, "connect" | "daemon">;
  readonly store: ProceduralStore;
  readonly settings: Settings;
  readonly preset?: string;
  readonly intervalMs?: number;
  /** Live reflection (`modelReflector`), used when the preset turns reflection on. */
  readonly reflect?: Reflector;
  readonly log?: (message: string) => void;
}): { learner: LiveLearner; drain(): Promise<void>; close(): void } {
  const { runtime, store, settings, log } = options;
  const learner = new LiveLearner({ store, settings: presetOf(settings, options.preset ?? "harness"), readLog: sessionLogReader(runtime.daemon), clock: hostPorts.clock, ...(options.reflect === undefined ? {} : { reflect: options.reflect }) });
  const pump = pumpHookEvents(runtime, {
    plugin: "procedural-learner",
    types: ["turn.ended"],
    onEvent: async (event) => void (await learner.onHookEvent(event)),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    ...(log === undefined ? {} : { log }),
  });
  return { learner, drain: pump.drain, close: pump.close };
}

/**
 * A session's log entries in `[from, to)`, read from the daemon's snapshot: the daemon has
 * no host-side log read yet, so this copies every session's log (plan §6.5). Entries
 * compacted into the log's snapshot are gone; an unknown session has none.
 */
export function sessionLogReader(daemon: Pick<Daemon, "snapshot">): (sessionId: string, from: number, to?: number) => Promise<LogEntry<unknown>[]> {
  return async (sessionId, from, to = Number.POSITIVE_INFINITY) => {
    const session = snapshotSessions(daemon.snapshot()).find((s) => s.id === sessionId);
    return (session?.entries ?? []).filter((e) => e.offset >= from && e.offset < to);
  };
}

/** Every session's log in a daemon snapshot (the daemon's, or the one saved in its state file); a snapshot of another shape has none. */
export function snapshotSessions(snapshot: unknown): { id: string; entries: LogEntry<unknown>[] }[] {
  const sessions = (snapshot as Partial<DaemonSnapshot> | undefined)?.sessions;
  if (!Array.isArray(sessions)) return [];
  return sessions.map((s: DaemonSnapshot["sessions"][number]) => ({ id: s.id, entries: (s.log as { entries?: LogEntry<unknown>[] } | undefined)?.entries ?? [] }));
}

/**
 * Dream on this host (plan §7.1, P6): `runDream` over the store with real ports. The
 * refiner is `modelRefiner` on the given generator, trajectories are the turns of the
 * session logs `sessions` returns (`logTrajectories`), and time and ids come from this
 * host. An evaluator, an approver, an approvals inbox and a composer are optional: a
 * candidate that needs approval is asked about when there is an approver, waits in the
 * inbox when there is an inbox (the daemon's: no one can be asked outside a session's
 * turn), and is rejected otherwise; without a composer there is no composition round. The run holds the graph's lease as `holder` (default `native-host`),
 * so a dream another process holds is `busy`.
 */
export function nativeDream(options: {
  readonly store: ProceduralStore;
  readonly settings: Settings;
  readonly preset?: string;
  readonly model: LanguageModel;
  readonly sessions: () => Promise<readonly SessionLog[]>;
  readonly evaluator?: Evaluator;
  readonly approver?: Approver;
  readonly inbox?: ApprovalInbox;
  /** A composer, or how to make one for each dream (`nativeComposition`'s, over the session tools as they are then). */
  readonly composer?: Composer | (() => Promise<Composer>);
  readonly task?: string;
  /** The session tool catalog, or how to list it for each dream (`nativeComposition`'s `catalog`). */
  readonly tools?: readonly string[] | (() => Promise<readonly string[]>);
  readonly sideEffectFree?: readonly string[];
  readonly holder?: string;
}): (graph: GraphId) => Promise<DreamResult> {
  const { store, settings, model, sessions, evaluator, approver, inbox, composer, task, tools, sideEffectFree, holder = "native-host" } = options;
  const preset = presetOf(settings, options.preset ?? "harness");
  const ports: DreamPorts = {
    refiner: modelRefiner({ model, settings }),
    trajectories: logTrajectories({ store, sessions }),
    ...hostPorts,
    ...(evaluator === undefined ? {} : { evaluator }),
    ...(approver === undefined ? {} : { approver }),
    ...(inbox === undefined ? {} : { inbox }),
  };
  return async (graph) =>
    runDream({
      store,
      graph,
      settings: preset,
      ports: composer === undefined ? ports : { ...ports, composer: typeof composer === "function" ? await composer() : composer },
      holder,
      ...(task === undefined ? {} : { task }),
      ...(tools === undefined ? {} : { tools: typeof tools === "function" ? await tools() : tools }),
      ...(sideEffectFree === undefined ? {} : { sideEffectFree }),
    });
}

/**
 * Composition on this host (plan §7.6). Dream stages the workflows it compiles in
 * `<dir>/staging` (the `--procedural` directory's: one file per workflow, run journals
 * under `.runs/`), a library of its own: the shared workflow library (`shared`, the
 * `--workflows` directory) is never written, and may not be the same directory. Staged
 * workflows run in AI SDK code mode, `ask` answering their questions.
 *
 * - `tools` is a session worker's per-turn tools (`sessionAgent({ tools })`): the host's
 *   `base` tools plus exactly the workflows the core the session reads this turn binds
 *   (`step.core`), each only while its staged code hashes to the binding.
 * - `composer` makes dream's composer (`nativeDream({ composer })`) over the specs of the
 *   base tools as they are when a dream starts, and `catalog` lists them as dream's tool
 *   catalog (`nativeDream({ tools })`), which the harness preset enforces.
 */
export function nativeComposition(options: {
  readonly dir: string;
  readonly settings: CompositionSettings;
  readonly step: Pick<ProceduralStepHook, "core">;
  readonly ask: Effects["ask"];
  /** The session tools a compiled path calls: the same for every session of this host. */
  readonly base?: () => ToolSet | Promise<ToolSet>;
  /** The shared workflow library's directory, if the host has one. */
  readonly shared?: string;
}): HostComposition {
  const { settings, step, ask, base } = options;
  const dir = join(options.dir, "staging");
  if (options.shared !== undefined && resolve(options.shared) === resolve(dir)) throw new Error(`the shared workflow library (${options.shared}) cannot be procedural's staging library`);
  return composition({ staging: staging({ files: new WorkflowFiles(dir), codeMode: aiCodeMode, ask }), settings, step, ...(base === undefined ? {} : { base }) });
}

/**
 * The approvals inbox's notices on the daemon's hook bus, published by this host under
 * source `procedural` (a peer can never pick it), and saved with the daemon's snapshot.
 * Plugins subscribe to `procedural.approval.*`.
 */
export const hookNotifier =
  (runtime: Pick<DaemonRuntime, "publish">) =>
  (notice: ApprovalNotice): void =>
    void runtime.publish({ source: "procedural", type: notice.type, payload: notice.payload });

/**
 * An approver that asks on a terminal (the CLI's permission flow): it names the graph,
 * the candidate and the tools its new edges route into, and approves only on `y` or `yes`.
 */
export function terminalApprover(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Approver {
  return {
    approve: async ({ graph, candidate, tools }) => {
      const lines = createInterface({ input, output, terminal: false });
      const routes = tools.length === 0 ? "no tools" : `tools ${tools.join(", ")}`;
      try {
        const answer = await lines.question(`Approve dream candidate ${candidate.id.slice(0, 12)} of graph ${graph}, routing into ${routes}? [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        lines.close();
      }
    },
  };
}
