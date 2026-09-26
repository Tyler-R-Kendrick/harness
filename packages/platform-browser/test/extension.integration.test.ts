import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const fixtures = new URL("./fixtures/extension/", import.meta.url).pathname;
const packages = new URL("../../", import.meta.url).pathname;

let out: string;
let context: BrowserContext;
let extensionId: string;

type Smoke = { smoke: { openAndTurn(text: string): Promise<{ sessionId: string; stopReason: string; said: string }>; takeOver(sessionId: string): Promise<{ stopReason: string; said: string }> } };

// The browser host bundled into an unpacked extension (a service worker and a page) and
// loaded into real Chromium; extensions need full Chromium, not the headless shell.
beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "harness-extension-"));
  await build({
    configFile: false,
    logLevel: "silent",
    resolve: { alias: Object.fromEntries(["platform-browser", "runtime", "core", "cognitive", "workers", "client", "protocol"].map((name) => [`@harness/${name}`, join(packages, name, "src/index.ts")])) },
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
}, 120_000);

afterAll(async () => {
  await context?.close();
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

describe("the browser host in an extension, in Chromium", () => {
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
});
