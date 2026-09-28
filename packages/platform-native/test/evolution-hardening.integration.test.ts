import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateSchema } from "@harness/evolution";
import { lockPath } from "../src/state-lock.ts";
import { fileText, gone, groupMembers, onLinux, sleep, stopped } from "./evolution-process.ts";
import { scenario } from "./evolution-world.ts";

const CLI = new URL("../src/evolution-cli.ts", import.meta.url).pathname;
const SLOW = new URL("./fixtures/slow-evaluator.ts", import.meta.url).pathname;
const GROUP = new URL("../src/process-group.ts", import.meta.url).pathname;
const env = { PATH: process.env["PATH"] ?? "", NODE_OPTIONS: "" };

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "evo-hi-"));
  dirs.push(d);
  return d;
};

interface Running {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }>;
}

/** Start `harness-evolution` as a real process. */
function cli(args: readonly string[]): Running {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (err += d.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }>((resolve) => child.on("close", (code, signal) => resolve({ code, signal, out, err })));
  return { child, exited };
}

describe("harness-evolution as real processes (EH13.50 to EH13.54)", () => {
  it("EH13.50 two concurrent runs on one state: the second is refused, naming the first, and the state holds one run measured once", async () => {
    const dir = tmp();
    const pidfile = join(dir, "evaluator.pid");
    const s = scenario(dir, { evaluator: [process.execPath, SLOW, "1500", pidfile] });
    const first = cli(["start", "--config", s.config]);
    await fileText(pidfile, 15_000);
    const held = JSON.parse(readFileSync(lockPath(s.state), "utf8")) as { pid: number; startedAt: string };
    expect(held.pid).toBe(first.child.pid);
    const second = await cli(["start", "--config", s.config, "--force"]).exited;
    expect(second).toMatchObject({ code: 1, out: "" });
    expect(second.err).toBe(`${s.state} is in use by another harness-evolution (pid ${held.pid}, started ${held.startedAt}); wait for it to finish, or delete ${s.state}.lock if that process is not running\n`);
    const finished = await first.exited;
    expect(finished).toMatchObject({ code: 0, err: "" });
    expect(finished.out).toContain(`run started in ${s.state}`);
    expect(existsSync(lockPath(s.state))).toBe(false);
    const state = StateSchema.parse((JSON.parse(readFileSync(s.state, "utf8")) as { evolution: unknown }).evolution);
    expect(state.round).toBe(0);
  }, 40_000);

  it("EH13.51 a lock left by a process that is gone is taken over by the next run", async () => {
    const dir = tmp();
    const s = scenario(dir, { evaluator: [process.execPath, SLOW, "0"] });
    const dead = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => dead.on("close", r));
    writeFileSync(lockPath(s.state), JSON.stringify({ pid: dead.pid, startedAt: "2020-01-01T00:00:00.000Z" }));
    const r = await cli(["start", "--config", s.config]).exited;
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(existsSync(lockPath(s.state))).toBe(false);
    expect(existsSync(s.state)).toBe(true);
  }, 40_000);

  it.skipIf(!onLinux)("EH13.52 SIGTERM to the command kills the evaluator's process group, releases the lock, saves nothing and exits 143", async () => {
    const dir = tmp();
    const pidfile = join(dir, "evaluator.pid");
    const s = scenario(dir, { evaluator: [process.execPath, SLOW, "60000", pidfile] });
    const running = cli(["start", "--config", s.config]);
    const evaluator = Number(await fileText(pidfile, 15_000));
    expect(groupMembers(evaluator).length).toBeGreaterThan(0);
    expect(existsSync(lockPath(s.state))).toBe(true);
    running.child.kill("SIGTERM");
    const r = await running.exited;
    expect(r).toMatchObject({ code: 143, signal: null });
    expect(await gone(evaluator)).toEqual([]);
    expect(await stopped(evaluator)).toBe(true);
    expect(existsSync(lockPath(s.state))).toBe(false);
    expect(existsSync(s.state)).toBe(false);
  }, 40_000);

  it.skipIf(!onLinux)("EH13.53 SIGINT does the same (a Ctrl-C at the terminal reaches only the command, not the evaluator's own group)", async () => {
    const dir = tmp();
    const pidfile = join(dir, "evaluator.pid");
    const s = scenario(dir, { evaluator: [process.execPath, SLOW, "60000", pidfile] });
    const running = cli(["start", "--config", s.config]);
    const evaluator = Number(await fileText(pidfile, 15_000));
    running.child.kill("SIGINT");
    expect(await running.exited).toMatchObject({ code: 130 });
    expect(await gone(evaluator)).toEqual([]);
    expect(existsSync(lockPath(s.state))).toBe(false);
  }, 40_000);

  it.skipIf(!onLinux)("EH13.54 a process that exits while a command runs takes the command's group with it", async () => {
    const dir = tmp();
    const pidfile = join(dir, "pid");
    const script = `
      import { runInGroup } from ${JSON.stringify(GROUP)};
      runInGroup({ command: ["sh", "-c", "echo $$ > ${pidfile}; sleep 60 | cat"], cwd: ${JSON.stringify(dir)}, env: { PATH: process.env.PATH }, input: "", timeoutMs: 60000, maxOutputBytes: 1000 });
      const fs = await import("node:fs");
      while (!fs.existsSync(${JSON.stringify(pidfile)})) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 150));
      process.exit(0);`;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", script], { env, stdio: "ignore" });
    children.push(parent);
    const exited = new Promise((r) => parent.on("close", r));
    const pid = Number(await fileText(pidfile, 15_000));
    await sleep(50);
    expect(groupMembers(pid).length).toBeGreaterThan(0);
    await exited;
    expect(await gone(pid)).toEqual([]);
  }, 40_000);
});
