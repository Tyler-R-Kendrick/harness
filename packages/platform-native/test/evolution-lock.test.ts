import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SeededEntropy } from "@harness/testkit";
import { evolutionCommand } from "../src/evolution-command.ts";
import { lockPath, withStateLock } from "../src/state-lock.ts";
import { sleep } from "./evolution-process.ts";
import { evaluateSim } from "./evolution-sim.ts";
import { scenario } from "./evolution-world.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "evo-lock-"));
  dirs.push(d);
  return d;
};

/** The pid of a process that has exited. */
const deadPid = () => {
  const r = spawnSync(process.execPath, ["-e", ""]);
  return r.pid;
};

const holder = (path: string) => JSON.parse(readFileSync(lockPath(path), "utf8")) as { pid: number; startedAt: string };

describe("the state file's lock (EH13.30 to EH13.36)", () => {
  it("EH13.30 the lock is a file beside the state file naming this process and when it began; it exists while the work runs, and is gone after, whether the work returns or throws", async () => {
    const state = join(tmp(), "sub", "run.state.json");
    expect(lockPath(state)).toBe(`${state}.lock`);
    const before = Date.now();
    const answer = await withStateLock(state, async () => {
      const held = holder(state);
      expect(held.pid).toBe(process.pid);
      expect(new Date(held.startedAt).toISOString()).toBe(held.startedAt);
      expect(Date.parse(held.startedAt)).toBeGreaterThanOrEqual(before - 1000);
      return "done";
    });
    expect(answer).toBe("done");
    expect(existsSync(lockPath(state))).toBe(false);
    await expect(withStateLock(state, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(existsSync(lockPath(state))).toBe(false);
  });

  it("EH13.31 a second holder is refused while the first lives, with a message naming the holder and the lock file; the first's lock is untouched and its work not disturbed", async () => {
    const state = join(tmp(), "run.state.json");
    let entered = false;
    const first = withStateLock(state, async () => {
      await sleep(300);
      return "first";
    });
    await sleep(50);
    const held = holder(state);
    await expect(
      withStateLock(state, async () => {
        entered = true;
      }),
    ).rejects.toThrow(`${state} is in use by another harness-evolution (pid ${process.pid}, started ${held.startedAt}); wait for it to finish, or delete ${state}.lock if that process is not running`);
    expect(entered).toBe(false);
    expect(holder(state)).toEqual(held);
    expect(await first).toBe("first");
    expect(existsSync(lockPath(state))).toBe(false);
    // Free again.
    expect(await withStateLock(state, async () => "again")).toBe("again");
  });

  it("EH13.32 a lock whose process is dead is stale: it is taken over, held by this process meanwhile, and released", async () => {
    const state = join(tmp(), "run.state.json");
    writeFileSync(lockPath(state), JSON.stringify({ pid: deadPid(), startedAt: "2020-01-01T00:00:00.000Z" }));
    expect(await withStateLock(state, async () => holder(state).pid)).toBe(process.pid);
    expect(existsSync(lockPath(state))).toBe(false);
  });

  it("EH13.33 a lock file that is empty or not a lock is stale too (a crash between creating it and writing it)", async () => {
    const state = join(tmp(), "run.state.json");
    for (const content of ["", "not json", "{}", JSON.stringify({ pid: "1", startedAt: "x" }), JSON.stringify({ pid: -1, startedAt: "x" }), JSON.stringify({ pid: 0, startedAt: "x" })]) {
      writeFileSync(lockPath(state), content);
      expect(await withStateLock(state, async () => "ok"), content).toBe("ok");
    }
  });

  it("EH13.34 when two processes find the same stale lock, exactly one takes it over", async () => {
    const state = join(tmp(), "run.state.json");
    writeFileSync(lockPath(state), JSON.stringify({ pid: deadPid(), startedAt: "2020-01-01T00:00:00.000Z" }));
    const work = async () => {
      await sleep(150);
      return "held";
    };
    const results = await Promise.allSettled([withStateLock(state, work), withStateLock(state, work), withStateLock(state, work)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
    for (const r of results) if (r.status === "rejected") expect((r.reason as Error).message).toMatch(/is in use by another harness-evolution/);
    expect(existsSync(lockPath(state))).toBe(false);
    expect(existsSync(`${lockPath(state)}.takeover`)).toBe(false);
  });

  it("EH13.35 a takeover left behind by a process that died is cleared once it is old", async () => {
    const state = join(tmp(), "run.state.json");
    writeFileSync(lockPath(state), JSON.stringify({ pid: deadPid(), startedAt: "2020-01-01T00:00:00.000Z" }));
    writeFileSync(`${lockPath(state)}.takeover`, "");
    const old = new Date(Date.now() - 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(`${lockPath(state)}.takeover`, old, old);
    expect(await withStateLock(state, async () => "ok")).toBe("ok");
    expect(existsSync(`${lockPath(state)}.takeover`)).toBe(false);
  });
});

describe("the commands that write the state take the lock (EH13.36)", () => {
  async function cli(args: readonly string[]) {
    let out = "";
    let err = "";
    const code = await evolutionCommand(args, { stdout: (s) => void (out += s), stderr: (s) => void (err += s) }, { evaluate: evaluateSim, entropy: new SeededEntropy(7) });
    return { code, out, err };
  }

  it("EH13.36 start, round, run and documents --write are refused (exit 1, naming the holder) while another process holds the lock; status and documents without --write are not; the lock is gone after each command, failed or not", async () => {
    const s = scenario(tmp());
    expect(await cli(["start", "--config", s.config])).toMatchObject({ code: 0 });
    expect(existsSync(lockPath(s.state))).toBe(false);
    let refusals = "";
    const held = withStateLock(s.state, async () => {
      const commands = [["start", "--force"], ["round", "--model", "m"], ["run", "--model", "m"], ["documents", "--write"]];
      for (const c of commands) {
        const r = await cli([c[0]!, "--config", s.config, ...c.slice(1)]);
        expect({ command: c.join(" "), code: r.code, out: r.out }).toEqual({ command: c.join(" "), code: 1, out: "" });
        refusals += r.err;
        expect(r.err).toBe(`${s.state} is in use by another harness-evolution (pid ${process.pid}, started ${holder(s.state).startedAt}); wait for it to finish, or delete ${s.state}.lock if that process is not running\n`);
      }
      // Reading needs no lock.
      expect(await cli(["status", "--config", s.config])).toMatchObject({ code: 0 });
      expect(await cli(["documents", "--config", s.config])).toMatchObject({ code: 0 });
    });
    await held;
    expect(refusals).not.toBe("");
    expect(existsSync(lockPath(s.state))).toBe(false);
    // A command that fails (no model to reach, here: the run is unchanged) still releases the lock.
    const failing = await cli(["round", "--config", join(s.dir, "absent.json"), "--model", "m"]);
    expect(failing.code).toBe(1);
    const noRun = await cli(["documents", "--config", s.config, "--write", "--state", join(s.dir, "other.json")]);
    expect(noRun.code).toBe(1);
    expect(noRun.err).toContain("no run in");
    expect(existsSync(lockPath(join(s.dir, "other.json")))).toBe(false);
  });
});
