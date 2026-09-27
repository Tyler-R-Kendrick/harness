/**
 * The harness in the terminal: `ask` and `harness …` commands registered in the
 * terminal's just-bash shell. `ask` streams a turn to the terminal as it happens (so its
 * output does not go through pipes); the `harness` subcommands print to stdout, so
 * `harness trace 100 | grep model` works like any other command.
 */
import type { RequestPermissionRequest, SessionUpdate } from "@agentclientprotocol/sdk";
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { Playground, TurnReport } from "./playground.ts";
import type { ModelTier } from "./sample-model.ts";
import type { TraceEvent, Tracer } from "./trace.ts";
import type { ApprovalPolicy } from "./vfs.ts";

export interface Settings {
  worker: string;
  tier: ModelTier;
  approval: ApprovalPolicy;
}

const TIERS: readonly ModelTier[] = ["quick", "default", "complex"];
const POLICIES: readonly ApprovalPolicy[] = ["ask", "auto"];

const ESC = "\x1b[";
const color = (code: string, s: string) => `${ESC}${code}m${s}${ESC}0m`;
const dim = (s: string) => color("2", s);
const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A yes/no question the terminal answers with one key, while the shell is busy running `ask`. */
export class Prompter {
  readonly #write: (s: string) => void;
  #resolve: ((answer: "allow" | "deny" | undefined) => void) | undefined;
  /** Called once a question is shown (the page focuses the terminal). */
  onAsk: (() => void) | undefined;

  constructor(write: (s: string) => void) {
    this.#write = write;
  }

  get waiting(): boolean {
    return this.#resolve !== undefined;
  }

  ask(question: string): Promise<"allow" | "deny" | undefined> {
    const answer = new Promise<"allow" | "deny" | undefined>((resolve) => (this.#resolve = resolve));
    this.#write(`${color("1;33", `? ${question}`)} ${dim("[y/n]")} `);
    this.onAsk?.();
    return answer;
  }

  /** Withdraw a waiting question (its turn ended without an answer), so keys go back to the shell. */
  withdraw(): void {
    const resolve = this.#resolve;
    if (!resolve) return;
    this.#resolve = undefined;
    this.#write(`${dim("withdrawn")}\r\n`);
    resolve(undefined);
  }

  /** Take a key if a question is waiting (true), or leave it for the shell (false). */
  handleKey(data: string): boolean {
    const resolve = this.#resolve;
    if (!resolve) return false;
    const answer = data === "y" || data === "Y" || data === "\r" ? "allow" : data === "n" || data === "N" ? "deny" : data === "\x03" ? undefined : "ignore";
    if (answer === "ignore") return true;
    this.#resolve = undefined;
    this.#write(answer === undefined ? "^C\r\n" : `${answer === "allow" ? color("32", "allowed") : color("31", "denied")}\r\n`);
    resolve(answer);
    return true;
  }
}

function toolOutput(raw: unknown): string {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  if (typeof r["exitCode"] !== "number") return JSON.stringify(raw);
  const out = `${String(r["stdout"])}${String(r["stderr"])}`.trimEnd().split("\n");
  const shown = out.slice(0, 3).join("\n    ") + (out.length > 3 ? "\n    …" : "");
  return `exit ${r["exitCode"]}${shown ? ` · ${shown}` : ""}`;
}

/** Session updates as terminal output, keeping track of whether the cursor is mid-line. */
export class TurnRenderer {
  #midLine = false;

  #text(s: string): string {
    if (s === "") return "";
    this.#midLine = !s.endsWith("\n");
    return crlf(s);
  }

  #line(s: string): string {
    const lead = this.#midLine ? "\r\n" : "";
    this.#midLine = false;
    return `${lead}${crlf(s)}\r\n`;
  }

