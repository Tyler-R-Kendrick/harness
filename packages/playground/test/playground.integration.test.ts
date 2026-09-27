import { createServer } from "node:http";
import type { Server } from "node:http";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPlayground } from "../build.ts";

// The playground built into its one HTML file (as it is published), served in the
// artifact's skeleton over HTTP, and run in real Chromium.
let server: Server;
let origin: string;
let browser: Browser;
let size = 0;

beforeAll(async () => {
  const html = await buildPlayground();
  size = html.length;
  const page = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>${html}</body></html>`;
  server = createServer((_req, res) => void res.writeHead(200, { "content-type": "text/html" }).end(page));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  browser = await chromium.launch(process.env["HARNESS_CHROMIUM"] ? { executablePath: process.env["HARNESS_CHROMIUM"] } : {});
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

/** The page, with fonts left out (no network in tests) and its errors collected. */
async function open(init?: () => void): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  if (init) await page.addInitScript(init);
  await page.goto(origin);
  // The first turn (typed at boot) has finished when it is listed.
  await page.waitForFunction(() => document.getElementById("count-turns")?.textContent === "1", undefined, { timeout: 30_000 }).catch(() => {
    throw new Error(`the playground did not boot: ${errors.join("; ")}`);
  });
  return { page, errors };
}

const terminalText = (page: Page) => page.locator("#terminal").innerText();

async function type(page: Page, line: string) {
  await page.locator("#terminal textarea").focus();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

describe("the playground page in Chromium", { timeout: 60_000 }, () => {
  it("PI1.1 boots in one file under the artifact size limit: the daemon runs a first turn that changes a file, and every panel shows it", async () => {
    expect(size).toBeLessThan(16 * 1024 * 1024);
    const { page, errors } = await open();
    expect(await terminalText(page)).toContain("ran a turn through the daemon");
    expect(await page.locator("#claude-pill").textContent()).toBe("Claude: not reachable here");
    expect(await page.locator("#worker button[data-worker=claude]").isDisabled()).toBe(true);
    await page.click("#tab-files");
    expect(await page.locator("#tree").innerText()).toMatch(/~\s*todo\.md/);
    await page.click("#tab-daemon");
    expect(await page.locator("#daemon").innerText()).toContain("turn.ended");
    await page.click("#tab-timeline");
    expect(Number(await page.locator("#count-timeline").textContent())).toBeGreaterThan(10);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("PI1.2 a command typed in the terminal asks for approval, runs on y, and its file appears in the Files tab", async () => {
    const { page } = await open();
    await type(page, "ask '$ echo typed > typed.txt'");
    await page.waitForFunction(() => document.getElementById("terminal")?.innerText.includes("Allow bash"));
    await page.keyboard.press("y");
    await page.waitForFunction(() => document.getElementById("count-turns")?.textContent === "2");
    expect(await terminalText(page)).toContain("+ /home/user/typed.txt");
    await page.click("#tab-files");
    await page.getByRole("button", { name: "typed.txt" }).click();
    expect(await page.locator("#viewer-text").textContent()).toBe("typed\n");
    await type(page, "cat typed.txt");
    await page.waitForFunction(() => (document.getElementById("terminal")?.innerText.match(/typed/g) ?? []).length >= 3);
    await page.close();
  });

  it("PI1.3 with the artifact runtime's sample capability, Claude is the worker: its tool call goes through the daemon's approval into the filesystem", async () => {
    const { page } = await open(() => {
      const replies = [
        JSON.stringify({ text: "Writing it.", toolCalls: [{ toolName: "writeFile", input: { path: "notes/claude.md", content: "from claude\n" } }] }),
        JSON.stringify({ text: "Done: notes/claude.md.", toolCalls: [] }),
      ];
      const asked: unknown[] = [];
      const sample = async (input: unknown, options: { onText?: (u: { text: string; delta: string }) => void }) => {
        asked.push(input);
        const text = replies.shift() ?? '{"text": "?"}';
        options.onText?.({ text, delta: text });
        return { text, truncated: false, modelTierApplied: "default" };
      };
      Object.assign(globalThis, { claude: { use: async (name: string) => (name === "sample" ? sample : null) }, sampled: asked });
    });
    await page.waitForFunction(() => document.getElementById("claude-pill")?.textContent === "Claude: ready");
    expect(await page.locator("#worker button[data-worker=claude]").getAttribute("aria-pressed")).toBe("true");
    await type(page, "ask write a note");
    await page.waitForFunction(() => document.getElementById("terminal")?.innerText.includes("Allow writeFile"));
    await page.keyboard.press("y");
    await page.waitForFunction(() => document.getElementById("count-turns")?.textContent === "2");
    const text = await terminalText(page);
    expect(text).toContain("Done: notes/claude.md.");
    expect(text).toContain("+ /home/user/notes/claude.md");
    const asked = await page.evaluate(() => (globalThis as unknown as { sampled: { role: string; content: string }[][] }).sampled);
    expect(asked).toHaveLength(2);
    expect(asked[0]![0]!.content).toContain("writeFile");
    expect(asked[1]!.at(-1)!.content).toContain("Tool results");
    await page.close();
  });
});
