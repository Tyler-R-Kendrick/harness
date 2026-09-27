import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Readable } from "node:stream";
import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxProvider } from "@ai-sdk/harness";
import type { Experimental_SandboxProcess, Experimental_SandboxSession } from "ai";
import { freePort } from "./free-port.ts";

const WORKDIR = "/workspace";
/** An exit code `cat` never uses: the file asked for does not exist. */
const MISSING = 44;

export interface DockerSandboxOptions {
  /** The image each session's container runs; it needs a POSIX shell (and node, for harness bridges). */
  readonly image: string;
  /** The docker CLI to run (default `docker`). */
  readonly docker?: string;
  /**
   * `bridge` (default): a network of its own, the session's port published on this
   * machine's loopback. `none`: no network and no port. `host`: this machine's network,
   * shared, so it isolates files and processes only.
   */
  readonly network?: "bridge" | "none" | "host";
  /** A shell command run once in each new container, before the harness's own first-create hook. */
  readonly setup?: string;
  /** Environment for every command (a harness's credentials, a proxy). */
  readonly env?: Readonly<Record<string, string>>;
  /** Directories of this machine to mount into each container. */
  readonly mounts?: readonly { readonly source: string; readonly target: string; readonly readonly?: boolean }[];
  /** Labels for each container, besides the ones that name it a harness sandbox. */
  readonly labels?: Readonly<Record<string, string>>;
}

interface Result {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** Run the docker CLI to completion, optionally feeding it stdin and giving it environment to pass on. */
function docker(cli: string, args: readonly string[], input?: Uint8Array, env?: Readonly<Record<string, string>>): Promise<Result> {
  return new Promise((done, reject) => {
    const child = spawn(cli, args, env ? { env: { ...process.env, ...env } } : {});
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    child.once("error", reject);
    child.on("close", (code) => done({ exitCode: code ?? 1, stdout: Buffer.concat(out), stderr }));
    child.stdin.end(input);
  });
}

/** A container name for a session: readable, and unique even when two ids read alike once made safe. */
const nameOf = (sessionId: string) => `harness-sandbox-${sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 40)}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}`;
const pairs = (flag: string, values: Readonly<Record<string, string>>) => Object.entries(values).flatMap(([k, v]) => [flag, `${k}=${v}`]);
/** Environment passed by name only: docker reads each value from its own environment, so none is on its command line. */
const names = (values: Readonly<Record<string, string>>) => Object.keys(values).flatMap((k) => ["-e", k]);

function session(options: DockerSandboxOptions, id: string, name: string, port: number | undefined): HarnessV1NetworkSandboxSession {
  const cli = options.docker ?? "docker";
  const at = (path: string) => posix.resolve(WORKDIR, path);
  const exec = (args: readonly string[], o: { workingDirectory?: string; env?: Record<string, string>; stdin?: boolean } = {}) => ({
    args: ["exec", ...(o.stdin ? ["-i"] : []), "-w", o.workingDirectory === undefined ? WORKDIR : at(o.workingDirectory), ...names({ ...options.env, ...o.env }), name, ...args],
    env: { ...options.env, ...o.env },
  });
  // Each command leads a session of its own in the container and records its id, so
  // killing it reaches everything it started (the docker CLI here is only a client).
  const command = (o: { command: string; workingDirectory?: string; env?: Record<string, string> }) => {
    const pidFile = `/tmp/.harness-${randomUUID()}.pid`;
    return { pidFile, ...exec(["setsid", "-w", "sh", "-c", 'echo $$ > "$0"; exec sh -c "$1"', pidFile, o.command], o) };
  };
  const read = async (path: string): Promise<Buffer | null> => {
    const r = await docker(cli, exec(["sh", "-c", 'if [ -e "$0" ]; then exec cat "$0"; else exit 44; fi', at(path)]).args);
    if (r.exitCode === MISSING) return null;
    if (r.exitCode !== 0) throw new Error(`reading ${at(path)} in ${name} failed: ${r.stderr.trim()}`);
    return r.stdout;
  };
  const write = async (path: string, content: Uint8Array) => {
    const r = await docker(cli, exec(["sh", "-c", 'mkdir -p "$(dirname "$0")" && cat > "$0"', at(path)], { stdin: true }).args, content);
    if (r.exitCode !== 0) throw new Error(`writing ${at(path)} in ${name} failed: ${r.stderr.trim()}`);
  };
  const endpoint = async ({ port: asked, protocol = "http" }: { port: number; protocol?: "http" | "https" | "ws" }) => {
    if (asked !== port) throw new Error(`port ${asked} is not published by this sandbox`);
    return { url: `${protocol}://127.0.0.1:${port}` };
  };
  const box: Experimental_SandboxSession = {
    description: `docker container ${name} (${options.image}): commands run in it, isolated from this machine's files and processes`,
    readFile: async (o) => {
      const bytes = await read(o.path);
      return bytes === null ? null : (Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>);
    },
    readBinaryFile: async (o) => {
      const bytes = await read(o.path);
      return bytes === null ? null : new Uint8Array(bytes);
    },
    readTextFile: async (o) => {
      const bytes = await read(o.path);
      if (bytes === null) return null;
      const text = bytes.toString((o.encoding ?? "utf8") as BufferEncoding);
      if (o.startLine === undefined && o.endLine === undefined) return text;
      return text.split("\n").slice((o.startLine ?? 1) - 1, o.endLine).join("\n");
    },
    writeFile: async (o) => write(o.path, new Uint8Array(await new Response(o.content).arrayBuffer())),
    writeBinaryFile: (o) => write(o.path, o.content),
    writeTextFile: (o) => write(o.path, new TextEncoder().encode(o.content)),
    spawn: async (o): Promise<Experimental_SandboxProcess> => {
      const { pidFile, args, env } = command(o);
      const child = spawn(cli, args, { env: { ...process.env, ...env } });
      const exited = new Promise<{ exitCode: number }>((done) => child.on("close", (code) => done({ exitCode: code ?? 1 })));
      return {
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        wait: () => exited,
        kill: async () => {
          if (child.exitCode !== null) return;
          await docker(cli, ["exec", name, "sh", "-c", 'kill -TERM -"$(cat "$0")" 2>/dev/null; rm -f "$0"', pidFile]);
        },
      };
    },
    run: async (o) => {
      const { args, env } = command(o);
      const r = await docker(cli, args, undefined, env);
      return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr };
    },
  };
  return {
    ...box,
    id,
    defaultWorkingDirectory: WORKDIR,
    ports: port === undefined ? [] : [port],
    getPortEndpoint: endpoint,
    getPortUrl: async (o) => (await endpoint(o)).url,
    // Stopping the container ends everything running in it; its files stay for a resume.
    stop: async () => void (await docker(cli, ["stop", "-t", "1", name])),
    destroy: async () => void (await docker(cli, ["rm", "-f", name])),
    restricted: () => box,
  };
}

