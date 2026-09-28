import { execFile, spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { revisionId, seedGraph } from "@harness/procedural";
import { invokeDaemon, STORE_LOCK } from "@harness/platform-native";

const run = promisify(execFile);
const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const CLI = new URL("../src/procedural-cli.ts", import.meta.url).pathname;
const env = { ...process.env, NODE_OPTIONS: "" };
const children: ChildProcessWithoutNullStreams[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "procedural-lock-"));
  dirs.push(dir);
  const store = join(dir, "store");
  const cli = (...args: string[]) => run(process.execPath, [CLI, ...args, "--procedural", store], { env });
  const json = async (...args: string[]) => JSON.parse((await cli(...args)).stdout) as Record<string, unknown>;
  return { dir, store, cli, json };
}

/** The daemon over the store in `store`: with the cognitive core (no hosted models) it serves procedural.*; `ready` resolves once it listens, `exited` with its exit code. */
function daemon(dir: string, store: string, transport: string[]) {
  const child = spawn(process.execPath, [MAIN, ...transport, "--worker", "echo", "--cognitive", "--no-hosted", "--model-cache", join(dir, "models"), "--procedural", store], { env });
  children.push(child);
  let stderr = "";
  const ready = new Promise<void>((resolve) => {
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (/harness listening on|in use by/.test(stderr)) resolve();
    });
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { child, ready, exited, stderr: () => stderr };
}

/** The pid of a process that has exited. */
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""], { env: { NODE_OPTIONS: "" } }).pid!;

describe("one owner per procedural store", () => {
  it("PX2.73 while a daemon holds the store and listens on a socket, harness-procedural sends its operations to the daemon", async () => {
    const { dir, store, cli, json } = await scratch();
    const socket = join(dir, "harness.sock");
    const d = daemon(dir, store, ["--socket", socket]);
    await d.ready;
    expect(JSON.parse(await readFile(join(store, STORE_LOCK), "utf8"))).toEqual({ pid: d.child.pid, holder: "harness", socket });
    expect(await json("import", "team/search")).toEqual({ status: "head", revision: revisionId(seedGraph()) });
    // The daemon's own store has it, and a write through the daemon after the CLI's is kept with it.
    expect(await invokeDaemon(socket, "procedural.history", { graph: "team/search" })).toMatchObject({ head: revisionId(seedGraph()) });
    expect(await invokeDaemon(socket, "procedural.import", { graph: "team/other" })).toMatchObject({ status: "head" });
    await cli("export", "team/search", "--format", "mermaid", "--out", join(dir, "graph.mmd"));
    expect(await readFile(join(dir, "graph.mmd"), "utf8")).toMatch(/^flowchart TD\n/);
    // Options that configure a local run do not apply to the daemon's, and the CLI says so.
    const noted = await cli("history", "team/search", "--preset", "paper", "--no-hosted");
    expect(JSON.parse(noted.stdout)).toMatchObject({ head: revisionId(seedGraph()) });
    expect(noted.stderr).toContain(`harness (pid ${d.child.pid}) holds ${store}: sending history to it on ${socket}`);
    expect(noted.stderr).toContain("ignoring --preset, --no-hosted");
    // A result the caller handles still exits 1, and so does a refusal from the daemon.
    await expect(cli("revert", "team/search")).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"refused"') });
    await expect(cli("revert", "team/search", "--to", "abc")).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/invalid procedural\.revert input/) });

    d.child.kill("SIGTERM");
    expect(await d.exited).toBe(0);
    expect(existsSync(join(store, STORE_LOCK))).toBe(false);
    // With the daemon gone the CLI opens the store itself, and sees both graphs the daemon saved.
    expect(await json("history", "team/other")).toMatchObject({ head: revisionId(seedGraph()) });
    expect(await json("history", "team/search")).toMatchObject({ head: revisionId(seedGraph()) });
  });

  it("PX2.74 a daemon that holds the store without a socket makes harness-procedural refuse, and the store is untouched", async () => {
    const { dir, store, cli } = await scratch();
    const d = daemon(dir, store, ["--stdio"]);
    for (let i = 0; i < 200 && !existsSync(join(store, STORE_LOCK)); i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(JSON.parse(await readFile(join(store, STORE_LOCK), "utf8"))).toEqual({ pid: d.child.pid, holder: "harness" });
    await expect(cli("import", "team/search")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`the procedural store in ${store} is in use by harness (pid ${d.child.pid}), which serves no socket`),
    });
    expect(existsSync(join(store, "procedural.json"))).toBe(false);
    d.child.stdin.end();
    expect(await d.exited).toBe(0);
    expect(existsSync(join(store, STORE_LOCK))).toBe(false);
  });

  it("PX2.75 a daemon refuses to start while another process holds the store; a stale lock does not stop it", async () => {
    const { dir, store } = await scratch();
    await mkdir(store, { recursive: true });
    await writeFile(join(store, STORE_LOCK), JSON.stringify({ pid: process.pid, holder: "harness-procedural" }));
    const refused = daemon(dir, store, ["--socket", join(dir, "a.sock")]);
    expect(await refused.exited).toBe(1);
    expect(refused.stderr()).toContain(`the procedural store in ${store} is in use by harness-procedural (pid ${process.pid}); stop it first`);
    expect(existsSync(join(dir, "a.sock"))).toBe(false);

    await writeFile(join(store, STORE_LOCK), JSON.stringify({ pid: deadPid(), holder: "harness-procedural" }));
    const started = daemon(dir, store, ["--socket", join(dir, "b.sock")]);
    await started.ready;
    expect(JSON.parse(await readFile(join(store, STORE_LOCK), "utf8"))).toMatchObject({ pid: started.child.pid, holder: "harness" });
    started.child.kill("SIGTERM");
    expect(await started.exited).toBe(0);
  });

  it("PX2.76 with no daemon, harness-procedural takes the lock for its run and releases it; a stale lock does not stop it", async () => {
    const { store, json } = await scratch();
    await mkdir(store, { recursive: true });
    await writeFile(join(store, STORE_LOCK), JSON.stringify({ pid: deadPid(), holder: "harness" }));
    expect(await json("import", "team/search")).toEqual({ status: "head", revision: revisionId(seedGraph()) });
    expect(existsSync(join(store, STORE_LOCK))).toBe(false);
    expect((await stat(join(store, "procedural.json"))).isFile()).toBe(true);
  });
});
