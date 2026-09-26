import { asSchema } from "ai";
import type { Tool } from "ai";
import { newQuickJSWASMModule } from "quickjs-emscripten";
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle, QuickJSWASMModule } from "quickjs-emscripten";
import type { CodeMode, CodeModeProgram } from "./code-mode.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
// QuickJS's own stack check must fire before the host's stack runs out: interpreter frames
// also use the host's (V8's) stack, which is about 1 MiB. 128 KiB of QuickJS stack is
// several hundred calls deep, and every overflow, JSON.parse's included, is caught.
const DEFAULT_STACK_LIMIT_BYTES = 128 * 1024;

/**
 * The code's side of the bridge. `tools` is a proxy, so `tools.<name>` is always a
 * function and an unknown name fails when called, as in AI SDK code mode. Values cross
 * as JSON text; what the body returns or throws goes back through __done and __fail.
 */
const prelude = `
const __call = globalThis.__call, __done = globalThis.__done, __fail = globalThis.__fail;
delete globalThis.__call; delete globalThis.__done; delete globalThis.__fail;
const tools = new Proxy({}, {
  get: (_, name) => typeof name !== "string" ? undefined : (input) =>
    __call(name, input === undefined ? undefined : JSON.stringify(input)).then((text) => { const r = JSON.parse(text); return "v" in r ? r.v : undefined; }),
  ownKeys: () => [],
});
const __describe = (e) => e instanceof Error
  ? { name: e.name, message: e.message }
  : { name: "Error", message: e !== null && typeof e === "object" && typeof e.message === "string" ? e.message : String(e) };
`;

class RunFailure extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/**
 * The interpreter failed below the code: the binding catches a host exception (the
 * host's own stack running out) and hands back an error that is not a QuickJS error
 * object. The module is not to be trusted after it.
 */
class HostFailure extends Error {}

const timedOut = (ms: number) => new RunFailure("CodeModeTimeoutError", `Code mode execution timed out after ${ms}ms.`);

/** The final value of a tool's output, which may stream (as AI SDK code mode takes it). */
async function output(value: unknown): Promise<unknown> {
  if (value !== null && typeof value === "object" && Symbol.asyncIterator in value) {
    let last: unknown;
    for await (const part of value as AsyncIterable<unknown>) last = part;
    return last;
  }
  return value;
}

/**
 * A code mode on QuickJS compiled to WebAssembly (`quickjs-emscripten`), for hosts
 * without Node worker threads: browsers, extensions, workers. Each run gets a runtime
 * of its own with memory and stack limits, and an interrupt handler that stops it at
 * its deadline or when aborted. The code sees only `tools` (and `input`, which the
 * workflow runner defines). If the WebAssembly module itself fails (a host stack
 * overflow), it is replaced, so the next run is unaffected.
 */
export function quickjsCodeMode(options: { readonly memoryLimitBytes?: number; readonly stackLimitBytes?: number } = {}): CodeMode {
  let module: Promise<QuickJSWASMModule> | undefined;
  const load = () => (module ??= newQuickJSWASMModule());
  return async (program) => {
    const wasm = await load();
    const broken = () => {
      // The module's own state is not to be trusted after a host-level failure.
      module = undefined;
    };
    try {
      return await run(wasm, program, options, broken);
    } catch (e) {
      if (e instanceof RunFailure) throw e;
      broken();
      if (e instanceof HostFailure || e instanceof RangeError) throw new RunFailure("RangeError", "Maximum call stack size exceeded (the host's stack ran out)");
      throw e;
    }
  };
}