/**
 * An AI SDK sandbox provider (`HarnessV1SandboxProvider`) whose sandboxes are Docker
 * containers, one per session: commands and files are the container's, so a harness
 * (Claude Code, Codex, an ACP agent) cannot reach this machine's files or processes.
 * Each session's port is published on this machine's loopback for the harness bridge.
 * A stopped session keeps its container, and resuming starts it again.
 */
export function dockerSandbox(options: DockerSandboxOptions): HarnessV1SandboxProvider {
  for (const m of options.mounts ?? []) {
    if (m.source.includes(",") || m.target.includes(",")) throw new Error(`mount path ${m.source}:${m.target} cannot contain a comma (docker's --mount syntax)`);
  }
  const cli = options.docker ?? "docker";
  const network = options.network ?? "bridge";
  /** The container's published port, if it exists; it is started when stopped. */
  const find = async (name: string): Promise<{ port: number | undefined } | undefined> => {
    const r = await docker(cli, ["inspect", "-f", '{{.State.Running}} {{index .Config.Labels "harness.port"}}', name]);
    if (r.exitCode !== 0) return undefined;
    const [running, port] = r.stdout.toString().trim().split(" ");
    if (running !== "true") {
      const started = await docker(cli, ["start", name]);
      if (started.exitCode !== 0) throw new Error(`starting ${name} failed: ${started.stderr.trim()}`);
    }
    return { port: port ? Number(port) : undefined };
  };
  return {
    specificationVersion: "harness-sandbox-v1",
    providerId: "docker",
    async createSession(o = {}) {
      const id = o.sessionId ?? randomUUID();
      const name = nameOf(id);
      const existing = await find(name);
      if (existing) return session(options, id, name, existing.port);
      const port = network === "none" ? undefined : await freePort();
      const r = await docker(cli, [
        "run",
        "-d",
        "--init",
        "--name",
        name,
        ...pairs("--label", { ...options.labels, "harness.sandbox": "true", "harness.port": port === undefined ? "" : String(port) }),
        "-w",
        WORKDIR,
        ...names(options.env ?? {}),
        ...(options.mounts ?? []).flatMap((m) => ["--mount", `type=bind,source=${m.source},target=${m.target}${m.readonly ? ",readonly" : ""}`]),
        ...(network === "bridge" ? ["-p", `127.0.0.1:${port}:${port}`] : ["--network", network]),
        options.image,
        "sleep",
        "infinity",
      ], undefined, options.env);
      if (r.exitCode !== 0) throw new Error(`starting a container for ${id} failed: ${r.stderr.trim()}`);
      const created = session(options, id, name, port);
      if (options.setup !== undefined) {
        const ran = await created.run({ command: options.setup });
        if (ran.exitCode !== 0) {
          await created.destroy();
          throw new Error(`sandbox setup failed (exit ${ran.exitCode}): ${ran.stderr.trim()}`);
        }
      }
      await o.onFirstCreate?.(created.restricted(), o.abortSignal ? { abortSignal: o.abortSignal } : {});
      return created;
    },
    async resumeSession({ sessionId }) {
      const name = nameOf(sessionId);
      const existing = await find(name);
      if (!existing) throw new Error(`no sandbox for session ${sessionId}`);
      return session(options, sessionId, name, existing.port);
    },
  };
}
