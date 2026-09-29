// Writes GitHub Actions outputs for the pull-request scope and the release plan.
// `node tools/ci/github.mjs <pull|promote|mutation-shard|integration>`.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { classify, integrationPaths, mutationTargets, promotionPlan } from "./scope.mjs";

const command = process.argv[2];

if (command === "pull") writePull();
else if (command === "promote") writePromote();
else if (command === "mutation-shard") writeShard();
else if (command === "integration") writeIntegration();
else throw new Error(`unknown ci command ${JSON.stringify(command)}`);

function writePull() {
  const event = process.env.EVENT_NAME;
  let flags;
  if (event === "pull_request") {
    const base = process.env.BASE_SHA ?? "";
    if (base === "") throw new Error("pull request is missing its base sha");
    execFileSync("git", ["fetch", "--no-tags", "origin", base], { stdio: "inherit" });
    flags = classify(names(base, "HEAD"));
  } else {
    const before = process.env.BEFORE_SHA ?? "";
    // The first push of a repository has no parent. Run the full pull-request suite.
    flags = before === "" || /^0+$/.test(before) ? { code: true, browser: true, host: true } : classify(names(before, "HEAD"));
  }
  setOutput("code", String(flags.code));
  setOutput("browser", String(flags.browser));
  setOutput("host", String(flags.host));
}

function writePromote() {
  const requested = process.env.BASELINE ?? "";
  let plan;
  if (requested !== "") {
    fetchRef(requested);
    plan = promotionPlan(names(requested, "HEAD"), false);
  } else {
    const previous = lastSuccessfulRelease();
    if (previous === "") plan = promotionPlan([], true);
    else if (previous === (process.env.PROMOTE_SHA ?? "")) plan = promotionPlan([], false);
    else {
      fetchRef(previous);
      plan = promotionPlan(names(previous, "HEAD"), false);
    }
  }
  setOutput("mutate", String(plan.mutate));
  setOutput("shards", JSON.stringify(plan.shards));
  setOutput("files", plan.files);
  setOutput("models", String(plan.models));
  setOutput("evals", String(plan.evals));
}

function writeShard() {
  const files = mutationTargets({ shard: process.env.MUTATION_SHARD, only: process.env.MUTATION_FILES });
  if (files !== null && files.length === 0) {
    process.stdout.write("skip\n");
    return;
  }
  process.stdout.write("run\n");
}

function writeIntegration() {
  const paths = integrationPaths({ browser: process.env.BROWSER === "true", host: process.env.HOST === "true" });
  process.stdout.write(paths.join("\n"));
}

/** @param {string} base @param {string} head */
function names(base, head) {
  return execFileSync("git", ["diff", "--name-only", base, head], { encoding: "utf8" })
    .split("\n")
    .map((file) => file.trim())
    .filter((file) => file !== "");
}

/** @param {string} ref */
function fetchRef(ref) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], { stdio: "ignore" });
  } catch {
    execFileSync("git", ["fetch", "--no-tags", "origin", ref], { stdio: "inherit" });
  }
}

/** The sha of the newest release deployment whose own status succeeded, or "" when there is none. */
function lastSuccessfulRelease() {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (repository === "" || process.env.GH_TOKEN === undefined && process.env.GITHUB_TOKEN === undefined) return "";
  let deployments;
  try {
    deployments = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/deployments?environment=release&per_page=10`], { encoding: "utf8" }));
  } catch {
    return "";
  }
  if (!Array.isArray(deployments)) return "";
  for (const deployment of deployments) {
    if (typeof deployment !== "object" || deployment === null) continue;
    const id = /** @type {{ id?: unknown, sha?: unknown }} */ (deployment).id;
    const sha = /** @type {{ sha?: unknown }} */ (deployment).sha;
    if (typeof id !== "number" || typeof sha !== "string") continue;
    let statuses;
    try {
      statuses = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/deployments/${id}/statuses`], { encoding: "utf8" }));
    } catch {
      continue;
    }
    const state = Array.isArray(statuses) ? statuses[0] : undefined;
    if (typeof state === "object" && state !== null && /** @type {{ state?: unknown }} */ (state).state === "success") return sha;
  }
  return "";
}

/** @param {string} name @param {string} value */
function setOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (output === undefined || output === "") {
    process.stdout.write(`${name}=${value}\n`);
    return;
  }
  const marker = `EOF_${name}_${process.pid}`;
  appendFileSync(output, `${name}<<${marker}\n${value}\n${marker}\n`);
}
