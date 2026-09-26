import { describe, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import { validatedSchema } from "@harness/cognitive";
import type { Tool, ToolExecutionOptions } from "ai";

/** An abort signal, named through the AI SDK's own types (this package has no DOM or Node types). */
type Signal = NonNullable<ToolExecutionOptions<unknown>["abortSignal"]>;

/** What the contract needs from the host: time passing, and aborts. */
export interface CodeModeContractHost {
  delay(ms: number): Promise<void>;
  abortable(): { readonly signal: Signal; abort(): void };
}

/**
 * A code mode as workflows use one: it runs `js` as the body of an async function with
 * `tools` in scope (each call goes to the host's AI SDK tool of that name) and resolves
 * with what the body returns, as JSON. Declared here by shape so testkit needs no
 * workflows dependency.
 */
export type CodeModeUnderTest = (program: {
  readonly js: string;
  readonly tools: Readonly<Record<string, Tool>>;
  readonly abortSignal: Signal;
  readonly timeoutMs?: number;
}) => Promise<unknown>;

const failure = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    (v) => {
      throw new Error(`expected a failure, got ${JSON.stringify(v)}`);
    },
    (e: unknown) => String(e),
  );

/** One behavior for every code mode, so a workflow runs the same on every host. */
export function codeModeContract(label: string, make: () => CodeModeUnderTest, host: CodeModeContractHost): void {
  describe(`code mode contract: ${label}`, { timeout: 20_000 }, () => {
    const signal = () => host.abortable().signal;
    const echo = tool({ inputSchema: validatedSchema({ type: "object", properties: { n: { type: "number" } }, required: ["n"] }), execute: async (input: unknown) => ({ n: (input as { n: number }).n }) });

    it("CM1.1 the body runs as an async function and its result comes back as JSON", async () => {
      const run = make();
      expect(await run({ js: "return 1 + 1;", tools: {}, abortSignal: signal() })).toBe(2);
      expect(await run({ js: "const x = await Promise.resolve(3); return { x, d: new Date(0), f() {}, u: undefined };", tools: {}, abortSignal: signal() })).toEqual({ x: 3, d: "1970-01-01T00:00:00.000Z" });
      expect(await run({ js: "", tools: {}, abortSignal: signal() })).toBeUndefined();
    });

    it("CM1.2 tools are called by name with their input checked against the tool's schema; results come back as JSON", async () => {
      const run = make();
      const seen: unknown[] = [];
      const tools = { echo, log: tool({ inputSchema: jsonSchema({}), execute: async (input: unknown) => (seen.push(input), undefined) }) };
      expect(await run({ js: "const a = await tools.echo({ n: 2 }); const b = await tools.log({ k: 'v' }); return [a, b === undefined];", tools, abortSignal: signal() })).toEqual([{ n: 2 }, true]);
      expect(seen).toEqual([{ k: "v" }]);
      expect(await run({ js: "return Promise.all([tools.echo({ n: 1 }), tools.echo({ n: 2 })]);", tools, abortSignal: signal() })).toEqual([{ n: 1 }, { n: 2 }]);
      expect(await failure(run({ js: "return tools.echo({ n: 'x' });", tools, abortSignal: signal() }))).toMatch(/Invalid input for tool "echo"/);
      expect(await failure(run({ js: "return tools.nope({});", tools, abortSignal: signal() }))).toMatch(/Unknown tool: nope/);
      expect(await run({ js: "try { await tools.nope({}); } catch (e) { return 'caught ' + e.message; }", tools, abortSignal: signal() })).toBe("caught Unknown tool: nope");
    });

    it("CM1.3 a tool that fails fails its call in the code, which may catch it", async () => {
      const run = make();
      const tools = { bad: tool({ inputSchema: jsonSchema({}), execute: async (): Promise<unknown> => Promise.reject(new Error("boom")) }) };
      expect(await failure(run({ js: "return tools.bad({});", tools, abortSignal: signal() }))).toMatch(/Host tool failed/);
      expect(await run({ js: "try { await tools.bad({}); } catch { return 'caught'; }", tools, abortSignal: signal() })).toBe("caught");
    });

    it("CM1.4 what the code throws is reported as name: message", async () => {
      const run = make();
      expect(await failure(run({ js: "throw new Error('mine');", tools: {}, abortSignal: signal() }))).toBe("Error: mine");
      expect(await failure(run({ js: "throw new TypeError('t');", tools: {}, abortSignal: signal() }))).toBe("TypeError: t");
      expect(await failure(run({ js: "throw 'plain';", tools: {}, abortSignal: signal() }))).toMatch(/^\w*Error: plain$/);
      expect(await failure(run({ js: "throw { message: 'no name' };", tools: {}, abortSignal: signal() }))).toMatch(/no name/);
      expect(await failure(run({ js: "return (", tools: {}, abortSignal: signal() }))).toMatch(/^SyntaxError: .*unexpected token/i);
    });

    it("CM1.5 the code has no way out but tools: no network, timers, process or modules", async () => {
      const run = make();
      expect(await run({ js: "return [typeof fetch, typeof setTimeout, typeof process, typeof require, typeof XMLHttpRequest].join();", tools: {}, abortSignal: signal() })).toBe("undefined,undefined,undefined,undefined,undefined");
    });

    it("CM1.6 the time limit stops code that runs too long, busy or waiting on a tool, even code that catches what stops it", async () => {
      const run = make();
      expect(await failure(run({ js: "for (;;) {}", tools: {}, abortSignal: signal(), timeoutMs: 200 }))).toMatch(/timed out after 200ms/);
      expect(await failure(run({ js: "try { for (;;) {} } catch {} return 'escaped';", tools: {}, abortSignal: signal(), timeoutMs: 200 }))).toMatch(/timed out after 200ms/);
      const slow = { slow: tool({ inputSchema: jsonSchema({}), execute: async () => (await host.delay(2_000), "late") }) };
      expect(await failure(run({ js: "return tools.slow({});", tools: slow, abortSignal: signal(), timeoutMs: 200 }))).toMatch(/timed out after 200ms/);
      expect(await run({ js: "return 'fine';", tools: {}, abortSignal: signal() })).toBe("fine");
    });

    it("CM1.7 memory and stack are bounded, and the next run is unaffected", async () => {
      const run = make();
      expect(await failure(run({ js: "return new Array(2e7).fill(1.5).length;", tools: {}, abortSignal: signal() }))).toMatch(/memory|timed out/i);
      expect(await failure(run({ js: "function f(n) { return n === 0 ? 0 : 1 + f(n - 1); } return f(1e6);", tools: {}, abortSignal: signal() }))).toMatch(/stack/i);
      expect(await failure(run({ js: "return JSON.parse('['.repeat(1e5) + ']'.repeat(1e5)).length;", tools: {}, abortSignal: signal() }))).toMatch(/stack|recursion|depth/i);
      expect(await run({ js: "function f(n) { return n === 0 ? 0 : 1 + f(n - 1); } return f(200);", tools: {}, abortSignal: signal() })).toBe(200);
    });

    it("CM1.8 an abort ends the run, and no tool is called after it", async () => {
      const run = make();
      const abort = host.abortable();
      const called: string[] = [];
      const tools = {
        first: tool({ inputSchema: jsonSchema({}), execute: async () => (called.push("first"), abort.abort(), "x") }),
        second: tool({ inputSchema: jsonSchema({}), execute: async () => (called.push("second"), "y") }),
      };
      await expect(run({ js: "await tools.first({}); await tools.second({}); return 'done';", tools, abortSignal: abort.signal })).rejects.toBeDefined();
      await host.delay(50);
      expect(called).toEqual(["first"]);
    });

    it("CM1.9 runs are independent: one run's globals are not another's", async () => {
      const run = make();
      await run({ js: "globalThis.leak = 1; return 0;", tools: {}, abortSignal: signal() });
      expect(await run({ js: "return typeof leak;", tools: {}, abortSignal: signal() })).toBe("undefined");
      expect(await Promise.all([run({ js: "return 'a';", tools: {}, abortSignal: signal() }), run({ js: "return 'b';", tools: {}, abortSignal: signal() })])).toEqual(["a", "b"]);
    });
  });
}
