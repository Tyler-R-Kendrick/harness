import { spawn } from "node:child_process";

/**
 * Commands run in a process group of their own, so that stopping one stops everything it
 * started: `child.kill()` reaches only the direct child, and a grandchild holding the pipe
 * (`sh -c 'a | b'`) or a child that ignores SIGTERM would otherwise outlive the timeout and
 * keep the promise pending. On POSIX a detached child is the leader of a new process group
 * (its pid is the group id), and `kill(-pid)` signals the whole group. Windows has no
 * process groups to signal: there only the direct child is killed (a documented limitation).
 */
export const HAS_GROUPS = process.platform !== "win32";

/** How long a group gets to leave after SIGTERM before it is killed with SIGKILL. */
export const KILL_GRACE_MS = 250;

/** How often a stopping group is looked at, to settle as soon as it is gone. */
const POLL_MS = 20;

/** The groups of commands that are running: the ones to kill when this process exits. */
const live = new Set<number>();
let hooked = false;

/** Signal every process of a group; a group that is already gone is not an error. */
export function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(HAS_GROUPS ? -pgid : pgid, signal);
  } catch {
    // ESRCH: nothing of it is left. EPERM cannot happen for a group this process made.
  }
}

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Kill every group still running (what the process's exit, and the CLI's signal handlers, do: a command never outlives the run that started it). */
export function killLiveGroups(): void {
  for (const pgid of live) killGroup(pgid, "SIGKILL");
  live.clear();
}

const hook = () => {
  if (hooked) return;
  hooked = true;
  process.on("exit", killLiveGroups);
};

/** The result of running a command in a group; running never rejects. */
export type GroupResult =
  | { readonly kind: "exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: Buffer; readonly stderr: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "overflow" }
  | { readonly kind: "spawn-error"; readonly error: Error };

export interface GroupRun {
  readonly command: readonly string[];
  readonly cwd: string;
  /** The child's whole environment (never the parent's). */
  readonly env: Readonly<Record<string, string>>;
  readonly input: string;
  readonly timeoutMs: number;
  /** The most it may write to stdout; more stops it. */
  readonly maxOutputBytes: number;
}

/**
 * Run a command in its own process group with `input` on stdin. When it takes longer than
 * `timeoutMs`, or writes more than `maxOutputBytes` to stdout, its group gets SIGTERM and,
 * `KILL_GRACE_MS` later at the latest, SIGKILL, and the promise settles then (as soon as the
 * group is gone), whether or not the command or its grandchildren ever close their pipes.
 * However the command ends, nothing of its group is left running.
 */
export function runInGroup({ command, cwd, env, input, timeoutMs, maxOutputBytes }: GroupRun): Promise<GroupResult> {
  return new Promise((settle) => {
    const [file, ...args] = command as [string, ...string[]];
    const child = spawn(file, args, { cwd, env: { ...env }, stdio: ["pipe", "pipe", "pipe"], detached: HAS_GROUPS });
    const pgid = child.pid;
    if (pgid !== undefined) {
      live.add(pgid);
      hook();
    }
    const out: Buffer[] = [];
    let size = 0;
    let err = "";
    let stopping = false;
    let done = false;
    let poll: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;

    const finish = (result: GroupResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      clearTimeout(grace);
      if (pgid !== undefined) {
        killGroup(pgid, "SIGKILL");
        live.delete(pgid);
      }
      settle(result);
    };

    const stop = (kind: "timeout" | "overflow") => {
      if (stopping || done) return;
      stopping = true;
      clearTimeout(timer);
      if (pgid === undefined) return finish({ kind });
      killGroup(pgid, "SIGTERM");
      grace = setTimeout(() => finish({ kind }), KILL_GRACE_MS);
      poll = setInterval(() => {
        if (!groupAlive(pgid)) finish({ kind });
      }, POLL_MS);
    };

    // (`finish` and `stop` only run later, from events and timers, when this exists.)
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (stopping) return;
      size += d.length;
      if (size > maxOutputBytes) {
        out.length = 0;
        stop("overflow");
      } else out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    // A child that exits before reading its input is reported by its exit code.
    child.stdin.on("error", () => {});
    child.on("error", (error) => finish({ kind: "spawn-error", error }));
    child.on("close", (code, signal) => {
      if (!stopping) finish({ kind: "exit", code, signal, stdout: Buffer.concat(out), stderr: err });
    });
    child.stdin.end(input);
  });
}
