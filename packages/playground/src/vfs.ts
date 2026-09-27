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

/** Whether commands and writes wait for the person (`ask`) or run at once (`auto`). */
export type ApprovalPolicy = "ask" | "auto";

export interface FileEntry {
  readonly size: number;
  /** The file's text, when it is small enough to keep. */
  readonly text?: string;
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
        const r = await bash.exec(command, { cwd: HOME, env: { PWD: HOME }, ...(abortSignal ? { signal: abortSignal } : {}) });
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

/** Every file under `root`, depth first in name order, with its size and (when small) its text. */
export async function walk(fs: IFileSystem, root: string, options: { readonly maxText?: number } = {}): Promise<Map<string, FileEntry>> {
  const maxText = options.maxText ?? 64_000;
  const files = new Map<string, FileEntry>();
  const visit = async (dir: string): Promise<void> => {
    const names = await fs.readdir(dir).catch(() => []);
    for (const name of [...names].sort()) {
      const path = `${dir}/${name}`.replace(/^\/\//, "/");
      const stat = await fs.stat(path);
      if (stat.isDirectory) await visit(path);
      else if (stat.size > maxText) files.set(path, { size: stat.size });
      else files.set(path, { size: stat.size, text: await fs.readFile(path) });
    }
  };
  await visit(root);
  return files;
}

/** What changed between two walks. */
export function diffVfs(before: ReadonlyMap<string, FileEntry>, after: ReadonlyMap<string, FileEntry>): VfsDiff {
  const added = [...after.keys()].filter((p) => !before.has(p));
  const removed = [...before.keys()].filter((p) => !after.has(p));
  const modified = [...after].filter(([p, e]) => {
    const was = before.get(p);
    return was !== undefined && (was.size !== e.size || was.text !== e.text);
  });
  return { added, modified: modified.map(([p]) => p), removed };
}