  update(u: SessionUpdate): string {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        return u.content.type === "text" ? this.#text(u.content.text) : "";
      case "agent_thought_chunk":
        return u.content.type === "text" ? color("2;3", this.#text(u.content.text)) : "";
      case "user_message_chunk":
        return u.content.type === "text" ? this.#line(color("36", `› ${u.content.text}`)) : "";
      case "tool_call":
        return this.#line(`${color("36", `⚙ ${u.title}`)} ${dim(JSON.stringify(u.rawInput ?? {}))}`);
      case "tool_call_update":
        if (u.status === "completed") return this.#line(`  ${color("32", "✓")} ${dim(toolOutput(u.rawOutput))}`);
        if (u.status === "failed") return this.#line(`  ${color("31", "✗")} ${String((u.rawOutput as { error?: unknown } | undefined)?.error ?? "failed")}`);
        return "";
      case "notice":
        return this.#line(color(u.severity === "error" ? "31" : "33", `! ${u.title}${u.description ? `: ${u.description}` : ""}`));
      default:
        return "";
    }
  }

  /** What ends the turn's output: a line break if the cursor is mid-line. */
  end(): string {
    return this.#midLine ? this.#line("").slice(0, 2) : "";
  }
}

export function reportLines(report: TurnReport): string {
  const { added, modified, removed } = report.diff;
  const changed = added.length + modified.length + removed.length;
  const changes = changed === 0 ? "no file changes" : `${added.length} added, ${modified.length} modified, ${removed.length} removed`;
  const head = color("2", `── ${report.stopReason} · ${plural(report.modelCalls, "model call")} · ${plural(report.toolCalls, "tool call")} · ${changes} · ${report.ms}ms`);
  const files = [...added.map((p) => color("32", `  + ${p}`)), ...modified.map((p) => color("33", `  ~ ${p}`)), ...removed.map((p) => color("31", `  - ${p}`))];
  return [head, ...files].join("\r\n") + "\r\n";
}

export function traceLine(e: TraceEvent): string {
  const arrow = e.direction === "in" ? "→" : e.direction === "out" ? "←" : " ";
  return `${String(e.seq).padStart(4)} ${e.kind.padEnd(6)} ${arrow} ${e.name}${e.duration === undefined ? "" : ` (${e.duration}ms)`}`;
}

/** The question a permission request asks in the terminal. */
export function question(request: RequestPermissionRequest): string {
  const input = request.toolCall.rawInput as { command?: unknown } | undefined;
  return `Allow ${request.toolCall.title ?? "this tool"}${typeof input?.command === "string" ? `: ${input.command}` : ` ${JSON.stringify(request.toolCall.rawInput ?? {})}`}?`;
}

const HELP = `ask <prompt>              run a turn in the current session (a new one if none); Ctrl-C cancels
harness new               start a new session and make it current
harness sessions          list sessions (* marks the current one)
harness use <id>          attach to a session by id prefix and replay its log
harness worker [name]     show or pick the worker for the next turn
harness tier [tier]       show or pick Claude's tier: quick, default or complex
harness approve [policy]  ask before commands and writes, or run them on auto
harness trace [n]         the newest trace events (default 20)
harness status            what the daemon holds
harness snapshot          the daemon's snapshot as JSON
harness reset             forget the sessions, conversations and files this browser keeps
`;

export interface ShellContext {
  readonly playground: Playground;
  readonly tracer: Tracer;
  readonly settings: Settings;
  readonly prompter: Prompter;
  /** Straight to the terminal (for `ask`'s streaming output). */
  readonly write: (s: string) => void;
  readonly workers: readonly string[];
  /** Called after a command changed the settings or the current session. */
  readonly onChange?: () => void;
  /** Called with every turn `ask` ran and its report. */
  readonly onTurn?: (prompt: string, report: TurnReport) => void;
  /** Forget what the page keeps across reloads (and reload); absent when it keeps nothing. */
  readonly onReset?: () => Promise<void>;
}

const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, exitCode = 2) => ({ stdout: "", stderr, exitCode });

