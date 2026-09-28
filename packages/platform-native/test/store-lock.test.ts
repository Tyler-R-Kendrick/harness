import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lockStore, STORE_LOCK } from "@harness/platform-native";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "store-lock-"));
  dirs.push(dir);
  return dir;
}

/** The pid of a process that has exited. */
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""], { env: { NODE_OPTIONS: "" } }).pid!;

describe("the procedural store's lock", () => {
  it("PX2.72 the first holder takes the lock, which names its pid and holder; while it holds it, another is told who holds it", async () => {
    const dir = join(await scratch(), "store");
    const first = await lockStore(dir, "harness");
    expect(first.status).toBe("acquired");
    expect(JSON.parse(await readFile(join(dir, STORE_LOCK), "utf8"))).toEqual({ pid: process.pid, holder: "harness" });
    expect(await lockStore(dir, "harness-procedural")).toEqual({ status: "held", owner: { pid: process.pid, holder: "harness" } });
    // No scratch file is left behind by the refused attempt.
    expect((await readdir(dir)).sort()).toEqual([STORE_LOCK]);
    expect(STORE_LOCK).toBe("procedural.lock");
  });

  it("PX2.73 a lock whose process has exited, or that does not parse, is stale: the next holder takes it over", async () => {
    const dir = await scratch();
    await writeFile(join(dir, STORE_LOCK), JSON.stringify({ pid: deadPid(), holder: "harness" }));
    const taken = await lockStore(dir, "harness-procedural");
    expect(taken.status).toBe("acquired");
    expect(JSON.parse(await readFile(join(dir, STORE_LOCK), "utf8"))).toEqual({ pid: process.pid, holder: "harness-procedural" });
    for (const junk of ["", "{", JSON.stringify({ pid: "one", holder: "x" }), JSON.stringify({ pid: 0, holder: "x" }), JSON.stringify(null)]) {
      await writeFile(join(dir, STORE_LOCK), junk);
      expect((await lockStore(dir, "harness")).status).toBe("acquired");
    }
    // A live holder that is another user's process (EPERM on the signal) still holds it.
    await writeFile(join(dir, STORE_LOCK), JSON.stringify({ pid: 1, holder: "harness" }));
    expect(await lockStore(dir, "harness-procedural", { alive: () => true })).toEqual({ status: "held", owner: { pid: 1, holder: "harness" } });
  });

  it("PX2.74 a holder advertises its socket in the lock, and release removes only its own lock, once", async () => {
    const dir = await scratch();
    const result = await lockStore(dir, "harness");
    if (result.status !== "acquired") throw new Error("not acquired");
    await result.lock.advertise("/run/harness.sock");
    expect(await lockStore(dir, "harness-procedural")).toEqual({ status: "held", owner: { pid: process.pid, holder: "harness", socket: "/run/harness.sock" } });
    await result.lock.release();
    expect(existsSync(join(dir, STORE_LOCK))).toBe(false);
    await result.lock.release();
    // A lock another process took after this one's was released stays.
    await writeFile(join(dir, STORE_LOCK), JSON.stringify({ pid: 1, holder: "other" }));
    await result.lock.release();
    await expect(result.lock.advertise("/elsewhere.sock")).rejects.toThrow(/no longer holds/);
    expect(JSON.parse(await readFile(join(dir, STORE_LOCK), "utf8"))).toEqual({ pid: 1, holder: "other" });
    expect((await readdir(dir)).sort()).toEqual([STORE_LOCK]);
  });

  it("PX2.75 a lock that cannot be read or written is an error, not a lock, and leaves no scratch file", async () => {
    const dir = await scratch();
    await mkdir(join(dir, STORE_LOCK));
    await expect(lockStore(dir, "harness", { alive: () => false })).rejects.toThrow(/EISDIR/);
    expect(await readdir(dir)).toEqual([STORE_LOCK]);
    await writeFile(join(dir, "file"), "");
    await expect(lockStore(join(dir, "file"), "harness")).rejects.toThrow(/EEXIST|ENOTDIR/);
  });
});
