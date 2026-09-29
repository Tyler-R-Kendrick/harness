import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProjectHome, loadDiscoveredHarnessHome, readHarnessHome } from "../src/home.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-home-"));
  roots.push(root);
  return root;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const session = (name: string, state: number) => `${JSON.stringify({ name, harness: "codex", state })}\n`;
const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nRun it.\n`;

describe("harness directory", () => {
  it("HD2.1 a missing directory is an empty home", () => {
    const root = temp();
    expect(readHarnessHome(join(root, ".harness"))).toEqual({ sessions: [], worktrees: [], skills: [] });
    expect(loadDiscoveredHarnessHome({ userRoot: join(root, "user"), start: join(root, "repo"), stop: root })).toEqual({ sessions: [], worktrees: [], skills: [] });
  });

  it("HD2.2 a directory's sessions, worktrees, and skills load in name order", () => {
    const root = join(temp(), ".harness");
    write(join(root, "sessions", "zeta.json"), session("zeta", 2));
    write(join(root, "sessions", "alpha.json"), session("alpha", 1));
    write(join(root, "sessions", ".keep"), "ignore\n");
    write(join(root, "worktrees", "docs.json"), JSON.stringify({ id: "docs", branch: "feature/docs", paths: ["docs"] }));
    write(join(root, "skills", "ship-it", "SKILL.md"), skill("ship-it", "Ship the branch."));
    write(join(root, "skills", "ship-it", "workflow.json"), "{}\n");
    write(join(root, "skills", "ship-it", ".DS_Store"), "ignore\n");
    write(join(root, "skills", ".draft", "SKILL.md"), skill("draft", "Hidden."));
    const home = readHarnessHome(root);
    expect(home.sessions.map((item) => item.name)).toEqual(["alpha", "zeta"]);
    expect(home.worktrees).toEqual([{ id: "docs", branch: "feature/docs", paths: ["docs"] }]);
    expect(home.skills.map((item) => [item.name, item.files.map((file) => file.path)])).toEqual([["ship-it", ["workflow.json"]]]);
  });

  it("HD2.3 the project directory replaces the same identity", () => {
    const stop = temp();
    const user = join(stop, "user", ".harness");
    const repo = join(stop, "repo");
    write(join(user, "sessions", "alpha.json"), session("alpha", 1));
    write(join(user, "sessions", "beta.json"), session("beta", 2));
    write(join(repo, ".harness", "sessions", "alpha.json"), session("alpha", 9));
    const home = loadDiscoveredHarnessHome({ userRoot: user, start: repo, stop });
    expect(home.sessions.map((item) => [item.name, item.state])).toEqual([["alpha", 9], ["beta", 2]]);
  });

  it("HD2.4 an ancestor directory is the project directory", () => {
    const stop = temp();
    write(join(stop, ".harness", "sessions", "user.json"), session("user", 1));
    write(join(stop, "repo", ".harness", "sessions", "project.json"), session("project", 2));
    const found = discoverProjectHome(join(stop, "repo", "pkg"), stop);
    expect(found).toBe(join(stop, "repo", ".harness"));
    const home = loadDiscoveredHarnessHome({ userRoot: join(stop, ".harness"), start: join(stop, "repo", "pkg"), stop });
    expect(home.sessions.map((item) => item.name)).toEqual(["user", "project"]);
  });

  it("HD2.5 the stop directory is not a project directory", () => {
    const stop = temp();
    write(join(stop, ".harness", "sessions", "user.json"), session("user", 1));
    expect(discoverProjectHome(join(stop, "repo"), stop)).toBeUndefined();
    const home = loadDiscoveredHarnessHome({ userRoot: join(stop, ".harness"), start: join(stop, "repo"), stop });
    expect(home.sessions.map((item) => item.name)).toEqual(["user"]);
  });

  it("HD2.6 a nearer directory wins over an ancestor", () => {
    const stop = temp();
    write(join(stop, "repo", ".harness", "sessions", "root.json"), session("root", 1));
    write(join(stop, "repo", "pkg", ".harness", "sessions", "near.json"), session("near", 2));
    const home = loadDiscoveredHarnessHome({ userRoot: join(stop, ".harness"), start: join(stop, "repo", "pkg", "src"), stop });
    expect(home.sessions.map((item) => item.name)).toEqual(["near"]);
  });

  it("HD2.7 an invalid definition fails with its path", () => {
    const root = join(temp(), ".harness");
    write(join(root, "sessions", "review.json"), "{}\n");
    expect(() => readHarnessHome(root)).toThrow(/sessions\/review\.json/);
  });

  it("HD2.8 a session entry that is not a json file is rejected", () => {
    const root = join(temp(), ".harness");
    write(join(root, "sessions", "notes.txt"), "hi\n");
    expect(() => readHarnessHome(root)).toThrow(/notes\.txt/);
  });

  it("HD2.9 a nested session directory is rejected", () => {
    const root = join(temp(), ".harness");
    write(join(root, "sessions", "nested", "review.json"), session("review", 1));
    expect(() => readHarnessHome(root)).toThrow(/nested/);
  });

  it("HD2.10 a .harness path that is a file is rejected", () => {
    const root = temp();
    const file = join(root, ".harness");
    writeFileSync(file, "nope\n");
    expect(() => readHarnessHome(file)).toThrow(/\.harness/);
  });

  it("HD2.11 a sessions entry that is not a directory of files is rejected", () => {
    const root = join(temp(), ".harness");
    write(join(root, "sessions"), "nope\n");
    expect(() => readHarnessHome(root)).toThrow(/sessions/);
  });

  it("HD2.12 a skill entry that is a file, or a directory inside a skill, is rejected", () => {
    const file = join(temp(), ".harness");
    write(join(file, "skills", "ship-it"), "nope\n");
    expect(() => readHarnessHome(file)).toThrow(/ship-it/);
    const nested = join(temp(), ".harness");
    write(join(nested, "skills", "ship-it", "SKILL.md"), skill("ship-it", "Ship the branch."));
    write(join(nested, "skills", "ship-it", "notes", "extra.md"), "x\n");
    expect(() => readHarnessHome(nested)).toThrow(/notes/);
  });

  it("HD2.13 discovery stops at the filesystem root", () => {
    expect(discoverProjectHome("/", temp())).toBeUndefined();
  });

  it("HD2.14 the daemon rejects a user home that is not a directory", () => {
    const home = temp();
    writeFileSync(join(home, ".harness"), "nope\n");
    const repo = fileURLToPath(new URL("../../..", import.meta.url));
    const result = spawnSync(process.execPath, ["packages/platform-native/src/main.ts", "--stdio"], {
      cwd: repo,
      env: { ...process.env, HOME: home, USERPROFILE: home, NODE_OPTIONS: "--max-old-space-size=8192" },
      encoding: "utf8",
      timeout: 20000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/\.harness/);
  });
});
