/**
 * The agent's tools on the playground's virtual filesystem: a just-bash shell (the same
 * instance the terminal runs, so the person and the agent see one filesystem), and a
 * walk and diff of that filesystem so every turn's effect on it can be shown.
 *
 * `bash-tool` (Vercel's AI SDK tools for just-bash) imports `node:fs`, `node:path` and
 * fast-glob at module load, so it does not bundle for a browser page; these three tools
 * keep its names and shapes (see ADR 0011).
 */
import { jsonSchema, tool } from "ai";
import type { ToolApprovalStatus, ToolSet } from "ai";
import type { Bash, IFileSystem } from "just-bash";

export const HOME = "/home/user";
/** The environment every shell here runs with: `~` is home, and so is the working directory. */
export const SHELL_ENV: Readonly<Record<string, string>> = { HOME, PWD: HOME };

/** Whether commands and writes wait for the person (`ask`) or run at once (`auto`). */
export type ApprovalPolicy = "ask" | "auto";

export interface FileEntry {
  readonly size: number;
  /** When it last changed, in milliseconds since the epoch. */
  readonly mtime: number;
  /** The file's text, when it is small enough to keep. */
  readonly text?: string;
  /** A symbolic link's target (the link is listed, never followed). */
  readonly link?: string;
}

export interface VfsDiff {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly removed: readonly string[];
}

const resolve = (path: string) => (path.startsWith("/") ? path : `${HOME}/${path}`);

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[cut: ${text.length - max} more characters]`;
}

/** `bash`, `readFile` and `writeFile` on a just-bash shell, as AI SDK tools. */
export function vfsTools(bash: Bash, options: { readonly maxOutput?: number } = {}) {
  const max = options.maxOutput ?? 16_000;
  return {
    bash: tool({
      description: `Run a bash command in a sandboxed shell with a virtual filesystem (the working directory is ${HOME}). Returns stdout, stderr and the exit code. Common Unix tools are available; there is no network.`,
      inputSchema: jsonSchema<{ command: string }>({ type: "object", properties: { command: { type: "string", description: "The command line to run" } }, required: ["command"] }),
      execute: async ({ command }, { abortSignal }) => {
        const r = await bash.exec(command, { cwd: HOME, env: { ...SHELL_ENV }, ...(abortSignal ? { signal: abortSignal } : {}) });
        return { stdout: cut(r.stdout, max), stderr: cut(r.stderr, max), exitCode: r.exitCode };
      },
    }),
    readFile: tool({
      description: `Read a text file (a path relative to ${HOME}, or absolute).`,
      inputSchema: jsonSchema<{ path: string }>({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
      execute: async ({ path }) => ({ content: cut(await bash.fs.readFile(resolve(path)), max) }),
    }),
    writeFile: tool({
      description: `Write a text file, creating its directories (a path relative to ${HOME}, or absolute).`,
      inputSchema: jsonSchema<{ path: string; content: string }>({ type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }),
      execute: async ({ path, content }) => {
        const file = resolve(path);
        await bash.fs.mkdir(file.slice(0, file.lastIndexOf("/")) || "/", { recursive: true });
        await bash.fs.writeFile(file, content);
        return { success: true, path: file };
      },
    }),
  } satisfies ToolSet;
}

/** The approval each tool call needs under the current policy: reads never ask. */
export function vfsApproval(policy: () => ApprovalPolicy): (options: { readonly toolCall: { readonly toolName: string } }) => ToolApprovalStatus {
  return ({ toolCall }) => (policy() === "ask" && toolCall.toolName !== "readFile" ? "user-approval" : "not-applicable");
}

/**
 * Every file under `root`, depth first in name order, with its size, time and (when small)
 * its text; links are listed with their target, not followed. Given the `previous` walk,
 * a file whose size and time are unchanged keeps its text from there rather than being read again.
 */
export async function walk(fs: IFileSystem, root: string, options: { readonly maxText?: number; readonly previous?: ReadonlyMap<string, FileEntry> | undefined } = {}): Promise<Map<string, FileEntry>> {
  const maxText = options.maxText ?? 64_000;
  const files = new Map<string, FileEntry>();
  const visit = async (dir: string): Promise<void> => {
    const names = await fs.readdir(dir).catch(() => []);
    for (const name of [...names].sort()) {
      const path = `${dir}/${name}`.replace(/^\/\//, "/");
      const stat = await fs.lstat(path);
      const known = { size: stat.size, mtime: stat.mtime.getTime() };
      const was = options.previous?.get(path);
      if (stat.isSymbolicLink) files.set(path, { ...known, size: 0, link: await fs.readlink(path) });
      else if (stat.isDirectory) await visit(path);
      else if (stat.size > maxText) files.set(path, known);
      else if (was?.text !== undefined && was.size === known.size && was.mtime === known.mtime) files.set(path, was);
      else files.set(path, { ...known, text: await fs.readFile(path) });
    }
  };
  await visit(root);
  return files;
}

/** What changed between two walks: files kept as text by their text, others by their size and time, links by their target. */
export function diffVfs(before: ReadonlyMap<string, FileEntry>, after: ReadonlyMap<string, FileEntry>): VfsDiff {
  const added = [...after.keys()].filter((p) => !before.has(p));
  const removed = [...before.keys()].filter((p) => !after.has(p));
  const modified = [...after].filter(([p, e]) => {
    const was = before.get(p);
    if (was === undefined) return false;
    if (was.link !== undefined || e.link !== undefined) return was.link !== e.link;
    return was.text !== undefined && e.text !== undefined ? was.text !== e.text : was.size !== e.size || was.mtime !== e.mtime;
  });
  return { added, modified: modified.map(([p]) => p), removed };
}
