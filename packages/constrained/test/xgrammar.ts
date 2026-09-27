import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants, Script } from "node:vm";
import type { XGrammar } from "@harness/constrained";

/** The web-xgrammar bundle is UMD in an ESM-labelled package, so tests load it as CommonJS (as the native host does). */
export function loadXGrammar(): XGrammar {
  const require = createRequire(import.meta.url);
  const file = require.resolve("@mlc-ai/web-xgrammar");
  const module = { exports: {} as unknown };
  const wrapper = new Script(`(function (exports, module, require, __filename, __dirname) {${readFileSync(file, "utf8")}\n})`, { filename: file, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }).runInThisContext() as (...args: unknown[]) => void;
  wrapper(module.exports, module, createRequire(file), file, file.replace(/\/[^/]*$/, ""));
  return module.exports as XGrammar;
}
