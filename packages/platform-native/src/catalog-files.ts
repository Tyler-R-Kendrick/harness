import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseCatalog } from "@harness/cognitive";
import type { Catalog } from "@harness/cognitive";
import { parseSettings as parseDialogueSettings } from "@harness/dialogue";
import type { Settings as DialogueSettings } from "@harness/dialogue";
import { parseSettings } from "@harness/learning";
import { parsePluginSettings } from "@harness/learning-plugins";
import type { PluginSettings } from "@harness/learning-plugins";
import type { Settings } from "@harness/learning";
import { parseCompositionSettings, parsePolicy, parseResolver, parseSettings as parseProceduralSettings, parseTaskSuite } from "@harness/procedural";
import type { AccessPolicy, CompositionSettings, Resolver, Settings as ProceduralSettings, TaskSuite } from "@harness/procedural";

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

/** Read and parse the dialogue's settings (thresholds, the drafter's prompt): its own data file by default, or a tweaked copy. */
export function loadDialogueSettings(file: string = require.resolve("@harness/dialogue/data/settings.json")): DialogueSettings {
  return parseDialogueSettings(JSON.parse(readFileSync(file, "utf8")));
}

/** Read and parse procedural graphs' settings (presets, decoding, prompts) at startup: its own data file by default, or a tweaked copy. */
export function loadProceduralSettings(file: string = require.resolve("@harness/procedural/data/settings.json")): ProceduralSettings {
  return parseProceduralSettings(JSON.parse(readFileSync(file, "utf8")));
}

/** Read and parse the procedural resolver (which graph a session uses) at startup: procedural's own data file by default, or a deployment's. */
export function loadProceduralResolver(file: string = require.resolve("@harness/procedural/data/resolver.json")): Resolver {
  return parseResolver(JSON.parse(readFileSync(file, "utf8")));
}

/** Read and parse dream's composition settings (which paths compile into workflows) at startup: procedural's own data file by default, or a deployment's. */
export function loadProceduralComposition(file: string = require.resolve("@harness/procedural/data/composition.json")): CompositionSettings {
  return parseCompositionSettings(JSON.parse(readFileSync(file, "utf8")));
}

/** Read and parse a procedural access policy (who may read, write, dream, revert or import which graph). */
export function loadProceduralPolicy(file: string): AccessPolicy {
  return parsePolicy(JSON.parse(readFileSync(file, "utf8")));
}

/** Read and parse a user's task suite (tasks, scorer, tools; see procedural's data/task-suite.schema.json), dream's evaluator. */
export function loadTaskSuite(file: string): TaskSuite {
  return parseTaskSuite(JSON.parse(readFileSync(file, "utf8")));
}
