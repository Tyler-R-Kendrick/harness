import { describe, expect, it } from "vitest";
import { Bash } from "just-bash";
import { parseTemplate, templateFile, TemplateStore, TEMPLATES } from "../src/templates.ts";
import { HOME } from "../src/vfs.ts";

const LIST = `---
description: Lists the files in the working directory
examples:
  - what files are here?
holes:
  files:
    description: the files, one per line
    source: fact
---
Files in {{cwd}}:
{{files}}
`;

describe("reply templates as files", () => {
  it("TP1.1 a template file is YAML frontmatter and a body whose {{holes}} become a template constraint; defaults fill the rest", () => {
    const t = parseTemplate("list-files", LIST);
    expect(t).toMatchObject({ id: "list-files", kind: "reply", description: "Lists the files in the working directory", examples: ["what files are here?"], helpful: 0, harmful: 0, version: 1, origin: "written" });
    expect(t.constraint.parts).toEqual(["Files in ", { hole: "cwd" }, ":\n", { hole: "files" }, "\n"]);
    expect(t.holes["files"]).toEqual({ description: "the files, one per line", source: "fact" });
  });

  it("TP1.2 writing a template and parsing it back gives the same template", () => {
    const t = parseTemplate("list-files", LIST);
    expect(parseTemplate("list-files", templateFile(t))).toEqual(t);
  });

  it("TP1.3 a file that is not a template says why: no frontmatter, a bad field, holes next to each other, a hole with nothing to fill it from, a bad id", () => {
    expect(() => parseTemplate("x", "just text")).toThrow(/frontmatter/);
    expect(() => parseTemplate("x", "---\nkind: poem\ndescription: d\n---\nbody")).toThrow(/kind/);
    expect(() => parseTemplate("x", "---\ndescription: d\n---\n{{a}}{{b}}")).toThrow(/next to each other/);
    expect(() => parseTemplate("x", "---\ndescription: d\nholes:\n  a: { description: a, source: pattern }\n---\n{{a}}")).toThrow(/pattern/);
    expect(() => parseTemplate("x", "---\ndescription: d\nholes:\n  a: { description: a, source: choice }\n---\n{{a}}")).toThrow(/options/);
    expect(() => parseTemplate("Not An Id", LIST)).toThrow(/id/);
    expect(() => parseTemplate("none", LIST)).toThrow(/not none/);
    expect(() => parseTemplate("x", "---\n[unclosed\n---\nbody")).toThrow();
  });
});

describe("the seed templates (data/templates)", () => {
  it("TP3.1 every seed is a template, from a seed", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL("../data/templates/", import.meta.url);
    const seeds = readdirSync(dir).map((f) => parseTemplate(f.replace(/\.md$/, ""), readFileSync(new URL(f, dir), "utf8")));
    expect(seeds.map((t) => t.id).sort()).toEqual(["help", "list-files", "run-command", "show-file", "today"]);
    for (const t of seeds) expect(t.origin).toBe("seed");
  });
});

describe("the template store: files under ~/agent/templates", () => {
  it("TP2.1 lists the templates in the directory (none when it is missing), naming files that are not templates rather than failing", async () => {
    const bash = new Bash({ cwd: HOME, files: { [`${TEMPLATES}/list-files.md`]: LIST, [`${TEMPLATES}/broken.md`]: "no frontmatter", [`${TEMPLATES}/notes.txt`]: "ignored" } });
    const store = new TemplateStore(bash.fs);
    const { templates, problems } = await store.list();
    expect(templates.map((t) => t.id)).toEqual(["list-files"]);
    expect(problems).toEqual([{ path: `${TEMPLATES}/broken.md`, error: expect.stringMatching(/frontmatter/) }]);
    expect(await new TemplateStore(new Bash({ files: {} }).fs).list()).toEqual({ templates: [], problems: [] });
  });

  it("TP2.2 put writes a template; putting one that exists keeps the old version under .history and counts the version up", async () => {
    const bash = new Bash({ cwd: HOME });
    const store = new TemplateStore(bash.fs);
    const first = await store.put({ ...parseTemplate("greet", "---\ndescription: Greets\n---\nHello, {{name}}.\n"), origin: "generated:test" });
    expect(await bash.readFile(`${TEMPLATES}/greet.md`)).toContain("Hello, {{name}}.");
    const second = await store.put({ ...first, body: "Hi, {{name}}!\n" });
    expect(second.version).toBe(2);
    expect(await bash.readFile(`${TEMPLATES}/.history/greet.v1.md`)).toContain("Hello, {{name}}.");
    expect((await store.get("greet"))?.constraint.parts).toEqual(["Hi, ", { hole: "name" }, "!\n"]);
    expect(await store.get("missing")).toBeUndefined();
  });

  it("TP2.3 feedback counts on the file; a template harmful by the margin retires to retired/, out of the list", async () => {
    const bash = new Bash({ cwd: HOME, files: { [`${TEMPLATES}/list-files.md`]: LIST } });
    const store = new TemplateStore(bash.fs, { retireMargin: 2 });
    expect(await store.feedback("list-files", "helpful")).toMatchObject({ helpful: 1, retired: false });
    expect(await store.feedback("list-files", "harmful", "too terse")).toMatchObject({ harmful: 1, refine: "too terse", retired: false });
    expect(await store.feedback("list-files", "harmful")).toMatchObject({ harmful: 2, retired: false });
    expect(await store.feedback("list-files", "harmful")).toMatchObject({ harmful: 3, retired: true });
    expect((await store.list()).templates).toEqual([]);
    expect(await bash.fs.exists(`${TEMPLATES}/retired/list-files.md`)).toBe(true);
    await expect(store.feedback("nope", "helpful")).rejects.toThrow("no template nope");
  });

  it("TP2.4 a correction is stored for RLHF and rewrites the template; a rating leaves the body; a second session reads both", async () => {
    const bash = new Bash({ cwd: HOME });
    const store = new TemplateStore(bash.fs);
    await store.put(parseTemplate("greet", "---\ndescription: Greets\n---\nHello"));
    await store.put(parseTemplate("other", "---\ndescription: Other\n---\nStay"));
    await store.prefer({ utterance: "hi", answer: "Hello", text: "Goodbye", action: "replacement", artifact: { kind: "template", id: "greet" } });
    expect((await store.get("greet"))?.body).toBe("Goodbye");
    expect((await store.get("other"))?.body).toBe("Stay");
    await store.prefer({ utterance: "hi", answer: "Goodbye", text: "be brief", action: "steering", artifact: { kind: "template", id: "greet" } });
    await store.prefer({ utterance: "hi", answer: "Goodbye", text: "", action: "rating", artifact: { kind: "template", id: "greet" } });
    const body = (await store.get("greet"))?.body;
    expect(body).toBe("Goodbye\nbe brief");
    const again = new TemplateStore(bash.fs);
    expect(await again.preferences()).toEqual([
      { utterance: "hi", answer: "Hello", text: "Goodbye", signal: "negative", action: "replacement", artifact: { kind: "template", id: "greet" } },
      { utterance: "hi", answer: "Goodbye", text: "be brief", signal: "negative", action: "steering", artifact: { kind: "template", id: "greet" } },
      { utterance: "hi", answer: "Goodbye", text: "", signal: "negative", action: "rating", artifact: { kind: "template", id: "greet" } },
    ]);
    expect((await again.get("greet"))?.body).toBe(body);
  });
});
