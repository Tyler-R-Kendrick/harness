import { stripTypes } from "./typescript.ts";

/**
 * Workflow code is a code-mode program: JavaScript or TypeScript run as an async
 * function body, with `input` and `tools` in scope. It is checked before it is kept: it
 * must parse. Types are stripped the way runs strip them; the JavaScript is then
 * compiled as a function that is never called, so nothing runs. Where a page's content
 * security policy forbids compiling code (an extension), the stripping's own parse is
 * the check.
 */
export function checkWorkflow(code: string): { ok: true } | { ok: false; error: string } {
  let js: string;
  try {
    js = stripTypes(code);
  } catch (e) {
    return { ok: false, error: `SyntaxError: ${(e as Error).message}` };
  }
  try {
    new Function(`return async function workflow(input, tools) {\n${js}\n}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof EvalError) return { ok: true };
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}
