import { asSchema } from "ai";
import type { Tool } from "ai";
import { QuickJSWASMModule } from "quickjs-emscripten-core";
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle } from "quickjs-emscripten-core";
import { QuickJSFFI } from "@jitl/quickjs-wasmfile-release-sync/ffi";
import emscriptenModule from "@jitl/quickjs-wasmfile-release-sync/emscripten-module";
import type { EmscriptenModuleLoader, QuickJSEmscriptenModule } from "@jitl/quickjs-ffi-types";
import type { CodeMode, CodeModeProgram } from "./code-mode.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
// QuickJS's own stack check must fire before the host's stack runs out: interpreter frames
// also use the host's (V8's) stack, which is about 1 MiB. 128 KiB of QuickJS stack is
// several hundred calls deep, and every overflow, JSON.parse's included, is caught.
const DEFAULT_STACK_LIMIT_BYTES = 128 * 1024;

/**
 * quickjs-emscripten's release build, put together from parts imported statically, as
 * its own loader does: that loader import()s them (and a module of its own), which a
 * service worker (an extension's background) forbids.
 */
async function releaseModule(): Promise<QuickJSWASMModule> {
  // Its types describe a CommonJS module (whose default is the exports object); imported as ESM, the default is the loader.
  const wasm = await (emscriptenModule as unknown as EmscriptenModuleLoader<QuickJSEmscriptenModule>)();
  // Stryker disable next-line StringLiteral: equivalent; the sync module reads no type, which is set as the library's own loader sets it
  wasm.type = "sync";
  return new QuickJSWASMModule(wasm, new QuickJSFFI(wasm));
}

/**
 * The code's side of the bridge, evaluated before the code: it takes the host's
 * functions off the global object and returns a function that runs the code's body
 * (compiled on its own, so the bridge is out of its reach) with `tools`. `tools` is a
 * proxy, so `tools.<name>` is always a function and an unknown name fails when called,
 * as in AI SDK code mode; it is not a thenable. Values cross as JSON text; what the body
 * returns (or a TypeError, if that is not JSON) or throws goes back through done and fail.
 */
const prelude = `(() => {
  const call = globalThis.__call, done = globalThis.__done, fail = globalThis.__fail;
  delete globalThis.__call; delete globalThis.__done; delete globalThis.__fail;
  const tools = new Proxy({}, {
    get: (_, name) => typeof name !== "string" || name === "then" ? undefined : (input) =>
      call(name, input === undefined ? undefined : JSON.stringify(input)).then((text) => { const r = JSON.parse(text); return "v" in r ? r.v : undefined; }),
    ownKeys: () => [],
  });
  const describe = (e) => e instanceof Error
    ? { name: e.name, message: e.message }
    : { name: "Error", message: e !== null && typeof e === "object" && typeof e.message === "string" ? e.message : String(e) };
  const result = (v) => {
    if (v === tools) throw new TypeError("tools is not a result");
    return JSON.stringify(v);
  };
  return (body) => body(tools).then(result).then(done, (e) => fail(describe(e)));
})()`;

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
export function quickjsCodeMode(
  options: {
    readonly memoryLimitBytes?: number;
    readonly stackLimitBytes?: number;
    /** Loads the WebAssembly module (default: quickjs-emscripten's release build). */
    readonly module?: () => Promise<QuickJSWASMModule>;
  } = {},
): CodeMode {
  let module: Promise<QuickJSWASMModule> | undefined;
  const load = () =>
    (module ??= (options.module ?? releaseModule)().catch((e: unknown) => {
      // A module that failed to load (a failed fetch) is loaded again by the next run.
      module = undefined;
      throw e;
    }));
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

type Outcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: Error };

