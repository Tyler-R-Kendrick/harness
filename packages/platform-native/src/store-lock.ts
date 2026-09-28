import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

/**
 * One owner per procedural store directory (P12, A1). The store is a single snapshot
 * file that its process loads once and saves whole, so two processes over one directory
 * would overwrite each other. The daemon (`--procedural <dir>`) and `harness-procedural`
 * both take this lock before they open the store: the daemon refuses to start while
 * another process holds it, and the CLI, finding a daemon that advertises its ACP socket
 * in the lock, sends its operation to that daemon instead of opening the file.
 *
 * The lock is a file created atomically (a hard link of a complete file, which fails when
 * one exists), naming the holder's pid, a label and, once it listens, its socket. A lock
 * whose process has exited, or that does not parse, is stale and is taken over.
 */

/** The lock file's name in the store directory. */
export const STORE_LOCK = "procedural.lock";

export interface LockOwner {
  readonly pid: number;
  /** Who holds it: `harness` (the daemon) or `harness-procedural` (the CLI). */
  readonly holder: string;
  /** The daemon's ACP socket, once it listens on one. */
  readonly socket?: string;
}

export interface StoreLock {
  /** Name the socket this holder serves ACP on, for a CLI that finds the store held. */
  advertise(socket: string): Promise<void>;
  /** Remove the lock if this holder still has it; safe to call more than once. */
  release(): Promise<void>;
}

export type LockResult = { readonly status: "acquired"; readonly lock: StoreLock } | { readonly status: "held"; readonly owner: LockOwner };

const LockOwnerSchema = z.strictObject({ pid: z.int().positive(), holder: z.string(), socket: z.string().exactOptional() });

/** Whether a process exists: signal 0 checks without signalling, and EPERM means it exists as another user's. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock's owner; `undefined` when it does not parse, `null` when there is no lock. */
async function readOwner(path: string): Promise<LockOwner | undefined | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    const parsed = LockOwnerSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const same = (a: LockOwner | undefined | null, b: LockOwner): boolean => a?.pid === b.pid && a.holder === b.holder;

function heldLock(path: string, mine: LockOwner): StoreLock {
  return {
    advertise: async (socket) => {
      if (!same(await readOwner(path), mine)) throw new Error(`this process no longer holds ${path}`);
      await writeFileAtomic(path, JSON.stringify({ ...mine, socket }), { mode: 0o600 });
    },
    release: async () => {
      if (same(await readOwner(path), mine)) await rm(path, { force: true });
    },
  };
}

/**
 * Take the lock on the store in `dir` for `holder`, or say who holds it. `alive` decides
 * whether a holder's process still runs (by default, a signal-0 check on its pid).
 */
export async function lockStore(dir: string, holder: string, options: { readonly alive?: (pid: number) => boolean } = {}): Promise<LockResult> {
  const alive = options.alive ?? processAlive;
  await mkdir(dir, { recursive: true });
  const path = join(dir, STORE_LOCK);
  const mine: LockOwner = { pid: process.pid, holder };
  // The lock appears whole or not at all: a complete scratch file is linked into place.
  const scratch = join(dir, `.${STORE_LOCK}.${process.pid}.${randomUUID()}`);
  await writeFile(scratch, JSON.stringify(mine), { mode: 0o600 });
  try {
    for (;;) {
      try {
        await link(scratch, path);
        return { status: "acquired", lock: heldLock(path, mine) };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const owner = await readOwner(path);
      if (owner !== null && owner !== undefined && alive(owner.pid)) return { status: "held", owner };
      // Stale (or released since the link failed): clear it and try again.
      await rm(path, { force: true });
    }
  } finally {
    await rm(scratch, { force: true });
  }
}
