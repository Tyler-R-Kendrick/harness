import { describe, expect, it, vi } from "vitest";
import { jsonSchema, tool } from "ai";
import type { Tool } from "ai";
import { newQuickJSWASMModule } from "quickjs-emscripten";
import type { QuickJSWASMModule } from "quickjs-emscripten";
import { z } from "zod";
import { checkWorkflow, quickjsCodeMode, runWorkflow } from "@harness/workflows";
import { MemoryStorage } from "@harness/testkit";

const signal = () => new AbortController().signal;
const failure = (p: Promise<unknown>) => p.then((v) => `resolved ${JSON.stringify(v)}`, (e: unknown) => String(e));

describe("QuickJS code mode", () => {
  it("QJ1.1 a tool whose output streams gives the code its last part; a tool with nothing to execute is refused", async () => {
    const run = quickjsCodeMode();
    const tools = {
      stream: tool({ inputSchema: jsonSchema({}), execute: async function* () {
        yield "partial";
        yield "final";
      } }),
      inert: { inputSchema: jsonSchema({}) } satisfies Tool,
    };
    expect(await run({ js: "return tools.stream({});", tools, abortSignal: signal() })).toBe("final");
    expect(await failure(run({ js: "return tools.inert({});", tools, abortSignal: signal() }))).toBe('CodeModeToolError: Tool "inert" does not have execute().');
  });

  it("QJ1.2 limits are options: less memory than the default fails what the default allows", async () => {
    const js = "return new Array(1e6).fill(0).length;";
    expect(await quickjsCodeMode()({ js, tools: {}, abortSignal: signal() })).toBe(1e6);
    expect(await failure(quickjsCodeMode({ memoryLimitBytes: 1024 * 1024 })({ js, tools: {}, abortSignal: signal() }))).toMatch(/out of memory/);
  });

  it.each(["''", "null", "5", "({ message: 'no name' })"])("QJ1.3 when the WebAssembly module itself fails (an error that is not an Error object: %s), the run says so and the next run gets a fresh module", async (thrown) => {
    // The binding hands back a host exception (the host's stack running out) as an error
    // that is not a QuickJS error object; the first module loaded here does so on its first run.
    let loads = 0;
    const run = quickjsCodeMode({
      module: async () => {
        const wasm = await newQuickJSWASMModule();
        if (++loads === 1) {
          const newRuntime = wasm.newRuntime.bind(wasm);
          wasm.newRuntime = (...args) => {
            const runtime = newRuntime(...args);
            const newContext = runtime.newContext.bind(runtime);
            runtime.newContext = (...more) => {
              const vm = newContext(...more);
              const evalCode = vm.evalCode.bind(vm);
              vm.evalCode = () => evalCode(`throw ${thrown}`);
              return vm;
            };
            return runtime;
          };
        }
        return wasm;
      },
    });
    expect(await failure(run({ js: "return 1;", tools: {}, abortSignal: signal() }))).toBe("RangeError: Maximum call stack size exceeded (the host's stack ran out)");
    expect(await run({ js: "return 'fresh';", tools: {}, abortSignal: signal() })).toBe("fresh");
    expect(loads).toBe(2);
  });

  it("QJ1.4 a run aborted before it starts calls no tool", async () => {
    const abort = new AbortController();
    abort.abort();
    const execute = vi.fn(async () => "x");
    expect(await failure(quickjsCodeMode()({ js: "return tools.t({});", tools: { t: tool({ inputSchema: jsonSchema({}), execute }) }, abortSignal: abort.signal }))).toBe("CodeModeAbortedError: Code mode execution was aborted.");
    expect(execute).not.toHaveBeenCalled();
  });

  it("QJ1.5 a workflow in TypeScript runs on QuickJS with its types stripped", async () => {
    const result = await runWorkflow({
      name: "typed",
      code: "interface Sum { total: number }\nconst s: Sum = { total: (input as { a: number }).a + 1 };\nreturn s.total;",
      input: { a: 41 },
      effects: { tool: async () => null, ask: async () => "" },
      journal: new MemoryStorage(),
      codeMode: quickjsCodeMode(),
    });
    expect(result).toMatchObject({ status: "completed", output: 42 });
  });
});

/** A module loader that counts loads, and can alter the first module's runtimes. */
function counting(alter?: (runtime: ReturnType<QuickJSWASMModule["newRuntime"]>) => void) {
  const state = { loads: 0 };
  const module = async () => {
    const wasm = await newQuickJSWASMModule();
    if (++state.loads === 1 && alter) {
      const newRuntime = wasm.newRuntime.bind(wasm);
      wasm.newRuntime = (...args) => {
        const runtime = newRuntime(...args);
        alter(runtime);
        return runtime;
      };
    }
    return wasm;
  };
  return { state, module };
}

