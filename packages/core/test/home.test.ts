import { describe, expect, it } from "vitest";
import { instructionsWithSkills, mergeHarnessHomes, parseHarnessHome } from "@harness/core";
import type { DeliveryTask, HarnessHomeFile } from "@harness/core";

function sessionFile(name: string, harness = "claude-code", state: unknown = { step: 1 }, extra?: Record<string, unknown>): HarnessHomeFile {
  return { path: `sessions/${name}.json`, text: JSON.stringify({ name, harness, state, ...extra }) };
}

function worktreeFile(id: string, branch = `feature/${id}`, paths: readonly string[] = ["packages/core/src/home.ts"]): HarnessHomeFile {
  return { path: `worktrees/${id}.json`, text: JSON.stringify({ id, branch, paths }) };
}

function skillFile(name: string, description: string, body = "Do the thing.\n", extras: readonly { path: string; text: string }[] = []): HarnessHomeFile[] {
  return [
    { path: `skills/${name}/SKILL.md`, text: `---\nname: ${name}\ndescription: ${description}\n---\n${body}` },
    ...extras.map((extra) => ({ path: `skills/${name}/${extra.path}`, text: extra.text })),
  ];
}

describe("harness home", () => {
  it("HD1.1 an empty file list is an empty home", () => {
    expect(parseHarnessHome([])).toEqual({ sessions: [], worktrees: [], skills: [] });
  });

  it("HD1.2 a session file is a session named by its file", () => {
    const home = parseHarnessHome([sessionFile("review", "codex", 0)]);
    expect(home.sessions).toEqual([{ name: "review", harness: "codex", state: 0 }]);
  });

  it("HD1.3 a session whose name differs from its file is rejected", () => {
    const file = sessionFile("review");
    const text = file.text.replace("review", "other");
    expect(() => parseHarnessHome([{ path: file.path, text }])).toThrow(/sessions\/review\.json/);
  });

  it("HD1.4 a session without a state is rejected", () => {
    expect(() => parseHarnessHome([{ path: "sessions/review.json", text: JSON.stringify({ name: "review", harness: "codex" }) }])).toThrow(/sessions\/review\.json/);
  });

  it("HD1.5 a worktree file is a delivery task", () => {
    const home = parseHarnessHome([worktreeFile("loop", "frontier/loop", ["packages/core/src/home.ts"])]);
    const tasks: readonly DeliveryTask[] = home.worktrees;
    expect(tasks).toEqual([{ id: "loop", branch: "frontier/loop", paths: ["packages/core/src/home.ts"] }]);
  });

  it("HD1.6 a worktree with no paths is rejected", () => {
    expect(() => parseHarnessHome([{ path: "worktrees/loop.json", text: JSON.stringify({ id: "loop", branch: "frontier/loop", paths: [] }) }])).toThrow(/worktrees\/loop\.json/);
    expect(() => parseHarnessHome([{ path: "worktrees/loop.json", text: JSON.stringify({ id: "loop", branch: "frontier/loop", paths: "packages/core" }) }])).toThrow(/worktrees\/loop\.json/);
  });

  it("HD1.7 a skill file is a skill whose content is the whole SKILL.md", () => {
    const [file] = skillFile("ship-it", "Ship the branch.");
    const home = parseHarnessHome([file!]);
    expect(home.skills).toEqual([{ name: "ship-it", description: "Ship the branch.", content: file!.text, files: [] }]);
  });

  it("HD1.8 a skill keeps its other files beside SKILL.md", () => {
    const home = parseHarnessHome(skillFile("ship-it", "Ship the branch.", "Run it.\n", [{ path: "workflow.json", text: "{}\n" }]));
    expect(home.skills[0]?.files).toEqual([{ path: "workflow.json", content: "{}\n" }]);
  });

  it("HD1.9 a skill whose frontmatter name differs from its directory is rejected", () => {
    const [file] = skillFile("ship-it", "Ship the branch.");
    expect(() => parseHarnessHome([{ path: file!.path, text: file!.text.replace("name: ship-it", "name: other") }])).toThrow(/skills\/ship-it\/SKILL\.md/);
  });

  it("HD1.10 a file outside sessions, worktrees, and skills is rejected", () => {
    expect(() => parseHarnessHome([{ path: "README.md", text: "hi\n" }])).toThrow(/README\.md/);
  });

  it("HD1.11 the project layer replaces the same identity and keeps the rest in place", () => {
    const user = parseHarnessHome([
      sessionFile("alpha", "codex", 1),
      sessionFile("beta", "codex", 2),
      worktreeFile("loop"),
      ...skillFile("ship-it", "User skill."),
    ]);
    const project = parseHarnessHome([
      sessionFile("alpha", "claude-code", 9),
      worktreeFile("loop", "project/loop"),
      worktreeFile("docs"),
      ...skillFile("ship-it", "Project skill."),
      ...skillFile("review", "Review the diff."),
    ]);
    const merged = mergeHarnessHomes(user, project);
    expect(merged.sessions.map((session) => [session.name, session.state])).toEqual([["alpha", 9], ["beta", 2]]);
    expect(merged.worktrees.map((task) => [task.id, task.branch])).toEqual([["loop", "project/loop"], ["docs", "feature/docs"]]);
    expect(merged.skills.map((skill) => [skill.name, skill.description])).toEqual([["ship-it", "Project skill."], ["review", "Review the diff."]]);
  });

  it("HD1.12 a skill description of 1024 characters is kept and a longer one is rejected", () => {
    const kept = "a".repeat(1024);
    expect(parseHarnessHome(skillFile("ship-it", kept)).skills[0]?.description).toBe(kept);
    expect(() => parseHarnessHome(skillFile("ship-it", `${kept}b`))).toThrow(/skills\/ship-it\/SKILL\.md/);
  });

  it("HD1.13 a skill written with CRLF frontmatter parses", () => {
    const text = "---\r\nname: ship-it\r\ndescription: Ship the branch.\r\n---\r\nDo the thing.\r\n";
    expect(parseHarnessHome([{ path: "skills/ship-it/SKILL.md", text }]).skills[0]?.description).toBe("Ship the branch.");
  });

  it("HD1.14 a session file with an unknown key is rejected", () => {
    expect(() => parseHarnessHome([sessionFile("review", "codex", 1, { note: "x" })])).toThrow(/sessions\/review\.json/);
  });

  it("HD1.15 a session whose harness is empty is rejected", () => {
    expect(() => parseHarnessHome([sessionFile("review", "")])).toThrow(/sessions\/review\.json/);
  });

  it("HD1.16 a worktree whose id differs from its file is rejected", () => {
    const file = worktreeFile("loop");
    expect(() => parseHarnessHome([{ path: file.path, text: file.text.replace("loop", "other") }])).toThrow(/worktrees\/loop\.json/);
  });

  it("HD1.17 a skill directory without SKILL.md is rejected", () => {
    expect(() => parseHarnessHome([{ path: "skills/ship-it/workflow.json", text: "{}\n" }])).toThrow(/skills\/ship-it\/SKILL\.md/);
  });

  it("HD1.18 no skills leaves the system text unchanged", () => {
    const home = parseHarnessHome([]);
    expect(instructionsWithSkills(undefined, home)).toBeUndefined();
    expect(instructionsWithSkills("Be brief.", home)).toBe("Be brief.");
  });

  it("HD1.19 skills contribute their name and description", () => {
    const home = parseHarnessHome([...skillFile("ship-it", "Ship the branch."), ...skillFile("review", "Review the diff.")]);
    expect(instructionsWithSkills(undefined, home)).toBe("Agent skills:\n- ship-it: Ship the branch.\n- review: Review the diff.");
    expect(instructionsWithSkills("Be brief.", home)).toBe("Be brief.\n\nAgent skills:\n- ship-it: Ship the branch.\n- review: Review the diff.");
  });

  it("HD1.20 a session file that is not a json object is rejected", () => {
    expect(() => parseHarnessHome([{ path: "sessions/review.json", text: "nope" }])).toThrow(/sessions\/review\.json/);
    expect(() => parseHarnessHome([{ path: "sessions/review.json", text: "[]" }])).toThrow(/sessions\/review\.json/);
  });

  it("HD1.21 the same definition path listed twice is rejected", () => {
    const file = sessionFile("review");
    expect(() => parseHarnessHome([file, file])).toThrow(/sessions\/review\.json/);
  });

  it("HD1.22 a worktree branch must be a non-empty string", () => {
    expect(() => parseHarnessHome([{ path: "worktrees/loop.json", text: JSON.stringify({ id: "loop", branch: "", paths: ["src"] }) }])).toThrow(/worktrees\/loop\.json/);
    expect(() => parseHarnessHome([{ path: "worktrees/loop.json", text: JSON.stringify({ id: "loop", branch: 1, paths: ["src"] }) }])).toThrow(/worktrees\/loop\.json/);
  });

  it("HD1.23 a worktree path must be a non-empty string", () => {
    expect(() => parseHarnessHome([{ path: "worktrees/loop.json", text: JSON.stringify({ id: "loop", branch: "feature/loop", paths: [""] }) }])).toThrow(/worktrees\/loop\.json/);
    expect(() => parseHarnessHome([{ path: "worktrees/loop.json", text: JSON.stringify({ id: "loop", branch: "feature/loop", paths: [1] }) }])).toThrow(/worktrees\/loop\.json/);
  });

  it("HD1.24 a worktree file with an unknown key is rejected", () => {
    expect(() => parseHarnessHome([{ path: "worktrees/loop.json", text: JSON.stringify({ id: "loop", branch: "feature/loop", paths: ["src"], note: "x" }) }])).toThrow(/worktrees\/loop\.json/);
  });

  it("HD1.25 a skill without frontmatter is rejected", () => {
    expect(() => parseHarnessHome([{ path: "skills/ship-it/SKILL.md", text: "# Ship\n" }])).toThrow(/skills\/ship-it\/SKILL\.md/);
  });

  it("HD1.26 a skill frontmatter line other than name and description is rejected", () => {
    const text = "---\nname: ship-it\nlicense: MIT\ndescription: Ship the branch.\n---\n";
    expect(() => parseHarnessHome([{ path: "skills/ship-it/SKILL.md", text }])).toThrow(/skills\/ship-it\/SKILL\.md/);
  });

  it("HD1.27 a skill that repeats name or omits description is rejected", () => {
    const repeated = "---\nname: ship-it\nname: ship-it\ndescription: Ship the branch.\n---\n";
    const undescribed = "---\nname: ship-it\n---\n";
    const blank = "---\nname: ship-it\ndescription: \n---\n";
    expect(() => parseHarnessHome([{ path: "skills/ship-it/SKILL.md", text: repeated }])).toThrow(/skills\/ship-it\/SKILL\.md/);
    expect(() => parseHarnessHome([{ path: "skills/ship-it/SKILL.md", text: undescribed }])).toThrow(/skills\/ship-it\/SKILL\.md/);
    expect(() => parseHarnessHome([{ path: "skills/ship-it/SKILL.md", text: blank }])).toThrow(/skills\/ship-it\/SKILL\.md/);
  });

  it("HD1.28 a skill that repeats its description is rejected", () => {
    const text = "---\nname: ship-it\ndescription: Ship the branch.\ndescription: Again.\n---\n";
    expect(() => parseHarnessHome([{ path: "skills/ship-it/SKILL.md", text }])).toThrow(/skills\/ship-it\/SKILL\.md/);
  });
});
