import type { Tool } from "ai";

/** A program for a code mode: the body of an async function, with `tools` in scope. */
export interface CodeModeProgram {
  /** JavaScript: types are stripped before a program is run. */
  readonly js: string;
  /** Each `tools.<name>(input)` call goes to the tool of that name, its input checked against the tool's schema. */
  readonly tools: Readonly<Record<string, Tool>>;
  /** Ends the run; no tool is called after it. */
  readonly abortSignal: AbortSignal;
  /** Wall-clock limit for the whole run, waiting on tools included, in milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * Where workflow code runs: an isolated interpreter whose only way out is `tools`, with
 * time, memory and stack limits. It resolves with what the body returns, as JSON, and
 * rejects with what it throws, reported as `name: message`. Every host brings one:
 * AI SDK code mode natively (`aiCodeMode`, from `@harness/workflows/node`), QuickJS
 * compiled to WebAssembly anywhere (`quickjsCodeMode`). `codeModeContract` in testkit
 * holds them to the same behavior.
 */
export type CodeMode = (program: CodeModeProgram) => Promise<unknown>;
