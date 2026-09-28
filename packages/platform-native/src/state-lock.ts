import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/** The lock file of a state file: beside it, so that whoever can reach the state can see who holds it. */
export const lockPath = (statePath: string): string => `${statePath}.lock`;

const HolderSchema = z.strictObject({ pid: z.int().positive(), startedAt: z.string() });
type Holder = z.output<typeof HolderSchema>;

/** A takeover older than this was abandoned by a process that died in the middle of it. */
const ABANDONED_MS = 10_000;
/** How long a lock that cannot be read is waited on (its creator may be about to write it), and how often it is looked at again. */
const UNREADABLE_MS = 250;
const RETRY_MS = 15;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

/** Whether a process is running (one this user cannot signal, EPERM, is). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return code(e) === "EPERM";
  }
}

/** The locks this process holds, released when it exits however it does (an exit, a signal handler's `process.exit`, an uncaught error). */
const held = new Set<string>();
let hooked = false;
const releaseHeld = () => {
  for (const path of held) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  }
  held.clear();
};

/** What a lock file says, or undefined when it is not (yet) a lock. */
async function holderOf(path: string): Promise<Holder | undefined> {
  const end = Date.now() + UNREADABLE_MS;
  for (;;) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      if (code(e) === "ENOENT") return undefined;
      throw e;
    }
    try {
      const parsed = HolderSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON: written in part, or not a lock.
    }
    if (Date.now() >= end) return undefined;
    await sleep(RETRY_MS);
  }
}

/** Create the lock exclusively (`wx`): true when this process now holds it. */
async function create(path: string, holder: Holder): Promise<boolean> {
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch (e) {
    if (code(e) === "EEXIST") return false;
    throw e;
  }
  try {
    await file.writeFile(JSON.stringify(holder));
  } finally {
    await file.close();
  }
  return true;
}

const same = (a: Holder | undefined, b: Holder | undefined) => a?.pid === b?.pid && a?.startedAt === b?.startedAt;

/**
 * Take over a stale lock. Only one process at a time may: the takeover is itself guarded by
 * a file made with `wx`, and under it the lock is looked at again, so a lock another process
 * has just taken over (which is alive) is never removed. Answers whether this process holds the lock now.
 */
async function takeOver(path: string, seen: Holder | undefined, mine: Holder): Promise<boolean> {
  const guard = `${path}.takeover`;
  if (!(await create(guard, mine))) {
    // Someone else is at it; one that died in the middle leaves the guard behind.
    try {
      if (Date.now() - (await stat(guard)).mtimeMs > ABANDONED_MS) await unlink(guard);
    } catch {
      // Gone already.
    }
    return false;
  }
  try {
    const now = await holderOf(path);
    if (!same(now, seen) || (now !== undefined && alive(now.pid))) return false;
    try {
      await unlink(path);
    } catch (e) {
      if (code(e) !== "ENOENT") throw e;
    }
    return await create(path, mine);
  } finally {
    await unlink(guard).catch(() => {});
  }
}

/**
 * Hold the state file's lock while `work` runs: an advisory lock, a file beside the state
 * file made with the `wx` flag that names the process holding it (pid) and when it began.
 * Two runs on one state would each load it and the last write would win (rounds lost or
 * repeated, the holdout's budget reset), so a second holder is refused, naming the first.
 * A lock whose process is no longer running is stale (a crash or a kill) and is taken over.
 * The lock is released when `work` ends, however it does, and when this process exits.
 * Limits: it is advisory (a process that ignores it is not stopped), a process id can be
 * reused by an unrelated process (then delete the lock file, as the message says), and it
 * does not work across machines sharing a network file system.
 */
export async function withStateLock<T>(statePath: string, work: () => Promise<T>): Promise<T> {
  const path = lockPath(statePath);
  await mkdir(dirname(path), { recursive: true });
  const mine: Holder = { pid: process.pid, startedAt: new Date().toISOString() };
  for (;;) {
    if (await create(path, mine)) break;
    const holder = await holderOf(path);
    if (holder !== undefined && alive(holder.pid)) throw new Error(`${statePath} is in use by another harness-evolution (pid ${holder.pid}, started ${holder.startedAt}); wait for it to finish, or delete ${path} if that process is not running`);
    if (await takeOver(path, holder, mine)) break;
    await sleep(RETRY_MS);
  }
  held.add(path);
  if (!hooked) {
    hooked = true;
    process.on("exit", releaseHeld);
  }
  try {
    return await work();
  } finally {
    // Only ever our own lock: what is there now is ours unless something removed it.
    held.delete(path);
    const now = await holderOf(path).catch(() => undefined);
    if (same(now, mine)) await unlink(path).catch(() => {});
  }
}
