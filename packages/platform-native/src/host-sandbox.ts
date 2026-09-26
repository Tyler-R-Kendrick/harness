import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxProvider } from "@ai-sdk/harness";
import type { Experimental_SandboxProcess, Experimental_SandboxSession } from "ai";
import { freePort } from "./free-port.ts";

async function missingAsNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** End each command still running, with the processes it started (its process group). */
function endAll(running: Set<ChildProcess>): void {
  for (const child of running) {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      // it ended on its own meanwhile
    }
  }
  running.clear();
}

async function session(id: string, directory: string, running: Set<ChildProcess>): Promise<HarnessV1NetworkSandboxSession> {
  const port = await freePort();
  const at = (path: string) => (isAbsolute(path) ? path : join(directory, path));
  const put = async (path: string, content: Uint8Array | string) => {
    await mkdir(dirname(at(path)), { recursive: true });
    await writeFile(at(path), content);
  };
  const start = (o: { command: string; workingDirectory?: string; env?: Record<string, string> }) => {
    // Each command leads its own process group, so killing it reaches what the shell started.
    const child = spawn("sh", ["-c", o.command], { cwd: o.workingDirectory === undefined ? directory : resolve(directory, o.workingDirectory), env: { ...process.env, ...o.env }, detached: true });
    running.add(child);
    child.on("close", () => running.delete(child));
    return child;
  };
  const endpoint = async ({ port: asked, protocol = "http" }: { port: number; protocol?: "http" | "https" | "ws" }) => {
    if (asked !== port) throw new Error(`port ${asked} is not exposed by this sandbox`);
    return { url: `${protocol}://127.0.0.1:${port}` };
  };
  const box: Experimental_SandboxSession = {
    description: `host process sandbox at ${directory}: commands run on this machine with the daemon's privileges, unisolated`,
    readFile: (o) => missingAsNull(async () => Readable.toWeb(Readable.from([await readFile(at(o.path))])) as ReadableStream<Uint8Array>),
    readBinaryFile: (o) => missingAsNull(async () => new Uint8Array(await readFile(at(o.path)))),
    readTextFile: (o) =>
      missingAsNull(async () => {
        const text = await readFile(at(o.path), { encoding: (o.encoding ?? "utf8") as BufferEncoding });
        if (o.startLine === undefined && o.endLine === undefined) return text;
        return text.split("\n").slice((o.startLine ?? 1) - 1, o.endLine).join("\n");
      }),
    writeFile: async (o) => put(o.path, new Uint8Array(await new Response(o.content).arrayBuffer())),
    writeBinaryFile: (o) => put(o.path, o.content),
    writeTextFile: (o) => put(o.path, o.content),
    spawn: async (o): Promise<Experimental_SandboxProcess> => {
      const child = start(o);
      const exited = new Promise<{ exitCode: number }>((done) => child.on("close", (code) => done({ exitCode: code ?? 1 })));
      return {
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        wait: () => exited,
        kill: async () => {
          if (child.pid !== undefined && child.exitCode === null) process.kill(-child.pid, "SIGTERM");
        },
      };
    },
    run: (o) =>
      new Promise((done, reject) => {
        const child = start(o);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
        child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
        child.once("error", reject);
        child.on("close", (code) => done({ exitCode: code ?? 1, stdout, stderr }));
      }),
  };
  return {
    ...box,
    id,
    defaultWorkingDirectory: directory,
    ports: [port],
    getPortEndpoint: endpoint,
    getPortUrl: async (o) => (await endpoint(o)).url,
    // Stopping ends what runs in the session (a harness bridge, say); its files stay for a resume.
    stop: async () => endAll(running),
    destroy: async () => {
      endAll(running);
      await rm(directory, { recursive: true, force: true });
    },
    restricted: () => box,
  };
}

/**
 * An AI SDK sandbox provider (`HarnessV1SandboxProvider`) whose sandboxes are
 * directories on this machine: commands run as the daemon's user with its
 * privileges, and each session gets a free loopback port for a harness bridge. It
 * isolates nothing; it is for running harnesses (Claude Code, Codex, ACP agents)
 * locally the way their own CLIs run, when no isolating provider is configured.
 */
export function hostSandbox(options: { readonly root: string }): HarnessV1SandboxProvider {
  const directoryOf = (sessionId: string) => join(options.root, sessionId);
  // What runs in each session, whichever handle started it (a resumed session is a new handle).
  const sessions = new Map<string, Set<ChildProcess>>();
  const runningIn = (sessionId: string) => {
    let running = sessions.get(sessionId);
    if (!running) sessions.set(sessionId, (running = new Set()));
    return running;
  };
  return {
    specificationVersion: "harness-sandbox-v1",
    providerId: "host",
    async createSession(o = {}) {
      const id = o.sessionId ?? randomUUID();
      const directory = directoryOf(id);
      const fresh = !existsSync(directory);
      await mkdir(directory, { recursive: true });
      const created = await session(id, directory, runningIn(id));
      if (fresh) await o.onFirstCreate?.(created.restricted(), o.abortSignal ? { abortSignal: o.abortSignal } : {});
      return created;
    },
    async resumeSession({ sessionId }) {
      const directory = directoryOf(sessionId);
      if (!existsSync(directory)) throw new Error(`no sandbox for session ${sessionId}`);
      return session(sessionId, directory, runningIn(sessionId));
    },
  };
}