describe("QuickJS code mode, in detail", () => {
  it("QJ1.6 failures read as AI SDK code mode's do, and QuickJS's own stack limit is what stops deep recursion", async () => {
    const run = quickjsCodeMode();
    const tools = {
      typed: tool({ inputSchema: z.object({ n: z.number() }), execute: async () => "ok" }),
      bad: tool({ inputSchema: jsonSchema({}), execute: async (): Promise<unknown> => Promise.reject(new Error("boom")) }),
      slow: tool({ inputSchema: jsonSchema({}), execute: () => new Promise((r) => setTimeout(() => r("late"), 1_000)) }),
    };
    expect(await failure(run({ js: "return tools.nope({});", tools, abortSignal: signal() }))).toBe("CodeModeToolError: Unknown tool: nope");
    expect(await failure(run({ js: "return tools.typed({ n: 'x' });", tools, abortSignal: signal() }))).toMatch(/^CodeModeToolError: Invalid input for tool "typed": /);
    expect(await failure(run({ js: "return tools.bad({});", tools, abortSignal: signal() }))).toBe("RunError: Host tool failed.");
    const started = Date.now();
    expect(await failure(run({ js: "return tools.slow({});", tools, abortSignal: signal(), timeoutMs: 100 }))).toBe("CodeModeTimeoutError: Code mode execution timed out after 100ms.");
    // it ends at its deadline, not when the tool answers
    expect(Date.now() - started).toBeLessThan(800);
    expect(await failure(run({ js: "for (;;) {}", tools, abortSignal: signal(), timeoutMs: 100 }))).toBe("CodeModeTimeoutError: Code mode execution timed out after 100ms.");
    expect(await failure(run({ js: "await tools.typed({ n: 1 }); for (;;) {}", tools, abortSignal: signal(), timeoutMs: 100 }))).toBe("CodeModeTimeoutError: Code mode execution timed out after 100ms.");
    expect(await failure(run({ js: "function f(n) { return n === 0 ? 0 : 1 + f(n - 1); } return f(1e6);", tools, abortSignal: signal() }))).toBe("InternalError: stack overflow");
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    const aborting = Date.now();
    expect(await failure(run({ js: "return tools.slow({});", tools, abortSignal: abort.signal }))).toBe("CodeModeAbortedError: Code mode execution was aborted.");
    expect(Date.now() - aborting).toBeLessThan(800);
  });

  it("QJ1.7 tools get what the code passes (nothing, a string, an object), with a call id each and the run's signal; null and primitives come back as they are", async () => {
    const seen: unknown[] = [];
    const abort = new AbortController();
    const echo = tool({
      inputSchema: jsonSchema({}),
      execute: async (input: unknown, options) => {
        seen.push([input, options.toolCallId, options.messages, options.abortSignal === abort.signal]);
        return input === "null" ? null : input === "abc" ? "abc" : input === 0 ? 0 : false;
      },
    });
    const result = await quickjsCodeMode()({ js: "return [await tools.echo(), await tools.echo('abc'), await tools.echo('null'), await tools.echo(0)];", tools: { echo }, abortSignal: abort.signal });
    expect(result).toEqual([false, "abc", null, 0]);
    expect(seen).toEqual([
      [undefined, "quickjs-1", [], true],
      ["abc", "quickjs-2", [], true],
      ["null", "quickjs-3", [], true],
      [0, "quickjs-4", [], true],
    ]);
  });

  it("QJ1.8 one WebAssembly module serves every run, whatever way each ends: runs free all they hold", async () => {
    const { state, module } = counting();
    const run = quickjsCodeMode({ module });
    const tools = {
      ok: tool({ inputSchema: jsonSchema({}), execute: async () => ({ fine: true }) }),
      bad: tool({ inputSchema: jsonSchema({}), execute: async (): Promise<unknown> => Promise.reject(new Error("boom")) }),
      slow: tool({ inputSchema: jsonSchema({}), execute: () => new Promise((r) => setTimeout(() => r("late"), 300)) }),
    };
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    const ends = await Promise.all([
      run({ js: "return tools.ok({});", tools, abortSignal: signal() }),
      failure(run({ js: "throw new Error('mine');", tools, abortSignal: signal() })),
      failure(run({ js: "return (", tools, abortSignal: signal() })),
      failure(run({ js: "return tools.bad({});", tools, abortSignal: signal() })),
      run({ js: "try { await tools.bad({}); } catch (e) { return e.message; }", tools, abortSignal: signal() }),
      failure(run({ js: "return tools.nope({});", tools, abortSignal: signal() })),
      failure(run({ js: "return tools.slow({});", tools, abortSignal: signal(), timeoutMs: 50 })),
      failure(run({ js: "await tools.slow({}); return 1;", tools, abortSignal: abort.signal })),
      failure(run({ js: "for (;;) {}", tools, abortSignal: signal(), timeoutMs: 50 })),
    ]);
    expect(ends).toEqual([
      { fine: true },
      "Error: mine",
      expect.stringMatching(/^SyntaxError/),
      "RunError: Host tool failed.",
      "Host tool failed.",
      "CodeModeToolError: Unknown tool: nope",
      expect.stringMatching(/timed out after 50ms/),
      "CodeModeAbortedError: Code mode execution was aborted.",
      expect.stringMatching(/timed out after 50ms/),
    ]);
    // the slow calls settle after their runs ended; nothing is handed to a run that is gone
    await new Promise((r) => setTimeout(r, 400));
    expect(await run({ js: "return 'still here';", tools, abortSignal: signal() })).toBe("still here");
    expect(state.loads).toBe(1);
  });

  it("QJ1.9 a runtime QuickJS cannot free, or cannot make, leaves the module behind: the next run loads a fresh one", async () => {
    const unfreeable = counting((runtime) => {
      runtime.dispose = () => {
        throw new Error("cannot free");
      };
    });
    const run = quickjsCodeMode({ module: unfreeable.module });
    expect(await run({ js: "return 1;", tools: {}, abortSignal: signal() })).toBe(1);
    expect(await run({ js: "return 2;", tools: {}, abortSignal: signal() })).toBe(2);
    expect(unfreeable.state.loads).toBe(2);
    let loads = 0;
    const unmakeable = quickjsCodeMode({
      module: async () => {
        const wasm = await newQuickJSWASMModule();
        if (++loads === 1)
          wasm.newRuntime = () => {
            throw new Error("no runtime");
          };
        return wasm;
      },
    });
    expect(await failure(unmakeable({ js: "return 1;", tools: {}, abortSignal: signal() }))).toBe("Error: no runtime");
    expect(await unmakeable({ js: "return 3;", tools: {}, abortSignal: signal() })).toBe(3);
  });
});

