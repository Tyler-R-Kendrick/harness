#!/usr/bin/env node
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { openSessionConsole } from "./console.ts";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { projectDaemonSetting, projectSettingsFile, readDaemonSettingFile, readDaemonSettingState, resolveDaemonTarget, socketPath } from "./daemon-uri.ts";
import { openInteractive } from "./interactive.ts";
import type { InteractiveClient } from "./interactive.ts";
import { colorEnabled, openSessionFrame, paint, presentReply } from "./present.ts";

const color = colorEnabled(process.stdout.isTTY === true, process.env);

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
const resume = resumeSession(parsed.tokens);
const extra = daemonFlags(parsed.tokens);

if (socket !== undefined && (daemon !== undefined || extra.length > 0)) {
  process.stderr.write("usage: harness-cli [--socket <path> | --daemon <entry> [daemon flags]]\n");
  process.exit(2);
}

interface Link {
  cli: InteractiveClient;
  stop(): Promise<void>;
}

/** `session resume <id>` is this client's command, wherever those three words sit. Anything else positional is still a daemon argument. */
function resumeSession(tokens: typeof parsed.tokens): string | undefined {
  const found = resumeAt(tokens);
  if (found === "usage" || (found === undefined && positionalsOf(tokens)[0] === "session")) {
    process.stderr.write("usage: harness-cli session resume <session_id>\n");
    process.exit(2);
  }
  return found?.id;
}

/** Flags this process does not own are the spawned daemon's own switches (`--dialogue`, `--worker`, …). */
function daemonFlags(tokens: typeof parsed.tokens): string[] {
  const found = resumeAt(tokens);
  const skip = found !== undefined && found !== "usage" ? found.index : undefined;
  let seen = 0;
  const args: string[] = [];
  for (const token of tokens) {
    if (token.kind === "option") {
      if (token.name === "socket" || token.name === "daemon" || token.name === "stdio") continue;
      args.push(`--${token.name}`);
      if (token.value !== undefined) args.push(token.value);
      continue;
    }
    // This parser does not know the daemon's options, so a value such as `ensemble` arrives as a
    // positional and must stay immediately after its flag. Only `session resume <id>` is ours.
    if (token.kind !== "positional") continue;
    const at = seen;
    seen += 1;
    if (skip !== undefined && at >= skip && at < skip + 3) continue;
    args.push(token.value);
  }
  return args;
}

function positionalsOf(tokens: typeof parsed.tokens): string[] {
  return tokens.flatMap((token) => (token.kind === "positional" ? [token.value] : []));
}

/** Where `session resume <id>` sits among positionals. `usage` is `session resume` with no id. */
function resumeAt(tokens: typeof parsed.tokens): { index: number; id: string } | "usage" | undefined {
  const positionals = positionalsOf(tokens);
  for (let index = 0; index < positionals.length; index += 1) {
    if (positionals[index] !== "session" || positionals[index + 1] !== "resume") continue;
    const id = positionals[index + 2];
    if (id === undefined || id.length === 0) return "usage";
    return { index, id };
  }
  return undefined;
}

