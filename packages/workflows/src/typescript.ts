import { transform } from "sucrase";

const PREFIX = "async function workflow(input, tools) {\n";
const SUFFIX = "\n}";

/**
 * Workflow code as JavaScript: TypeScript's types removed (sucrase, which runs on every
 * host and keeps line numbers). The code is transformed as the body of an async
 * function, where `return` and `await` belong. Throws a SyntaxError on code that does
 * not parse.
 */
export function stripTypes(code: string): string {
  let out: string;
  try {
    // Stryker disable next-line BooleanLiteral: equivalent; sucrase's ES transforms rewrite modern syntax into code that does the same in QuickJS
    out = transform(`${PREFIX}${code}${SUFFIX}`, { transforms: ["typescript"], disableESTransforms: true }).code;
  } catch (e) {
    throw new SyntaxError(e instanceof Error ? e.message : String(e));
  }
  // Stryker disable next-line all: defensive; sucrase leaves the wrapper as written, so this never throws
  if (!out.startsWith(PREFIX) || !out.endsWith(SUFFIX)) throw new SyntaxError("workflow code must be a function body");
  return out.slice(PREFIX.length, out.length - SUFFIX.length);
}
