#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parseArgs } from "node:util";
import type { JSONValue } from "@ai-sdk/provider";
import { parseBook } from "@harness/dialogue";
import { importDialogue, isDialogueFile } from "@harness/dialogue-standards";
import { FileStorage } from "./file-storage.ts";
import { WorkflowFiles } from "./workflow-files.ts";

// harness-dialogue import <file or directory>... --book <book.json> --name <name>
//   [--entry] [--pattern <regex>]... [--flows <dir>] [--option key=value]...
// Imports a VoiceXML application (.vxml, with its .grxml/.gram grammars) or an AIML bot
// (.aiml, with its sets, maps, properties and substitutions) into a script book: the
// files become one of the book's documents, and the flow that runs it goes to the flows
// directory: by default next to the book, where `harness --dialogue` looks; when the daemon
// runs with --workflows <dir>, its flows are that library's, so pass --flows <dir> too.
// --entry makes it the flow every session starts in; --pattern adds (or replaces) a script
// that starts it. In a directory, only the files a standard reads are taken.
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    book: { type: "string" },
    name: { type: "string" },
    flows: { type: "string" },
    entry: { type: "boolean", default: false },
    pattern: { type: "string", multiple: true },
    option: { type: "string", multiple: true },
  },
});
const [command, ...sources] = positionals;
if (command !== "import" || sources.length === 0 || values.book === undefined || values.name === undefined) {
  process.stderr.write(
    "usage: harness-dialogue import <file or directory>... --book <book.json> --name <name> [--entry] [--pattern <regex>]... [--flows <dir>] [--option key=value]...\n" +
      "  --flows <dir>  where the flow goes: the daemon's --dialogue-flows (by default <book>.flows), or its --workflows directory when it runs with one\n",
  );
  process.exit(2);
}

/**
 * Files by the name documents refer to them by: a directory's relative to it, a file's by
 * its base name. A directory's files a standard does not read (a README, audio) are left
 * out, and named.
 */
function read(sourceList: readonly string[]): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string, root: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const name = relative(root, path).split("\\").join("/");
      if (statSync(path).isDirectory()) walk(path, root);
      else if (isDialogueFile(name)) files[name] = readFileSync(path, "utf8");
      else process.stderr.write(`skipped ${path}: not a file a dialogue standard reads\n`);
    }
  };
  for (const source of sourceList) {
    if (statSync(source).isDirectory()) walk(source, source);
    else files[basename(source)] = readFileSync(source, "utf8");
  }
  return files;
}

const options: Record<string, JSONValue> = {};
for (const pair of values.option ?? []) {
  const at = pair.indexOf("=");
  if (at < 1) {
    process.stderr.write(`--option takes key=value, not "${pair}"\n`);
    process.exit(2);
  }
  options[pair.slice(0, at)] = pair.slice(at + 1);
}

try {
  const { document, flow, warnings } = importDialogue({ name: values.name, files: read(sources), options });
  const storage = new FileStorage(values.book);
  const book = existsSync(values.book) ? ((await storage.load()) as Record<string, unknown>) : { scripts: [] };
  // A script of the document's name is replaced only by a new one (--pattern): importing again keeps it.
  const trigger = values.pattern === undefined ? [] : [{ id: document.name, intent: `Start ${document.name}`, patterns: values.pattern, reply: [{ flow: document.name }] }];
  const scripts = ((book["scripts"] ?? []) as { id: string }[]).filter((s) => trigger.length === 0 || s.id !== document.name);
  const next = {
    ...book,
    ...(values.entry ? { entry: document.name } : {}),
    documents: [...((book["documents"] ?? []) as { name: string }[]).filter((d) => d.name !== document.name), document],
    scripts: [...scripts, ...trigger],
  };
  parseBook(next);
  await storage.save(next);
  await new WorkflowFiles(values.flows ?? `${values.book}.flows`).put(flow);
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
  process.stdout.write(`imported ${document.type} ${document.name} (${Object.keys(document.files).length} files) into ${values.book}\n`);
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