export function harnessCommands(ctx: ShellContext): Command[] {
  const { playground, tracer, settings, prompter, write } = ctx;
  const changed = <T>(value: T) => (ctx.onChange?.(), value);

  const ask = defineCommand("ask", async (args, command) => {
    const text = args.join(" ").trim();
    if (text === "") return fail("usage: ask <prompt>\n");
    const renderer = new TurnRenderer();
    const cancel = () => void playground.cancel();
    command.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const report = await playground.prompt(text, {
        update: (u) => write(renderer.update(u)),
        permission: async (request) => {
          write(renderer.end());
          const answer = await prompter.ask(question(request));
          const kind = answer === "allow" ? "allow" : "reject";
          return answer === undefined ? undefined : request.options.find((o) => o.kind.startsWith(kind))?.optionId;
        },
      });
      write(renderer.end() + reportLines(report));
      ctx.onTurn?.(text, report);
      return changed(ok(""));
    } catch (e) {
      write(renderer.end());
      return fail(`${e instanceof Error ? e.message : String(e)}\n`, 1);
    } finally {
      prompter.withdraw();
      command.signal?.removeEventListener("abort", cancel);
    }
  });

  const choose = <T extends string>(what: string, value: string | undefined, options: readonly T[], get: () => T, set: (v: T) => void) => {
    if (value === undefined) return ok(`${get()} (one of ${options.join(", ")})\n`);
    if (!(options as readonly string[]).includes(value)) return fail(`unknown ${what} ${value} (one of ${options.join(", ")})\n`);
    set(value as T);
    return changed(ok(`${what === "policy" ? "approve" : what}: ${value}\n`));
  };

  const harness = defineCommand("harness", async ([sub, arg]) => {
    switch (sub) {
      case undefined:
      case "help":
        return ok(HELP);
      case "new":
        return changed(ok(`${await playground.newSession()}\n`));
      case "sessions":
        return ok((await playground.sessions()).map((id) => `${id === playground.sessionId ? "*" : " "} ${id}\n`).join(""));
      case "use": {
        const id = (await playground.sessions()).find((s) => s.startsWith(arg ?? ""));
        if (id === undefined || !arg) return fail(`no session starts with ${arg ?? ""}\n`, 1);
        const renderer = new TurnRenderer();
        await playground.use(id, (u) => write(renderer.update(u)));
        write(renderer.end());
        return changed(ok(""));
      }
      case "worker":
        return choose("worker", arg, ctx.workers, () => settings.worker, (v) => (settings.worker = v));
      case "tier":
        return choose("tier", arg, TIERS, () => settings.tier, (v) => (settings.tier = v));
      case "approve":
        return choose("policy", arg, POLICIES, () => settings.approval, (v) => (settings.approval = v));
      case "trace": {
        const n = Number(arg ?? 20);
        return ok(tracer.events().slice(-n).map(traceLine).join("\n") + "\n");
      }
      case "status": {
        const snap = playground.snapshot();
        const hooks = (snap.hooks as { events: unknown[] }).events.length;
        const rows: [string, string | number][] = [
          ["sessions", snap.sessions.length],
          ["current", playground.sessionId ?? "none"],
          ["worker", settings.worker],
          ["tier", settings.tier],
          ["approve", settings.approval],
          ["hook events", hooks],
          ["trace events", tracer.events().length],
          ["capabilities", playground.host.daemon.capabilities().map((c) => c.name).join(", ")],
        ];
        return ok(rows.map(([k, v]) => `${k.padEnd(13)}${v}\n`).join(""));
      }
      case "snapshot":
        return ok(`${JSON.stringify(playground.snapshot(), null, 2)}\n`);
      case "reset":
        if (!ctx.onReset) return fail("this page keeps nothing to reset\n", 1);
        await ctx.onReset();
        return ok("cleared the saved sessions, conversations and files; reloading\n");
      default:
        return fail(`unknown command ${sub}; try: harness help\n`);
    }
  });

  return [ask, harness];
}
