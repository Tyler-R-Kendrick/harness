import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCatalog } from "@harness/cognitive";
import { buildNativeEnsemble } from "@harness/platform-native";
import { modelCacheDir } from "../../platform-native/test/models-env.ts";
import { buildPlayground } from "../build.ts";
import { rankGenerators } from "../src/generator-model.ts";

// The built page in Chromium with no WebGPU (WebAssembly only), on the real weights of the
// smallest local model for a browser (picked by size, not by name): a question no template
// answers gets the local model's answer, and nothing asks first. The weights come from the
// verified native cache (fetched through the native host first), served where the browser
// asks Hugging Face for them; onnxruntime-web's WebAssembly from the installed package.

const data = (file: string) => JSON.parse(readFileSync(new URL(`../../cognitive/data/${file}`, import.meta.url), "utf8")) as unknown;
const catalog = parseCatalog(data("catalog.json"), data("benchmarks.json"));
const tiny = [...rankGenerators(catalog)].sort((a, b) => a.downloadBytes - b.downloadBytes)[0]!;
const root = new URL("../../../", import.meta.url).pathname;
/** MEASURE_OUT keeps what the page answered. */
const writeAnswer = async (text: string) => {
  if (process.env["MEASURE_OUT"]) (await import("node:fs")).appendFileSync(process.env["MEASURE_OUT"], `${text.split("\n").slice(-12).join("\n")}\n`);
};
/** onnxruntime-web's dist folder for the version the page asks for. */
const ortDist = (version: string) =>
  [join(root, "node_modules/onnxruntime-web"), join(root, "packages/playground/node_modules/onnxruntime-web")].find((dir) => existsSync(join(dir, "package.json")) && (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version === version);

let server: Server;
let origin: string;
let browser: Browser;

beforeAll(async () => {
  // The native host fetches and verifies the pinned files into the cache the browser is served from.
  const host = buildNativeEnsemble({ cacheDir: modelCacheDir, allowHosted: false, catalog: { models: [tiny], preferences: {} } });
  await host.ensemble.resolve("chat", "generator");
  await host.close();
  const page = `<!doctype html><html><head><meta charset=utf8></head><body>${await buildPlayground()}</body></html>`;
  const cache = join(modelCacheDir, "transformers");
  server = createServer((q, r) => {
    const url = decodeURIComponent(q.url ?? "/");
    const ort = /^\/ort\/([^/]+)\/(.+)$/.exec(url);
    const file = url.startsWith("/hf/") ? join(cache, url.slice(4)) : ort ? join(ortDist(ort[1]!) ?? "/missing", "dist", ort[2]!) : undefined;
    if (file === undefined) return void r.writeHead(200, { "content-type": "text/html" }).end(page);
    if (!existsSync(file)) return void r.writeHead(404, { "access-control-allow-origin": "*" }).end("not found");
    const type = file.endsWith(".wasm") ? "application/wasm" : file.endsWith("js") ? "text/javascript" : "application/octet-stream";
    r.writeHead(200, { "content-type": type, "content-length": statSync(file).size, "access-control-allow-origin": "*" });
    createReadStream(file).pipe(r);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  browser = await chromium.launch(process.env["HARNESS_CHROMIUM"] ? { executablePath: process.env["HARNESS_CHROMIUM"] } : {});
}, 900_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

describe(`the page answers with local inference in any browser (${tiny.name}, WebAssembly)`, () => {
  it("PAM1.1 with no WebGPU, auto loads the smallest local model on its own, and a question no template answers gets its answer, with nothing asked", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Console errors say where it went wrong (the fonts this test blocks log one); uncaught ones fail it.
    const logged: string[] = [];
    page.on("console", (m) => void (m.type() === "error" && logged.push(m.text().slice(0, 300))));
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    // Where the browser asks Hugging Face for the model's files, the verified cache answers (a branch resolves to the pinned revision).
    await page.route(/^https:\/\/huggingface\.co\//, (route) => {
      const m = /^https:\/\/huggingface\.co\/(.+?)\/resolve\/([^/]+)\/(.+)$/.exec(route.request().url());
      if (!m) return route.fulfill({ status: 404, body: "not found" });
      const revision = /^[0-9a-f]{40}$/.test(m[2]!) ? m[2]! : tiny.artifact!.revision;
      return route.fulfill({ status: 302, headers: { location: `${origin}/hf/${m[1]}/${revision}/${m[3]}`, "access-control-allow-origin": "*" } });
    });
    await page.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@([^/]+)\/dist\/(.+)$/, (route) => {
      const [, version, file] = /onnxruntime-web@([^/]+)\/dist\/([^?]+)/.exec(route.request().url())!;
      return route.fulfill({ status: 302, headers: { location: `${origin}/ort/${version}/${file}`, "access-control-allow-origin": "*" } });
    });
    await page.goto(origin);
    await page.waitForFunction(() => document.documentElement.dataset["booted"] !== undefined, undefined, { timeout: 60_000 });
    expect(await page.evaluate(async () => Boolean(await (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu?.requestAdapter().catch(() => null)))).toBe(false);
    // On a timeout, say where the local model was.
    const where = async () => `${await page.locator("#writer-pill").getAttribute("title")}; errors: ${[...errors, ...logged].join("; ")}`;
    await page.waitForFunction((name) => document.getElementById("writer-pill")?.textContent === `Writes: ${name}`, tiny.name, { timeout: 600_000 }).catch(async (e: unknown) => {
      throw new Error(`the local model did not load: ${await where()}`, { cause: e });
    });
    await page.locator("#terminal textarea").focus();
    await page.keyboard.type("/ask What is the capital of France?");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("count-turns")?.textContent === "2", undefined, { timeout: 600_000 }).catch(async (e: unknown) => {
      throw new Error(`the question was not answered: ${await where()}; terminal: ${(await page.locator("#terminal").innerText()).slice(-600)}`, { cause: e });
    });
    const text = await page.locator("#terminal").innerText();
    await writeAnswer(text);
    expect(text).toMatch(/Paris/);
    expect(text).not.toMatch(/Spend inference|Allow write_template|Could not write a template/);
    expect(errors).toEqual([]);
    await page.close();
  });
});
