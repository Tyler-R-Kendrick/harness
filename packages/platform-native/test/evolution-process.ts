// Helpers for tests that run real child processes and must show that none of a command's process group survives (Linux: /proc).
import { existsSync, readdirSync, readFileSync } from "node:fs";

/** The live (not zombie) processes in a process group. */
export function groupMembers(pgid: number): number[] {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .flatMap((pid) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        // After the command's name (in parentheses): state, parent, process group.
        const [state, , group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return group === String(pgid) && state !== "Z" ? [Number(pid)] : [];
      } catch {
        return [];
      }
    });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits (up to `ms`) until a file exists, and answers its text. */
export async function fileText(path: string, ms = 5000): Promise<string> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      if (text.endsWith("\n") || text.length > 0) return text.trim();
    }
    await sleep(20);
  }
  throw new Error(`${path} never appeared`);
}

/** Waits (up to `ms`) until nothing of the group is alive; answers what still was. */
export async function gone(pgid: number, ms = 3000): Promise<number[]> {
  const end = Date.now() + ms;
  let members = groupMembers(pgid);
  while (members.length && Date.now() < end) {
    await sleep(25);
    members = groupMembers(pgid);
  }
  return members;
}

export const onLinux = process.platform === "linux";

/** Waits (up to `ms`) until a process is gone (or a zombie); whether it is. */
export async function stopped(pid: number, ms = 3000): Promise<boolean> {
  const running = () => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
    } catch {
      return false;
    }
  };
  const end = Date.now() + ms;
  while (running() && Date.now() < end) await sleep(25);
  return !running();
}
