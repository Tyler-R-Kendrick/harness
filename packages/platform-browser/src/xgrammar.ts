import type { XGrammar } from "@harness/constrained";

/**
 * An XGrammar loader for the browser from the source of its web binding
 * (`@mlc-ai/web-xgrammar`'s `lib/index.js`, which an app bundles as text). The binding
 * is UMD; it is evaluated as CommonJS, and asked for a fresh instance it is evaluated
 * again, because XGrammar aborts an instance on a grammar it cannot parse.
 */
export function xgrammarFromSource(source: string): (fresh: boolean) => Promise<XGrammar> {
  let loaded: XGrammar | undefined;
  return async (fresh) => {
    if (loaded && !fresh) return loaded;
    const module = { exports: {} as unknown };
    new Function("exports", "module", source)(module.exports, module);
    loaded = module.exports as XGrammar;
    return loaded;
  };
}
