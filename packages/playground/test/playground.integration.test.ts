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
let replacementCharacters = 0;

beforeAll(async () => {
  const html = await buildPlayground();
  size = html.length;
  replacementCharacters = [...html.matchAll(/\uFFFD/g)].length;
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

/** The page, with fonts and model downloads left out (no network in tests: the decision model cannot load) and its errors collected. */
async function open(init?: () => void): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com|huggingface\.co|cdn\.jsdelivr\.net/, (route) => route.abort());
  if (init) await page.addInitScript(init);
  await page.goto(origin);
  await booted(page, errors);
  return { page, errors };
}

/** Wait until the page has started: fresh (after its first turn) or restored from this browser. */
async function booted(page: Page, errors: string[] = []) {
  await page.waitForFunction(() => document.documentElement.dataset["booted"] !== undefined, undefined, { timeout: 30_000 }).catch(() => {
    throw new Error(`the playground did not boot: ${errors.join("; ")}`);
  });
}

/** How many page loads the timeline shows (host events named so). */
const pageLoads = (page: Page) => page.evaluate(() => [...document.querySelectorAll("#events summary")].filter((s) => s.textContent?.includes("page loaded")).length);

/** The keys of the playground's IndexedDB records that hold something. */
const storedKeys = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const open = indexedDB.open("harness-playground", 1);
        open.onsuccess = () => {
          const store = open.result.transaction("snapshots").objectStore("snapshots");
          const keys: string[] = [];
          store.openCursor().onsuccess = (e) => {
            const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cursor) return resolve(keys);
            if (cursor.value !== undefined) keys.push(String(cursor.key));
            cursor.continue();
          };
        };
      }),
  );

const terminalText = (page: Page) => page.locator("#terminal").innerText();

