import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { packagedEmscripten, xgrammarFromFactory } from "@harness/platform-browser";
import { factoryImports } from "../src/vite.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

/** What the build plugin makes of a CommonJS or UMD file: a function that runs its code again on each call. */
function factoryOf(source: string): () => unknown {
  const transformed = factoryImports().transform(source, "/x/loader.js?factory");
  if (transformed === undefined) throw new Error("not transformed");
  const body = transformed.replace(/^export default /, "return ");
  return new Function(body)() as () => unknown;
}

describe("packaged code, for pages that cannot evaluate code (extensions)", () => {
  it("PK1.1 the build plugin wraps a module's code in a function that runs it again on each call, and leaves other imports alone", () => {
    const plugin = factoryImports();
    expect(plugin).toMatchObject({ name: "harness-factory-imports", enforce: "pre" });
    expect(plugin.transform("module.exports = 1;", "/x/loader.js")).toBeUndefined();
    const make = factoryOf("let n = 0; module.exports = { next: () => ++n };");
    const a = make() as { next(): number };
    const b = make() as { next(): number };
    a.next();
    expect([a.next(), b.next()]).toEqual([2, 1]);
    // a UMD binding takes its CommonJS branch
    const umd = factoryOf("(function (g, f) { typeof exports === 'object' && typeof module !== 'undefined' ? f(exports) : f(g.lib = {}); })(this, function (exports) { exports.kind = 'umd'; });");
    expect(umd()).toEqual({ kind: "umd" });
  });

  it("PK1.2 an Emscripten loader runs from the packaged copy whose source matches the verified loader, byte for byte", async () => {
    const source = "module.exports = async (arg) => ({ size: arg.wasmBinary.length, which: 'packaged' });";
    const hash = createHash("sha256").update(source).digest("hex");
    const emscripten = packagedEmscripten([{ source, factory: factoryOf(source) }]);
    expect(await emscripten(bytes(source), new Uint8Array(3), "engine.js")).toEqual({ size: 3, which: "packaged" });
    await expect(emscripten(bytes(`${source} `), new Uint8Array(3), "engine.js")).rejects.toThrow(
      new RegExp(`engine.js \\(sha256 [0-9a-f]{64}\\) is not packaged here; packaged: ${hash}`),
    );
    const broken = packagedEmscripten([{ source: "module.exports = 3;", factory: factoryOf("module.exports = 3;") }]);
    await expect(broken(bytes("module.exports = 3;"), new Uint8Array(0), "odd.js")).rejects.toThrow(/odd.js did not export a module factory/);
  });

  it("PK1.3 XGrammar from a factory: loaded once, and asked for a fresh instance it runs the binding again", async () => {
    let made = 0;
    const load = xgrammarFromFactory(() => ({ instance: ++made }) as never);
    const first = await load(false);
    expect(await load(false)).toBe(first);
    const fresh = await load(true);
    expect(fresh).not.toBe(first);
    expect(await load(false)).toBe(fresh);
    expect(made).toBe(2);
  });
});
