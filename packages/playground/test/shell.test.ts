import { afterEach, describe, expect, it } from "vitest";
import { Bash } from "just-bash";
import { Playground } from "../src/playground.ts";
import { Prompter, question, reportLines, SlashCommands, traceLine, TurnRenderer, withSlashCommands, words } from "../src/shell.ts";
import type { Settings } from "../src/shell.ts";
import { shellModel } from "../src/shell-model.ts";
import { Tracer } from "../src/trace.ts";
import { HOME } from "../src/vfs.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const open: Playground[] = [];
afterEach(async () => {
  for (const p of open.splice(0)) await p.close();
});

async function terminal(answer?: (key: Prompter) => void) {
  const tracer = new Tracer(() => Date.now());
  const bash = new Bash({ cwd: HOME, files: { [`${HOME}/README.md`]: "hi\n" } });
  const settings: Settings = { worker: "shell", tier: "default", approval: "ask", generate: "auto", decide: "auto", writer: "auto" };
  const playground = await Playground.start({ bash, tracer, models: { shell: shellModel() }, worker: () => settings.worker, approval: () => settings.approval });
  open.push(playground);
  let out = "";
  const turns: [string, string][] = [];
  const prompter = new Prompter((s) => void (out += s));
  if (answer) prompter.onAsk = () => answer(prompter);
  withSlashCommands(bash, new SlashCommands({ playground, tracer, settings, prompter, write: (s) => void (out += s), workers: ["echo", "shell", "claude"], onTurn: (p, r) => void turns.push([p, r.stopReason]) }));
  const run = async (line: string) => {
    out = "";
    const r = await bash.exec(line, { cwd: HOME });
    return { ...r, out: plain(out), stdout: plain(r.stdout) };
  };
  return { run, settings, playground, bash, tracer, turns, prompter };
}