/** Sessions survive the process so `session resume` can load them. A caller's `--state` wins. */
function withState(flags: string[]): string[] {
  if (flags.includes("--state")) return flags;
  const root = process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache");
  const dir = join(root, "harness");
  mkdirSync(dir, { recursive: true });
  return [...flags, "--state", join(dir, "cli-state.json")];
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

function userSettingsFile(): string {
  return join(homedir(), ".harness", "settings.json");
}

function daemonTarget(): { readonly kind: "socket"; readonly path: string } | { readonly kind: "spawn" } {
  if (socket !== undefined) return { kind: "socket", path: socketPath(socket) };
  const home = homedir();
  const dev = join(process.env["XDG_CACHE_HOME"] ?? join(home, ".cache"), "harness", "dev.sock");
  return resolveDaemonTarget({
    localSetting: projectDaemonSetting(process.cwd(), home),
    userSetting: readDaemonSettingFile(userSettingsFile()),
    globalSetting: readDaemonSettingFile("/etc/harness/settings.json"),
    envSetting: process.env["HARNESS_DAEMON"] ?? "",
    devSocket: existsSync(dev) ? dev : "",
  });
}

function settingsTarget(home: string): { settingsFile: string; daemonSetting?: { readonly requested: string; readonly accepted?: string } } {
  const localFile = projectSettingsFile(process.cwd(), home);
  if (localFile !== undefined && readDaemonSettingFile(localFile).length > 0) {
    const daemonSetting = readDaemonSettingState(localFile);
    return daemonSetting === undefined ? { settingsFile: localFile } : { settingsFile: localFile, daemonSetting };
  }
  const settingsFile = userSettingsFile();
  const daemonSetting = readDaemonSettingState(settingsFile);
  return daemonSetting === undefined ? { settingsFile } : { settingsFile, daemonSetting };
}

function sessionOn(stream: Parameters<typeof openInteractive>[0], early: Early): Promise<InteractiveClient> {
  const chosen = settingsTarget(homedir());
  return new Promise((resolve, reject) => {
    early.then(reject, reject);
    const opening = openInteractive(stream, {
      ...(resume === undefined ? {} : { resume }),
      settingsFile: chosen.settingsFile,
      ...(chosen.daemonSetting === undefined ? {} : { daemonSetting: chosen.daemonSetting }),
    });
    opening.then(
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
  const args = ["--stdio", ...withState(extra)];
  // A new process group: a terminal Ctrl+C stays with this client, which stops the daemon itself.
  const options = { stdio: ["pipe", "pipe", "inherit"] as ["pipe", "pipe", "inherit"], detached: true };
  if (entry === undefined) return spawn("harness", args, options);
  return spawn(process.execPath, [entry, ...args], options);
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
  const target = daemonTarget();
  const link = target.kind === "socket" ? await connectSocket(target.path) : await connectDaemon(daemon);
  const banner = target.kind === "socket" ? `harness cli on ${target.path}\n` : "harness cli connected\n";
  const tty = process.stdout.isTTY === true;
  const redraw = tty && color;
  const height = process.stdout.rows;
  const frame = openSessionFrame({
    tty,
    color,
    ...(tty && typeof height === "number" && height > 1 ? { rows: height - 1 } : {}),
  });
  let leaving = false;
  let finish = (): void => {};
  const session = openSessionConsole({
    input: process.stdin,
    output: process.stdout,
    tty,
    color,
    frame,
    ...(tty && typeof height === "number" && height > 0 ? { height } : {}),
    onArm: () => link.cli.interrupt(),
    onExit: () => finish(),
    complete: (prefix) => link.cli.complete(prefix),
  });
  process.stdout.write(paint(banner, "hint", color));
  process.stdout.write(paint("Type a message. /help lists commands.\n", "hint", color));
  const next = (): Promise<string | undefined> => session.next();
  const show = (): void => {
    if (!leaving && process.stdin.readableEnded !== true) session.show();
  };
  const writeFrame = () => {
    session.paint();
  };
  let pulse: ReturnType<typeof setInterval> | undefined;
  const stopPulse = (): void => {
    if (pulse === undefined) return;
    clearInterval(pulse);
    pulse = undefined;
  };
  const armPulse = (): void => {
    if (pulse !== undefined || !redraw) return;
    pulse = setInterval(() => {
      if (leaving || !frame.tick()) stopPulse();
      else writeFrame();
    }, 100);
    pulse.unref();
  };
  const writeResult = (text: string) => {
    if (redraw && text.length > 0 && frame.liveText() === text) {
      frame.activity("idle");
      stopPulse();
      frame.settle();
      writeFrame();
      return;
    }
    const turned = link.cli.turnParts();
    const joined = turned.map((part) => part.text).join("");
    if (!turned.some((part) => part.error) || joined !== text) {
      process.stdout.write(`${presentReply(text, color)}\n`);
      return;
    }
    for (const part of turned) process.stdout.write(`${part.error ? paint(part.text, "error", color) : presentReply(part.text, color)}\n`);
  };
  const command = (value: string) => {
    const trimmed = value.trim();
    return trimmed.toLowerCase() === "help" || trimmed.startsWith("/");
  };
  link.cli.watch((state, sessionId) => {
    if (sessionId !== link.cli.sessionId()) return;
    frame.activity(state);
    if (state === "idle") stopPulse();
    else armPulse();
    writeFrame();
  });
  link.cli.follow((event) => {
    if (event.kind === "thought") frame.intermediate(event.text);
    else if (event.kind === "error") frame.fail(event.text);
    else frame.chunk(event.text);
    writeFrame();
  });
  let choosing: ((line: string | undefined) => void) | undefined;
  let chain: Promise<void> = Promise.resolve();
  let releaseStop: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const untilStop = async <T>(pending: Promise<T>): Promise<T | undefined> => {
    const winner = await Promise.race([
      pending.then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      stopped.then(() => ({ kind: "stopped" as const })),
    ]);
    if (winner.kind === "stopped") return undefined;
    if (winner.kind === "error") throw winner.error;
    return winner.value;
  };
  finish = () => {
    if (leaving) return;
    leaving = true;
    stopPulse();
    void (async () => {
      const id = link.cli.sessionId();
      await link.cli.leave().catch(() => undefined);
      session.close();
      process.stdout.write(`Session context cleared.\nnpm run dev:cli -- session resume ${id}\n`);
      releaseStop?.();
    })();
  };
  const onInterrupt = (): void => {
    if (leaving) return;
    session.interrupt();
  };
  process.on("SIGINT", onInterrupt);
  const runTurn = async (text: string): Promise<void> => {
    if (leaving) return;
    try {
      const armed = link.cli.armPermission();
      const handed = link.cli.backgrounded();
      const result = link.cli.line(text);
      const gate = await untilStop(
        Promise.race([
          result.then((answer) => ({ kind: "done" as const, text: answer })),
          armed.then((answer) => ({ kind: "ask" as const, text: answer })),
          handed.then(() => ({ kind: "background" as const })),
        ]),
      );
      if (gate === undefined) return;
      if (gate.kind === "background") {
        void result.then(
          (answer) => {
            if (!leaving) writeResult(answer);
          },
          () => undefined,
        );
        return;
      }
      if (gate.kind === "ask") {
        process.stdout.write(`${paint(gate.text, "warning", color)}\n`);
        show();
        const choice = await untilStop(
          new Promise<string | undefined>((resolve) => {
            choosing = resolve;
          }),
        );
        choosing = undefined;
        if (choice === undefined) {
          link.cli.cancel();
          await result.catch(() => undefined);
          return;
        }
        const answered = await untilStop(link.cli.line(choice));
        if (answered === undefined) return;
        writeResult(answered);
      } else writeResult(gate.text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${paint(message, "error", color)}\n`);
    }
    if (!leaving) show();
  };
  const enqueue = (text: string) => {
    chain = chain.then(() => runTurn(text));
  };
  const answerCommand = async (text: string) => {
    const answered = await untilStop(link.cli.line(text));
    if (answered !== undefined) writeResult(answered);
  };
  show();
  try {
    let line = await untilStop(next());
    while (line !== undefined && !leaving) {
      try {
        if (choosing && command(line)) {
          await answerCommand(line);
          show();
        } else if (choosing) {
          const deliver = choosing;
          choosing = undefined;
          deliver(line);
        } else if (line.trim().length === 0) show();
        else if (command(line)) {
          await answerCommand(line);
          show();
        } else {
          enqueue(line);
          show();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${paint(message, "error", color)}\n`);
      }
      if (leaving) break;
      line = await untilStop(next());
    }
    choosing?.(undefined);
    choosing = undefined;
    await chain;
  } finally {
    stopPulse();
    process.off("SIGINT", onInterrupt);
    session.close();
    await link.stop();
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${paint(message, "error", color)}\n`);
  process.exit(1);
}
