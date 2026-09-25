import { stripTypeScriptTypes } from "node:module";

/**
 * Workflow code is a code-mode program (see @ai-sdk/code-mode): JavaScript or
 * type-stripped TypeScript run as an async function body, with `input` and `tools` in
 * scope. It is checked before it is kept: it must parse. Constructing a function only
 * parses it, and the function it defines is never called: nothing runs.
 */
export function checkWorkflow(code: string): { ok: true } | { ok: false; error: string } {
  try {
    // Stripped as a function body, where `return` and `await` belong.
    new Function(stripTypeScriptTypes(`async function workflow(input, tools) {\n${code}\n}`));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}
