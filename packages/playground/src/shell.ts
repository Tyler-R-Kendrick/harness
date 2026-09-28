/**
 * The harness in the terminal: slash commands (`/ask`, `/sessions`, `/trace` …) read
 * before bash sees the line, split into words leniently (a prompt's apostrophe is a
 * letter) and parsed by cac, a command-line parser: options, per-command `--help` and
 * unknown-option errors come from it. `/ask` streams a turn to the terminal as it
 * happens; the others print to stdout, which pipes into bash (`/trace 100 | grep model`).
 */
import type { RequestPermissionRequest, SessionUpdate } from "@agentclientprotocol/sdk";
import { cac } from "cac";
import type { Bash, BashExecResult, ExecOptions } from "just-bash";
import { GENERATIONS } from "./engine.ts";
import type { Generation, TemplateEngine } from "./engine.ts";
import type { Playground, TurnReport } from "./playground.ts";
import type { ModelTier } from "./sample-model.ts";
import type { TraceEvent, Tracer } from "./trace.ts";
import type { TemplateStore } from "./templates.ts";
import type { ApprovalPolicy } from "./vfs.ts";
import { HOME } from "./vfs.ts";

export interface Settings {
  worker: string;
  tier: ModelTier;
  approval: ApprovalPolicy;
  /** Whether generating (spending inference on a template) asks first, runs on auto, or is off. */
  generate: Generation;
  /** Which decision model picks templates, by slug: `auto` (the best this browser runs), `lexical` (the lexical judge alone), or a catalog id. */
  decide: string;
  /** Which model writes templates, by slug: `auto` (a local one this browser runs, then Claude), `claude` (Claude alone), or a catalog id. */
  writer: string;
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

export function reportLines(report: Omit<TurnReport, "files">): string {
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

/** What each generation tool spends inference on, as the approval asks it. */
const SPENDING: Readonly<Record<string, (input: Record<string, unknown>) => string>> = {
  write_template: (i) => `write a template for "${String(i["request"])}"`,
  fill_template: (i) => `fill ${Array.isArray(i["holes"]) ? i["holes"].join(", ") : "the holes"} of template ${String(i["id"])}`,
  refine_template: (i) => `rewrite template ${String(i["id"])} (${String(i["note"])})`,
};

/** The question a permission request asks in the terminal. */
export function question(request: RequestPermissionRequest): string {
  const spend = SPENDING[request.toolCall.title ?? ""];
  if (spend) return `Spend inference to ${spend((request.toolCall.rawInput ?? {}) as Record<string, unknown>)}?`;
  const input = request.toolCall.rawInput as { command?: unknown } | undefined;
  return `Allow ${request.toolCall.title ?? "this tool"}${typeof input?.command === "string" ? `: ${input.command}` : ` ${JSON.stringify(request.toolCall.rawInput ?? {})}`}?`;
}

export interface ShellContext {
  readonly playground: Playground;
  readonly tracer: Tracer;
  readonly settings: Settings;
  readonly prompter: Prompter;
  /** Straight to the terminal (for `/ask`'s streaming output). */
  readonly write: (s: string) => void;
  readonly workers: readonly string[];
  /** Called after a command changed the settings or the current session. */
  readonly onChange?: () => void;
  /** Called with every turn `/ask` ran and its report. */
  readonly onTurn?: (prompt: string, report: TurnReport) => void;
  /** Forget what the page keeps across reloads (and reload); absent when it keeps nothing. */
  readonly onReset?: () => Promise<void>;
  /** The template engine `/ask` answers from, and its templates, for `/templates` and `/rate`. */
  readonly engine?: TemplateEngine;
  readonly store?: TemplateStore;
  /** The decision models' slugs, and how a slug's model is doing (loading, ready, or why not), for `/decide` and `/status`. */
  readonly decider?: { slugs(): readonly string[]; status(slug: string): string };
  /** The generators' slugs, and how a slug's local model is doing, for `/writer` and `/status`. */
  readonly writer?: { slugs(): readonly string[]; status(slug: string): string };
}

/** A path under home as the terminal shows it. */
const tilde = (path: string) => (path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path);

interface Output {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const ok = (stdout: string): Output => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, exitCode = 2): Output => ({ stdout: "", stderr, exitCode });

/**
 * Where a quote at `i` ends, or -1 when it is a letter: a quote opens only at the start
 * of a word (so the apostrophe in "what's" is a letter) and only when it closes.
 */
function closing(line: string, i: number): number {
  const c = line[i]!;
  if ((c !== "'" && c !== '"') || (i > 0 && !/\s/.test(line[i - 1]!))) return -1;
  return line.indexOf(c, i + 1);
}

/** A line split into words as a shell would, but leniently: quotes group only where they open a word and close. */
export function words(line: string): string[] {
  const out: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    const end = closing(line, i);
    if (end > i) {
      word = (word ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (/\s/.test(c)) {
      if (word !== undefined) out.push(word);
      word = undefined;
    } else word = (word ?? "") + c;
  }
  if (word !== undefined) out.push(word);
  return out;
}

/** The line split at its first pipe (a lone `|` outside closed quotes): the slash command, and the bash that reads its output. */
function pipeline(line: string): [string, string | undefined] {
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    const end = closing(line, i);
    if (end > i) i = end;
    else if (c === "|" && line[i + 1] !== "|" && line[i - 1] !== "|") return [line.slice(0, i), line.slice(i + 1)];
  }
  return [line, undefined];
}

/** A slash command's name, when the line starts with one (`/` alone is help). */
const slashName = (line: string) => /^\s*\/([A-Za-z][\w-]*)?(?=\s|$)/.exec(line)?.[1] ?? (/^\s*\/(\s|$)/.test(line) ? "" : undefined);

/** Commands whose text is the rest of the line as typed (only leading options are parsed, and nothing is piped). */
const RAW = new Set(["ask"]);

/** Text wholly in one pair of quotes, without them. */
const unquoted = (text: string) => /^\s*(['"])(.*)\1\s*$/s.exec(text)?.[2] ?? text;

const usage = (sections: { title?: string; body: string }[]) =>
  sections
    .filter((s) => s.title !== undefined)
    .map((s) => `${s.title}:\n${s.body.replaceAll("$ harness ", "/")}`)
    .join("\n\n");

/** The harness's commands in the terminal, parsed with cac. */
export class SlashCommands {
  readonly #ctx: ShellContext;

  constructor(ctx: ShellContext) {
    this.#ctx = ctx;
  }

  /** The commands, as the parser has them (name with its arguments, and what it does). */
  list(): { name: string; description: string }[] {
    return this.#cli(undefined, "").commands.map((c) => ({ name: c.rawName, description: c.description }));
  }

  /** Whether a line is a slash command's (or an unknown one's), not bash's. */
  claims(line: string): boolean {
    return slashName(line) !== undefined;
  }

  /** Whether the line's output may be piped: `/ask` takes the whole rest of its line as the prompt. */
  pipes(line: string): boolean {
    return !RAW.has(slashName(line) ?? "");
  }

  /** Run a slash command line (its first word without the slash is the command). */
  async run(line: string, signal?: AbortSignal): Promise<Output> {
    const name = slashName(line) || "help";
    const rest = line.replace(/^\s*\/\S*\s?/, "");
    let argv = words(rest);
    let text = rest;
    if (RAW.has(name)) {
      // Only leading options are the parser's; the rest of the line is the text, as typed.
      const options = argv.findIndex((w) => !w.startsWith("-"));
      argv = options < 0 ? argv : argv.slice(0, options);
      text = unquoted(rest.replace(/^\s*(?:-\S*\s+)*/, "").replace(/^\s*-\S*\s*$/, ""));
    }
    let result: Output | undefined;
    let help: string | undefined;
    const cli = this.#cli(signal, text);
    cli.help((sections) => {
      help = usage(sections);
      return [];
    });
    if (!cli.commands.some((c) => c.name === name)) return fail(`unknown command /${name}; /help lists them\n`);
    try {
      cli.parse(["", "", name, ...argv], { run: false });
      if (help !== undefined) return ok(`${help}\n`);
      result = (await cli.runMatchedCommand()) as Output;
    } catch (e) {
      return fail(`${e instanceof Error ? e.message : String(e)}; see /${name} --help\n`);
    }
    return result;
  }

  #cli(signal: AbortSignal | undefined, text: string) {
    const { playground, tracer, settings, write } = this.#ctx;
    const changed = (value: Output) => (this.#ctx.onChange?.(), value);
    const choose = <T extends string>(what: string, value: string | undefined, options: readonly T[], get: () => T, set: (v: T) => void) => {
      if (value === undefined) return ok(`${get()} (one of ${options.join(", ")})\n`);
      if (!(options as readonly string[]).includes(value)) return fail(`unknown ${what} ${value} (one of ${options.join(", ")})\n`);
      set(value as T);
      return changed(ok(`${what === "policy" ? "approve" : what}: ${value}\n`));
    };
    const cli = cac("harness");
    cli.command("ask [...prompt]", "Run a turn in the current session (a new one if none); Ctrl-C cancels").action(() => this.#ask(text.trim(), signal));
    cli.command("new", "Start a new session and make it current").action(async () => changed(ok(`${await playground.newSession()}\n`)));
    cli.command("sessions", "List sessions (* marks the current one)").action(async () => ok((await playground.sessions()).map((id) => `${id === playground.sessionId ? "*" : " "} ${id}\n`).join("")));
    cli.command("use [id]", "Attach to a session by id prefix and replay its log").action(async (prefix: string | undefined) => {
      const id = (await playground.sessions()).find((s) => s.startsWith(prefix ?? ""));
      if (id === undefined || !prefix) return fail(`no session starts with ${prefix ?? ""}\n`, 1);
      const renderer = new TurnRenderer();
      await playground.use(id, (u) => write(renderer.update(u)));
      write(renderer.end());
      return changed(ok(""));
    });
    cli.command("worker [name]", "Show or pick the worker for the next turn").action((v: string | undefined) => choose("worker", v, this.#ctx.workers, () => settings.worker, (w) => (settings.worker = w)));
    cli.command("tier [tier]", "Show or pick Claude's tier: quick, default or complex").action((v: string | undefined) => choose("tier", v, TIERS, () => settings.tier, (t) => (settings.tier = t)));
    cli.command("approve [policy]", "Ask before commands and writes, or run them on auto").action((v: string | undefined) => choose("policy", v, POLICIES, () => settings.approval, (p) => (settings.approval = p)));
    cli.command("generate [mode]", "Whether writing a template (inference) asks first, runs on auto, or is off").action((v: string | undefined) => choose("generate", v, GENERATIONS, () => settings.generate, (g) => (settings.generate = g)));
    cli.command("decide [slug]", "Which decision model picks templates: auto (the best this browser runs), lexical, or a catalog id").action((v: string | undefined) => {
      const { decider } = this.#ctx;
      const slugs = decider?.slugs() ?? [settings.decide];
      if (v === undefined && decider) return ok(`${settings.decide} (one of ${slugs.join(", ")})\ndecision model: ${decider.status(settings.decide)}\n`);
      return choose("decide", v, slugs, () => settings.decide, (d) => (settings.decide = d));
    });
    cli.command("writer [slug]", "Which model writes templates: auto (a local one this browser runs, then Claude), claude, or a catalog id").action((v: string | undefined) => {
      const { writer } = this.#ctx;
      const slugs = writer?.slugs() ?? [settings.writer];
      if (v === undefined && writer) return ok(`${settings.writer} (one of ${slugs.join(", ")})\ngenerator: ${writer.status(settings.writer)}\n`);
      return choose("writer", v, slugs, () => settings.writer, (w) => (settings.writer = w));
    });
    cli.command("templates", "The templates /ask answers from, with their feedback (files in ~/agent/templates)").action(async () => {
      const { store } = this.#ctx;
      if (!store) return fail("no template engine here\n", 1);
      const { templates, problems } = await store.list();
      const width = Math.max(0, ...templates.map((t) => t.id.length)) + 2;
      const rows = templates.map((t) => `${t.id.padEnd(width)}${t.kind.padEnd(8)}${`+${t.helpful} -${t.harmful}`.padEnd(8)}${t.description}${t.refine ? ` (to rewrite: ${t.refine})` : ""}\n`);
      return ok([...rows, ...problems.map((p) => `${tilde(p.path)} is not a template: ${p.error}\n`)].join("") || `no templates yet; they are files in ${tilde(store.dir)}\n`);
    });
    cli.command("rate <verdict> [...why]", "Rate the last answer: good, or bad and why (a bad one is rewritten when next chosen)").action(async (verdict: string, why: string[]) => {
      const { engine, store } = this.#ctx;
      if (!engine || !store) return fail("no template engine here\n", 1);
      if (verdict !== "good" && verdict !== "bad") return fail("usage: /rate good|bad [why]\n");
      const last = engine.last;
      if (!last) return fail("nothing to rate yet: /ask something first\n", 1);
      const note = why.join(" ").trim();
      const counted = await store.feedback(last.templateId, verdict === "good" ? "helpful" : "harmful", note || undefined);
      const after = counted.retired ? `; retired to ${tilde(store.dir)}/retired` : counted.refine !== undefined && verdict === "bad" ? `; rewritten when next chosen (${counted.refine})` : "";
      return ok(`${last.templateId}: ${counted.helpful} helpful, ${counted.harmful} harmful${after}\n`);
    });
    cli.command("trace [n]", "The newest trace events (default 20)").action((n: string | undefined) => {
      if (n !== undefined && !/^[1-9]\d*$/.test(String(n))) return fail("usage: /trace [n], n a positive whole number\n");
      return ok(tracer.events().slice(-Number(n ?? 20)).map(traceLine).join("\n") + "\n");
    });
    cli.command("status", "What the daemon holds").action(() => {
      const snap = playground.snapshot();
      const hooks = (snap.hooks as { events: unknown[] }).events.length;
      const rows: [string, string | number][] = [
        ["sessions", snap.sessions.length],
        ["current", playground.sessionId ?? "none"],
        ["worker", settings.worker],
        ["tier", settings.tier],
        ["approve", settings.approval],
        ["generate", settings.generate],
        ["decide", this.#ctx.decider ? `${settings.decide}: ${this.#ctx.decider.status(settings.decide)}` : settings.decide],
        ["writer", this.#ctx.writer ? `${settings.writer}: ${this.#ctx.writer.status(settings.writer)}` : settings.writer],
        ["hook events", hooks],
        ["trace events", tracer.events().length],
        ["capabilities", playground.host.daemon.capabilities().map((c) => c.name).join(", ")],
      ];
      return ok(rows.map(([k, v]) => `${k.padEnd(13)}${v}\n`).join(""));
    });
    cli.command("snapshot", "The daemon's snapshot as JSON").action(() => ok(`${JSON.stringify(playground.snapshot(), null, 2)}\n`));
    cli.command("reset", "Forget the sessions, conversations and files this browser keeps").action(async () => {
      if (!this.#ctx.onReset) return fail("this page keeps nothing to reset\n", 1);
      await this.#ctx.onReset();
      return ok("cleared the saved sessions, conversations and files; reloading\n");
    });
    cli.command("help", "List the commands; any command takes --help").action(() => {
      const width = Math.max(...cli.commands.map((c) => c.rawName.length)) + 1;
      return ok(cli.commands.map((c) => `/${c.rawName.padEnd(width)} ${c.description}\n`).join(""));
    });
    return cli;
  }

  async #ask(text: string, signal: AbortSignal | undefined): Promise<Output> {
    const { playground, prompter, write } = this.#ctx;
    if (text === "") return fail("usage: /ask <prompt>\n");
    const renderer = new TurnRenderer();
    const cancel = () => void playground.cancel();
    signal?.addEventListener("abort", cancel, { once: true });
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
      this.#ctx.onTurn?.(text, report);
      this.#ctx.onChange?.();
      return ok("");
    } catch (e) {
      write(renderer.end());
      return fail(`${e instanceof Error ? e.message : String(e)}\n`, 1);
    } finally {
      prompter.withdraw();
      signal?.removeEventListener("abort", cancel);
    }
  }
}

/**
 * Route the terminal's lines: a slash command's to the harness (its output piped into
 * bash when the line has a `|`), anything else to bash. A path that exists (`/bin/ls`)
 * is bash's even though it starts with a slash.
 */
export function withSlashCommands(bash: Bash, commands: SlashCommands): void {
  const exec = bash.exec.bind(bash);
  bash.exec = async (line: string, options?: ExecOptions): Promise<BashExecResult> => {
    const name = slashName(line);
    if (!commands.claims(line) || (name && (await bash.fs.exists(`/${name}`)))) return exec(line, options);
    const [head, tail] = commands.pipes(line) ? pipeline(line) : [line, undefined];
    const out = await commands.run(head, options?.signal);
    const env = { PWD: options?.cwd ?? bash.getCwd() };
    if (tail === undefined) return { ...out, env };
    const piped = await exec(tail, { ...options, stdin: out.stdout });
    return { ...piped, stderr: out.stderr + piped.stderr };
  };
}
