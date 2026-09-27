const SUFFIX = "?factory";

/**
 * A build plugin (Vite or Rollup) for pages that may not evaluate code, such as an
 * extension's pages and service worker under Manifest V3's content security policy.
 * `import make from "some/module.js?factory"` gives a function that runs the module's
 * CommonJS or UMD code again on each call and returns its `module.exports`: a fresh
 * instance of an Emscripten module factory or of XGrammar's binding, from code packaged
 * at build time rather than evaluated at run time.
 */
export function factoryImports(): { readonly name: string; readonly enforce: "pre"; transform(code: string, id: string): string | undefined } {
  return {
    name: "harness-factory-imports",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith(SUFFIX)) return undefined;
      return `export default function () {
  const module = { exports: {} };
  (function (exports, module, require, define) {
${code}
  }).call(globalThis, module.exports, module, undefined, undefined);
  return module.exports;
}`;
    },
  };
}
