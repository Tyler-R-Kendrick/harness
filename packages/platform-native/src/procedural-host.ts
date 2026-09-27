import type { Daemon, HookEvent, LogEntry } from "@harness/core";
import type { DaemonRuntime } from "@harness/runtime";

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
  let reply: Reply | undefined;
  // The daemon answers these methods synchronously, through `send`, while `receive` runs.
  const connection = runtime.connect({ principal: options.plugin, kind: "plugin" }, (message) => void (reply = message as Reply));
  const call = (method: string, params: Record<string, unknown>): unknown => {
    reply = undefined;
    connection.receive({ jsonrpc: "2.0", id: (next += 1), method, params });
    const answer = reply as Reply | undefined;
    if (answer?.error) throw new Error(`${method}: ${answer.error.message}`);
    return answer?.result;
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