describe("the terminal's slash commands", () => {
  it("TM1.1 /ask streams the agent's reply to the terminal and ends with the turn's report", async () => {
    const t = await terminal();
    t.settings.worker = "echo";
    const r = await t.run("/ask hello there");
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("echo: hello there");
    expect(r.out).toMatch(/── end_turn · 0 model calls · 0 tool calls · no file changes · \d+ms/);
    expect(t.turns).toEqual([["hello there", "end_turn"]]);
  });

  it("TM1.2 a tool call asks y/n in the terminal; yes runs it and the report names the files it changed", async () => {
    const t = await terminal((p) => p.handleKey("y"));
    const r = await t.run("/ask $ echo x > made.txt");
    expect(r.out).toContain("Allow bash");
    expect(r.out).toContain("allowed");
    expect(r.out).toContain("⚙ bash");
    expect(r.out).toContain("+ /home/user/made.txt");
    expect(r.out).toMatch(/1 tool call · 1 added, 0 modified, 0 removed/);
    expect(await t.bash.readFile(`${HOME}/made.txt`)).toBe("x\n");
  });

  it("TM1.3 no keeps it from running; Ctrl-C at the question cancels the turn", async () => {
    const denied = await terminal((p) => p.handleKey("n"));
    expect((await denied.run("/ask $ rm README.md")).out).toContain("denied");
    expect(await denied.bash.fs.exists(`${HOME}/README.md`)).toBe(true);
    const dismissed = await terminal((p) => p.handleKey("\x03"));
    expect((await dismissed.run("/ask $ rm README.md")).out).toContain("── cancelled");
  });

  it("TM1.3b a turn that fails outright prints why and exits 1", async () => {
    for (const [thrown, said] of [
      [new Error("daemon gone"), "daemon gone"],
      ["just a string", "just a string"],
    ] as const) {
      const bash = new Bash({ cwd: HOME });
      const stub = { prompt: () => Promise.reject(thrown), cancel: async () => {} } as unknown as Playground;
      withSlashCommands(bash, new SlashCommands({ playground: stub, tracer: new Tracer(() => 0), settings: { worker: "echo", tier: "default", approval: "ask", generate: "auto", decide: "auto", writer: "auto" }, prompter: new Prompter(() => {}), write: () => {}, workers: ["echo"] }));
      expect(await bash.exec("/ask hi", { cwd: HOME })).toMatchObject({ exitCode: 1, stderr: `${said}\n` });
    }
  });

  it("TM1.3c Ctrl-C while a question waits cancels the turn and withdraws the question, so keys go back to the shell", async () => {
    const abort = new AbortController();
    const t = await terminal(() => abort.abort());
    const bash = t.bash;
    const r = await bash.exec("/ask $ touch never", { cwd: HOME, signal: abort.signal });
    expect(r.exitCode).not.toBe(2);
    expect(await bash.fs.exists(`${HOME}/never`)).toBe(false);
    expect(t.prompter.waiting).toBe(false);
  });

  it("TM1.4 /ask without words says how to use it", async () => {
    const t = await terminal();
    expect(await t.run("/ask")).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("usage: /ask <prompt>") });
  });

  it("TM2.1 /worker, /tier and /approve show and change the settings, refusing unknown values", async () => {
    const t = await terminal();
    expect((await t.run("/worker")).stdout).toBe("shell (one of echo, shell, claude)\n");
    expect((await t.run("/worker echo")).stdout).toBe("worker: echo\n");
    expect(t.settings.worker).toBe("echo");
    expect(await t.run("/worker nope")).toMatchObject({ exitCode: 2, stderr: "unknown worker nope (one of echo, shell, claude)\n" });
    expect((await t.run("/tier quick")).stdout).toBe("tier: quick\n");
    expect((await t.run("/tier")).stdout).toBe("quick (one of quick, default, complex)\n");
    expect(await t.run("/tier huge")).toMatchObject({ exitCode: 2 });
    expect((await t.run("/approve")).stdout).toBe("ask (one of ask, auto)\n");
    expect((await t.run("/approve auto")).stdout).toBe("approve: auto\n");
    expect(t.settings).toEqual({ worker: "echo", tier: "quick", approval: "auto", generate: "auto", decide: "auto", writer: "auto" });
    expect(await t.run("/approve maybe")).toMatchObject({ exitCode: 2 });
  });

  it("TM2.2 sessions, new and use manage sessions; use takes an id prefix and replays the log", async () => {
    const t = await terminal();
    t.settings.worker = "echo";
    await t.run("/ask one");
    const first = t.playground.sessionId!;
    const made = (await t.run("/new")).stdout.trim();
    expect(made).not.toBe(first);
    const listed = (await t.run("/sessions")).stdout;
    expect(listed).toContain(`  ${first}`);
    expect(listed).toContain(`* ${made}`);
    const used = await t.run(`/use ${first.slice(0, 12)}`);
    expect(used.out).toContain("echo: one");
    expect(t.playground.sessionId).toBe(first);
    expect(await t.run("/use zzz")).toMatchObject({ exitCode: 1, stderr: "no session starts with zzz\n" });
    expect(await t.run("/use")).toMatchObject({ exitCode: 1, stderr: "no session starts with \n" });
  });

  it("TM2.3 trace prints the newest events, one per line, and can be piped; a count that is not a positive whole number is refused", async () => {
    const t = await terminal();
    t.settings.worker = "echo";
    await t.run("/ask hi");
    const lines = (await t.run("/trace 3")).stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toMatch(/vfs\s+changes · 0 added/);
    expect((await t.run("/trace 50 | grep -c acp")).stdout.trim()).not.toBe("0");
    await t.run("/ask again");
    expect((await t.run("/trace")).stdout.trim().split("\n")).toHaveLength(20);
    for (const bad of ["0", "abc", "1.5"]) expect(await t.run(`/trace ${bad}`)).toMatchObject({ exitCode: 2, stderr: "usage: /trace [n], n a positive whole number\n" });
    expect(await t.run("/trace -5")).toMatchObject({ exitCode: 2, stderr: "Unknown option `-5`; see /trace --help\n" });
  });

  it("TM2.4 status summarizes the daemon; help lists the commands; an unknown one is refused", async () => {
    const t = await terminal();
    t.settings.worker = "echo";
    await t.run("/ask hi");
    const status = (await t.run("/status")).stdout;
    expect(status).toMatch(/sessions\s+1/);
    expect(status).toMatch(/worker\s+echo/);
    expect(status).toMatch(/hook events\s+\d+/);
    t.playground.host.daemon.offerPlatformCapability({ name: "memory", version: 1, trust: "trusted" });
    expect((await t.run("/status")).stdout).toMatch(/capabilities\s+memory/);
    expect((await t.run("/help")).stdout).toMatch(/^\/trace \[n\]\s+The newest trace events/m);
    expect(await t.run("/nope")).toMatchObject({ exitCode: 2, stderr: "unknown command /nope; /help lists them\n" });
  });

  it("TM2.6 /reset clears what this browser keeps (when the page keeps anything) and says so", async () => {
    const t = await terminal();
    expect(await t.run("/reset")).toMatchObject({ exitCode: 1, stderr: "this page keeps nothing to reset\n" });
    const bash = new Bash({ cwd: HOME });
    let reset = 0;
    withSlashCommands(bash, new SlashCommands({ playground: t.playground, tracer: t.tracer, settings: t.settings, prompter: new Prompter(() => {}), write: () => {}, workers: ["echo"], onReset: async () => void reset++ }));
    expect(await bash.exec("/reset", { cwd: HOME })).toMatchObject({ exitCode: 0, stdout: "cleared the saved sessions, conversations and files; reloading\n" });
    expect(reset).toBe(1);
  });

  it("TM2.5 /snapshot prints the daemon's snapshot as JSON", async () => {
    const t = await terminal();
    expect(JSON.parse((await t.run("/snapshot")).stdout)).toMatchObject({ version: 1, sessions: [] });
  });
});

