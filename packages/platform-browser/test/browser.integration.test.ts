import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { parseCatalog } from "@harness/cognitive";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext } from "playwright-core";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const packages = new URL("../../", import.meta.url).pathname;
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript" };

let out: string;
let server: Server;
let origin: string;
let browser: Browser;
/** Model files the test server serves under /hub, as Hugging Face would. */
const hubFiles: Record<string, Uint8Array> = {};

// The browser host, bundled for the browser (as an app would), served over HTTP (IndexedDB
// and shared workers need an origin) and run in real Chromium.
beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "harness-browser-"));
  await build({
    configFile: false,
    logLevel: "silent",
    resolve: { alias: Object.fromEntries(["platform-browser", "runtime", "core", "cognitive", "workers", "client", "protocol", "models", "constrained", "behavior"].map((name) => [`@harness/${name}`, join(packages, name, "src/index.ts")])) },
    build: {
      outDir: out,
      emptyOutDir: true,
      target: "es2022",
      minify: false,
      rollupOptions: { input: { page: join(fixtures, "page.ts"), "shared-worker": join(fixtures, "shared-worker.ts") }, output: { format: "es", entryFileNames: "[name].js" } },
    },
  });
  server = createServer((req, res) => {
    const hubFile = (req.url ?? "").startsWith("/hub/") ? Object.entries(hubFiles).find(([path]) => (req.url ?? "").endsWith(`/${path}`)) : undefined;
    if (hubFile) return void res.writeHead(200).end(hubFile[1]);
    const name = req.url === "/" ? "index.html" : (req.url ?? "").slice(1);
    try {
      const body = name === "index.html" ? readFileSync(join(fixtures, name)) : readFileSync(join(out, name));
      res.writeHead(200, { "content-type": TYPES[extname(name)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  browser = await chromium.launch(process.env["HARNESS_CHROMIUM"] ? { executablePath: process.env["HARNESS_CHROMIUM"] } : {});
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
  rmSync(out, { recursive: true, force: true });
});

/** A tab; tabs in one context share an origin's storage and shared workers, as in one browser profile. */
async function page(context?: BrowserContext) {
  const p = await (context ?? browser).newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(origin);
  await p.waitForFunction(() => document.title === "ready", undefined, { timeout: 20_000 }).catch(() => {
    throw new Error(`the page did not start: ${errors.join("; ")}`);
  });
  return p;
}

describe("the browser host in Chromium", () => {
  it("BI1.1 in a tab: a client on a MessagePort runs a turn, hanging up frees the session for another, and a restart restores it from IndexedDB", async () => {
    const p = await page();
    const result = await p.evaluate(() => (globalThis as unknown as { smoke: { inTab(): Promise<Record<string, unknown>> } }).smoke.inTab());
    expect(result).toMatchObject({ stopReason: "end_turn", said: "echo: hello browser", again: "end_turn", sessions: [result["sessionId"]] });
    expect(result["reloaded"]).toContain("echo: again");
    await p.close();
  });

  it("BI1.2 in a shared worker: one daemon serves every tab, so a session one tab starts is listed in another", async () => {
    const p = await page();
    const result = await p.evaluate(() => (globalThis as unknown as { smoke: { inSharedWorker(): Promise<Record<string, unknown>> } }).smoke.inSharedWorker());
    expect(result).toMatchObject({ said: "echo: from tab one" });
    expect(result["sessions"]).toContain(result["sessionId"]);
    await p.close();
  });

  it("BI1.3 a tab that dies without hanging up frees its session: the daemon learns from the tab's Web Lock", async () => {
    type Smoke = { smoke: { openAndLeave(): Promise<string>; join(): Promise<void>; takeOver(sessionId: string): Promise<Record<string, unknown>> } };
    const profile = await browser.newContext();
    const left = await page(profile);
    const sessionId = await left.evaluate(() => (globalThis as unknown as Smoke).smoke.openAndLeave());
    const other = await page(profile);
    // The other tab is connected before the first dies, so the same daemon (and its lease) lives on.
    await other.evaluate(() => (globalThis as unknown as Smoke).smoke.join());
    await left.close();
    const result = await other.evaluate((id) => (globalThis as unknown as Smoke).smoke.takeOver(id), sessionId);
    expect(result).toMatchObject({ stopReason: "end_turn", said: expect.stringMatching(/echo: mine now$/) });
    await profile.close();
  });

  it("BI3.1 model files are kept in the real Cache API and found again by another instance", async () => {
    const p = await page();
    expect(await p.evaluate(() => (globalThis as unknown as { smoke: { cacheRoundTrip(): Promise<unknown> } }).smoke.cacheRoundTrip())).toEqual({ found: [1, 2, 3], missing: true });
    await p.close();
  });

  it("BI3.2 XGrammar runs in the browser from its bundled source: a JSON Schema constrains tokens, and a grammar it cannot parse is recovered from", async () => {
    const p = await page();
    const result = await p.evaluate(() => (globalThis as unknown as { smoke: { xgrammar(): Promise<{ allowed: string[]; forced: string; broken: string; afterBroken: string[] }> } }).smoke.xgrammar());
    expect(result.allowed).toEqual(["{"]);
    expect(result.forced).toBe('{"n": ');
    expect(result.broken).toMatch(/does not compile/);
    expect(result.afterBroken).toEqual(["a", "b", "c"]);
    await p.close();
  });

  it("BI3.3 the browser host's cognitive core loads a Cactus WASM router from verified files and answers a cognitive invoke over ACP", async () => {
    const engine = new TextEncoder().encode(`
      module.exports = async function (arg) {
        const heap = new Uint8Array(1 << 16); let next = 16;
        return {
          HEAPU8: heap,
          _malloc: (n) => { const p = next; next += Math.ceil((n + 8) / 16) * 16; return p; },
          _free: () => {},
          _tiny_load: () => (arg.wasmBinary.length > 0 ? 0 : -1),
          UTF8ToString: (p) => { let e = p; while (heap[e]) e++; return new TextDecoder().decode(heap.subarray(p, e)); },
          ccall: (name, _r, _t, args) => {
            if (name === "tiny_embed") return 2;
            if (name !== "tiny_complete") return 0;
            const reply = new TextEncoder().encode(JSON.stringify({ success: true, function_calls: [{ name: "t", arguments: {} }], confidence: 0.9, reasoning: "" }));
            heap.set(reply, args[2]); heap[args[2] + reply.length] = 0; return 1;
          },
        };
      };`);
    Object.assign(hubFiles, { "engine.js": engine, "engine.wasm": new Uint8Array([0, 97, 115, 109]), "weights.bin": new Uint8Array([1, 2, 3]) });
    const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    const data = (file: string) => JSON.parse(readFileSync(new URL(`../../cognitive/data/${file}`, import.meta.url), "utf8")) as unknown;
    const router = parseCatalog(data("catalog.json"), data("benchmarks.json")).models.find((m) => m.runtime === "cactus-wasm" && m.platforms.includes("browser"))!;
    const model = { ...router, run: { loader: "engine.js", wasm: "engine.wasm", weights: "weights.bin", prefix: "tiny" }, artifact: { ...router.artifact!, files: Object.entries(hubFiles).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) })) } };
    const p = await page();
    const routed = await p.evaluate(([m, hub]) => (globalThis as unknown as { smoke: { cognitive(m: unknown, hub: string): Promise<unknown> } }).smoke.cognitive(m, hub), [model, `${origin}/hub`] as const);
    expect(routed).toMatchObject({ model: model.id, calls: [{ name: "t", arguments: {} }], confidence: 0.9 });
    await p.close();
  });
});
