import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { constants, Script } from "node:vm";
import type { XGrammar } from "@harness/constrained";

const require = createRequire(import.meta.url);
let loaded: XGrammar | undefined;

/**
 * The XGrammar web binding for Node. Its bundle is UMD in a package labelled ESM, so it
 * is evaluated as CommonJS; its own dynamic imports resolve through Node's loader.
 * `fresh` loads a new instance (XGrammar aborts an instance on a grammar it cannot parse).
 */
export function loadXGrammar(fresh = false): XGrammar {
  if (loaded && !fresh) return loaded;
  const file = require.resolve("@mlc-ai/web-xgrammar");
  const module = { exports: {} as unknown };
  const wrapper = new Script(`(function (exports, module, require, __filename, __dirname) {${readFileSync(file, "utf8")}\n})`, {
    filename: file,
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }).runInThisContext() as (...args: unknown[]) => void;
  wrapper(module.exports, module, createRequire(file), file, dirname(file));
  loaded = module.exports as XGrammar;
  return loaded;
}