describe("slash commands: parsed before bash, with a command-line parser", () => {
  it("TM5.1 words split as a shell would, but leniently: quotes group only when they close, so an apostrophe is a letter", () => {
    expect(words(`ask what's  "in here"  'a b'c don't`)).toEqual(["ask", "what's", "in here", "a bc", "don't"]);
    expect(words(`  `)).toEqual([]);
    expect(words(`say "unclosed and 'this'`)).toEqual(["say", '"unclosed', "and", "this"]);
  });

  it("TM5.2 a line whose first word is a slash command is the harness's; anything else, a path that exists included, is bash's", async () => {
    const t = await terminal();
    t.settings.worker = "echo";
    expect((await t.run("/ask what's in here?")).out).toContain("echo: what's in here?");
    expect((await t.run("echo plain")).stdout).toBe("plain\n");
    expect((await t.run("/bin/echo from a path")).stdout).toBe("from a path\n");
    expect((await t.run("/help")).exitCode).toBe(0);
    expect((await t.run("/")).stdout).toBe((await t.run("/help")).stdout);
  });

  it("TM5.3 a slash command's output pipes into bash; /ask's prompt is the rest of the line as typed (a bar and quotes included; quotes around all of it dropped)", async () => {
    const t = await terminal();
    expect((await t.run("/worker | tr a-z A-Z")).stdout).toBe("SHELL (ONE OF ECHO, SHELL, CLAUDE)\n");
    expect((await t.run("/status | grep -c worker")).stdout).toBe("1\n");
    t.settings.worker = "echo";
    expect((await t.run(`/ask a|b "c"`)).out).toContain('echo: a|b "c"');
    expect((await t.run(`/ask 'all of it quoted'`)).out).toContain("echo: all of it quoted");
  });

  it("TM5.3b /ask runs a command through the shell worker exactly as typed, pipes and quotes included", async () => {
    const t = await terminal((p) => p.handleKey("y"));
    await t.run(`/ask $ printf '%s\\n' "a b" | wc -l > n.txt`);
    expect((await t.bash.readFile(`${HOME}/n.txt`)).trim()).toBe("1");
    expect((await t.run("/ask --help")).stdout).toMatch(/Usage:\n\s+\/ask \[\.\.\.prompt\]/);
  });

  it("TM5.4 every command takes --help from the parser; unknown options and extra words are refused with a pointer to it", async () => {
    const t = await terminal();
    expect((await t.run("/trace --help")).stdout).toMatch(/Usage:\n\s+\/trace \[n\]/);
    expect((await t.run("/help --help")).exitCode).toBe(0);
    expect(await t.run("/status --bogus")).toMatchObject({ exitCode: 2, stderr: "Unknown option `--bogus`; see /status --help\n" });
  });

  it("TM5.5 the parser's commands are the ones help lists, each with a description", async () => {
    const t = await terminal();
    const listed = (await t.run("/help")).stdout.trim().split("\n").map((l) => l.split(/\s+/)[0]);
    expect(listed).toEqual(["/ask", "/new", "/sessions", "/use", "/worker", "/tier", "/approve", "/generate", "/decide", "/writer", "/templates", "/rate", "/trace", "/status", "/snapshot", "/reset", "/help"]);
    const commands = new SlashCommands({ playground: t.playground, tracer: t.tracer, settings: t.settings, prompter: t.prompter, write: () => {}, workers: [] }).list();
    expect(commands.map((c) => `/${c.name.split(" ")[0]}`)).toEqual(listed);
    expect(commands[0]).toEqual({ name: "ask [...prompt]", description: expect.stringContaining("Run a turn") });
  });
});