describe("QuickJS code mode, at its edges", () => {
  it("QJ1.10 an error from the code's pending jobs (one it cannot catch) ends the run with it, and the run still frees all it holds", async () => {
    let loads = 0;
    let injected = false;
    const run = quickjsCodeMode({
      module: async () => {
        const wasm = await newQuickJSWASMModule();
        if (++loads === 1) {
          const newRuntime = wasm.newRuntime.bind(wasm);
          wasm.newRuntime = (...args) => {
            const runtime = newRuntime(...args);
            const newContext = runtime.newContext.bind(runtime);
            runtime.newContext = (...more) => {
              const vm = newContext(...more);
              const executePendingJobs = runtime.executePendingJobs.bind(runtime);
              runtime.executePendingJobs = (...jobs) => {
                if (injected) return executePendingJobs(...jobs);
                injected = true;
                return { error: vm.newError({ name: "InternalError", message: "out of memory" }) } as unknown as ReturnType<typeof executePendingJobs>;
              };
              return vm;
            };
            return runtime;
          };
        }
        return wasm;
      },
    });
    expect(await failure(run({ js: "return 1;", tools: {}, abortSignal: signal() }))).toBe("InternalError: out of memory");
    expect(await run({ js: "return 2;", tools: {}, abortSignal: signal() })).toBe(2);
    expect(loads).toBe(1);
  });

  it("QJ1.11 a call the code makes after an abort, before the run has ended, is refused: no tool runs after an abort", async () => {
    // a aborts as it runs, before the code has asked for b: b and c are refused
    const abort = new AbortController();
    const ran: string[] = [];
    const tools = {
      a: tool({ inputSchema: jsonSchema({}), execute: async () => (ran.push("a"), abort.abort(), "a") }),
      b: tool({ inputSchema: jsonSchema({}), execute: async () => (ran.push("b"), "b") }),
      c: tool({ inputSchema: jsonSchema({}), execute: async () => (ran.push("c"), "c") }),
    };
    await expect(quickjsCodeMode()({ js: "await Promise.all([tools.a({}), tools.b({})]); await tools.c({}); return 'done';", tools, abortSignal: abort.signal })).rejects.toThrow("Code mode execution was aborted.");
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toEqual(["a"]);
  });
});

describe("checking workflow code", () => {
  it("WF1.20 where compiling code is forbidden (an extension's content security policy), stripping's own parse is the check", () => {
    vi.stubGlobal(
      "Function",
      new Proxy(Function, {
        construct: () => {
          throw new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source");
        },
      }),
    );
    try {
      expect(checkWorkflow("const n: number = await tools.count({}); return n;")).toEqual({ ok: true });
      expect(checkWorkflow("return (")).toMatchObject({ ok: false, error: expect.stringMatching(/^SyntaxError: /) });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("WF1.21 an early error that stripping lets through is still caught where code can be compiled", () => {
    expect(checkWorkflow("let x = 1; let x = 2;")).toMatchObject({ ok: false, error: expect.stringMatching(/^SyntaxError: /) });
  });
});
