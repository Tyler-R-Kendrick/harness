import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseCatalog } from "@harness/cognitive";
import type { Catalog } from "@harness/cognitive";
import { parseSettings } from "@harness/learning";
import { parsePluginSettings } from "@harness/learning-plugins";
import type { PluginSettings } from "@harness/learning-plugins";
import type { Settings } from "@harness/learning";

const require = createRequire(import.meta.url);

/**
 * Read and parse a catalog (catalog.json + benchmarks.json) at startup: a package's own
 * data files by default, or a directory holding tweaked copies.
 */
export function loadCatalog(from: { readonly package: "@harness/cognitive" | "@harness/memory" } | { readonly dir: string } = { package: "@harness/cognitive" }): Catalog {
  const path = (file: string) => ("dir" in from ? join(from.dir, file) : require.resolve(`${from.package}/data/${file}`));
  const read = (file: string): unknown => JSON.parse(readFileSync(path(file), "utf8"));
  return parseCatalog(read("catalog.json"), read("benchmarks.json"));
}

/** Read and parse learning's settings (thresholds and prompts) at startup: its own data file by default, or a tweaked copy. */
export function loadLearningSettings(file: string = require.resolve("@harness/learning/data/settings.json")): Settings {
  return parseSettings(JSON.parse(readFileSync(file, "utf8")));
}

/** Read and parse the learning plugins' settings (prompts, thresholds): their own data file by default, or a tweaked copy. */
export function loadPluginSettings(file: string = require.resolve("@harness/learning-plugins/data/settings.json")): PluginSettings {
  return parsePluginSettings(JSON.parse(readFileSync(file, "utf8")));
}
