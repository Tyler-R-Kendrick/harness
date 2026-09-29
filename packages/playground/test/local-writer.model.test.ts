import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { Bash } from "just-bash";
import { parseCatalog } from "@harness/cognitive";
import { buildNativeEnsemble } from "@harness/platform-native";
import { modelCacheDir } from "../../platform-native/test/models-env.ts";
import { lexicalDecider } from "../src/decide.ts";
import { TemplateEngine } from "../src/engine.ts";
import { parseEngineSettings } from "../src/engine-settings.ts";
import { rankGenerators } from "../src/generator-model.ts";
import { TEMPLATES, TemplateStore } from "../src/templates.ts";
import { HOME } from "../src/vfs.ts";

// The page's local generator (the catalog's best local generator for a browser, picked by
// rank, not by name) writing templates through the engine on real weights, natively. Its
// answers are held to the bounded schema, so every one is a template; a template that
// leaves a hole without a value, repeats one already kept, or whose script fails on a copy of the files, is refused
// and is answered by the local model itself (the page never sends it to Claude unless named). MEASURE_OUT keeps each outcome.

const data = (file: string) => JSON.parse(readFileSync(new URL(`../../cognitive/data/${file}`, import.meta.url), "utf8")) as unknown;
const catalog = parseCatalog(data("catalog.json"), data("benchmarks.json"));
const settings = parseEngineSettings(JSON.parse(readFileSync(new URL("../data/templates.json", import.meta.url), "utf8")));
const seedDir = new URL("../data/templates/", import.meta.url);
const SEEDS = Object.fromEntries(readdirSync(seedDir).map((f) => [`${TEMPLATES}/${f}`, readFileSync(new URL(f, seedDir), "utf8")]));
const FILES = { [`${HOME}/README.md`]: "# hello\nworld\n", ...SEEDS };
const REQUESTS = ["write a haiku about the sea", "tell me a joke", "how many files are here?", "what's 17 times 23?", "translate hello into French", "greet me, my name is Sam", "what time is it?", "count the lines in README.md"];

const model = rankGenerators(catalog)[0]!;
const host = buildNativeEnsemble({ cacheDir: modelCacheDir, allowHosted: false, catalog: { models: [model], preferences: {} } });
afterAll(() => host.close());

describe(`the page's local generator writing templates (${model.runtime})`, () => {
  it("LW1.1 every answer is a template under the bounded schema; one the trial refuses says why, and one it keeps is a file whose script runs", async () => {
    const generator = (await host.ensemble.resolve("structured-extraction", "generator")).port as LanguageModelV4;
    for (const request of REQUESTS) {
      const bash = new Bash({ cwd: HOME, files: FILES });
      const store = new TemplateStore(bash.fs, { retireMargin: settings.curation.retireMargin });
      const engine = new TemplateEngine({
        store,
        settings,
        facts: { cwd: () => HOME, files: () => "README.md", date: () => "Monday, September 28, 2026" },
        deciders: () => [lexicalDecider(settings.lexical)],
        generators: () => [generator],
        generation: () => "auto",
        trial: (script) => new Bash({ cwd: HOME, files: FILES }).exec(script, { cwd: HOME }),
      });
      const started = performance.now();
      const write = engine.tools()["write_template"]!.execute as (input: object, options: object) => Promise<{ id?: string; error?: string }>;
      const out = await write({ request }, { toolCallId: "w", messages: [] });
      const kept = out.id === undefined ? undefined : await store.get(out.id);
      if (process.env["MEASURE_OUT"]) appendFileSync(process.env["MEASURE_OUT"], `\n=== ${request} (${Math.round(performance.now() - started)} ms) ${JSON.stringify(out)}\n${kept ? `${kept.kind}: ${kept.body}` : ""}\n`);
      if (kept) expect(kept.origin).toBe(`generated:${generator.provider}/${generator.modelId}`);
      else expect(out.error).toMatch(/without a value|failed on a copy of the files|repeats/);
    }
  });
});
