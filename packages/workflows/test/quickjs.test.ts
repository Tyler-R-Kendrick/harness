import { describe, expect, it, vi } from "vitest";
import { jsonSchema, tool } from "ai";
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
      inert: tool({ inputSchema: jsonSchema({}) }),
    };
    expect(await run({ js: "return tools.stream({});", tools, abortSignal: signal() })).toBe("final");
    expect(await failure(run({ js: "return tools.inert({});", tools, abortSignal: signal() }))).toBe('CodeModeToolError: Tool "inert" does not have execute().');
  });

  it("QJ1.2 limits are options: less memory than the default fails what the default allows", async () => {
    const js = "return new Array(1e6).fill(0).length;";
    expect(await quickjsCodeMode()({ js, tools: {}, abortSignal: signal() })).toBe(1e6);
    expect(await failure(quickjsCodeMode({ memoryLimitBytes: 1024 * 1024 })({ js, tools: {}, abortSignal: signal() }))).toMatch(/out of memory/);
  });

  it("QJ1.3 when the WebAssembly module itself fails, the run says so and the next run gets a fresh module", async () => {
    // A stack limit past what the host's own stack holds lets recursion overflow the host first.
    const run = quickjsCodeMode({ stackLimitBytes: 512 * 1024 });
    expect(await failure(run({ js: "function f(n) { return n === 0 ? 0 : 1 + f(n - 1); } return f(1e7);", tools: {}, abortSignal: signal() }))).toBe("RangeError: Maximum call stack size exceeded (the host's stack ran out)");
    expect(await run({ js: "return 'fresh';", tools: {}, abortSignal: signal() })).toBe("fresh");
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