async function type(page: Page, line: string) {
  await page.locator("#terminal textarea").focus();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

describe("the playground page in Chromium", { timeout: 60_000 }, () => {
  it("PI1.1 boots in one file under the artifact size limit: the daemon runs a first turn (a template answers it) that changes a file, every panel shows it, and the harness is in its own files (AGENTS.md, an Eve agent under agent/)", async () => {
    expect(size).toBeLessThan(16 * 1024 * 1024);
    // No raw U+FFFD, which the artifact service takes for text lost in an edit.
    expect(replacementCharacters).toBe(0);
    const { page, errors } = await open();
    expect(await terminalText(page)).toContain("ran a turn through the daemon");
    expect(await page.locator("#claude-pill").textContent()).toBe("Claude: not reachable here");
    expect(await page.locator("#worker button[data-worker=claude]").isDisabled()).toBe(true);
    await page.click("#tab-files");
    expect(await page.locator("#tree").innerText()).toMatch(/~\s*todo\.md/);
    const tree = await page.locator("#tree").innerText();
    for (const file of ["run-command.md", "AGENTS.md", "agent.ts", "instructions.md", "bash.ts", "write_template.ts", "terminal.md", "show-file.sh"]) expect(tree).toContain(file);
    await type(page, "cat AGENTS.md | grep -c 'Worker: templates'");
    await page.waitForFunction(() => /\n1\s*\n/.test(document.getElementById("terminal")?.innerText ?? ""));
    await page.click("#tab-daemon");
    expect(await page.locator("#daemon").innerText()).toContain("turn.ended");
    await page.click("#tab-timeline");
    expect(Number(await page.locator("#count-timeline").textContent())).toBeGreaterThan(10);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("PI1.5 the decision model is picked for this browser (auto): headless Chromium has no WebGPU, so none fits, nothing is downloaded, and the page says why; a model named by its slug (/decide <id>) is tried anyway", async () => {
    const { page, errors } = await open();
    const requested: string[] = [];
    page.on("request", (r) => requested.push(r.url()));
    await page.waitForFunction(() => document.getElementById("decide-pill")?.getAttribute("title")?.includes("none fits"));
    expect(await page.locator("#decide-pill").textContent()).toBe("Decides: lexical");
    expect(await page.locator("#decide-pill").getAttribute("title")).toMatch(/^\/decide auto: none fits this browser \(.+: no WebGPU adapter for a \d+ MB model\); the lexical judge decides/);
    await type(page, "/decide");
    await page.waitForFunction(() => document.getElementById("terminal")?.innerText.includes("decision model: "));
    // The terminal wraps long lines: compare with the wrapping taken out. The slugs are auto, lexical, then the catalog's ids.
    const shown = (await terminalText(page)).replace(/\s+/g, "");
    expect(shown).toMatch(/auto\(oneofauto,lexical,[^)]+\)decisionmodel:nonefitsthisbrowser/);
    const slug = /auto\(oneofauto,lexical,([^,)]+)/.exec(shown)![1]!;
    expect(requested.filter((u) => u.includes("huggingface.co"))).toEqual([]);
    // Named, the model loads even though auto skipped it; here its files cannot be fetched, and the page says so.
    await type(page, `/decide ${slug}`);
    await page.waitForFunction(() => document.getElementById("decide-pill")?.getAttribute("title")?.includes("could not load"), undefined, { timeout: 30_000 });
    expect(await page.locator("#decide-pill").getAttribute("title")).toMatch(/could not load \(.+\); the lexical judge decides; named by \/decide, though auto would skip it \(no WebGPU adapter/);
    expect(requested.some((u) => u.includes("huggingface.co"))).toBe(true);
    // The template still answers, decided lexically, and the timeline says the model did not load.
    await type(page, "/ask what files are here?");
    await page.waitForFunction(() => document.getElementById("count-turns")?.textContent === "2");
    expect(await terminalText(page)).toContain("README.md");
    await page.click("#tab-timeline");
    expect(await page.locator("#events").innerText()).toContain("decision model");
    await type(page, "cat AGENTS.md | grep -c 'could not load'");
    await page.waitForFunction(() => /\n1\s*\n/.test(document.getElementById("terminal")?.innerText ?? ""));
    expect(errors).toEqual([]);
    await page.close();
  });

  it("PI1.2 a command typed in the terminal asks for approval, runs on y, and its file appears in the Files tab", async () => {
    const { page } = await open();
    await type(page, "/ask $ echo typed > typed.txt");
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

  it("PI1.4 a reload keeps the files, the sessions, the current session's log, the turns, the settings and the timeline; /reset starts over", async () => {
    const { page } = await open();
    expect(await page.evaluate(() => document.documentElement.dataset["booted"])).toBe("fresh");
    await page.locator("#approval").uncheck();
    await type(page, "echo kept > kept.txt && mkdir -p empty/dir");
    await type(page, "/ask $ echo from the agent >> kept.txt");
    await page.waitForFunction(() => document.getElementById("count-turns")?.textContent === "2");
    await type(page, "/sessions");
    await page.waitForFunction(() => /\* ses_/.test(document.getElementById("terminal")?.innerText ?? ""));
    const session = /\* (ses_\S+)/.exec(await terminalText(page))![1]!;
    const before = Number(await page.locator("#count-timeline").textContent());
    // The timeline is saved at most once a second.
    await page.waitForTimeout(1_500);

    await page.reload();
    await booted(page);
    expect(await page.evaluate(() => document.documentElement.dataset["booted"])).toBe("restored");
    const restored = await terminalText(page);
    expect(restored).toMatch(/restored from this browser: 1 session, \d+ files, 2 turns/);
    expect(restored).toContain("exit 0");
    expect(await page.locator("#count-turns").textContent()).toBe("2");
    expect(await page.locator("#approval").isChecked()).toBe(false);
    expect(restored).toMatch(/, \d+ timeline events/);
    expect(Number(await page.locator("#count-timeline").textContent())).toBeGreaterThan(before);
    expect(await pageLoads(page)).toBe(2);
    await type(page, "cat kept.txt; ls -d empty/dir");
    await type(page, "/sessions");
    // Terminal rows are padded to the terminal's width.
    await page.waitForFunction((id) => /empty\/dir\s*\n/.test(document.getElementById("terminal")?.innerText ?? "") && (document.getElementById("terminal")?.innerText ?? "").includes(`* ${id}`), session);
    const after = await terminalText(page);
    expect(after).toMatch(/kept\s*\nfrom the agent/);
    expect(after).toContain(`* ${session}`);

    expect(await storedKeys(page)).toContain(`conversation:${session}`);
    const reloaded = page.waitForEvent("load");
    await type(page, "/reset");
    await reloaded;
    await booted(page);
    expect(await page.evaluate(() => document.documentElement.dataset["booted"])).toBe("fresh");
    expect(await page.locator("#count-turns").textContent()).toBe("1");
    expect(await pageLoads(page)).toBe(1);
    expect((await storedKeys(page)).filter((k) => k.startsWith("conversation:"))).toEqual([expect.not.stringContaining(session)]);
    await type(page, "ls kept.txt");
    await page.waitForFunction(() => /No such file/i.test(document.getElementById("terminal")?.innerText ?? ""));
    await page.close();
  });

  it("PI1.3 with the artifact runtime's sample capability, Claude is not picked for you: with no template it writes one (asked first), the next like request costs no inference, and it runs as a worker only when chosen", async () => {
    const { page } = await open(() => {
      const greet = { id: "greet", description: "Greets someone by name", examples: ["say hello to Ada"], kind: "reply", body: "Hello, {{name}}!", holes: { name: { description: "who", source: "pattern", pattern: "hello to (\\w+)" } }, values: {} };
      const replies = [
        JSON.stringify({ text: JSON.stringify(greet), toolCalls: [] }),
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
      // Claude becomes reachable while the scripted first turn runs.
      const duringDemo = () =>
        new Promise((resolve) => {
          const wait = setInterval(() => {
            if (document.documentElement.dataset["demo"] === "running") {
              clearInterval(wait);
              resolve(sample);
            }
          }, 1);
        });
      Object.assign(globalThis, { claude: { use: async (name: string) => (name === "sample" ? duringDemo() : null) }, sampled: asked });
    });
    const sampled = () => page.evaluate(() => (globalThis as unknown as { sampled: unknown[] }).sampled.length);
    await page.waitForFunction(() => document.getElementById("claude-pill")?.textContent === "Claude: ready");
    expect(await page.locator("#worker button[data-worker=templates]").getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator("#worker button[data-worker=claude]").getAttribute("aria-pressed")).toBe("false");
    expect(await sampled()).toBe(0);

    await type(page, "/ask say hello to Ada");
    await page.waitForFunction(() => document.getElementById("terminal")?.innerText.includes("Spend inference to write a template"));
    await page.keyboard.press("y");
    await page.waitForFunction(() => document.getElementById("count-turns")?.textContent === "2");
    expect(await terminalText(page)).toContain("Hello, Ada!");
    expect(await terminalText(page)).toContain("+ /home/user/agent/templates/greet.md");
    expect(await sampled()).toBe(1);

    await type(page, "/ask say hello to Grace");
    await page.waitForFunction(() => document.getElementById("count-turns")?.textContent === "3");
    expect(await terminalText(page)).toContain("Hello, Grace!");
    expect(await sampled()).toBe(1);

    await type(page, "/worker claude");
    await type(page, "/ask write a note");
    await page.waitForFunction(() => document.getElementById("terminal")?.innerText.includes("Allow writeFile"));
    await page.keyboard.press("y");
    await page.waitForFunction(() => document.getElementById("count-turns")?.textContent === "4");
    const text = await terminalText(page);
    expect(text).toContain("Done: notes/claude.md.");
    expect(text).toContain("+ /home/user/notes/claude.md");
    const asked = await page.evaluate(() => (globalThis as unknown as { sampled: { role: string; content: string }[][] }).sampled);
    expect(asked).toHaveLength(3);
    expect(asked[1]![0]!.content).toContain("writeFile");
    expect(asked[2]!.at(-1)!.content).toContain("Tool results");
    await page.close();
  });
});
