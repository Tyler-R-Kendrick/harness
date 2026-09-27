import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCatalog } from "@harness/cognitive";
import { factoryImports } from "../src/vite.ts";

const fixtures = new URL("./fixtures/extension/", import.meta.url).pathname;
const packages = new URL("../../", import.meta.url).pathname;

let out: string;
let context: BrowserContext;
let extensionId: string;
let hub: Server;
let hubUrl: string;
/** Model files the test's hub serves, as Hugging Face would. */
const hubFiles: Record<string, Uint8Array> = {};

type Smoke = { smoke: { openAndTurn(text: string): Promise<{ sessionId: string; stopReason: string; said: string }>; takeOver(sessionId: string): Promise<{ stopReason: string; said: string }> } };

// The browser host bundled into an unpacked extension (a service worker and a page) and
// loaded into real Chromium; extensions need full Chromium, not the headless shell.
beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "harness-extension-"));
  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [factoryImports()],
    resolve: { alias: Object.fromEntries(["platform-browser", "runtime", "core", "cognitive", "workers", "client", "protocol", "models", "constrained", "behavior", "workflows"].map((name) => [`@harness/${name}`, join(packages, name, "src/index.ts")])) },
    build: {
      outDir: out,
      emptyOutDir: true,
      target: "es2022",
      minify: false,
      rollupOptions: { input: { background: join(fixtures, "background.ts"), "ext-page": join(fixtures, "ext-page.ts") }, output: { format: "es", entryFileNames: "[name].js" } },
    },
  });
  for (const file of ["manifest.json", "page.html"]) copyFileSync(join(fixtures, file), join(out, file));
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${out}`, `--load-extension=${out}`],
    ...(process.env["HARNESS_CHROMIUM"] ? { executablePath: process.env["HARNESS_CHROMIUM"] } : {}),
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
  hub = createServer((req, res) => {
    const file = Object.entries(hubFiles).find(([path]) => (req.url ?? "").endsWith(`/${path}`));
    if (file) return void res.writeHead(200).end(file[1]);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const address = hub.address();
  hubUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/hub`;
}, 120_000);

afterAll(async () => {
  await context?.close();
  await new Promise((resolve) => hub?.close(resolve));
  rmSync(out, { recursive: true, force: true });
});

async function page(): Promise<Page> {
  const p = await context.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`chrome-extension://${extensionId}/page.html`);
  await p.waitForFunction(() => document.title === "ready", undefined, { timeout: 20_000 }).catch(() => {
    throw new Error(`the extension page did not start: ${errors.join("; ")}`);
  });
  return p;
}

describe("the browser host in an extension, in Chromium", { timeout: 60_000 }, () => {
  it("BI2.1 an extension page's ACP client on a runtime port runs a turn on the daemon in the extension's service worker", async () => {
    const p = await page();
    expect(await p.evaluate(() => (globalThis as unknown as Smoke).smoke.openAndTurn("from the extension"))).toMatchObject({ stopReason: "end_turn", said: "echo: from the extension" });
    await p.close();
  });

  it("BI2.2 a page that closes disconnects its runtime port, which frees its session for another page", async () => {
    const left = await page();
    const { sessionId } = await left.evaluate(() => (globalThis as unknown as Smoke).smoke.openAndTurn("mine"));
    await left.close();
    const other = await page();
    let result: { stopReason: string; said: string } | undefined;
    for (let i = 0; i < 20 && !result; i++) {
      result = await other.evaluate((id) => (globalThis as unknown as Smoke).smoke.takeOver(id), sessionId).catch(async () => (await new Promise((r) => setTimeout(r, 100)), undefined));
    }
    expect(result).toMatchObject({ stopReason: "end_turn", said: expect.stringMatching(/echo: mine now$/) });
    await other.close();
  });

  it("BI2.3 where Manifest V3 forbids evaluating code, XGrammar and a Cactus WASM router run from code packaged with the extension", async () => {
    type Smoke = { smoke: { xgrammar(): Promise<{ evalRefused: boolean; allowed: string[]; broken: string; afterBroken: string[]; fromSource: string }>; cognitive(m: unknown, hub: string): Promise<{ evalRefused: boolean; refused: string; routed: unknown }> } };
    // An open page keeps the service worker alive (MV3 stops idle workers); evaluate in the current one.
    const p = await page();
    const sw = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extensionId}/`))!;
    const grammar = await sw.evaluate(() => (globalThis as unknown as Smoke).smoke.xgrammar());
    // Evaluating the binding's source is refused; the packaged binding runs, and a fresh instance recovers from a broken grammar.
    expect(grammar).toEqual({ evalRefused: true, allowed: ["{"], broken: expect.stringMatching(/does not compile/), afterBroken: ["a", "b", "c"], fromSource: expect.stringMatching(/unsafe-eval/) });
    // The loader the hub serves is byte for byte the one packaged with the extension.
    Object.assign(hubFiles, { "engine.js": readFileSync(join(fixtures, "engine.js")), "engine.wasm": new Uint8Array([0, 97, 115, 109]), "weights.bin": new Uint8Array([1, 2, 3]) });
    const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    const data = (file: string) => JSON.parse(readFileSync(new URL(`../../cognitive/data/${file}`, import.meta.url), "utf8")) as unknown;
    const router = parseCatalog(data("catalog.json"), data("benchmarks.json")).models.find((m) => m.runtime === "cactus-wasm" && m.platforms.includes("browser"))!;
    const model = { ...router, run: { loader: "engine.js", wasm: "engine.wasm", weights: "weights.bin", prefix: "tiny" }, artifact: { ...router.artifact!, files: Object.entries(hubFiles).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) })) } };
    const result = await sw.evaluate(([m, url]) => (globalThis as unknown as Smoke).smoke.cognitive(m, url), [model, hubUrl] as const);
    expect(result).toMatchObject({ evalRefused: true, refused: expect.stringMatching(/unsafe-eval/), routed: { model: model.id, calls: [{ name: "t", arguments: {} }], confidence: 0.9 } });
    await p.close();
  });

  it("BI2.4 onnxruntime-web, which transformers.js models run on, runs a model in the extension's service worker", async () => {
    const p = await page();
    const sw = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extensionId}/`))!;
    const result = await sw.evaluate(() => (globalThis as unknown as { smoke: { onnx(): Promise<{ evalRefused: boolean; y: number[] }> } }).smoke.onnx());
    expect(result).toEqual({ evalRefused: true, y: [2, 3] });
    await p.close();
  });

  it("BI2.5 a durable workflow runs on QuickJS in the extension's service worker, where modules cannot be imported on demand", async () => {
    const p = await page();
    const sw = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extensionId}/`))!;
    const result = await sw.evaluate(() => (globalThis as unknown as { smoke: { workflows(): Promise<unknown> } }).smoke.workflows());
    expect(result).toMatchObject({ evalRefused: true, run: { status: "completed", output: 14 } });
    await p.close();
  });
});
