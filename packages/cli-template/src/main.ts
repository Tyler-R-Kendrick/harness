#!/usr/bin/env node
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { connect } from "node:net";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { openInteractive } from "./interactive.ts";
import type { InteractiveClient } from "./interactive.ts";

const parsed = parseArgs({
  options: {
    socket: { type: "string" },
    daemon: { type: "string" },
  },
  strict: false,
  tokens: true,
});
const socket = typeof parsed.values.socket === "string" ? parsed.values.socket : undefined;
const daemon = typeof parsed.values.daemon === "string" ? parsed.values.daemon : undefined;
const extra = daemonFlags(parsed.tokens);

if (socket !== undefined && (daemon !== undefined || extra.length > 0)) {
  process.stderr.write("usage: harness-cli [--socket <path> | --daemon <entry> [daemon flags]]\n");
  process.exit(2);
}

interface Link {
  cli: InteractiveClient;
  stop(): Promise<void>;
}

/** Flags this process does not own are the spawned daemon's own switches (`--dialogue`, `--worker`, …). */
function daemonFlags(tokens: typeof parsed.tokens): string[] {
  const args: string[] = [];
  for (const token of tokens) {
    if (token.kind === "option") {
      if (token.name === "socket" || token.name === "daemon" || token.name === "stdio") continue;
      args.push(`--${token.name}`);
      if (token.value !== undefined) args.push(token.value);
    } else if (token.kind === "positional") args.push(token.value);
  }
  return args;
}

type Early = Promise<never> & { ready(): void };

/** Reject while the transport is still coming up; ignore the same events after the session exists. */
function untilReady(fail: (reject: (error: Error) => void) => void): Early {
  let settled = false;
  const pending = new Promise<never>((_resolve, reject) => {
    fail((error) => {
      if (!settled) reject(error);
    });
  });
  return Object.assign(pending, {
    ready() {
      settled = true;
    },
  });
}

function sessionOn(stream: Parameters<typeof openInteractive>[0], early: Early): Promise<InteractiveClient> {
  return new Promise((resolve, reject) => {
    early.then(reject, reject);
    openInteractive(stream).then(
      (session) => {
        early.ready();
        resolve(session);
      },
      reject,
    );
  });
}

async function connectSocket(socketPath: string): Promise<Link> {
  const socket = connect(socketPath);
  const early = untilReady((reject) => socket.once("error", reject));
  const opened = new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  await Promise.race([opened, early]);
  const stream = ndJsonStream(Writable.toWeb(socket) as WritableStream<Uint8Array>, Readable.toWeb(socket) as ReadableStream<Uint8Array>);
  const cli = await sessionOn(stream, early);
  return { cli, stop: async () => void socket.end() };
}

function startDaemon(entry: string | undefined): ChildProcess {
  const args = ["--stdio", ...extra];
  if (entry === undefined) return spawn("harness", args, { stdio: ["pipe", "pipe", "inherit"] });
  return spawn(process.execPath, [entry, ...args], { stdio: ["pipe", "pipe", "inherit"] });
}

async function connectDaemon(entry: string | undefined): Promise<Link> {
  const child = startDaemon(entry);
  const stdin = child.stdin;
  const stdout = child.stdout;
  if (stdin === null || stdout === null) throw new Error("daemon stdio is not piped");
  const early = untilReady((reject) => {
    child.once("error", (error) => {
      const missing = entry === undefined && "code" in error && error.code === "ENOENT";
      reject(missing ? new Error("could not start the harness daemon. Pass --daemon <entry> or --socket <path>") : error);
    });
    child.once("exit", (code, signal) => reject(new Error(`daemon exited ${code ?? signal ?? "null"} before the cli connected`)));
  });
  const stream = ndJsonStream(Writable.toWeb(stdin) as WritableStream<Uint8Array>, Readable.toWeb(stdout) as ReadableStream<Uint8Array>);
  const cli = await sessionOn(stream, early);
  return {
    cli,
    stop: async () => {
      const exited = once(child, "exit");
      stdin.end();
      const timer = new Promise<"timeout">((resolve) => {
        const handle = setTimeout(() => resolve("timeout"), 2000);
        handle.unref();
      });
      const result = await Promise.race([exited.then(() => "exit" as const), timer]);
      if (result === "timeout" && child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

async function main(): Promise<void> {
  const link = socket === undefined ? await connectDaemon(daemon) : await connectSocket(socket);
  process.stdout.write(socket === undefined ? "harness cli connected\n" : `harness cli on ${socket}\n`);
  process.stdout.write("Type a message or /ask <message>. /help lists commands.\n");
  const lines = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  const read = lines[Symbol.asyncIterator]();
  const next = async (): Promise<string | undefined> => {
    const step = await read.next();
    return step.done ? undefined : step.value;
  };
  const show = () => {
    if (!process.stdin.readableEnded) lines.prompt();
  };
  show();
  try {
    let line = await next();
    while (line !== undefined) {
      if (line.trim().length === 0) {
        show();
        line = await next();
        continue;
      }
      try {
        const armed = link.cli.armPermission();
        const result = link.cli.line(line);
        const gate = await Promise.race([
          result.then((text) => ({ kind: "done" as const, text })),
          armed.then((text) => ({ kind: "ask" as const, text })),
        ]);
        if (gate.kind === "ask") {
          process.stdout.write(`${gate.text}\n`);
          show();
          const choice = await next();
          if (choice === undefined) {
            link.cli.cancel();
            await result.catch(() => undefined);
            break;
          }
          process.stdout.write(`${await link.cli.line(choice)}\n`);
        } else {
          process.stdout.write(`${gate.text}\n`);
        }
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      }
      show();
      line = await next();
    }
  } finally {
    lines.close();
    await link.stop();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