describe("the template engine's commands", () => {
  async function withEngine() {
    const t = await terminal();
    const { TemplateStore, TEMPLATES } = await import("../src/templates.ts");
    const { TemplateEngine } = await import("../src/engine.ts");
    const { lexicalDecider } = await import("../src/decide.ts");
    const { parseEngineSettings } = await import("../src/engine-settings.ts");
    const { readFileSync } = await import("node:fs");
    const settings = parseEngineSettings(JSON.parse(readFileSync(new URL("../data/templates.json", import.meta.url), "utf8")));
    await t.bash.fs.mkdir(TEMPLATES, { recursive: true });
    await t.bash.fs.writeFile(`${TEMPLATES}/list-files.md`, readFileSync(new URL("../data/templates/list-files.md", import.meta.url), "utf8"));
    await t.bash.fs.writeFile(`${TEMPLATES}/broken.md`, "not a template");
    const store = new TemplateStore(t.bash.fs, { retireMargin: 2 });
    const engine = new TemplateEngine({ store, settings, facts: {}, deciders: () => [lexicalDecider(settings.lexical)], generators: () => [], generation: () => t.settings.generate });
    const bash = new Bash({ fs: t.bash.fs, cwd: HOME });
    const decider = { state: "Julia 1: loading (614 MB)" };
    const slugs = ["auto", "lexical", "org/decider"];
    withSlashCommands(bash, new SlashCommands({ playground: t.playground, tracer: t.tracer, settings: t.settings, prompter: t.prompter, write: () => {}, workers: ["templates"], engine, store, decider: { slugs: () => slugs, status: (slug) => (slug === "lexical" ? "the lexical judge alone" : decider.state) }, writer: { slugs: () => ["auto", "claude", "org/writer"], status: (slug) => (slug === "claude" ? "Claude alone" : `${slug}: Writer: ready`) } }));
    const run = async (line: string) => {
      const r = await bash.exec(line, { cwd: HOME });
      return { ...r, stdout: plain(r.stdout) };
    };
    return { ...t, run, engine, store, decider };
  }

  it("TM6.1 /generate shows and sets whether the local model generates (auto, never asking) or is off; asking first is no option", async () => {
    const t = await withEngine();
    expect((await t.run("/generate")).stdout).toBe("auto (one of auto, off)\n");
    expect((await t.run("/generate off")).stdout).toBe("generate: off\n");
    expect(t.settings.generate).toBe("off");
    expect(await t.run("/generate ask")).toMatchObject({ exitCode: 2 });
  });

  it("TM6.5 /decide shows and sets which decision model decides by slug: auto (picked for this browser), lexical, or a catalog id; how it is doing shows in /decide and /status", async () => {
    const t = await withEngine();
    t.settings.decide = "auto";
    expect((await t.run("/decide")).stdout).toBe("auto (one of auto, lexical, org/decider)\ndecision model: Julia 1: loading (614 MB)\n");
    t.decider.state = "Julia 1: ready";
    expect((await t.run("/status")).stdout).toMatch(/^decide\s+auto: Julia 1: ready$/m);
    expect((await t.run("/decide org/decider")).stdout).toBe("decide: org/decider\n");
    expect(t.settings.decide).toBe("org/decider");
    expect((await t.run("/decide lexical")).stdout).toBe("decide: lexical\n");
    expect((await t.run("/status")).stdout).toMatch(/^decide\s+lexical: the lexical judge alone$/m);
    expect(await t.run("/decide julia")).toMatchObject({ exitCode: 2, stderr: "unknown decide julia (one of auto, lexical, org/decider)\n" });
  });

  it("TM6.6 /writer shows and sets which model writes templates by slug: auto (a local one for this browser, then Claude), claude, or a catalog id", async () => {
    const t = await withEngine();
    expect((await t.run("/writer")).stdout).toBe("auto (one of auto, claude, org/writer)\ngenerator: auto: Writer: ready\n");
    expect((await t.run("/status")).stdout).toMatch(/^writer\s+auto: auto: Writer: ready$/m);
    expect((await t.run("/writer claude")).stdout).toBe("writer: claude\n");
    expect(t.settings.writer).toBe("claude");
    expect((await t.run("/status")).stdout).toMatch(/^writer\s+claude: Claude alone$/m);
    expect(await t.run("/writer gpt")).toMatchObject({ exitCode: 2, stderr: "unknown writer gpt (one of auto, claude, org/writer)\n" });
  });

  it("TM6.2 /templates lists the templates with their feedback, and the files that are not templates", async () => {
    const t = await withEngine();
    const out = (await t.run("/templates")).stdout;
    expect(out).toMatch(/^list-files\s+reply\s+\+0 -0\s+A list of the files in the working directory$/m);
    expect(out).toContain("~/agent/templates/broken.md is not a template:");
  });

  it("TM6.3 /rate counts the last answer's template helpful or harmful (a reason makes it rewritten when next chosen); retiring says so", async () => {
    const t = await withEngine();
    expect(await t.run("/rate good")).toMatchObject({ exitCode: 1, stderr: "nothing to rate yet: /ask something first\n" });
    t.engine.last = { templateId: "list-files", request: "list the files" };
    expect((await t.run("/rate good")).stdout).toBe("list-files: 1 helpful, 0 harmful\n");
    expect((await t.run("/rate bad too terse, isn't it")).stdout).toBe("list-files: 1 helpful, 1 harmful; rewritten when next chosen (too terse, isn't it)\n");
    expect((await t.run("/rate bad")).stdout).toMatch(/list-files: 1 helpful, 2 harmful; rewritten/);
    expect((await t.run("/rate bad")).stdout).toBe("list-files: 1 helpful, 3 harmful; retired to ~/agent/templates/retired\n");
    expect(await t.run("/rate meh")).toMatchObject({ exitCode: 2, stderr: "usage: /rate good|bad [why]\n" });
  });

  it("TM6.4 without the engine the template commands say so", async () => {
    const t = await terminal();
    expect(await t.run("/templates")).toMatchObject({ exitCode: 1, stderr: "no template engine here\n" });
    expect(await t.run("/rate good")).toMatchObject({ exitCode: 1, stderr: "no template engine here\n" });
  });
});

