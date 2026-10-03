import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const packages = new URL("../../", import.meta.url).pathname;
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };

let out: string;
let server: Server;
let origin: string;
let browser: Browser;

// The decision layer on the browser host, bundled for the browser (as an app would), served over
// HTTP (IndexedDB needs an origin) and run in real Chromium.
beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "harness-browser-decision-"));
  await build({
    configFile: false,
    logLevel: "silent",
    resolve: { alias: Object.fromEntries(["platform-browser", "runtime", "core", "cognitive", "workers", "client", "protocol", "models", "constrained", "behavior", "workflows", "decision", "dialogue", "dialogue-standards"].map((name) => [`@harness/${name}`, join(packages, name, "src/index.ts")])) },
    build: {
      outDir: out,
      emptyOutDir: true,
      target: "es2022",
      minify: false,
      rollupOptions: { input: { "decision-page": join(fixtures, "decision-page.ts") }, output: { format: "es", entryFileNames: "[name].js" } },
    },
  });
  server = createServer((req, res) => {
    const name = req.url === "/" ? "decision.html" : (req.url ?? "").slice(1);
    try {
      const body = name === "decision.html" ? readFileSync(join(fixtures, name)) : readFileSync(join(out, name));
      res.writeHead(200, { "content-type": TYPES[extname(name)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  browser = await chromium.launch(process.env["HARNESS_CHROMIUM"] ? { executablePath: process.env["HARNESS_CHROMIUM"] } : {});
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
  rmSync(out, { recursive: true, force: true });
});

type Smoke = { permissionFlow(name: string): Promise<Record<string, unknown>>; reopen(name: string): Promise<Record<string, unknown>> };

async function page() {
  const context = await browser.newContext();
  const p = await context.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(origin);
  await p.waitForFunction(() => document.title === "ready", undefined, { timeout: 20_000 }).catch(() => {
    throw new Error(`the page did not start: ${errors.join("; ")}`);
  });
  return { p, context, errors };
}

describe("the decision layer on the browser host in Chromium", () => {
  it("DBD3.1 a permission request is annotated and shown to the person without being answered, the person's denial becomes the decision's outcome, and the history survives a reload of the page", async () => {
    const { p, context, errors } = await page();
    const first = await p.evaluate(() => (globalThis as unknown as { smoke: Smoke }).smoke.permissionFlow("smoke"));
    expect(first).toMatchObject({
      annotated: expect.stringMatching(/^Bash: rm -rf build \(risk: \w+\)$/),
      openWhileAnnotated: 1,
      asked: 1,
      stopReason: "end_turn",
      id: "dec-0",
      rung: "model",
      outcome: { source: "human", kind: "denied" },
    });
    // the same origin, a fresh page: the records are in IndexedDB
    await p.reload();
    await p.waitForFunction(() => document.title === "ready", undefined, { timeout: 20_000 });
    const again = await p.evaluate(() => (globalThis as unknown as { smoke: Smoke }).smoke.reopen("smoke"));
    expect(again).toEqual({ ids: ["dec-0"], outcomes: ["denied"], next: "dec-1", status: 2 });
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);
});
