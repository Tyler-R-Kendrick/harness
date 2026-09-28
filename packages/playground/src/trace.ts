/**
 * One timeline of what the harness does, across its layers: the ACP messages between
 * the playground's client and the daemon, the commands the daemon gives its worker and
 * the events the worker sends back, every model call (through AI SDK middleware), tool
 * runs, filesystem changes and hook events.
 */
import type { LanguageModelV4Content, LanguageModelV4Middleware, LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import type { ToolSet } from "ai";
import type { AcpPort } from "@harness/platform-browser";
import { PORT_CONTROL } from "@harness/platform-browser";
import type { Worker } from "@harness/workers";

export type TraceKind = "acp" | "worker" | "model" | "tool" | "vfs" | "hook" | "host";

export interface TraceInput {
  readonly kind: TraceKind;
  readonly name: string;
  readonly detail?: unknown;
  /** `in`: towards the daemon (or the worker); `out`: from it. */
  readonly direction?: "in" | "out";
  readonly sessionId?: string;
  readonly turnId?: string;
}

export interface TraceEvent extends TraceInput {
  readonly seq: number;
  readonly at: number;
  readonly phase?: "start" | "end";
  /** For a span's end: the start's sequence number. */
  readonly spanOf?: number;
  /** For a span's end: milliseconds since its start. */
  readonly duration?: number;
}

export class Tracer {
  readonly #now: () => number;
  readonly #limit: number;
  #events: TraceEvent[] = [];
  #seq = 0;
  readonly #listeners = new Set<(event: TraceEvent) => void>();

  constructor(now: () => number, options: { readonly limit?: number } = {}) {
    this.#now = now;
    this.#limit = options.limit ?? 5_000;
  }

  record(input: TraceInput & Partial<Pick<TraceEvent, "phase" | "spanOf" | "duration">>): TraceEvent {
    const event: TraceEvent = { ...input, seq: ++this.#seq, at: this.#now() };
    this.#events.push(event);
    if (this.#events.length > this.#limit) this.#events.splice(0, this.#events.length - this.#limit);
    for (const listener of this.#listeners) listener(event);
    return event;
  }

  /** Record a start now, and its end (with the time between) when `end` is called. */
  span(input: TraceInput): { end(detail?: unknown): TraceEvent } {
    const start = this.record({ ...input, phase: "start" });
    return { end: (detail) => this.record({ ...input, detail, phase: "end", spanOf: start.seq, duration: this.#now() - start.at }) };
  }

  events(): readonly TraceEvent[] {
    return this.#events;
  }

  /** The sequence number of the newest event (0 before any). */
  get last(): number {
    return this.#seq;
  }

  subscribe(listener: (event: TraceEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /**
   * Put events from before (a reload) ahead of the ones recorded since, which are
   * renumbered after them, spans included; numbering continues from there.
   */
  restore(older: readonly TraceEvent[]): void {
    if (older.length === 0) return;
    const offset = Math.max(...older.map((e) => e.seq));
    const since = this.#events.map((e) => ({ ...e, seq: e.seq + offset, ...(e.spanOf === undefined ? {} : { spanOf: e.spanOf + offset }) }));
    this.#events = [...older, ...since].slice(-this.#limit);
    this.#seq += offset;
  }

  clear(): void {
    this.#events = [];
  }
}

const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A one-line name for a JSON-RPC message; undefined for anything else. */
export function acpSummary(message: unknown): string | undefined {
  const m = record(message);
  if (m["jsonrpc"] !== "2.0") return undefined;
  const id = m["id"] === undefined ? "" : ` #${String(m["id"])}`;
  if (typeof m["method"] === "string") {
    const params = record(m["params"]);
    const what = record(params["update"])["sessionUpdate"] ?? params["event"];
    return `${m["method"]}${id}${typeof what === "string" ? ` · ${what}` : ""}`;
  }
  if ("error" in m) return `error${id}: ${String(record(m["error"])["message"])}`;
  return `result${id}`;
}

function sessionOf(message: unknown): string | undefined {
  const s = record(record(message)["params"])["sessionId"];
  return typeof s === "string" ? s : undefined;
}

/** A client's port with every JSON-RPC message through it recorded (sent: `in` to the daemon; received: `out` of it). */
export function tracedPort(port: AcpPort, tracer: Tracer): AcpPort {
  const note = (direction: "in" | "out", message: unknown) => {
    const name = acpSummary(message);
    const sessionId = sessionOf(message);
    if (name !== undefined) tracer.record({ kind: "acp", direction, name, detail: message, ...(sessionId ? { sessionId } : {}) });
  };
  return {
    postMessage: (message) => {
      if (!(typeof message === "object" && message !== null && PORT_CONTROL in message)) note("in", message);
      port.postMessage(message);
    },
    addEventListener: (type, listener) =>
      port.addEventListener(type, (event) => {
        if (type === "message") note("out", event.data);
        listener(event);
      }),
    start: () => port.start(),
    close: () => port.close(),
  };
}

/** A worker whose commands (in) and emitted events (out) are recorded. */
export function tracedWorker(worker: Worker, tracer: Tracer): Worker {
  const turn = (sessionId: string, turnId?: string) => ({ sessionId, ...(turnId === undefined ? {} : { turnId }) });
  return {
    run: (command, emit) => {
      tracer.record({ kind: "worker", direction: "in", name: "prompt", detail: command, ...turn(command.sessionId, command.turnId) });
      return worker.run(command, (event) => {
        const name =
          event.type === "update" ? `update · ${event.update.sessionUpdate}` : event.type === "end" ? `end · ${event.stopReason}` : event.type === "permission" ? `permission · ${event.toolCall.title ?? ""}` : `behavior · ${event.change.state}`;
        tracer.record({ kind: "worker", direction: "out", name, detail: event, ...turn(event.sessionId, "turnId" in event ? event.turnId : undefined) });
        emit(event);
      });
    },
    cancel: (sessionId, turnId) => {
      tracer.record({ kind: "worker", direction: "in", name: "cancel", ...turn(sessionId, turnId) });
      worker.cancel(sessionId, turnId);
    },
    permission: (command) => {
      const outcome = command.outcome.outcome === "selected" ? command.outcome.optionId : command.outcome.outcome;
      tracer.record({ kind: "worker", direction: "in", name: `permission · ${outcome}`, detail: command, ...turn(command.sessionId, command.turnId) });
      worker.permission(command);
    },
    event: (command, emit) => {
      tracer.record({ kind: "worker", direction: "in", name: `event · ${command.name}`, detail: command, sessionId: command.sessionId });
      worker.event?.(command, emit);
    },
  };
}

function parsedInput(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

const tokens = (u: LanguageModelV4Usage | undefined) => ({ input: u?.inputTokens.total, output: u?.outputTokens.total });

function outcome(content: readonly (LanguageModelV4Content | LanguageModelV4StreamPart)[], finish: string | undefined, usage: LanguageModelV4Usage | undefined) {
  const text = content.map((c) => (c.type === "text" ? c.text : c.type === "text-delta" ? c.delta : "")).join("");
  const toolCalls = content.flatMap((c) => (c.type === "tool-call" ? [{ toolName: c.toolName, input: parsedInput(c.input) }] : []));
  return { text, toolCalls, finishReason: finish, usage: tokens(usage) };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** AI SDK middleware recording each model call as a span: the prompt in, what came back out. */
export function tracingMiddleware(tracer: Tracer): LanguageModelV4Middleware {
  const start = (name: "generate" | "stream", params: { readonly prompt: unknown; readonly tools?: readonly { readonly name: string }[] }, modelId: string) =>
    tracer.span({ kind: "model", name, detail: { model: modelId, prompt: params.prompt, tools: (params.tools ?? []).map((t) => t.name) } });
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const span = start("generate", params, model.modelId);
      try {
        const result = await doGenerate();
        span.end(outcome(result.content, result.finishReason.unified, result.usage));
        return result;
      } catch (e) {
        span.end({ error: message(e) });
        throw e;
      }
    },
    wrapStream: async ({ doStream, params, model }) => {
      const span = start("stream", params, model.modelId);
      let ended = false;
      const end = (detail: unknown) => {
        if (!ended) span.end(detail);
        ended = true;
      };
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        result = await doStream();
      } catch (e) {
        end({ error: message(e) });
        throw e;
      }
      const parts: LanguageModelV4StreamPart[] = [];
      const reader = result.stream.getReader();
      return {
        ...result,
        // Pulled part by part, so the span ends however the stream does: finished, failed or cancelled by its reader.
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async pull(controller) {
            let next: ReadableStreamReadResult<LanguageModelV4StreamPart>;
            try {
              next = await reader.read();
            } catch (e) {
              end({ error: message(e) });
              throw e;
            }
            if (next.done) {
              const error = parts.find((p) => p.type === "error");
              const finish = parts.find((p) => p.type === "finish");
              end(error ? { error: message(error.error) } : outcome(parts, finish?.finishReason.unified, finish?.usage));
              controller.close();
              return;
            }
            parts.push(next.value);
            controller.enqueue(next.value);
          },
          cancel(reason) {
            end({ cancelled: true, ...outcome(parts, undefined, undefined) });
            return reader.cancel(reason);
          },
        }),
      };
    },
  };
}

/** Tools whose runs are recorded as spans: the input going in, the output (or error) coming out. */
export function tracedTools<T extends ToolSet>(tools: T, tracer: Tracer): T {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => {
      const execute = t.execute;
      if (!execute) return [name, t];
      return [
        name,
        {
          ...t,
          execute: async (input: unknown, options: { readonly toolCallId: string }) => {
            const span = tracer.span({ kind: "tool", name, detail: { toolCallId: options.toolCallId, input } });
            try {
              const output: unknown = await (execute as (input: unknown, options: unknown) => unknown)(input, options);
              span.end({ output });
              return output;
            } catch (e) {
              span.end({ error: message(e) });
              throw e;
            }
          },
        },
      ];
    }),
  ) as T;
}

export interface HookEventView {
  readonly offset: number;
  readonly type: string;
  readonly sessionId?: string;
}

/** The hook events in a daemon snapshot at or past `from` (their offsets). */
export function hookEvents(snapshot: unknown, from: number): HookEventView[] {
  const events = record(record(snapshot)["hooks"])["events"];
  return Array.isArray(events) ? (events as HookEventView[]).filter((e) => e.offset >= from) : [];
}

/** A hook event as a trace event (with its session, when it has one). */
export function hookTrace(e: HookEventView): TraceInput {
  return { kind: "hook", name: e.type, detail: e, ...(typeof e.sessionId === "string" ? { sessionId: e.sessionId } : {}) };
}