async function run(wasm: QuickJSWASMModule, program: CodeModeProgram, options: { readonly memoryLimitBytes?: number; readonly stackLimitBytes?: number }, broken: () => void): Promise<unknown> {
  const { js, tools, abortSignal } = program;
  const timeoutMs = program.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const runtime = wasm.newRuntime();
  runtime.setMemoryLimit(options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(options.stackLimitBytes ?? DEFAULT_STACK_LIMIT_BYTES);
  runtime.setInterruptHandler(() => abortSignal.aborted || Date.now() > deadline);
  const vm = runtime.newContext();
  const pending = new Set<QuickJSDeferredPromise>();
  let finished = false;
  let calls = 0;

  let settle!: (outcome: { ok: true; value: unknown } | { ok: false; error: Error }) => void;
  const outcome = new Promise<{ ok: true; value: unknown } | { ok: false; error: Error }>((resolve) => (settle = resolve));
  const finish = (o: { ok: true; value: unknown } | { ok: false; error: Error }) => {
    if (finished) return;
    finished = true;
    // Code that catches its own interrupt still ends stopped: past its deadline or aborted, nothing it says counts.
    settle(abortSignal.aborted || Date.now() > deadline ? { ok: false, error: stopped() } : o);
  };
  /** Run the code's pending jobs (promise reactions) until it waits on the host again. */
  const pump = () => {
    if (finished) return;
    const jobs = runtime.executePendingJobs();
    if (jobs.error) finish({ ok: false, error: failureOf(jobs.error) });
  };
  /** What an error the interpreter hands back means; it frees the handle. */
  const failureOf = (handle: QuickJSHandle): Error => {
    const error: unknown = vm.dump(handle);
    handle.dispose();
    if (error === null || typeof error !== "object" || typeof (error as { name?: unknown }).name !== "string") return new HostFailure(String(error));
    const { name, message } = error as { name: string; message: string };
    return name === "InternalError" && message === "interrupted" ? stopped() : new RunFailure(name, message);
  };
  const stopped = () => (abortSignal.aborted ? new RunFailure("CodeModeAbortedError", "Code mode execution was aborted.") : timedOut(timeoutMs));

  const invoke = async (name: string, inputJson: string | undefined): Promise<string> => {
    if (abortSignal.aborted) throw new RunFailure("CodeModeAbortedError", "Code mode execution was aborted.");
    const hostTool: Tool | undefined = Object.hasOwn(tools, name) ? tools[name] : undefined;
    if (!hostTool) throw new RunFailure("CodeModeToolError", `Unknown tool: ${name}`);
    if (!hostTool.execute) throw new RunFailure("CodeModeToolError", `Tool "${name}" does not have execute().`);
    const input: unknown = inputJson === undefined ? undefined : JSON.parse(inputJson);
    const schema = asSchema(hostTool.inputSchema);
    const checked = schema.validate ? await schema.validate(input) : { success: true as const, value: input };
    if (!checked.success) throw new RunFailure("CodeModeToolError", `Invalid input for tool "${name}": ${checked.error.message}`);
    try {
      const value = await output(await hostTool.execute(checked.value, { toolCallId: `quickjs-${++calls}`, messages: [], abortSignal, context: undefined }));
      return JSON.stringify(value === undefined ? {} : { v: value });
    } catch {
      // As in AI SDK code mode, a tool's own error stays on the host side.
      throw new RunFailure("RunError", "Host tool failed.");
    }
  };

  const expose = (name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | undefined) => {
    const handle = vm.newFunction(name, fn);
    vm.setProp(vm.global, name, handle);
    handle.dispose();
  };
  expose("__call", (nameHandle, inputHandle) => {
    const name = vm.getString(nameHandle);
    const inputJson = inputHandle && vm.typeof(inputHandle) === "string" ? vm.getString(inputHandle) : undefined;
    const deferred = vm.newPromise();
    pending.add(deferred);
    invoke(name, inputJson).then(
      (text) => {
        if (finished) return;
        const value = vm.newString(text);
        deferred.resolve(value);
        value.dispose();
      },
      (e: unknown) => {
        if (finished) return;
        const error = vm.newError({ name: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) });
        deferred.reject(error);
        error.dispose();
      },
    ).finally(() => {
      // A run that has finished has freed its deferreds already.
      if (!pending.delete(deferred)) return;
      deferred.dispose();
      pump();
    });
    return deferred.handle;
  });
  expose("__done", (text) => {
    const json = text && vm.typeof(text) === "string" ? vm.getString(text) : undefined;
    finish({ ok: true, value: json === undefined ? undefined : JSON.parse(json) });
    return undefined;
  });
  expose("__fail", (described) => {
    const { name, message } = vm.dump(described) as { name: string; message: string };
    finish({ ok: false, error: new RunFailure(name, message) });
    return undefined;
  });

  const onAbort = () => finish({ ok: false, error: stopped() });
  abortSignal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => finish({ ok: false, error: timedOut(timeoutMs) }), Math.max(0, deadline - Date.now()));
  try {
    const started = vm.evalCode(`${prelude}\n(async () => {\n${js}\n})().then((v) => __done(JSON.stringify(v)), (e) => __fail(__describe(e)));`, "workflow.js");
    if (started.error) finish({ ok: false, error: failureOf(started.error) });
    else {
      started.value.dispose();
      pump();
    }
    const result = await outcome;
    if (!result.ok) throw result.error;
    return result.value;
  } finally {
    finished = true;
    clearTimeout(timer);
    abortSignal.removeEventListener("abort", onAbort);
    if (!dispose(vm, runtime, pending)) broken();
  }
}

/** Free what the run holds; false if QuickJS could not, which leaves its module unusable. */
function dispose(vm: QuickJSContext, runtime: { dispose(): void }, pending: Set<QuickJSDeferredPromise>): boolean {
  try {
    for (const deferred of pending) deferred.dispose();
    pending.clear();
    vm.dispose();
    runtime.dispose();
    return true;
  } catch {
    return false;
  }
}