describe("rendering a turn in the terminal", () => {
  it("TM3.1 text keeps its lines; tool calls, results and notices get lines of their own", () => {
    const r = new TurnRenderer();
    const out = [
      r.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi\nthere" } }),
      r.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } }),
      r.update({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "AA==", mimeType: "image/png" } }),
      r.update({ sessionUpdate: "agent_thought_chunk", content: { type: "image", data: "AA==", mimeType: "image/png" } }),
      r.update({ sessionUpdate: "user_message_chunk", content: { type: "image", data: "AA==", mimeType: "image/png" } }),
      r.update({ sessionUpdate: "tool_call", toolCallId: "1", title: "bash", rawInput: { command: "ls" } }),
      r.update({ sessionUpdate: "tool_call_update", toolCallId: "1", status: "completed", rawOutput: { stdout: "a\nb\nc\nd\n", stderr: "", exitCode: 0 } }),
      r.update({ sessionUpdate: "tool_call_update", toolCallId: "2", status: "failed", rawOutput: { error: "boom" } }),
      r.update({ sessionUpdate: "tool_call_update", toolCallId: "3", status: "in_progress" }),
      r.update({ sessionUpdate: "tool_call_update", toolCallId: "4", status: "failed" }),
      r.update({ sessionUpdate: "tool_call", toolCallId: "5", title: "readFile" }),
      r.update({ sessionUpdate: "notice", severity: "warning", title: "Heads up" }),
      r.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }),
      r.update({ sessionUpdate: "notice", severity: "error", title: "Model call failed", description: "down" }),
      r.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "you said" } }),
      r.update({ sessionUpdate: "available_commands_update", availableCommands: [] }),
      r.end(),
    ].join("");
    expect(plain(out)).toBe(
      "Hi\r\nthere\r\n⚙ bash {\"command\":\"ls\"}\r\n  ✓ exit 0 · a\r\n    b\r\n    c\r\n    …\r\n  ✗ boom\r\n  ✗ failed\r\n⚙ readFile {}\r\n! Heads up\r\nhmm\r\n! Model call failed: down\r\n› you said\r\n",
    );
  });

  it("TM3.2 end adds a line break only when the cursor is mid-line", () => {
    const r = new TurnRenderer();
    expect(r.end()).toBe("");
    r.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done\n" } });
    expect(r.end()).toBe("");
  });

  it("TM3.3 a completed call whose output is not a command's shows it as JSON; a command with no output shows its exit code", () => {
    const r = new TurnRenderer();
    expect(plain(r.update({ sessionUpdate: "tool_call_update", toolCallId: "1", status: "completed", rawOutput: { content: "x" } }))).toBe('  ✓ {"content":"x"}\r\n');
    expect(plain(r.update({ sessionUpdate: "tool_call_update", toolCallId: "1", status: "completed", rawOutput: "text" }))).toBe('  ✓ "text"\r\n');
    expect(plain(r.update({ sessionUpdate: "tool_call_update", toolCallId: "1", status: "completed", rawOutput: { stdout: "", stderr: "", exitCode: 3 } }))).toBe("  ✓ exit 3\r\n");
    // A generation says who generated, not the text the reply then gives.
    expect(plain(r.update({ sessionUpdate: "tool_call_update", toolCallId: "1", status: "completed", rawOutput: { answer: "Paris.", by: "local/tiny", problems: [] } }))).toBe("  ✓ answered by local/tiny\r\n");
    expect(plain(r.update({ sessionUpdate: "tool_call_update", toolCallId: "1", status: "completed", rawOutput: { id: "greet", values: { name: "Ada" }, by: "local/tiny" } }))).toBe("  ✓ template greet by local/tiny\r\n");
  });

  it("TM3.3b a turn's report lists the files it added, modified and removed", () => {
    const lines = plain(reportLines({ stopReason: "end_turn", modelCalls: 1, toolCalls: 2, ms: 5, diff: { added: ["/a"], modified: ["/m"], removed: ["/r"] } }));
    expect(lines).toBe("── end_turn · 1 model call · 2 tool calls · 1 added, 1 modified, 1 removed · 5ms\r\n  + /a\r\n  ~ /m\r\n  - /r\r\n");
  });

  it("TM3.4 a trace line shows the sequence, kind, direction, name and a span's duration", () => {
    expect(traceLine({ seq: 7, at: 0, kind: "model", name: "stream", phase: "end", duration: 12 })).toBe("   7 model    stream (12ms)");
    expect(traceLine({ seq: 8, at: 0, kind: "acp", name: "result #1", direction: "out" })).toBe("   8 acp    ← result #1");
    expect(traceLine({ seq: 9, at: 0, kind: "acp", name: "initialize #0", direction: "in" })).toBe("   9 acp    → initialize #0");
  });

  it("TM3.5 a permission question names the tool and its command, or its input (generation never asks)", () => {
    const ask = (toolCall: object) => question({ sessionId: "s", toolCall: { toolCallId: "c", ...toolCall }, options: [] });
    expect(ask({ title: "bash", rawInput: { command: "ls" } })).toBe("Allow bash: ls?");
    expect(ask({ title: "writeFile", rawInput: { path: "a" } })).toBe('Allow writeFile {"path":"a"}?');
    expect(ask({})).toBe("Allow this tool {}?");
  });
});

describe("the prompter: a question the terminal answers with a key", () => {
  it("TM4.1 y or enter allows, n denies, Ctrl-C dismisses; other keys are swallowed while it waits; nothing is taken when it is not asking", async () => {
    let out = "";
    const p = new Prompter((s) => void (out += s));
    expect(p.handleKey("y")).toBe(false);
    const answers: (string | undefined)[] = [];
    for (const key of ["y", "\r", "n", "\x03"]) {
      const asked = p.ask("Allow?");
      expect(p.handleKey("x")).toBe(true);
      expect(p.handleKey(key)).toBe(true);
      answers.push(await asked);
    }
    expect(answers).toEqual(["allow", "allow", "deny", undefined]);
    const withdrawn = p.ask("Still there?");
    p.withdraw();
    p.withdraw();
    expect(await withdrawn).toBeUndefined();
    expect(plain(out)).toContain("withdrawn");
    expect(plain(out)).toContain("Allow? [y/n] ");
    expect(p.waiting).toBe(false);
  });
});
