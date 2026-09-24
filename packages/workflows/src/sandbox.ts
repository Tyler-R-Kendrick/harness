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
  ask: (prompt) => __effect("ask", JSON.stringify({ prompt: String(prompt) })).then(JSON.parse),
});
`;

const LIMITS = { memoryBytes: 64 * 1024 * 1024, stackBytes: 1024 * 1024 };
/** Interrupt checks allowed before a run is stopped; counted, not timed, so it is deterministic. */
export const DEFAULT_BUDGET = 5_000_000;

function describe(ctx: QuickJSContext, handle: QuickJSHandle): string {
  const e = ctx.dump(handle) as { name?: unknown; message?: unknown } | undefined;
  return e && typeof e === "object" && "message" in e ? `${String(e.name ?? "Error")}: ${String(e.message)}` : String(e);
}

function fresh(qjs: QuickJSWASMModule, budget: number): QuickJSContext {
  const runtime = qjs.newRuntime();
  runtime.setMemoryLimit(LIMITS.memoryBytes);
  runtime.setMaxStackSize(LIMITS.stackBytes);
  let ticks = 0;
  runtime.setInterruptHandler(() => ++ticks > budget);
  return runtime.newContext();
}

function dispose(ctx: QuickJSContext): void {
  const runtime = ctx.runtime;
  ctx.dispose();
  runtime.dispose();
}

/** Compile workflow code and confirm it defines `workflow(input, ctx)`, without running it. */
export async function checkWorkflow(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = fresh(await quickjs(), DEFAULT_BUDGET);
  try {
    const result = ctx.evalCode(`${PRELUDE}\n${code}\n;typeof workflow === "function"`, "workflow.js");
    if (result.error) {
      const error = describe(ctx, result.error);
      result.error.dispose();
      return { ok: false, error };
    }
    const defined = ctx.dump(result.value) === true;
    result.value.dispose();
    return defined ? { ok: true } : { ok: false, error: "the code does not define function workflow(input, ctx)" };
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
      queue.push({ deferred, settle: async () => {
        try {
          if (aborted) throw aborted.error;
          const value = ctx.newString(JSON.stringify((await effect(op, request)) ?? null));
          deferred.resolve(value);
          value.dispose();
        } catch (error) {
          aborted ??= { error };
          const e = ctx.newError("the effect failed; the run stops here and can be resumed");
          deferred.reject(e);
          e.dispose();
        } finally {
          deferred.dispose();
        }
      } });
      return deferred.handle;
    });
    ctx.setProp(ctx.global, "__effect", bridge);
    bridge.dispose();
    const inputJson = ctx.newString(JSON.stringify(input ?? null));
    ctx.setProp(ctx.global, "__input", inputJson);
    inputJson.dispose();

    const started = ctx.evalCode(`${PRELUDE}\n${code}\n;globalThis.__run = Promise.resolve().then(() => workflow(JSON.parse(__input), __ctx));`, "workflow.js");
    if (started.error) {
      const error = describe(ctx, started.error);
      started.error.dispose();
      return { ok: false, error };
    }
    started.value.dispose();
    const run = ctx.getProp(ctx.global, "__run");
    try {
      for (;;) {
        const jobs = ctx.runtime.executePendingJobs();
        if (jobs.error) {
          const error = describe(ctx, jobs.error);
          jobs.error.dispose();
          return { ok: false, error };
        }
        if (aborted) throw aborted.error;
        const state = ctx.getPromiseState(run);
        if (state.type === "fulfilled") {
          const value = ctx.dump(state.value) as unknown;
          state.value.dispose();
          return { ok: true, value: value === undefined ? null : value };
        }
        if (state.type === "rejected") {
          const error = describe(ctx, state.error);
          state.error.dispose();
          return { ok: false, error };
        }
        const next = queue.shift();
        if (!next) return { ok: false, error: "the workflow is waiting on nothing: it can never finish" };
        await next.settle();
      }
    } finally {
      run.dispose();
    }
  } finally {
    // Calls the run never reached still hold promise handles; release them before the context goes.
    for (const { deferred } of queue.splice(0)) deferred.dispose();
    dispose(ctx);
  }
}
