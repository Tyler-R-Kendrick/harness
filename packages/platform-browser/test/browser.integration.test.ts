import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
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

// The browser host, bundled for the browser (as an app would), served over HTTP (IndexedDB
// and shared workers need an origin) and run in real Chromium.
beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "harness-browser-"));
  await build({
    configFile: false,
    logLevel: "silent",
    resolve: { alias: Object.fromEntries(["platform-browser", "runtime", "core", "cognitive", "workers", "client", "protocol"].map((name) => [`@harness/${name}`, join(packages, name, "src/index.ts")])) },
    build: {
      outDir: out,
      emptyOutDir: true,
      target: "es2022",
      minify: false,
      rollupOptions: { input: { page: join(fixtures, "page.ts"), "shared-worker": join(fixtures, "shared-worker.ts") }, output: { format: "es", entryFileNames: "[name].js" } },
    },
  });
  server = createServer((req, res) => {
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
});
