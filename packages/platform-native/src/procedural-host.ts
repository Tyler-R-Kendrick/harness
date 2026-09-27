import { getRandomValues } from "node:crypto";
import { join } from "node:path";
import type { Daemon, HookEvent, LogEntry } from "@harness/core";
import { authorize, proceduralStep, SnapshotProceduralStore } from "@harness/procedural";
import type { AccessPolicy, Action, GraphId, ProceduralStepHook, ProceduralStore, Resolver, Settings } from "@harness/procedural";
import type { DaemonRuntime } from "@harness/runtime";
import type { LanguageModel } from "ai";
import { FileStorage } from "./file-storage.ts";

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
 * A session's log entries in `[from, to)`, read from the daemon's snapshot: the daemon has
 * no host-side log read yet, so this copies every session's log (plan §6.5). Entries
 * compacted into the log's snapshot are gone; an unknown session has none.
 */
export function sessionLogReader(daemon: Pick<Daemon, "snapshot">): (sessionId: string, from: number, to: number) => Promise<LogEntry<unknown>[]> {
  return async (sessionId, from, to) => {
    const session = daemon.snapshot().sessions.find((s) => s.id === sessionId);
    const entries = (session?.log as { entries?: LogEntry<unknown>[] } | undefined)?.entries ?? [];
    return entries.filter((e) => e.offset >= from && e.offset < to);
  };
}
