import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxProvider } from "@ai-sdk/harness";
import type { Experimental_SandboxProcess, Experimental_SandboxSession } from "ai";

/** A free TCP port on the loopback interface, as the OS hands it out. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("no port"))));
    });
  });
}

async function missingAsNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function session(id: string, directory: string): Promise<HarnessV1NetworkSandboxSession> {
  const port = await freePort();
  const at = (path: string) => (isAbsolute(path) ? path : join(directory, path));
  const put = async (path: string, content: Uint8Array | string) => {
    await mkdir(dirname(at(path)), { recursive: true });
    await writeFile(at(path), content);
  };
  const start = (o: { command: string; workingDirectory?: string; env?: Record<string, string> }) =>
    spawn("sh", ["-c", o.command], { cwd: o.workingDirectory === undefined ? directory : resolve(directory, o.workingDirectory), env: { ...process.env, ...o.env } });
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
        kill: async () => void child.kill(),
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
    stop: async () => {},
    destroy: async () => void (await rm(directory, { recursive: true, force: true })),
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
  return {
    specificationVersion: "harness-sandbox-v1",
    providerId: "host",
    async createSession(o = {}) {
      const id = o.sessionId ?? randomUUID();
      const directory = directoryOf(id);
      const fresh = !existsSync(directory);
      await mkdir(directory, { recursive: true });
      const created = await session(id, directory);
      if (fresh) await o.onFirstCreate?.(created.restricted(), o.abortSignal ? { abortSignal: o.abortSignal } : {});
      return created;
    },
    async resumeSession({ sessionId }) {
      const directory = directoryOf(sessionId);
      if (!existsSync(directory)) throw new Error(`no sandbox for session ${sessionId}`);
      return session(sessionId, directory);
    },
  };
}
