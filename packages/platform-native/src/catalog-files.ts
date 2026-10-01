import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parseCatalog } from "@harness/cognitive";
import type { Catalog } from "@harness/cognitive";
import { parseSettings as parseDialogueSettings } from "@harness/dialogue";
import type { Settings as DialogueSettings } from "@harness/dialogue";
import { parseSettings as parseEvolutionSettings } from "@harness/evolution";
import type { Settings as EvolutionSettings } from "@harness/evolution";
import { parseSettings } from "@harness/learning";
import { parsePluginSettings } from "@harness/learning-plugins";
import type { PluginSettings } from "@harness/learning-plugins";
import type { Settings } from "@harness/learning";
import { parseCompositionSettings, parsePolicy, parseResolver, parseSettings as parseProceduralSettings, parseTaskSuite, parseToolDeclarations } from "@harness/procedural";
import type { AccessPolicy, CompositionSettings, Resolver, Settings as ProceduralSettings, TaskSuite, ToolDeclarations } from "@harness/procedural";

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

/** The builtin script book: fixed replies, templates whose holes the chat model fills, and the default AIML chat and VoiceXML menu. */
export function loadBuiltinBook(file: string = require.resolve("@harness/dialogue/data/builtin.json")): unknown {
  const book = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!isRecord(book)) return book;
  const have = new Set(listedDocuments(book).map((document) => document.name));
  const documents = [...builtinDocuments(dirname(file)).filter((document) => !have.has(document.name)).map((document) => document.raw), ...listedDocuments(book).map((document) => document.raw)];
  const entry = typeof book["entry"] === "string" ? book["entry"] : "harness-chat";
  return { ...book, entry, documents };
}

/** The shipped chat and menu, read from beside the book so the AIML and VoiceXML stay the files the standards edit. */
function builtinDocuments(dir: string): { name: string; raw: unknown }[] {
  const chat = readFileSync(join(dir, "builtin", "harness-chat.aiml"), "utf8");
  const menu = readFileSync(join(dir, "builtin", "harness-menu.vxml"), "utf8");
  return [
    { name: "harness-chat", raw: { name: "harness-chat", type: "aiml", files: { "harness-chat.aiml": chat } } },
    { name: "harness-menu", raw: { name: "harness-menu", type: "voicexml", files: { "harness-menu.vxml": menu }, options: { nomatch: "reprompt" } } },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listedScripts(book: unknown): { id: string; raw: unknown }[] {
  if (!isRecord(book) || !Array.isArray(book["scripts"])) return [];
  return book["scripts"].flatMap((script) => {
    if (!isRecord(script) || typeof script["id"] !== "string") return [];
    return [{ id: script["id"], raw: script }];
  });
}

/**
 * `book` laid over the builtin book. Scripts and documents in `book` follow the builtin
 * ones, and a shared id or document name keeps the one from `book`. No book is the builtin
 * book itself. A book with no entry uses the builtin chat.
 */
export function withBuiltinBook(book: unknown): unknown {
  const builtin = loadBuiltinBook();
  if (book === undefined) return builtin;
  const ids = new Set(listedScripts(book).map((script) => script.id));
  const scripts = [...listedScripts(builtin).filter((script) => !ids.has(script.id)).map((script) => script.raw), ...listedScripts(book).map((script) => script.raw)];
  const names = new Set(listedDocuments(book).map((document) => document.name));
  const documents = [...listedDocuments(builtin).filter((document) => !names.has(document.name)).map((document) => document.raw), ...listedDocuments(book).map((document) => document.raw)];
  const entry = isRecord(book) && typeof book["entry"] === "string" ? book["entry"] : isRecord(builtin) && typeof builtin["entry"] === "string" ? builtin["entry"] : undefined;
  return { ...(isRecord(book) ? book : {}), scripts, documents, ...(entry === undefined ? {} : { entry }) };
}

function listedDocuments(book: unknown): { name: string; raw: unknown }[] {
  if (!isRecord(book) || !Array.isArray(book["documents"])) return [];
  return book["documents"].flatMap((document) => {
    if (!isRecord(document) || typeof document["name"] !== "string") return [];
    return [{ name: document["name"], raw: document }];
  });
}

/** Read and parse the evolution settings (rounds, selection rule, the proposer's prompt): its own data file by default, or a tweaked copy. */
export function loadEvolutionSettings(file: string = require.resolve("@harness/evolution/data/settings.json")): EvolutionSettings {
  return parseEvolutionSettings(JSON.parse(readFileSync(file, "utf8")));
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

/** Read and parse what a deployment declares about its session tools (which are free of side effects) at startup: procedural's own data file (none) by default, or a deployment's. */
export function loadProceduralTools(file: string = require.resolve("@harness/procedural/data/tools.json")): ToolDeclarations {
  return parseToolDeclarations(JSON.parse(readFileSync(file, "utf8")));
}

/** Read and parse a procedural access policy (who may read, write, dream, revert or import which graph). */
export function loadProceduralPolicy(file: string): AccessPolicy {
  return parsePolicy(JSON.parse(readFileSync(file, "utf8")));
}

/** Read and parse a user's task suite (tasks, scorer, tools; see procedural's data/task-suite.schema.json), dream's evaluator. */
export function loadTaskSuite(file: string): TaskSuite {
  return parseTaskSuite(JSON.parse(readFileSync(file, "utf8")));
}
