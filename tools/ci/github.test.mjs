import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";

const SCRIPT = new URL("./github.mjs", import.meta.url).pathname;
const PROMOTE = new URL("../../.github/workflows/promote.yml", import.meta.url);

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** @param {string} cwd */
function init(cwd) {
  mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "ci@example.com"]);
  git(cwd, ["config", "user.name", "ci"]);
}

/**
 * @param {string} cwd
 * @param {Record<string, string>} env
 */
function pull(cwd, env) {
  const { PATH, HOME } = process.env;
  return execFileSync("node", [SCRIPT, "pull"], {
    cwd,
    encoding: "utf8",
    env: { PATH, HOME, EVENT_NAME: "push", ...env },
  });
}

/** @param {string} output */
function flags(output) {
  return Object.fromEntries(output.trim().split("\n").map((line) => line.split("=")));
}

it("CI1.11 a push whose parent is gone runs the full pull-request suite", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ci-missing-"));
  try {
    init(cwd);
    writeFileSync(join(cwd, "README.md"), "hello\n");
    git(cwd, ["add", "README.md"]);
    git(cwd, ["commit", "-m", "init"]);
    const output = pull(cwd, { BEFORE_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(flags(output)).toEqual({ code: "true", browser: "true", host: "true" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("CI1.12 a push fetches a parent that exists only on origin", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-origin-"));
  const work = join(root, "work");
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  try {
    init(work);
    writeFileSync(join(work, "README.md"), "a\n");
    git(work, ["add", "README.md"]);
    git(work, ["commit", "-m", "base"]);
    const before = git(work, ["rev-parse", "HEAD"]);
    writeFileSync(join(work, "notes.md"), "docs only\n");
    git(work, ["add", "notes.md"]);
    git(work, ["commit", "-m", "notes"]);
    git(work, ["init", "--bare", origin]);
    git(origin, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
    git(work, ["remote", "add", "origin", origin]);
    git(work, ["push", "origin", "HEAD:refs/heads/main"]);
    git(root, ["clone", "--depth", "1", "--branch", "main", `file://${origin}`, clone]);
    const output = pull(clone, { BEFORE_SHA: before });
    expect(flags(output)).toEqual({ code: "false", browser: "false", host: "false" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("CI1.13 promote pins one sha, records that deployment, and keeps a failed mutation report", () => {
  const doc = parse(readFileSync(PROMOTE, "utf8"));
  expect(doc.concurrency.group).toBe("release");
  expect(doc.jobs.scope.outputs.sha).toBe("${{ steps.pin.outputs.sha }}");
  const plan = doc.jobs.scope.steps.find((step) => step.id === "plan");
  expect(plan.env.PROMOTE_SHA).toBe("${{ steps.pin.outputs.sha }}");
  for (const name of ["mutation", "evals", "models"]) {
    const checkout = doc.jobs[name].steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout"));
    expect(checkout.with.ref).toBe("${{ needs.scope.outputs.sha }}");
  }
  expect(doc.jobs.release.environment).toBeUndefined();
  const recorded = doc.jobs.release.steps.map((step) => step.run ?? "").join("\n");
  expect(recorded).toContain("repos/${GITHUB_REPOSITORY}/deployments");
  expect(recorded).toContain("PROMOTED_SHA");
  const upload = doc.jobs.mutation.steps.find((step) => String(step.uses ?? "").startsWith("actions/upload-artifact"));
  expect(upload.if).toBe("always() && steps.decision.outputs.decision == 'run'");
});
