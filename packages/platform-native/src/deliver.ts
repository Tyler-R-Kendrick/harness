import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inspectBudget, parseDeclarativeWorkflow, parseResourcePolicy, runDeliveryWorkflow } from "@harness/core";
import type { CacheKind, DeclarativeReport, DeclarativeWorkflow, DeliveryEffects, DeliveryTask, Gate, ResourcePolicy, ResourceSample } from "@harness/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Host side of the delivery machine: linked git worktrees, one shared cache symlink,
 * a sparse checkout of each task's paths, the repository's pre-commit hook, and a
 * stack of squash merges. Nothing here copies the dependency install or skips a hook.
 */

export interface CommandRun {
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface CommandRunner {
  (command: string, args: readonly string[], options?: CommandRun): Promise<string>;
}

export interface PullRemote {
  open(branch: string, base: string): Promise<string>;
  review(branch: string): Promise<"comment" | "approve">;
  resolve(branch: string): Promise<number>;
  squashMerge(branch: string): Promise<{ readonly sha: string; readonly parents: number }>;
  noteRetarget(branch: string, onto: string): Promise<void>;
}

export interface GitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface GitDeliveryOptions {
  readonly repo: string;
  readonly trunk: string;
  readonly worktrees: string;
  readonly cachePath: string;
  readonly cacheName: string;
  readonly tasks: readonly DeliveryTask[];
  readonly policy: ResourcePolicy;
  readonly gates: readonly { readonly command: string; readonly args: readonly string[] }[];
  readonly remote: PullRemote;
  readonly clock: { now(): number };
  readonly startedAt: number;
  readonly tokens?: () => number;
  readonly memoryBytes?: () => number;
  readonly gpuRequested?: () => boolean;
  readonly author?: GitAuthor;
  readonly prepare?: (worktree: string, task: DeliveryTask) => Promise<void>;
  readonly run?: CommandRunner;
}

const ARTIFACTS = ["coverage", "reports", ".stryker-tmp"];

export function defaultRunner(): CommandRunner {
  return (command, args, options) => new Promise((resolve, reject) => {
    execFile(command, [...args], {
      encoding: "utf8",
      cwd: options?.cwd,
      env: options?.env === undefined ? process.env : { ...process.env, ...options.env },
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function du(run: CommandRunner, path: string): Promise<number> {
  try {
    const stdout = await run("du", ["-s", "-B1", path]);
    const size = Number(stdout.trim().split(/\s+/)[0] ?? "");
    return Number.isFinite(size) ? size : 0;
  } catch {
    return 0;
  }
}

/** Non-cone patterns for a task path and, when it is a directory, everything under it. */
function sparsePatterns(paths: readonly string[]): string[] {
  return paths.flatMap((path) => [`/${path}`, `/${path}/**`]);
}

function gitEnv(author: GitAuthor | undefined): Record<string, string> {
  return {
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    ...(author === undefined ? {} : {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    }),
  };
}

async function localGate(run: CommandRunner, command: string, args: readonly string[], cwd: string): Promise<Gate> {
  try {
    await run(command, args, { cwd });
    return "pass";
  } catch {
    return "fail";
  }
}

export function gitDeliveryEffects(options: GitDeliveryOptions): DeliveryEffects {
  const run = options.run ?? defaultRunner();
  const env = gitEnv(options.author);
  const byBranch = new Map(options.tasks.map((task) => [task.branch, task]));
  const worktree = (branch: string): string => {
    const task = byBranch.get(branch);
    if (task === undefined) throw new Error(`no worktree for ${branch}`);
    return join(options.worktrees, task.id);
  };
  const git = (cwd: string, args: readonly string[]): Promise<string> => run("git", ["-C", cwd, ...args], { env });

  async function measure(): Promise<ResourceSample> {
    let extraDiskBytes = 0;
    let artifactBytes = 0;
    const roots = [options.repo, ...options.tasks.map((task) => join(options.worktrees, task.id))];
    for (const task of options.tasks) extraDiskBytes += await du(run, join(options.worktrees, task.id));
    for (const root of roots) {
      for (const name of ARTIFACTS) artifactBytes += await du(run, join(root, name));
    }
    const avail = await run("df", ["-B1", "--output=avail", options.repo]);
    const freeDiskBytes = Number(avail.trim().split("\n").at(-1) ?? "0");
    return {
      extraDiskBytes,
      freeDiskBytes,
      memoryBytes: options.memoryBytes?.() ?? 0,
      tokens: options.tokens?.() ?? 0,
      gpuRequested: options.gpuRequested?.() ?? false,
      elapsedMs: options.clock.now() - options.startedAt,
      artifactBytes,
    };
  }

  async function hooksAndGates(wt: string): Promise<{ hooks: Gate; local: Gate }> {
    let hooks: Gate;
    try {
      await git(wt, ["hook", "run", "pre-commit"]);
      hooks = "pass";
    } catch {
      hooks = "fail";
    }
    let local: Gate = "pass";
    for (const gate of options.gates) {
      if (await localGate(run, gate.command, gate.args, wt) === "fail") local = "fail";
    }
    return { hooks, local };
  }

  async function discard(wt: string): Promise<void> {
    await rm(join(wt, options.cacheName), { force: true }).catch(() => undefined);
    await git(options.repo, ["worktree", "remove", "--force", wt]).catch(() => undefined);
  }

  return {
    measure,
    async link() {
      await mkdir(options.worktrees, { recursive: true });
      const trunk = (await git(options.repo, ["rev-parse", options.trunk])).trim();
      const caches: CacheKind[] = [];
      const created: string[] = [];
      let commonDir = "";
      try {
        for (const task of options.tasks) {
          const wt = join(options.worktrees, task.id);
          // Checkout after the sparse patterns exist, so the index keeps the rest of
          // the tree with skip-worktree and the working tree never materializes it.
          await git(options.repo, ["worktree", "add", "--no-checkout", "-b", task.branch, wt, trunk]);
          created.push(wt);
          await git(wt, ["sparse-checkout", "set", "--no-cone", "--", ...sparsePatterns(task.paths)]);
          await git(wt, ["checkout"]);
          const dir = (await git(wt, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
          if (commonDir === "") commonDir = dir;
          else if (commonDir !== dir) throw new Error("worktrees do not share one git directory");
          const link = join(wt, options.cacheName);
          await symlink(options.cachePath, link);
          const stat = await lstat(link);
          caches.push(stat.isSymbolicLink() ? "symlink" : "copy");
          await options.prepare?.(wt, task);
        }
      } catch (error) {
        for (const wt of [...created].reverse()) await discard(wt);
        await git(options.repo, ["worktree", "prune"]).catch(() => undefined);
        throw error;
      }
      return { commonDir, caches };
    },
    gates(branch) {
      return hooksAndGates(worktree(branch));
    },
    async commit(branch, parent) {
      const task = byBranch.get(branch);
      if (task === undefined) throw new Error(`no task for ${branch}`);
      const wt = worktree(branch);
      // A later task starts from trunk. Its commit has to sit on the previous task and
      // keep that task's tree, or the squash of this branch would drop the earlier files.
      if (parent !== undefined) await git(wt, ["read-tree", parent]);
      await git(wt, ["add", "--", ...task.paths]);
      if (parent !== undefined) await git(wt, ["reset", "--soft", parent]);
      await git(wt, ["commit", "-m", `Deliver ${branch}`]);
      await git(wt, ["reset", "--hard", "HEAD"]);
      const sha = (await git(wt, ["rev-parse", "HEAD"])).trim();
      const actual = (await git(wt, ["rev-parse", "HEAD^"])).trim();
      return { sha, parent: actual };
    },
    async cleanArtifacts() {
      const roots = [options.repo, ...options.tasks.map((task) => join(options.worktrees, task.id))];
      for (const root of roots) {
        for (const name of ARTIFACTS) await rm(join(root, name), { recursive: true, force: true });
      }
    },
    openPullRequest(branch, base) {
      return options.remote.open(branch, base);
    },
    async verify(branch) {
      const checked = await hooksAndGates(worktree(branch));
      const verdict = inspectBudget(options.policy, await measure());
      return { correctness: checked.local, gates: checked.hooks, budget: verdict.ok ? "pass" : "fail" };
    },
    review: (branch) => options.remote.review(branch),
    resolve: (branch) => options.remote.resolve(branch),
    squashMerge: (branch) => options.remote.squashMerge(branch),
    async retarget(branch, onto) {
      const wt = worktree(branch);
      const parent = (await git(wt, ["rev-parse", "HEAD^"])).trim();
      await git(wt, ["rebase", "--onto", onto, parent]);
      await options.remote.noteRetarget(branch, onto);
      return Number((await git(wt, ["rev-list", "--count", `${onto}..HEAD`])).trim());
    },
    async removeWorktree(branch) {
      const wt = worktree(branch);
      await rm(join(wt, options.cacheName), { force: true });
      await git(options.repo, ["worktree", "remove", "--force", wt]);
      await git(options.repo, ["worktree", "prune"]);
    },
    async worktreePresent(branch) {
      try {
        await lstat(worktree(branch));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** A stack kept in the local repository: each squash is one commit with one parent. */
export function gitStackRemote(options: {
  readonly repo: string;
  readonly trunk: string;
  readonly author?: GitAuthor;
  readonly run?: CommandRunner;
}): PullRemote & { readonly requests: { branch: string; base: string }[] } {
  const run = options.run ?? defaultRunner();
  const git = (args: readonly string[]): Promise<string> => run("git", ["-C", options.repo, ...args], { env: gitEnv(options.author) });
  const requests: { branch: string; base: string }[] = [];
  return {
    requests,
    async open(branch, base) {
      await git(["rev-parse", "--verify", `refs/heads/${branch}`]);
      requests.push({ branch, base });
      return base;
    },
    async review() {
      return "comment";
    },
    async resolve() {
      return 0;
    },
    async squashMerge(branch) {
      const tree = (await git(["rev-parse", `${branch}^{tree}`])).trim();
      const parent = (await git(["rev-parse", options.trunk])).trim();
      const sha = (await git(["commit-tree", tree, "-p", parent, "-m", `Deliver ${branch}`])).trim();
      await git(["update-ref", `refs/heads/${options.trunk}`, sha, parent]);
      const parents = (await git(["rev-parse", `${sha}^@`])).trim().split(/\s+/).filter((item) => item.length > 0);
      return { sha, parents: parents.length };
    },
    async noteRetarget() {
      return undefined;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function field(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Ids of review threads a GitHub review query still has open. */
export function unresolvedThreadIds(body: string): string[] {
  const parsed: unknown = JSON.parse(body);
  const data = isRecord(parsed) ? field(parsed, "data") : undefined;
  const repository = isRecord(data) ? field(data, "repository") : undefined;
  const pullRequest = isRecord(repository) ? field(repository, "pullRequest") : undefined;
  const threads = isRecord(pullRequest) ? field(pullRequest, "reviewThreads") : undefined;
  const nodes = isRecord(threads) ? field(threads, "nodes") : undefined;
  if (!Array.isArray(nodes)) return [];
  const ids: string[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const id = field(node, "id");
    if (typeof id === "string" && field(node, "isResolved") === false) ids.push(id);
  }
  return ids;
}

const THREAD_QUERY = "query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner, name:$name){ pullRequest(number:$number){ reviewThreads(first:20){ nodes { id isResolved } } } } }";
const RESOLVE_QUERY = "mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread { isResolved } } }";

/** GitHub pull requests. The review is a comment; an approval is never requested. */
export function githubPullRemote(options: {
  readonly owner: string;
  readonly name: string;
  readonly trunk: string;
  readonly repo: string;
  readonly run?: CommandRunner;
}): PullRemote {
  const run = options.run ?? defaultRunner();
  const gh = (args: readonly string[]): Promise<string> => run("gh", args);
  const threads = async (number: number): Promise<string[]> => {
    const listed = await gh(["api", "graphql", "-f", `query=${THREAD_QUERY}`, "-f", `owner=${options.owner}`, "-f", `name=${options.name}`, "-F", `number=${number}`]);
    return unresolvedThreadIds(listed);
  };
  return {
    async open(branch, base) {
      await gh(["pr", "create", "--repo", `${options.owner}/${options.name}`, "--base", base, "--head", branch, "--title", `Deliver ${branch}`, "--body", "Stacked delivery. Verification has to pass before squash-merge."]);
      return base;
    },
    async review(branch) {
      await gh(["pr", "review", branch, "--repo", `${options.owner}/${options.name}`, "--comment", "--body", "Self-review: the verification checks passed and the budget still holds."]);
      return "comment";
    },
    async resolve(branch) {
      const number = Number((await gh(["pr", "view", branch, "--repo", `${options.owner}/${options.name}`, "--json", "number", "--jq", ".number"])).trim());
      const ids = await threads(number);
      for (const id of ids) await gh(["api", "graphql", "-f", `query=${RESOLVE_QUERY}`, "-f", `id=${id}`]);
      return (await threads(number)).length;
    },
    async squashMerge(branch) {
      await gh(["pr", "merge", branch, "--repo", `${options.owner}/${options.name}`, "--squash"]);
      const sha = (await gh(["pr", "view", branch, "--repo", `${options.owner}/${options.name}`, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"])).trim();
      const parents = (await run("git", ["-C", options.repo, "rev-parse", `${sha}^@`])).trim().split(/\s+/).filter((item) => item.length > 0);
      return { sha, parents: parents.length };
    },
    async noteRetarget(branch) {
      await gh(["pr", "edit", branch, "--repo", `${options.owner}/${options.name}`, "--base", options.trunk]);
    },
  };
}

/** The policy file. The core parser is the authority; this schema is what editors check. */
export const DeliveryPolicySchema = z.object({
  $schema: z.string().optional(),
  maxExtraDiskBytes: z.int().nonnegative(),
  minFreeDiskBytes: z.int().positive(),
  maxMemoryBytes: z.int().nonnegative(),
  maxTokens: z.int().nonnegative(),
  gpu: z.enum(["deny", "allow"]),
  timeoutMs: z.int().positive(),
  maxWorktrees: z.int().positive(),
}).strict();

export function deliveryPolicyJsonSchema(): object {
  return z.toJSONSchema(DeliveryPolicySchema, { io: "input" });
}

export function readDeliveryPolicy(json: string): ResourcePolicy {
  return parseResourcePolicy(JSON.parse(json));
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

export interface DeliveryPlan {
  readonly tasks: readonly DeliveryTask[];
  readonly prepares: Readonly<Record<string, readonly string[]>>;
  readonly gates: readonly { readonly command: string; readonly args: readonly string[] }[];
}

/** Tasks, an optional prepare command per task, and the local gates. */
export function readDeliveryPlan(json: string): DeliveryPlan {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new TypeError("delivery plan tasks must be an array");
  const listedTasks = field(parsed, "tasks");
  if (!Array.isArray(listedTasks)) throw new TypeError("delivery plan tasks must be an array");
  const tasks: DeliveryTask[] = [];
  const prepares: Record<string, readonly string[]> = {};
  for (const item of listedTasks) {
    if (!isRecord(item)) throw new TypeError("a delivery task needs an id, a branch, and paths");
    const id = field(item, "id");
    const branch = field(item, "branch");
    const paths = strings(field(item, "paths"));
    if (typeof id !== "string" || typeof branch !== "string" || paths === undefined || paths.length === 0) {
      throw new TypeError("a delivery task needs an id, a branch, and paths");
    }
    tasks.push({ id, branch, paths });
    const prepare = field(item, "prepare");
    if (prepare !== undefined) {
      const command = strings(prepare);
      if (command === undefined || command.length === 0) throw new TypeError(`task ${id} prepare must be a command`);
      prepares[id] = command;
    }
  }
  const gates: { command: string; args: readonly string[] }[] = [];
  const listed = field(parsed, "gates");
  if (listed !== undefined) {
    if (!Array.isArray(listed)) throw new TypeError("delivery plan gates must be an array");
    for (const gate of listed) {
      if (!isRecord(gate)) throw new TypeError("a delivery gate needs a command and args");
      const command = field(gate, "command");
      const args = strings(field(gate, "args"));
      if (typeof command !== "string" || args === undefined) throw new TypeError("a delivery gate needs a command and args");
      gates.push({ command, args });
    }
  }
  return { tasks, prepares, gates };
}

const SHIPPED_WORKFLOW = fileURLToPath(new URL("../data/git-delivery.workflow.yaml", import.meta.url));

/** YAML text to the declarative workflow document the static executor runs. */
export function loadDeclarativeWorkflow(text: string): DeclarativeWorkflow {
  return parseDeclarativeWorkflow(parseYaml(text));
}

/**
 * Run the delivery workflow file. The shipped file is the default; a runtime passes
 * its own text or path and the executor stays the same.
 */
export async function runDeclarativeDelivery(options: {
  readonly trunk: string;
  readonly tasks: readonly DeliveryTask[];
  readonly policy: ResourcePolicy;
  readonly effects: DeliveryEffects;
  readonly workflowText?: string;
  readonly workflowPath?: string;
}): Promise<DeclarativeReport> {
  const text = options.workflowText ?? readFileSync(options.workflowPath ?? SHIPPED_WORKFLOW, "utf8");
  return runDeliveryWorkflow(
    { trunk: options.trunk, tasks: options.tasks, policy: options.policy },
    options.effects,
    loadDeclarativeWorkflow(text),
  );
}

export interface DeliveryIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

/**
 * harness-deliver --repo <dir> --policy <delivery-policy.json> --tasks <tasks.json>
 * --worktrees <dir> --cache <path> [--trunk main] [--cache-name node_modules]
 * [--owner <owner> --name <repo>] [--author-name <name> --author-email <email>]
 * [--workflow <git-delivery.workflow.yaml>]
 * One task branch per worktree, sharing the cache by symlink. With --owner and --name
 * the stack is opened on GitHub; otherwise each squash is a local commit on the trunk.
 */
export async function deliverCommand(argv: readonly string[], io: DeliveryIo): Promise<number> {
  const usage = "usage: harness-deliver --repo <dir> --policy <delivery-policy.json> --tasks <tasks.json> --worktrees <dir> --cache <path> [--trunk main] [--cache-name node_modules] [--owner <owner> --name <repo>] [--author-name <name> --author-email <email>] [--workflow <file>]\n";
  let repo: string | undefined;
  let trunk: string;
  let policyPath: string | undefined;
  let tasksPath: string | undefined;
  let worktrees: string | undefined;
  let cache: string | undefined;
  let cacheName: string;
  let owner: string | undefined;
  let name: string | undefined;
  let authorName: string | undefined;
  let authorEmail: string | undefined;
  let workflowPath: string | undefined;
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        repo: { type: "string" },
        trunk: { type: "string", default: "main" },
        policy: { type: "string" },
        tasks: { type: "string" },
        worktrees: { type: "string" },
        cache: { type: "string" },
        "cache-name": { type: "string", default: "node_modules" },
        owner: { type: "string" },
        name: { type: "string" },
        "author-name": { type: "string" },
        "author-email": { type: "string" },
        workflow: { type: "string" },
      },
    });
    repo = parsed.values.repo;
    trunk = parsed.values.trunk;
    policyPath = parsed.values.policy;
    tasksPath = parsed.values.tasks;
    worktrees = parsed.values.worktrees;
    cache = parsed.values.cache;
    cacheName = parsed.values["cache-name"];
    owner = parsed.values.owner;
    name = parsed.values.name;
    authorName = parsed.values["author-name"];
    authorEmail = parsed.values["author-email"];
    workflowPath = parsed.values.workflow;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (repo === undefined || policyPath === undefined || tasksPath === undefined || worktrees === undefined || cache === undefined) {
    io.stderr(usage);
    return 2;
  }
  try {
    const policy = readDeliveryPolicy(readFileSync(policyPath, "utf8"));
    const plan = readDeliveryPlan(readFileSync(tasksPath, "utf8"));
    const author = authorName !== undefined && authorEmail !== undefined ? { name: authorName, email: authorEmail } : undefined;
    const identified = author === undefined ? {} : { author };
    const remote = owner !== undefined && name !== undefined
      ? githubPullRemote({ owner, name, trunk, repo })
      : gitStackRemote({ repo, trunk, ...identified });
    const logging: PullRemote = {
      open: async (branch, base) => {
        const actual = await remote.open(branch, base);
        io.stdout(`open ${branch} ${actual}\n`);
        return actual;
      },
      review: (branch) => remote.review(branch),
      resolve: (branch) => remote.resolve(branch),
      squashMerge: (branch) => remote.squashMerge(branch),
      noteRetarget: (branch, onto) => remote.noteRetarget(branch, onto),
    };
    const startedAt = Date.now();
    const report = await runDeclarativeDelivery({
      trunk,
      tasks: plan.tasks,
      policy,
      ...(workflowPath === undefined ? {} : { workflowPath }),
      effects: gitDeliveryEffects({
      repo,
      trunk,
      worktrees,
      cachePath: cache,
      cacheName,
      tasks: plan.tasks,
      policy,
      gates: plan.gates,
      remote: logging,
      clock: Date,
      startedAt,
      ...identified,
      prepare: async (wt, task) => {
        const command = plan.prepares[task.id];
        if (command === undefined || command[0] === undefined) return;
        await defaultRunner()(command[0], command.slice(1), { cwd: wt, env: gitEnv(author) });
      },
    }),
    });
    io.stdout(`${report.status}\n`);
    if (report.reason !== undefined) io.stderr(`${report.reason}\n`);
    return report.status === "done" ? 0 : 1;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