async function run(wasm: QuickJSWASMModule, program: CodeModeProgram, options: { readonly memoryLimitBytes?: number; readonly stackLimitBytes?: number }, broken: () => void): Promise<unknown> {
  const { js, tools, abortSignal } = program;
  const timeoutMs = program.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const runtime = wasm.newRuntime();
  runtime.setMemoryLimit(options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(options.stackLimitBytes ?? DEFAULT_STACK_LIMIT_BYTES);
  runtime.setInterruptHandler(() => abortSignal.aborted || Date.now() > deadline);
  const vm = runtime.newContext();
  // Tool calls in flight: the run holds their promises until they settle or it ends.
  const pending = new Set<QuickJSDeferredPromise>();
  let calls = 0;

  const stopped = () => (abortSignal.aborted ? new RunFailure("CodeModeAbortedError", "Code mode execution was aborted.") : timedOut(timeoutMs));
  let outcome: Outcome | undefined;
  let wake!: () => void;
  const ended = new Promise<void>((resolve) => (wake = resolve));
  const finish = (o: Outcome) => {
    // Stryker disable next-line ConditionalExpression: equivalent; a later outcome never reaches the awaiting run, which reads the first
    if (outcome) return;
    // Code that catches its own interrupt still ends stopped: past its deadline or aborted, nothing it says counts.
    // Stryker disable next-line EqualityOperator: equivalent at the clock's millisecond resolution
    outcome = abortSignal.aborted || Date.now() > deadline ? { ok: false, error: stopped() } : o;
    wake();
  };
  /** What an error the interpreter hands back means; it frees the handle. (An interrupt ends the run stopped: see finish.) */
  const failureOf = (handle: QuickJSHandle): Error => {
    const error: unknown = handle.consume((h) => vm.dump(h));
    // Stryker disable next-line ConditionalExpression: equivalent; a primitive has no string name either, which the last check catches
    if (error === null || typeof error !== "object" || typeof (error as { name?: unknown }).name !== "string") return new HostFailure(String(error));
    const { name, message } = error as { name: string; message: string };
    return new RunFailure(name, message);
  };
  /** Run the code's pending jobs (promise reactions) until it waits on the host again. */
  const pump = () => {
    const jobs = runtime.executePendingJobs();
    if (jobs.error) finish({ ok: false, error: failureOf(jobs.error) });
  };

  const invoke = async (name: string, inputJson: string | undefined): Promise<string> => {
    if (abortSignal.aborted) throw stopped();
    const hostTool: Tool | undefined = Object.hasOwn(tools, name) ? tools[name] : undefined;
    if (!hostTool) throw new RunFailure("CodeModeToolError", `Unknown tool: ${name}`);
    if (!hostTool.execute) throw new RunFailure("CodeModeToolError", `Tool "${name}" does not have execute().`);
    const input: unknown = inputJson === undefined ? undefined : JSON.parse(inputJson);
    const schema = asSchema(hostTool.inputSchema);
    const checked = schema.validate ? await schema.validate(input) : { success: true as const, value: input };
    if (!checked.success) throw new RunFailure("CodeModeToolError", `Invalid input for tool "${name}": ${checked.error.message}`);
    try {
      const value = await output(await hostTool.execute(checked.value, { toolCallId: `quickjs-${++calls}`, messages: [], abortSignal, context: undefined }));
      // JSON leaves out an undefined value: the code reads { } as undefined.
      return JSON.stringify({ v: value });
    } catch {
      // As in AI SDK code mode, a tool's own error stays on the host side.
      throw new RunFailure("RunError", "Host tool failed.");
    }
  };

  const expose = (name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | undefined) => vm.newFunction(name, fn).consume((f) => vm.setProp(vm.global, name, f));
  expose("__call", (nameHandle, inputHandle) => {
    const name = vm.getString(nameHandle);
    const inputJson = vm.typeof(inputHandle!) === "string" ? vm.getString(inputHandle!) : undefined;
    const deferred = vm.newPromise();
    pending.add(deferred);
    /** Hand the call's result to the code, if the run still holds the call (one that has ended has freed it). */
    // (Settling frees the deferred's resolvers; its promise went to the code, which owns it.)
    const settle = (fill: () => void) => {
      if (!pending.delete(deferred)) return;
      fill();
      pump();
    };
    invoke(name, inputJson).then(
      (text) => settle(() => vm.newString(text).consume((v) => deferred.resolve(v))),
      (e: Error) => settle(() => vm.newError({ name: e.name, message: e.message }).consume((error) => deferred.reject(error))),
    );
    return deferred.handle;
  });
  expose("__done", (text) => {
    // As in AI SDK code mode, code may not end while a tool call it made is still open.
    if (pending.size > 0) finish({ ok: false, error: new RunFailure("CodeModeDetachedBridgeRequestError", "The code ended with a tool call it did not wait for.") });
    else finish({ ok: true, value: vm.typeof(text!) === "string" ? JSON.parse(vm.getString(text!)) : undefined });
    return undefined;
  });
  expose("__fail", (described) => {
    const { name, message } = vm.dump(described!) as { name: string; message: string };
    finish({ ok: false, error: new RunFailure(name, message) });
    return undefined;
  });

  // An abort, or the deadline passing while the code waits on a tool, ends the run stopped.
  abortSignal.addEventListener("abort", wake);
  const timer = setTimeout(wake, deadline - Date.now());
  try {
    const start = vm.evalCode(prelude);
    const body = vm.evalCode(`(async (tools) => {\n${js}\n})`);
    // The first step that failed (an interrupt, code that does not compile) fails the run.
    const started = start.error ? start : body.error ? body : vm.callFunction(start.value, vm.undefined, body.value);
    if (started.error) finish({ ok: false, error: failureOf(started.error) });
    else {
      started.value.dispose();
      pump();
    }
    for (const r of [start, body]) if (r !== started) (r.error ?? r.value).dispose();
    await ended;
    const result = outcome ?? { ok: false, error: stopped() };
    if (!result.ok) throw result.error;
    return result.value;
  } finally {
    // Stryker disable next-line all: equivalent; a timer or listener left behind only wakes a run that has ended
    clearTimeout(timer);
    // Stryker disable next-line all: equivalent, as above
    abortSignal.removeEventListener("abort", wake);
    try {
      dispose(vm, runtime, pending);
    } catch {
      // QuickJS could not free the run, which leaves its module unusable.
      broken();
    }
  }
}

/** Free what the run holds: calls still in flight, the context, the runtime. */
function dispose(vm: QuickJSContext, runtime: { dispose(): void }, pending: Set<QuickJSDeferredPromise>): void {
  for (const deferred of pending) deferred.dispose();
  pending.clear();
  vm.dispose();
  runtime.dispose();
}
