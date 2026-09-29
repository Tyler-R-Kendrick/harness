import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyProposal, ProposalSchema } from "@harness/evolution";
import { buildSurface, evolutionConfigJsonSchema, isTextDocument, parseEvolutionConfig, readDocuments, textCheck } from "../src/evolution-config.ts";

const file = JSON.parse(readFileSync(new URL("../data/evolution.example.json", import.meta.url), "utf8")) as Record<string, unknown>;

describe("evolution config (data/evolution.example.json)", () => {
  it("EH1.1 the example config parses, and names its JSON Schema, which is generated from the parser", async () => {
    const c = parseEvolutionConfig(file);
    expect(Object.keys(c.documents)).toEqual(["dialogue", "instructions"]);
    expect(c.evaluator.concurrency).toBe(2);
    expect(file["$schema"]).toBe("./evolution.schema.json");
    await expect(`${JSON.stringify(evolutionConfigJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/evolution.schema.json");
  });

  it("EH1.2 a minimal config takes the defaults: no structural components, no rules, a ten-minute evaluator with two at once", () => {
    const c = parseEvolutionConfig({ documents: { a: { path: "a.json" } }, components: ["prompt", "config"], tasks: { evolve: [{ id: "t1", text: "x" }] }, evaluator: { command: ["node"] } });
    expect(c.structural).toEqual([]);
    expect(c.classify).toEqual({ rules: [] });
    expect(c.evaluator).toEqual({ command: ["node"], timeoutMs: 600_000, concurrency: 2 });
  });

  it("EH1.3 configs that cannot be right are refused, naming where", () => {
    const edit = (path: readonly (string | number)[], value: unknown) => {
      const s = structuredClone(file);
      let o: Record<string | number, unknown> = s;
      for (const key of path.slice(0, -1)) o = o[key] as Record<string | number, unknown>;
      o[path.at(-1)!] = value;
      return () => parseEvolutionConfig(s);
    };
    expect(edit(["documents"], {})).toThrow(/at least one document/);
    expect(edit(["structural"], ["skill"])).toThrow(/structural components must be components: skill/);
    expect(edit(["classify", "rules", 0, "component"], "nope")).toThrow(/classify\.rules\[0\]\.component/);
    expect(edit(["classify", "rules", 0, "document"], "absent")).toThrow(/not a document: absent/);
    expect(edit(["classify", "fallback"], "nope")).toThrow(/classify\.fallback/);
    expect(edit(["classify", "rules", 0, "prefix"], "draft")).toThrow(/JSON Pointer/);
    expect(edit(["tasks", "holdout"], [{ id: "booking-1", text: "again" }])).toThrow(/unique across the evolve set and the holdout: booking-1/);
    expect(edit(["tasks", "evolve"], [])).toThrow(/tasks\.evolve/);
    expect(edit(["evaluator", "command"], [])).toThrow(/evaluator\.command/);
    expect(edit(["evaluator", "concurrency"], 0)).toThrow(/evaluator\.concurrency/);
    expect(edit(["extra"], 1)).toThrow(/extra/);
  });
});

// ---- text documents ------------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "evo-cfg-"));
  dirs.push(d);
  return d;
};

const base = { components: ["prompt", "config", "skill"], tasks: { evolve: [{ id: "t1", text: "x" }] }, evaluator: { command: ["node"] } };
const withDoc = (doc: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ ...base, documents: { code: doc }, ...extra });
const NODE = process.execPath;

describe("text documents in the config (kind: text)", () => {
  it("EH11.1 a text document names its file, and optionally its component, regions and check, with the check's limit defaulted; a JSON document may say kind json", () => {
    const code = { kind: "text", path: "agent.py", component: "skill", regions: [{ pattern: "^def ", component: "config" }], check: { command: ["python3", "-c", "1"] } };
    const c = parseEvolutionConfig({ ...base, documents: { code, data: { kind: "json", path: "d.json" }, bare: { path: "b.json" } } });
    expect(c.documents["code"]).toEqual({ kind: "text", path: "agent.py", component: "skill", regions: [{ pattern: "^def ", component: "config" }], check: { command: ["python3", "-c", "1"], timeoutMs: 10_000 } });
    expect(c.documents["data"]).toEqual({ kind: "json", path: "d.json" });
    expect(c.documents["bare"]).toEqual({ path: "b.json" });
    expect(parseEvolutionConfig(withDoc({ kind: "text", path: "notes.md" })).documents["code"]).toEqual({ kind: "text", path: "notes.md", regions: [] });
  });

  it("EH11.2 a text document that cannot be right is refused, naming where", () => {
    // A refusal names the problem and, below it, where it is.
    const refused = (doc: Record<string, unknown>, problem: string, at: string, components?: string[]) =>
      expect(() => parseEvolutionConfig(withDoc({ kind: "text", path: "a.py", ...doc }, components ? { components } : {})), JSON.stringify(doc)).toThrow(new RegExp(`${problem}\\n\\s+→ at ${at.replaceAll(".", "\\.").replaceAll("[", "\\[").replaceAll("]", "\\]")}`));
    refused({ schema: "s.json" }, 'Unrecognized key: "schema"', "documents.code");
    refused({ component: "nope" }, "not one of the components: nope", "documents.code.component");
    refused({ regions: [{ pattern: "x", component: "nope" }] }, "not one of the components: nope", "documents.code.regions[0].component");
    refused({ regions: [{ pattern: "(", component: "skill" }] }, "not a regular expression: Invalid regular expression: /\\(/: Unterminated group", "documents.code.regions[0].pattern");
    refused({ regions: [{ pattern: "(a+)+", component: "skill" }] }, "can take exponential time: \\(a\\+\\)\\+", "documents.code.regions[0].pattern");
    refused({ regions: [{ pattern: "", component: "skill" }] }, "Too small[^\\n]*", "documents.code.regions[0].pattern");
    refused({ check: { command: [] } }, "Too small[^\\n]*", "documents.code.check.command");
    refused({ check: { command: ["x"], timeoutMs: 0 } }, "Too small[^\\n]*", "documents.code.check.timeoutMs");
    refused({ check: { command: ["x"], extra: 1 } }, 'Unrecognized key: "extra"', "documents.code.check");
    refused({ path: "" }, "Too small[^\\n]*", "documents.code.path");
    refused({}, "a text document without a component is a prompt, which is not one of the components", "documents.code.component", ["config", "skill"]);
    expect(() => parseEvolutionConfig(withDoc({ kind: "banana", path: "a" }))).toThrow(/Invalid discriminator value[\s\S]*kind/);
    expect(() => parseEvolutionConfig(withDoc({ path: "a.json", regions: [] }))).toThrow(/regions/);
    expect(() => parseEvolutionConfig(withDoc({ path: "a.json", check: { command: ["x"] } }))).toThrow(/check/);
    // A component named for the document is enough when there is no prompt component.
    expect(parseEvolutionConfig(withDoc({ kind: "text", path: "a.py", component: "skill" }, { components: ["config", "skill"] })).documents["code"]).toMatchObject({ component: "skill" });
  });

  it("EH11.3 the file is read as raw text, verbatim: trailing newline, CRLF and a byte order mark kept, JSON never parsed; a file that is not UTF-8 is refused", () => {
    const dir = tmp();
    writeFileSync(join(dir, "code.py"), "a = 1\r\nb = 2\r\n");
    writeFileSync(join(dir, "bom.md"), "\uFEFFnotes\n\n");
    writeFileSync(join(dir, "data.json"), '{"x": 1}\n');
    writeFileSync(join(dir, "json-as-text.json"), '{"x": 1}');
    writeFileSync(join(dir, "binary.bin"), Buffer.from([0x61, 0xff, 0xfe]));
    const config = (documents: Record<string, unknown>) => ({ config: parseEvolutionConfig({ ...base, documents }), dir });
    const loaded = config({ code: { kind: "text", path: "code.py" }, bom: { kind: "text", path: "bom.md" }, data: { path: "data.json" }, raw: { kind: "text", path: "json-as-text.json" } });
    expect(readDocuments(loaded)).toEqual({ code: "a = 1\r\nb = 2\r\n", bom: "\uFEFFnotes\n\n", data: { x: 1 }, raw: '{"x": 1}' });
    expect(isTextDocument(loaded, "code")).toBe(true);
    expect(isTextDocument(loaded, "data")).toBe(false);
    expect(() => readDocuments(config({ b: { kind: "text", path: "binary.bin" } }))).toThrow(/document b .*binary\.bin is not UTF-8 text/);
    expect(() => readDocuments(config({ b: { kind: "text", path: "absent.txt" } }))).toThrow(/cannot read document b .*absent\.txt/);
  });

  it("EH11.4 a changed region belongs to the component of the first region whose pattern matches its old or its new text, else the document's component", () => {
    const dir = tmp();
    const source = "import os\n\ndef plan(task):\n    return think(task)\n\nSYSTEM = 'be careful'\nLIMIT = 3\n";
    writeFileSync(join(dir, "agent.py"), source);
    const config = parseEvolutionConfig({
      ...base,
      documents: { code: { kind: "text", path: "agent.py", component: "prompt", regions: [{ pattern: "^def |\\bthink\\(", component: "skill" }, { pattern: "LIMIT", component: "config" }, { pattern: "def", component: "prompt" }] } },
    });
    const loaded = { config, dir };
    const surface = buildSurface(loaded);
    const documents = readDocuments(loaded);
    const components = (old: string, replacement: string) => {
      const r = applyProposal(surface, documents, ProposalSchema.parse({ summary: "s", edits: [{ id: "e", hypothesis: "h", targets: "t", ops: [{ op: "edit", document: "code", old, new: replacement }] }] }), 1);
      if (r.kind !== "applied") throw new Error(r.problems.join("; "));
      return r.edits[0]!.components;
    };
    // The old text matches the first region; the second region is not consulted.
    expect(components("def plan(task):", "def plan(task, depth):")).toEqual(["skill"]);
    // Only the new text matches: still that region.
    expect(components("    return think(task)", "    return act(task)")).toEqual(["skill"]);
    expect(components("    return think(task)", "    return act(think(task))")).toEqual(["skill"]);
    // Two regions could match (LIMIT, and the later def): the first in the list wins.
    expect(components("LIMIT = 3", "LIMIT = 4")).toEqual(["config"]);
    // Matched by the new text only.
    expect(components("SYSTEM = 'be careful'", "SYSTEM = 'be careful; LIMIT'")).toEqual(["config"]);
    // No region matches: the document's component.
    expect(components("SYSTEM = 'be careful'", "SYSTEM = 'be very careful'")).toEqual(["prompt"]);
    // The pattern is not anchored to the whole text: ^ is the start of the region.
    expect(components("import os", "import os, sys")).toEqual(["prompt"]);
  });

  it("EH11.5 without regions or a component, text is a prompt; with a component and no regions, that component", () => {
    const dir = tmp();
    writeFileSync(join(dir, "n.md"), "alpha\nbeta\n");
    const components = (doc: Record<string, unknown>) => {
      const loaded = { config: parseEvolutionConfig({ ...base, documents: { n: { kind: "text", path: "n.md", ...doc } } }), dir };
      const r = applyProposal(buildSurface(loaded), readDocuments(loaded), ProposalSchema.parse({ summary: "s", edits: [{ id: "e", hypothesis: "h", targets: "t", ops: [{ op: "edit", document: "n", old: "beta", new: "gamma" }] }] }), 1);
      if (r.kind !== "applied") throw new Error(r.problems.join("; "));
      return r.edits[0]!.components;
    };
    expect(components({})).toEqual(["prompt"]);
    expect(components({ component: "config" })).toEqual(["config"]);
  });
});

describe("a text document's check command (run synchronously: the surface's check is)", () => {
  const check = (script: string, options: { timeoutMs?: number; cwd?: string } = {}) => textCheck({ command: [NODE, "-e", script], timeoutMs: options.timeoutMs ?? 10_000, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) }, tmp());

  it("EH11.6 the text is on stdin; exit 0 is fine (undefined), whatever it prints", () => {
    const run = check(`let s = require("fs").readFileSync(0, "utf8"); if (s !== "a\\r\\nb\\n") { console.error("got " + JSON.stringify(s)); process.exit(1) } console.log("ok"); console.error("noise")`);
    expect(run("a\r\nb\n")).toBeUndefined();
    expect(run("other")).toBe('got "other"');
  });

  it("EH11.7 a nonzero exit is a problem: the first line of stderr, trimmed; without stderr, the exit code; a long line is cut", () => {
    expect(check(`console.error("\\n  SyntaxError: unexpected token  \\r\\nsecond line"); process.exit(2)`)("x")).toBe("SyntaxError: unexpected token");
    expect(check(`process.exit(3)`)("x")).toBe("the check exited with code 3");
    expect(check(`process.kill(process.pid, "SIGKILL")`)("x")).toBe("the check was stopped by signal SIGKILL");
    expect(check(`console.error("e".repeat(1000)); process.exit(1)`)("x")).toBe(`${"e".repeat(300)}...`);
    expect(check(`console.error("e".repeat(300)); process.exit(1)`)("x")).toBe("e".repeat(300));
  });

  it("EH11.8 a check that takes longer than its limit is stopped and is a problem, naming the limit", () => {
    const started = Date.now();
    expect(check(`setTimeout(() => {}, 60000)`, { timeoutMs: 300 })("x")).toBe("the check took longer than 300 ms and was stopped");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("EH11.9 output past the bound stops the check: it is a problem, not unbounded memory", () => {
    expect(check(`process.stderr.write("x".repeat(2 * 1024 * 1024)); setTimeout(() => {}, 60000)`)("x")).toBe("the check wrote more than 65536 bytes and was stopped");
  });

  it("EH11.10 a check that cannot start is the host's failure, not the candidate's: it throws", () => {
    const run = textCheck({ command: ["/no/such/check"], timeoutMs: 1000 }, tmp());
    expect(() => run("x")).toThrow(/cannot start the check \/no\/such\/check: /);
  });

  it("EH11.11 a check that exits before reading its input is reported by its exit code, however large the text", () => {
    expect(check(`process.exit(4)`)("y".repeat(5 * 1024 * 1024))).toBe("the check exited with code 4");
  });

  it("EH11.12 the check runs in the config's directory, or in the cwd it names", () => {
    const dir = tmp();
    const where = (cwd?: string) => textCheck({ command: [NODE, "-e", `console.error(process.cwd()); process.exit(1)`], timeoutMs: 5000, ...(cwd === undefined ? {} : { cwd }) }, dir)("x");
    expect(where()).toBe(realpathSync(dir));
    mkdirSync(join(dir, "sub"));
    expect(where("sub")).toBe(realpathSync(join(dir, "sub")));
  });

  it("EH11.13 buildSurface wires the check to the document: a candidate that fails it is refused with its problem, and a passing one applies", () => {
    const dir = tmp();
    writeFileSync(join(dir, "code.txt"), "ok = 1\n");
    const config = parseEvolutionConfig({ ...base, documents: { code: { kind: "text", path: "code.txt", check: { command: [NODE, "-e", `const s = require("fs").readFileSync(0, "utf8"); if (s.includes("BROKEN")) { console.error("line 1: BROKEN\\nmore"); process.exit(1) }`] } } } });
    const loaded = { config, dir };
    const surface = buildSurface(loaded);
    const documents = readDocuments(loaded);
    const apply = (replacement: string) => applyProposal(surface, documents, ProposalSchema.parse({ summary: "s", edits: [{ id: "e", hypothesis: "h", targets: "t", ops: [{ op: "edit", document: "code", old: "ok = 1", new: replacement }] }] }), 1);
    expect(apply("ok = 2")).toMatchObject({ kind: "applied" });
    expect(apply("BROKEN")).toEqual({ kind: "refused", problems: ["code fails its check: line 1: BROKEN"] });
  });
});
