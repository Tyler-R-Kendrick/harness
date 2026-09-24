import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule } from "quickjs-emscripten-core";

/**
 * Workflow code runs in QuickJS compiled to WebAssembly: isolated from the host (no
 * file system, network, process or timers), the same on every platform, and made
 * deterministic here (no clock, no randomness). Its only way out is `ctx`, whose calls
 * the host turns into effects.
 */

export type EffectOp = "tool" | "ask";

let module: Promise<QuickJSWASMModule> | undefined;
const quickjs = () => (module ??= newQuickJSWASMModuleFromVariant(import("@jitl/quickjs-wasmfile-release-sync") as Parameters<typeof newQuickJSWASMModuleFromVariant>[0]));

const PRELUDE = `"use strict";
Math.random = function () { throw new Error("Math.random is not available in a workflow: randomness must come from an effect"); };
globalThis.Date = new Proxy(function Date() {}, {
  get() { throw new Error("Date is not available in a workflow: time must come from an effect"); },
  apply() { throw new Error("Date is not available in a workflow: time must come from an effect"); },
  construct() { throw new Error("Date is not available in a workflow: time must come from an effect"); },
});
const __ctx = Object.freeze({
  tool: (name, args) => __effect("tool", JSON.stringify({ name: String(name), args: args === undefined ? {} : args })).then(JSON.parse),
  ask: (prompt, constraint) => __effect("ask", JSON.stringify(constraint === undefined ? { prompt: String(prompt) } : { prompt: String(prompt), constraint })).then(JSON.parse),
});
`;

const LIMITS = { memoryBytes: 64 * 1024 * 1024, stackBytes: 256 * 1024 };
/** Interrupt checks allowed before a run is stopped; counted, not timed, so it is deterministic. */
export const DEFAULT_BUDGET = 5_000_000;

/** Read a handle and release it. (Releasing frees WASM memory; nothing in a run can observe it.) */
function take<T>(handle: QuickJSHandle, read: (handle: QuickJSHandle) => T): T {
  try {
    return read(handle);
  } finally {
    // Stryker disable next-line all: frees WASM memory, not observable
    handle.dispose();
  }
}

/** A thrown value as text: "Name: message" for errors, the value itself otherwise. */
function describe(ctx: QuickJSContext, handle: QuickJSHandle): string {
  const e = ctx.dump(handle) as unknown;
  if (typeof e !== "object" || e === null || !("message" in e)) return String(e);
  const { name, message } = e as { name?: unknown; message: unknown };
  return `${String(name ?? "Error")}: ${String(message)}`;
}

function fresh(qjs: QuickJSWASMModule, budget: number): QuickJSContext {
  const runtime = qjs.newRuntime();
  runtime.setMemoryLimit(LIMITS.memoryBytes);
  runtime.setMaxStackSize(LIMITS.stackBytes);
  let ticks = 0;
  // Stryker disable next-line EqualityOperator: one interrupt check more or less is the same budget
  runtime.setInterruptHandler(() => ++ticks > budget);
  return runtime.newContext();
}

/**
 * Release a run's context and runtime. A run that ended badly (out of memory, say) can
 * leave the WebAssembly instance unable to free it; that instance is then dropped, so
 * the next run starts on a fresh one and no workflow can break the ones after it.
 */
function dispose(ctx: QuickJSContext): void {
  const runtime = ctx.runtime;
  try {
    // Stryker disable next-line all: frees WASM memory, not observable
    ctx.dispose();
    runtime.dispose();
  } catch {
    module = undefined;
  }
}

/** Compile workflow code and confirm it defines `workflow(input, ctx)`, without running it. */
export async function checkWorkflow(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = fresh(await quickjs(), DEFAULT_BUDGET);
  try {
    const result = ctx.evalCode(`${PRELUDE}\n${code}\n;typeof workflow === "function"`, "workflow.js");
    if (result.error) return { ok: false, error: take(result.error, (h) => describe(ctx, h)) };
    return take(result.value, (h) => ctx.dump(h) === true) ? { ok: true } : { ok: false, error: "the code does not define function workflow(input, ctx)" };
  } finally {
    dispose(ctx);
  }
}

/**
 * Run `workflow(input, ctx)` to completion. Each `ctx.tool` / `ctx.ask` call becomes a
 * call to `effect`, one at a time in the order the code made them (so parallel calls are
 * still deterministic). If `effect` fails, the run stops with that error, which the code
 * cannot catch: the run is left to be resumed.
 */
export async function evaluate(
  code: string,
  input: unknown,
  effect: (op: EffectOp, request: unknown) => Promise<unknown>,
  budget: number = DEFAULT_BUDGET,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const ctx = fresh(await quickjs(), budget);
  const queue: { readonly settle: () => Promise<void>; readonly deferred: { dispose(): void } }[] = [];
  let aborted: { error: unknown } | undefined;
  try {
    const bridge = ctx.newFunction("__effect", (opHandle, requestHandle) => {
      const op = ctx.getString(opHandle) as EffectOp;
      const request = JSON.parse(ctx.getString(requestHandle)) as unknown;
      const deferred = ctx.newPromise();
      queue.push({
        deferred,
        settle: async () => {
          try {
            take(ctx.newString(JSON.stringify((await effect(op, request)) ?? null)), (value) => deferred.resolve(value));
          } catch (error) {
            // The loop below stops the run before anything else settles.
            aborted = { error };
          }
        },
      });
      return deferred.handle;
    });
    take(bridge, (h) => ctx.setProp(ctx.global, "__effect", h));
    take(ctx.newString(JSON.stringify(input ?? null)), (h) => ctx.setProp(ctx.global, "__input", h));

    const started = ctx.evalCode(`${PRELUDE}\n${code}\n;globalThis.__run = Promise.resolve().then(() => workflow(JSON.parse(__input), __ctx));`, "workflow.js");
    if (started.error) return { ok: false, error: take(started.error, (h) => describe(ctx, h)) };
    take(started.value, () => undefined);
    const run = ctx.getProp(ctx.global, "__run");
    try {
      for (;;) {
        const jobs = ctx.runtime.executePendingJobs();
        // Stryker disable next-line all: workflow code runs inside the run's promise chain, so no job can fail outside it
        if (jobs.error) return { ok: false, error: take(jobs.error, (h) => describe(ctx, h)) };
        if (aborted) throw aborted.error;
        const state = ctx.getPromiseState(run);
        if (state.type === "fulfilled") return { ok: true, value: take(state.value, (h) => ctx.dump(h) as unknown) ?? null };
        if (state.type === "rejected") return { ok: false, error: take(state.error, (h) => describe(ctx, h)) };
        const next = queue.shift();
        if (!next) return { ok: false, error: "the workflow is waiting on nothing: it can never finish" };
        try {
          await next.settle();
        } finally {
          // Stryker disable next-line all: frees WASM memory, not observable
          next.deferred.dispose();
        }
      }
    } finally {
      take(run, () => undefined);
    }
  } finally {
    // Stryker disable next-line all: frees the promise handles of calls the run never reached, not observable
    for (const { deferred } of queue) deferred.dispose();
    dispose(ctx);
  }
}
