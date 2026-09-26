import type { XGrammar } from "@harness/constrained";

/** A module packaged with the app: its source (to match what was verified) and a factory that runs it (`?factory`). */
export interface PackagedModule {
  readonly source: string;
  readonly factory: () => unknown;
}

const hex = async (data: Uint8Array | string): Promise<string> => {
  // A copy, so the digest reads an ArrayBuffer (never a SharedArrayBuffer view).
  const digest = await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Emscripten loaders for pages that may not evaluate code (an extension): the loader's
 * bytes are still fetched and verified against the catalog, but what runs is the copy
 * packaged with the app whose source has the same sha256. The WebAssembly itself is
 * compiled as usual, which Manifest V3 allows (`wasm-unsafe-eval`).
 */
export function packagedEmscripten(modules: readonly PackagedModule[]): <M>(loader: Uint8Array, wasm: Uint8Array, name: string) => Promise<M> {
  let byHash: Promise<Map<string, PackagedModule>> | undefined;
  return async <M>(loader: Uint8Array, wasm: Uint8Array, name: string): Promise<M> => {
    byHash ??= Promise.all(modules.map(async (m) => [await hex(m.source), m] as const)).then((entries) => new Map(entries));
    const packaged = await byHash;
    const hash = await hex(loader);
    const module = packaged.get(hash);
    if (!module) throw new Error(`${name} (sha256 ${hash}) is not packaged here; packaged: ${[...packaged.keys()].join(", ") || "none"}`);
    const factory = module.factory();
    if (typeof factory !== "function") throw new Error(`${name} did not export a module factory`);
    return (factory as (arg: { wasmBinary: Uint8Array }) => Promise<M>)({ wasmBinary: wasm });
  };
}

/**
 * An XGrammar loader from its binding packaged with the app
 * (`import binding from "@mlc-ai/web-xgrammar?factory"`), for pages that may not
 * evaluate code. Asked for a fresh instance (XGrammar aborts one on a grammar it cannot
 * parse), it runs the binding again.
 */
export function xgrammarFromFactory(factory: () => unknown): (fresh: boolean) => Promise<XGrammar> {
  let loaded: XGrammar | undefined;
  return async (fresh) => {
    if (loaded && !fresh) return loaded;
    loaded = factory() as XGrammar;
    return loaded;
  };
}
