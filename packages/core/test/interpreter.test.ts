import { describe, expect, it } from "vitest";
import { InputInterpreter } from "@harness/core";
import type { DecisionAnswer, InferenceAnswer, InputAction, RegisteredTool } from "@harness/core";

const echo: RegisteredTool = { kind: "tool", name: "echo", description: "Repeat text." };
const searchSkill: RegisteredTool = { kind: "skill", name: "search", description: "Search as a skill." };
const searchMcp: RegisteredTool = { kind: "mcp", name: "search", description: "Search as an MCP." };

const alpha = { name: "alpha", harness: "claude-code", state: { checkpoint: 1 } };
const beta = { name: "beta", harness: "claude-code", state: { checkpoint: 2 } };
const gamma = { name: "gamma", harness: "codex", state: { checkpoint: 3 } };

function document(session: { name: string; harness: string; state: unknown }): string {
  return `${JSON.stringify({ name: session.name, harness: session.harness, state: session.state }, null, 2)}\n`;
}

function interpreter(options: {
  tools?: readonly RegisteredTool[];
  commands?: readonly { name: string; description: string }[];
  maxOptions?: number;
  sessions?: readonly { name: string; harness: string; state: unknown }[];
  settings?: readonly { key: string; description: string; fallback: string; values?: readonly string[] }[];
  decide?: (text: string, context: string, options: readonly { name: string; description: string }[]) => DecisionAnswer | Promise<DecisionAnswer>;
  infer?: (text: string, context: string) => InferenceAnswer | Promise<InferenceAnswer>;
  suggest?: (text: string, context: string) => { ok: true; suggestions: readonly { text: string; description: string }[] } | { ok: false } | Promise<{ ok: true; suggestions: readonly { text: string; description: string }[] } | { ok: false }>;
} = {}) {
  const seen: { decide: string[]; infer: string[]; suggest: string[] } = { decide: [], infer: [], suggest: [] };
  const calls = {
    files: [] as [string, string][],
    clips: [] as string[],
    resumes: [] as { name: string; harness: string; state: unknown }[],
  };
  const engine = new InputInterpreter({
    tools: options.tools ?? [echo, searchSkill, searchMcp],
    commands: options.commands ?? [{ name: "ask", description: "Run a turn." }],
    ...(options.maxOptions === undefined ? {} : { maxOptions: options.maxOptions }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.sessions === undefined
      ? {}
      : {
          harnesses: {
            sessions: options.sessions,
            writeFile: (filename: string, contents: string) => { calls.files.push([filename, contents]); },
            copy: (text: string) => { calls.clips.push(text); },
            resume: (session: { name: string; harness: string; state: unknown }) => { calls.resumes.push(session); },
          },
        }),
  }, {
    decide: async (request) => {
      seen.decide.push(`${request.context}\n---\n${request.text}\n[${request.options.map((option) => option.name).join(",")}]`);
      return options.decide?.(request.text, request.context, request.options) ?? { choice: "message", complicated: false };
    },
    infer: async (request) => {
      seen.infer.push(`${request.context}\n---\n${request.text}`);
      return options.infer?.(request.text, request.context) ?? { ok: false };
    },
    ...(options.suggest === undefined
      ? {}
      : {
          suggest: async (request: { text: string; context: string }) => {
            seen.suggest.push(`${request.context}\n---\n${request.text}`);
            return options.suggest?.(request.text, request.context) ?? { ok: false };
          },
        }),
  });
  return { engine, seen, calls };
}

const prior = { turns: [{ role: "user" as const, text: "remember /tools from before" }, { role: "assistant" as const, text: "the earlier fact" }] };

async function run(engine: InputInterpreter, text: string, context = prior): Promise<InputAction> {
  const result = await engine.submit(text, context, 5);
  return result.action;
}

async function complete(engine: InputInterpreter, prefix: string, context = prior) {
  return engine.complete(prefix, context);
}

describe("input interpreter", () => {
  it("IN1.1 a slash command is parsed from the new line, and prior text does not make one", async () => {
    const { engine, seen } = interpreter();
    const listed = await run(engine, " \n /tools \n ");
    expect(listed).toEqual({ type: "list-tools", tools: [echo, searchSkill, searchMcp] });
    expect(seen.decide).toEqual([]);
    expect(seen.infer).toEqual([]);
    const said = await run(engine, "hello");
    expect(said).toEqual({ type: "message", text: "hello" });
    expect(seen.decide).toHaveLength(1);
    expect(seen.decide[0]?.split("\n---\n")[0]).toBe("remember /tools from before\nthe earlier fact");
    expect(seen.decide[0]).toContain("---\nhello\n");
    expect(seen.decide[0]).toContain("[message,echo,skill:search,mcp:search,complicated]");
    expect(seen.infer).toEqual([]);
    expect(await run(engine, "please /tools")).toEqual({ type: "message", text: "please /tools" });
    expect(seen.decide).toHaveLength(2);
  });

  it("IN1.2 /tools names an mcp, skill, or native tool and invokes it as a model tool", async () => {
    const { engine, seen } = interpreter();
    expect(await run(engine, "/tools echo say hi")).toEqual({ type: "invoke-tool", tool: echo, argument: "say hi" });
    expect(await run(engine, "/tools skill:search")).toEqual({ type: "invoke-tool", tool: searchSkill, argument: "" });
    expect(await run(engine, "/tools mcp:search")).toEqual({ type: "invoke-tool", tool: searchMcp, argument: "" });
    expect(await run(engine, "/tools search")).toMatchObject({ type: "elicit" });
    expect(await run(engine, "/tools missing")).toEqual({ type: "unknown-tool", name: "missing" });
    expect(await run(engine, "/tools mcp:missing")).toEqual({ type: "unknown-tool", name: "mcp:missing" });
    expect(seen.decide).toEqual([]);
  });

  it("IN1.3 a harness command is not a tool, and an unknown slash command stays a command", async () => {
    const { engine, seen } = interpreter();
    expect(await run(engine, "/ask  the rest ")).toEqual({ type: "harness-command", name: "ask", argument: "the rest" });
    expect(await run(engine, "/nope")).toEqual({ type: "unknown-command", name: "nope" });
    expect(await run(engine, "/")).toEqual({ type: "unknown-command", name: "" });
    expect(seen.decide).toEqual([]);
    expect(() => interpreter({ commands: [{ name: "tools", description: "no" }] })).toThrow(/tools/);
    expect(() => interpreter({ commands: [{ name: "ask", description: "a" }, { name: "ask", description: "b" }] })).toThrow(/duplicated/);
    expect(() => interpreter({ tools: [echo, echo] })).toThrow(/duplicated/);
    expect(() => interpreter({ maxOptions: 1 })).toThrow(/maxOptions/);
    expect(() => interpreter({ maxOptions: 21 })).toThrow(/maxOptions/);
    expect(() => interpreter({ maxOptions: 2.5 })).toThrow(/maxOptions/);
    const bounded = interpreter({ maxOptions: 20 });
    expect(await run(bounded.engine, "/tools")).toEqual({ type: "list-tools", tools: [echo, searchSkill, searchMcp] });
  });

  it("IN1.4 the decision model can name a tool, and a complicated reading goes to the generator", async () => {
    const named = interpreter({
      decide: () => ({ choice: "echo", complicated: false }),
    });
    expect(await run(named.engine, "please echo this")).toEqual({ type: "invoke-tool", tool: echo, argument: "please echo this" });
    expect(named.seen.infer).toEqual([]);
    const hard = interpreter({
      decide: () => ({ choice: "message", complicated: true }),
      infer: () => ({ ok: true, action: { type: "message", text: "please think" } }),
    });
    expect(await run(hard.engine, "please think")).toEqual({ type: "message", text: "please think" });
    expect(hard.seen.infer).toHaveLength(1);
    expect(hard.seen.infer[0]).toContain("the earlier fact");
  });

  it("IN1.5 a decision the model cannot name, a bad generator action, or a generator failure asks the user", async () => {
    const coarse = interpreter({
      tools: Array.from({ length: 19 }, (_, index) => ({ kind: "tool" as const, name: `t${index}`, description: `tool ${index}` })),
      decide: (_text, _context, options) => {
        expect(options.map((option) => option.name)).toEqual(["message", "use-tool", "complicated"]);
        return { choice: "use-tool", complicated: false };
      },
      infer: () => ({ ok: true, action: { type: "invoke-tool", tool: { kind: "tool", name: "nope", description: "" }, argument: "" } }),
    });
    const asked = await run(coarse.engine, "use something");
    expect(asked).toMatchObject({ type: "elicit" });
    if (asked.type === "elicit") expect(asked.question).toContain("use something");
    const refused = interpreter({
      decide: () => ({ choice: "complicated", complicated: false }),
      infer: () => { throw new Error("generator down"); },
    });
    expect(await run(refused.engine, "classify me")).toMatchObject({ type: "elicit" });
    const blank = interpreter({ decide: () => { throw new Error("decision down"); }, infer: () => ({ ok: false }) });
    expect(await run(blank.engine, "classify me")).toMatchObject({ type: "elicit" });
    const weird = interpreter({ decide: () => ({ choice: "nope", complicated: false }), infer: () => ({ ok: false }) });
    expect(await run(weird.engine, "classify me")).toMatchObject({ type: "elicit" });
    const command = interpreter({
      decide: () => ({ choice: "complicated", complicated: false }),
      infer: () => ({ ok: true, action: { type: "harness-command", name: "ask", argument: "hi" } }),
    });
    expect(await run(command.engine, "run ask")).toEqual({ type: "harness-command", name: "ask", argument: "hi" });
  });

  it("IN1.6 actors publish on the hook bus and never handle their own events", async () => {
    const { engine } = interpreter({ decide: () => ({ choice: "complicated", complicated: false }), infer: () => ({ ok: false }) });
    await run(engine, "needs a person");
    const events = engine.events();
    expect(events.map((event) => event.type)).toEqual(["input.received", "intent.decide", "intent.infer", "intent.unresolved", "action.ready"]);
    expect(events[1]?.causationId).toBe(events[0]?.eventId);
    expect(events[4]?.causationId).toBe(events[3]?.eventId);
    expect(new Set(events.map((event) => event.source)).size).toBe(events.length);
    const sources = events.map((event) => event.source);
    expect(sources[0]).toBe("input");
    expect(sources[1]).toBe("actor.parser");
    expect(sources[4]).toBe("actor.eliciter");
  });

  it("IN1.7 the decision model sees the newest context that fits, not the whole history", async () => {
    const { engine, seen } = interpreter();
    const huge = "x".repeat(5000);
    await run(engine, "now", { turns: [{ role: "user", text: huge }, { role: "assistant", text: "tail-marker" }] });
    const context = seen.decide[0]?.split("\n---\n")[0] ?? "";
    expect(context).toBe("tail-marker");
    await run(engine, "now", { turns: [{ role: "user", text: "OLD" }, { role: "assistant", text: `${"y".repeat(5000)}END` }] });
    const only = seen.decide[1]?.split("\n---\n")[0] ?? "";
    expect(only).toBe(`${"y".repeat(1997)}END`);
    const boundary = "b".repeat(1995);
    await run(engine, "now", { turns: [{ role: "user", text: boundary }, { role: "assistant", text: "tail" }] });
    expect(seen.decide[2]?.split("\n---\n")[0]).toBe(`${boundary}\ntail`);
  });

  it("IN1.8 a generator action is kept only when it names this registry", async () => {
    const listed = interpreter({
      decide: () => ({ choice: "complicated", complicated: false }),
      infer: () => ({ ok: true, action: { type: "list-tools", tools: [] } }),
    });
    expect(await run(listed.engine, "list them")).toEqual({ type: "list-tools", tools: [echo, searchSkill, searchMcp] });
    const invoked = interpreter({
      decide: () => ({ choice: "complicated", complicated: false }),
      infer: () => ({ ok: true, action: { type: "invoke-tool", tool: { kind: "tool", name: "echo", description: "other" }, argument: "hi" } }),
    });
    const called = await run(invoked.engine, "please");
    expect(called).toEqual({ type: "invoke-tool", tool: echo, argument: "hi" });
    if (called.type === "invoke-tool") expect(called.tool).toBe(echo);
    const reserved = interpreter({
      decide: () => ({ choice: "complicated", complicated: false }),
      infer: () => ({ ok: true, action: { type: "harness-command", name: "tools", argument: "" } }),
    });
    expect(await run(reserved.engine, "show tools")).toEqual({ type: "harness-command", name: "tools", argument: "" });
    const invented = interpreter({
      decide: () => ({ choice: "complicated", complicated: false }),
      infer: () => ({ ok: true, action: { type: "harness-command", name: "nope", argument: "x" } }),
    });
    const asked = await run(invented.engine, "classify me");
    expect(asked).toMatchObject({ type: "elicit" });
    if (asked.type === "elicit") expect(asked.question).toContain("classify me");
    const kind = interpreter({
      decide: () => ({ choice: "complicated", complicated: false }),
      infer: () => ({ ok: true, action: { type: "invoke-tool", tool: { kind: "skill", name: "echo", description: "" }, argument: "" } }),
    });
    expect(await run(kind.engine, "classify me")).toMatchObject({ type: "elicit" });
    const elicited = interpreter({
      decide: () => ({ choice: "complicated", complicated: false }),
      infer: () => ({ ok: true, action: { type: "elicit", question: "from the model" } }),
    });
    const replaced = await run(elicited.engine, "classify me");
    expect(replaced).toMatchObject({ type: "elicit" });
    if (replaced.type === "elicit") expect(replaced.question).toContain("classify me");
    const coarseNamed = interpreter({
      tools: Array.from({ length: 19 }, (_, index) => ({ kind: "tool" as const, name: `t${index}`, description: `tool ${index}` })),
      decide: () => ({ choice: "t0", complicated: false }),
      infer: () => ({ ok: false }),
    });
    expect(await run(coarseNamed.engine, "use something")).toMatchObject({ type: "elicit" });
  });

  it("IN2.1 /sessions export writes the named harness session to a file and does not classify it", async () => {
    const { engine, seen, calls } = interpreter({ sessions: [alpha, beta] });
    expect(await run(engine, " /sessions export alpha ")).toEqual({
      type: "exported",
      sessions: [{ name: "alpha", harness: "claude-code" }],
      destination: { type: "file", filename: "alpha.json" },
    });
    expect(calls.files).toEqual([["alpha.json", document(alpha)]]);
    expect(calls.clips).toEqual([]);
    expect(seen.decide).toEqual([]);
    expect(seen.infer).toEqual([]);
  });

  it("IN2.2 --file and --clipboard choose where /sessions export writes", async () => {
    const filed = interpreter({ sessions: [alpha] });
    expect(await run(filed.engine, "/sessions export --file out.json alpha")).toEqual({
      type: "exported",
      sessions: [{ name: "alpha", harness: "claude-code" }],
      destination: { type: "file", filename: "out.json" },
    });
    expect(filed.calls.files).toEqual([["out.json", document(alpha)]]);
    expect(filed.calls.clips).toEqual([]);
    const clipped = interpreter({ sessions: [alpha, gamma] });
    expect(await run(clipped.engine, "/sessions export gamma --clipboard")).toEqual({
      type: "exported",
      sessions: [{ name: "gamma", harness: "codex" }],
      destination: { type: "clipboard" },
    });
    expect(clipped.calls.clips).toEqual([document(gamma)]);
    expect(clipped.calls.files).toEqual([]);
  });

  it("IN2.3 /sessions export with no name writes every managed session in this session", async () => {
    const { engine, calls } = interpreter({ sessions: [alpha, beta, gamma] });
    const all = `${JSON.stringify([alpha, beta, gamma].map((session) => ({ name: session.name, harness: session.harness, state: session.state })), null, 2)}\n`;
    expect(await run(engine, "/sessions export")).toEqual({
      type: "exported",
      sessions: [
        { name: "alpha", harness: "claude-code" },
        { name: "beta", harness: "claude-code" },
        { name: "gamma", harness: "codex" },
      ],
      destination: { type: "file", filename: "harness-sessions.json" },
    });
    expect(calls.files).toEqual([["harness-sessions.json", all]]);
    const empty = interpreter({ sessions: [] });
    expect(await run(empty.engine, "/sessions export --clipboard")).toEqual({
      type: "exported",
      sessions: [],
      destination: { type: "clipboard" },
    });
    expect(empty.calls.clips).toEqual(["[]\n"]);
    expect(empty.calls.files).toEqual([]);
  });

  it("IN2.4 a bad /sessions export writes nothing", async () => {
    const { engine, calls } = interpreter({ sessions: [alpha, beta] });
    for (const line of ["/sessions export missing", "/sessions export alpha beta", "/sessions export alpha --clipboard --file out.json", "/sessions export --file", "/sessions export --file --clipboard", "/sessions export --file .", "/sessions export --file ..", "/sessions export --to clipboard", "/sessions export alpha --file ../secret.json"]) {
      expect(await run(engine, line)).toMatchObject({ type: "command-usage", name: "export" });
    }
    expect(calls.files).toEqual([]);
    expect(calls.clips).toEqual([]);
    const unwired = interpreter();
    expect(await run(unwired.engine, "/sessions export")).toMatchObject({ type: "command-usage", name: "export" });
  });

  it("IN2.5 /sessions resume continues one managed harness session", async () => {
    const only = interpreter({ sessions: [gamma] });
    expect(await run(only.engine, "/sessions resume codex")).toEqual({ type: "resumed", harness: "codex", session: "gamma" });
    expect(only.calls.resumes[0]).toBe(gamma);
    const picked = interpreter({ sessions: [alpha, beta, gamma] });
    expect(await run(picked.engine, "/sessions resume claude-code beta")).toEqual({ type: "resumed", harness: "claude-code", session: "beta" });
    expect(picked.calls.resumes[0]).toBe(beta);
    expect(picked.calls.files).toEqual([]);
    expect(picked.seen.decide).toEqual([]);
  });

  it("IN2.6 /sessions resume reports usage unless it names one session", async () => {
    const { engine, calls, seen } = interpreter({ sessions: [alpha, beta, gamma] });
    for (const line of ["/sessions resume", "/sessions resume claude-code", "/sessions resume codex nope", "/sessions resume missing", "/sessions resume claude-code beta extra"]) {
      expect(await run(engine, line)).toMatchObject({ type: "command-usage", name: "resume" });
    }
    expect(calls.resumes).toEqual([]);
    expect(seen.decide).toEqual([]);
    const unwired = interpreter();
    expect(await run(unwired.engine, "/sessions resume codex")).toMatchObject({ type: "command-usage", name: "resume" });
  });

  it("IN2.7 sessions is built in, and session records are checked", () => {
    expect(() => interpreter({ commands: [{ name: "sessions", description: "no" }] })).toThrow(/sessions/);
    expect(interpreter({ commands: [{ name: "export", description: "copy" }, { name: "resume", description: "continue" }] }).engine).toBeInstanceOf(InputInterpreter);
    expect(() => interpreter({ sessions: [alpha, { ...alpha }] })).toThrow(/duplicated/);
    expect(() => interpreter({ sessions: [{ name: "bad name", harness: "claude-code", state: {} }] })).toThrow(/session/);
    expect(() => interpreter({ sessions: [{ name: "alpha", harness: "", state: {} }] })).toThrow(/harness/);
    expect(() => interpreter({ sessions: [{ name: "alpha", harness: "claude code", state: {} }] })).toThrow(/harness/);
  });

  it("IN2.8 /sessions lists managed harness sessions and leaves export and resume off the top level", async () => {
    const { engine, seen, calls } = interpreter({ sessions: [alpha, beta, gamma] });
    expect(await run(engine, " /sessions ")).toEqual({
      type: "list-sessions",
      sessions: [
        { name: "alpha", harness: "claude-code" },
        { name: "beta", harness: "claude-code" },
        { name: "gamma", harness: "codex" },
      ],
    });
    expect(calls.files).toEqual([]);
    expect(calls.clips).toEqual([]);
    expect(calls.resumes).toEqual([]);
    expect(seen.decide).toEqual([]);
    const empty = interpreter({ sessions: [] });
    expect(await run(empty.engine, "/sessions")).toEqual({ type: "list-sessions", sessions: [] });
    const unwired = interpreter();
    expect(await run(unwired.engine, "/sessions")).toMatchObject({ type: "command-usage", name: "sessions" });
    expect(await run(engine, "/sessions nope")).toMatchObject({ type: "command-usage", name: "sessions" });
    expect(await run(engine, "/export alpha")).toEqual({ type: "unknown-command", name: "export" });
    expect(await run(engine, "/resume codex")).toEqual({ type: "unknown-command", name: "resume" });
    expect(calls.files).toEqual([]);
    expect(calls.resumes).toEqual([]);
    expect(seen.decide).toEqual([]);
    const registered = interpreter({ commands: [{ name: "export", description: "copy" }], sessions: [alpha] });
    expect(await run(registered.engine, "/export alpha")).toEqual({ type: "harness-command", name: "export", argument: "alpha" });
    expect(registered.calls.files).toEqual([]);
    expect(registered.seen.decide).toEqual([]);
  });

  const workerSetting = { key: "worker", description: "Which worker runs a turn.", fallback: "echo", values: ["echo", "model"] as const };
  const decideSetting = { key: "decide", description: "Which decision model picks.", fallback: "auto" };

  it("IN3.1 /settings lists every setting and shows one key's three layers", async () => {
    const { engine, seen } = interpreter({ settings: [workerSetting, decideSetting] });
    expect(await run(engine, " /settings ")).toEqual({
      type: "settings",
      view: "list",
      entries: [
        { key: "worker", description: workerSetting.description, effective: "echo" },
        { key: "decide", description: decideSetting.description, effective: "auto" },
      ],
    });
    expect(await run(engine, "/settings worker")).toEqual({
      type: "settings",
      view: "show",
      entry: { key: "worker", description: workerSetting.description, effective: "echo" },
    });
    expect(seen.decide).toEqual([]);
    expect(seen.infer).toEqual([]);
  });

  it("IN3.2 /settings records a request and accepts it only when the catalog allows it", async () => {
    const { engine } = interpreter({ settings: [workerSetting, decideSetting] });
    expect(await run(engine, "/settings worker model")).toEqual({
      type: "settings",
      view: "set",
      applied: true,
      entry: { key: "worker", description: workerSetting.description, requested: "model", accepted: "model", effective: "model" },
    });
    expect(await run(engine, "/settings worker nope")).toEqual({
      type: "settings",
      view: "set",
      applied: false,
      entry: { key: "worker", description: workerSetting.description, requested: "nope", accepted: "model", effective: "model" },
    });
    const fresh = interpreter({ settings: [workerSetting] });
    expect(await run(fresh.engine, "/settings worker nope")).toEqual({
      type: "settings",
      view: "set",
      applied: false,
      entry: { key: "worker", description: workerSetting.description, requested: "nope", effective: "echo" },
    });
    expect(await run(engine, "/settings decide local judge")).toEqual({
      type: "settings",
      view: "set",
      applied: true,
      entry: { key: "decide", description: decideSetting.description, requested: "local judge", accepted: "local judge", effective: "local judge" },
    });
  });

  it("IN3.3 /settings --unset returns a setting to its fallback", async () => {
    const { engine } = interpreter({ settings: [workerSetting] });
    await run(engine, "/settings worker model");
    expect(await run(engine, "/settings worker --unset")).toEqual({
      type: "settings",
      view: "unset",
      entry: { key: "worker", description: workerSetting.description, effective: "echo" },
    });
    await run(engine, "/settings worker model");
    expect(await run(engine, "/settings --unset worker")).toEqual({
      type: "settings",
      view: "unset",
      entry: { key: "worker", description: workerSetting.description, effective: "echo" },
    });
  });

  it("IN3.4 a bad /settings line changes nothing and is not classified", async () => {
    const { engine, seen } = interpreter({ settings: [workerSetting] });
    await run(engine, "/settings worker model");
    for (const line of ["/settings missing", "/settings --unset", "/settings --unset worker extra", "/settings worker --file x"]) {
      expect(await run(engine, line)).toMatchObject({ type: "command-usage", name: "settings" });
    }
    expect(await run(engine, "/settings worker")).toEqual({
      type: "settings",
      view: "show",
      entry: { key: "worker", description: workerSetting.description, requested: "model", accepted: "model", effective: "model" },
    });
    expect(seen.decide).toEqual([]);
    const unwired = interpreter();
    expect(await run(unwired.engine, "/settings")).toMatchObject({ type: "command-usage", name: "settings" });
    const empty = interpreter({ settings: [] });
    expect(await run(empty.engine, "/settings")).toEqual({ type: "settings", view: "list", entries: [] });
  });

  it("IN3.5 settings is built in, and the catalog is checked", () => {
    expect(() => interpreter({ commands: [{ name: "settings", description: "no" }] })).toThrow(/settings/);
    expect(() => interpreter({ settings: [workerSetting, { ...workerSetting }] })).toThrow(/duplicated/);
    expect(() => interpreter({ settings: [{ key: "bad key", description: "x", fallback: "a" }] })).toThrow(/setting/);
    expect(() => interpreter({ settings: [{ key: "worker", description: "x", fallback: "nope", values: ["echo"] }] })).toThrow(/setting/);
    expect(() => interpreter({ settings: [{ key: "worker", description: "x", fallback: "echo", values: [] }] })).toThrow(/setting/);
    expect(() => interpreter({ settings: [{ key: "worker", description: "x", fallback: "echo", values: ["echo", "echo"] }] })).toThrow(/duplicated/);
  });

  it("IN4.1 /tools --help describes the command and every registration", async () => {
    const { engine, seen } = interpreter();
    const listed = [
      "usage: /tools [name | kind:name] [argument]",
      "Lists registered skills, MCPs, and native tools, or invokes one.",
      "tool echo: Repeat text.",
      "skill search: Search as a skill.",
      "mcp search: Search as an MCP.",
    ].join("\n");
    expect(await run(engine, " /tools --help ")).toEqual({ type: "help", name: "tools", message: listed });
    expect(await run(engine, "/tools --help --help")).toEqual({ type: "help", name: "tools", message: listed });
    const empty = interpreter({ tools: [] });
    expect(await run(empty.engine, "/tools --help")).toEqual({
      type: "help",
      name: "tools",
      message: "usage: /tools [name | kind:name] [argument]\nLists registered skills, MCPs, and native tools, or invokes one.",
    });
    expect(seen.decide).toEqual([]);
    expect(seen.infer).toEqual([]);
  });

  it("IN4.2 --help on a tool, skill, or MCP describes that registration and does not invoke it", async () => {
    const { engine, seen } = interpreter();
    const echoHelp = { type: "help", name: "tools echo", message: "usage: /tools echo [argument]\ntool echo: Repeat text." };
    expect(await run(engine, "/tools echo --help")).toEqual(echoHelp);
    expect(await run(engine, "/tools --help echo")).toEqual(echoHelp);
    expect(await run(engine, "/tools echo say hi --help")).toEqual(echoHelp);
    expect(await run(engine, "/tools skill:search --help")).toEqual({
      type: "help",
      name: "tools skill:search",
      message: "usage: /tools skill:search [argument]\nskill search: Search as a skill.",
    });
    expect(await run(engine, "/tools mcp:search --help")).toEqual({
      type: "help",
      name: "tools mcp:search",
      message: "usage: /tools mcp:search [argument]\nmcp search: Search as an MCP.",
    });
    expect(await run(engine, "/tools search --help")).toEqual({
      type: "help",
      name: "tools search",
      message: "usage: /tools search [argument]\nskill search: Search as a skill.\nmcp search: Search as an MCP.",
    });
    expect(await run(engine, "/tools missing --help")).toEqual({ type: "unknown-tool", name: "missing" });
    expect(await run(engine, "/tools mcp:missing --help")).toEqual({ type: "unknown-tool", name: "mcp:missing" });
    expect(seen.decide).toEqual([]);
  });

  it("IN4.3 --help on /sessions and its subcommands does not export or resume", async () => {
    const { engine, seen, calls } = interpreter({ sessions: [alpha, beta, gamma] });
    const sessionsHelp = {
      type: "help",
      name: "sessions",
      message: "usage: /sessions [export | resume]\nLists managed harness sessions in this session.",
    };
    const exportHelp = {
      type: "help",
      name: "sessions export",
      message: "usage: /sessions export [session] [--clipboard | --file <filename>]\nWrites the named session, or every managed session, as JSON. The default destination is a file.",
    };
    const resumeHelp = {
      type: "help",
      name: "sessions resume",
      message: "usage: /sessions resume <harness> [session]\nResumes one managed harness session.",
    };
    expect(await run(engine, "/sessions --help")).toEqual(sessionsHelp);
    expect(await run(engine, "/sessions export --help")).toEqual(exportHelp);
    expect(await run(engine, "/sessions --help export")).toEqual(exportHelp);
    expect(await run(engine, "/sessions export alpha --file out.json --help")).toEqual(exportHelp);
    expect(await run(engine, "/sessions resume --help")).toEqual(resumeHelp);
    expect(await run(engine, "/sessions resume codex --help")).toEqual(resumeHelp);
    expect(await run(engine, "/sessions nope --help")).toEqual({
      type: "command-usage",
      name: "sessions",
      message: "usage: /sessions [export | resume]",
    });
    expect(calls.files).toEqual([]);
    expect(calls.clips).toEqual([]);
    expect(calls.resumes).toEqual([]);
    expect(seen.decide).toEqual([]);
    const unwired = interpreter();
    expect(await run(unwired.engine, "/sessions --help")).toEqual(sessionsHelp);
    expect(await run(unwired.engine, "/sessions export --help")).toEqual(exportHelp);
    expect(await run(unwired.engine, "/sessions resume --help")).toEqual(resumeHelp);
  });

  it("IN4.4 --help on /settings describes the catalog and a key without changing it", async () => {
    const { engine, seen } = interpreter({ settings: [workerSetting, decideSetting] });
    await run(engine, "/settings worker model");
    const settingsHelp = {
      type: "help",
      name: "settings",
      message: [
        "usage: /settings [key] [value | --unset]",
        "Reads and writes harness configuration.",
        "worker: Which worker runs a turn.",
        "decide: Which decision model picks.",
      ].join("\n"),
    };
    const workerHelp = {
      type: "help",
      name: "settings worker",
      message: "usage: /settings worker [value | --unset]\nWhich worker runs a turn.\nfallback: echo\nvalues: echo, model",
    };
    expect(await run(engine, "/settings --help")).toEqual(settingsHelp);
    expect(await run(engine, "/settings worker --help")).toEqual(workerHelp);
    expect(await run(engine, "/settings --help worker")).toEqual(workerHelp);
    expect(await run(engine, "/settings worker model --help")).toEqual(workerHelp);
    expect(await run(engine, "/settings --unset worker --help")).toEqual(workerHelp);
    expect(await run(engine, "/settings --unset --help")).toEqual(settingsHelp);
    expect(await run(engine, "/settings decide --help")).toEqual({
      type: "help",
      name: "settings decide",
      message: "usage: /settings decide [value | --unset]\nWhich decision model picks.\nfallback: auto",
    });
    expect(await run(engine, "/settings missing --help")).toEqual({ type: "command-usage", name: "settings", message: "no setting missing" });
    expect(await run(engine, "/settings worker")).toEqual({
      type: "settings",
      view: "show",
      entry: { key: "worker", description: workerSetting.description, requested: "model", accepted: "model", effective: "model" },
    });
    expect(seen.decide).toEqual([]);
    const unwired = interpreter();
    expect(await run(unwired.engine, "/settings --help")).toEqual({
      type: "help",
      name: "settings",
      message: "usage: /settings [key] [value | --unset]\nReads and writes harness configuration.",
    });
    expect(await run(unwired.engine, "/settings worker --help")).toEqual({
      type: "command-usage",
      name: "settings",
      message: "no settings are configured",
    });
    const empty = interpreter({ settings: [] });
    expect(await run(empty.engine, "/settings --help")).toEqual({
      type: "help",
      name: "settings",
      message: "usage: /settings [key] [value | --unset]\nReads and writes harness configuration.",
    });
  });

  it("IN4.5 --help on a harness command describes it, and an unknown command stays unknown", async () => {
    const { engine, seen } = interpreter();
    const askHelp = { type: "help", name: "ask", message: "usage: /ask [argument]\nRun a turn." };
    expect(await run(engine, "/ask --help")).toEqual(askHelp);
    expect(await run(engine, "/ask --help the rest")).toEqual(askHelp);
    expect(await run(engine, "/nope --help")).toEqual({ type: "unknown-command", name: "nope" });
    expect(seen.decide).toEqual([]);
    expect(seen.infer).toEqual([]);
  });

  it("IN5.1 a partial command completes known harness commands and a decision model reranks them", async () => {
    const ranked = interpreter({
      decide: () => ({
        choice: "/tools",
        complicated: false,
        probabilities: { "/tools": 0.1, "/sessions": 0.2, "/settings": 0.3, "/autopilot": 0.15, "/ask": 0.4 },
      }),
    });
    expect(await complete(ranked.engine, " /to")).toEqual({
      completions: [{ text: "/tools", description: "Lists registered skills, MCPs, and native tools, or invokes one.", source: "command", score: 1 }],
    });
    expect(ranked.seen.decide).toEqual([]);
    expect(await complete(ranked.engine, "/")).toEqual({
      completions: [
        { text: "/ask", description: "Run a turn.", source: "command", score: 0.4 },
        { text: "/settings", description: "Reads and writes harness configuration.", source: "command", score: 0.3 },
        { text: "/sessions", description: "Lists managed harness sessions in this session.", source: "command", score: 0.2 },
        { text: "/autopilot", description: "Proposes its own goals on a branch until interrupted.", source: "command", score: 0.15 },
        { text: "/tools", description: "Lists registered skills, MCPs, and native tools, or invokes one.", source: "command", score: 0.1 },
      ],
    });
    expect(ranked.seen.decide).toHaveLength(1);
    expect(ranked.seen.decide[0]?.split("\n---\n")[0]).toBe("remember /tools from before\nthe earlier fact");
    expect(ranked.seen.decide[0]).toContain("---\n/\n[/tools,/sessions,/settings,/autopilot,/ask]");
    expect(ranked.seen.infer).toEqual([]);
    expect(ranked.engine.events()).toEqual([]);
    const tied = interpreter({
      decide: () => ({ choice: "/ask", complicated: false, probabilities: { "/tools": 0.25, "/sessions": 0.25, "/settings": 0.25, "/autopilot": 0.25, "/ask": 0.25 } }),
    });
    expect((await complete(tied.engine, "/")).completions.map((item) => item.text)).toEqual(["/tools", "/sessions", "/settings", "/autopilot", "/ask"]);
    const huge = `${"y".repeat(5000)}END`;
    const bounded = interpreter({ decide: () => ({ choice: "/tools", complicated: false }) });
    await complete(bounded.engine, "/", { turns: [{ role: "user", text: "OLD" }, { role: "assistant", text: huge }] });
    expect(bounded.seen.decide[0]?.split("\n---\n")[0]).toBe(`${"y".repeat(1997)}END`);
    expect(await run(ranked.engine, "/tools")).toEqual({ type: "list-tools", tools: [echo, searchSkill, searchMcp] });
  });

  it("IN5.2 /tools completes native tools, skills, and MCPs", async () => {
    const { engine, seen } = interpreter({
      decide: (_text, _context, options) => ({ choice: options[options.length - 1]?.name ?? "", complicated: false }),
    });
    expect(await complete(engine, "/tools ")).toEqual({
      completions: [
        { text: "/tools --help", description: "Describes /tools.", source: "command", score: 1 },
        { text: "/tools echo", description: "tool echo: Repeat text.", source: "command", score: 0 },
        { text: "/tools search", description: "skill search: Search as a skill.\nmcp search: Search as an MCP.", source: "command", score: 0 },
        { text: "/tools tool:echo", description: "tool echo: Repeat text.", source: "command", score: 0 },
        { text: "/tools skill:search", description: "skill search: Search as a skill.", source: "command", score: 0 },
        { text: "/tools mcp:search", description: "mcp search: Search as an MCP.", source: "command", score: 0 },
      ],
    });
    expect(await complete(engine, "/tools")).toEqual({
      completions: [
        { text: "/tools --help", description: "Describes /tools.", source: "command", score: 1 },
        { text: "/tools", description: "Lists registered skills, MCPs, and native tools, or invokes one.", source: "command", score: 0 },
        { text: "/tools echo", description: "tool echo: Repeat text.", source: "command", score: 0 },
        { text: "/tools search", description: "skill search: Search as a skill.\nmcp search: Search as an MCP.", source: "command", score: 0 },
        { text: "/tools tool:echo", description: "tool echo: Repeat text.", source: "command", score: 0 },
        { text: "/tools skill:search", description: "skill search: Search as a skill.", source: "command", score: 0 },
        { text: "/tools mcp:search", description: "mcp search: Search as an MCP.", source: "command", score: 0 },
      ],
    });
    expect(await complete(engine, "/tools ec")).toEqual({
      completions: [{ text: "/tools echo", description: "tool echo: Repeat text.", source: "command", score: 1 }],
    });
    expect(await complete(engine, "/tools skill:s")).toEqual({
      completions: [{ text: "/tools skill:search", description: "skill search: Search as a skill.", source: "command", score: 1 }],
    });
    expect(await complete(engine, "/tools echo")).toEqual({
      completions: [
        { text: "/tools echo --help", description: "Describes /tools echo.", source: "command", score: 1 },
        { text: "/tools echo", description: "tool echo: Repeat text.", source: "command", score: 0 },
      ],
    });
    expect(await complete(engine, "/tools echo say")).toEqual({ completions: [] });
    expect(seen.decide).toHaveLength(3);
    expect(seen.infer).toEqual([]);
  });

  it("IN5.3 /sessions completes export and resume without writing or resuming", async () => {
    const { engine, calls, seen } = interpreter({
      sessions: [alpha, beta, gamma],
      decide: (_text, _context, options) => ({ choice: options[0]?.name ?? "", complicated: false }),
    });
    expect((await complete(engine, "/sessions ")).completions.map((item) => item.text)).toEqual(["/sessions export", "/sessions resume", "/sessions --help"]);
    expect((await complete(engine, "/sessions exp")).completions).toEqual([
      { text: "/sessions export", description: "Writes the named session, or every managed session, as JSON. The default destination is a file.", source: "command", score: 1 },
    ]);
    expect((await complete(engine, "/sessions export ")).completions.map((item) => item.text)).toEqual([
      "/sessions export alpha",
      "/sessions export beta",
      "/sessions export gamma",
      "/sessions export --clipboard",
      "/sessions export --file",
      "/sessions export --help",
    ]);
    expect((await complete(engine, "/sessions export --file report")).completions).toEqual([]);
    expect((await complete(engine, "/sessions export alpha --c")).completions).toEqual([
      { text: "/sessions export alpha --clipboard", description: "Copies the export to the clipboard.", source: "command", score: 1 },
    ]);
    expect((await complete(engine, "/sessions resume ")).completions.map((item) => ({ text: item.text, description: item.description }))).toEqual([
      { text: "/sessions resume claude-code", description: "Resumes harness claude-code." },
      { text: "/sessions resume codex", description: "Resumes harness codex." },
      { text: "/sessions resume --help", description: "Describes /sessions resume." },
    ]);
    expect((await complete(engine, "/sessions resume claude-code ")).completions.map((item) => item.text)).toEqual([
      "/sessions resume claude-code alpha",
      "/sessions resume claude-code beta",
      "/sessions resume claude-code --help",
    ]);
    expect((await complete(engine, "/sessions resume claude-code a")).completions).toEqual([
      { text: "/sessions resume claude-code alpha", description: "Resumes session alpha on claude-code.", source: "command", score: 1 },
    ]);
    const unwired = interpreter();
    expect((await complete(unwired.engine, "/sessions export ")).completions.map((item) => item.text)).toEqual([
      "/sessions export --clipboard",
      "/sessions export --file",
      "/sessions export --help",
    ]);
    expect(calls.files).toEqual([]);
    expect(calls.clips).toEqual([]);
    expect(calls.resumes).toEqual([]);
    expect(seen.infer).toEqual([]);
  });

  it("IN5.4 /settings completes keys and closed values without changing one", async () => {
    const { engine } = interpreter({
      settings: [workerSetting, decideSetting, { key: "tone", description: "Color.", fallback: "warm grey", values: ["warm grey", "blue"] }],
      decide: (_text, _context, options) => ({ choice: options[0]?.name ?? "", complicated: false }),
    });
    await run(engine, "/settings worker model");
    expect((await complete(engine, "/settings ")).completions.map((item) => ({ text: item.text, description: item.description }))).toEqual([
      { text: "/settings worker", description: "Which worker runs a turn." },
      { text: "/settings decide", description: "Which decision model picks." },
      { text: "/settings tone", description: "Color." },
      { text: "/settings --unset", description: "Restores the setting to its fallback." },
      { text: "/settings --help", description: "Describes /settings." },
    ]);
    expect((await complete(engine, "/settings w")).completions).toEqual([
      { text: "/settings worker", description: "Which worker runs a turn.", source: "command", score: 1 },
    ]);
    expect((await complete(engine, "/settings worker ")).completions.map((item) => item.text)).toEqual([
      "/settings worker echo",
      "/settings worker model",
      "/settings worker --unset",
      "/settings worker --help",
    ]);
    expect((await complete(engine, "/settings decide ")).completions.map((item) => item.text)).toEqual(["/settings decide --unset", "/settings decide --help"]);
    expect((await complete(engine, "/settings tone warm")).completions).toEqual([
      { text: "/settings tone warm grey", description: "Sets tone to warm grey.", source: "command", score: 1 },
    ]);
    expect((await complete(engine, "/settings --unset w")).completions).toEqual([
      { text: "/settings --unset worker", description: "Which worker runs a turn.", source: "command", score: 1 },
    ]);
    expect(await run(engine, "/settings worker")).toEqual({
      type: "settings",
      view: "show",
      entry: { key: "worker", description: workerSetting.description, requested: "model", accepted: "model", effective: "model" },
    });
    expect((await complete(interpreter().engine, "/settings ")).completions).toEqual([
      { text: "/settings --help", description: "Describes /settings.", source: "command", score: 1 },
    ]);
    expect((await complete(interpreter({ settings: [] }).engine, "/settings ")).completions).toEqual([
      { text: "/settings --help", description: "Describes /settings.", source: "command", score: 1 },
    ]);
    expect((await complete(engine, "/ask ")).completions).toEqual([
      { text: "/ask --help", description: "Describes /ask.", source: "command", score: 1 },
    ]);
    expect(await complete(engine, "/nope")).toEqual({ completions: [] });
  });

  it("IN5.5 an empty prefix predicts the next instruction and reranks natural language after commands", async () => {
    const suggestions = [
      { text: "please export", description: "Guess an export." },
      { text: "/tools", description: "Do not replace the command." },
      { text: "hello there", description: "A greeting." },
      { text: "Hello there", description: "Different case." },
    ];
    const { engine, seen } = interpreter({
      suggest: () => ({ ok: true, suggestions }),
      decide: () => ({
        choice: "/tools",
        complicated: false,
        probabilities: { "/tools": 0.05, "/sessions": 0.05, "/settings": 0.05, "/autopilot": 0.05, "/ask": 0.05, "please export": 0.7, "hello there": 0.1 },
      }),
    });
    expect(await complete(engine, "")).toEqual({
      completions: [
        { text: "please export", description: "Guess an export.", source: "language", score: 0.7 },
        { text: "hello there", description: "A greeting.", source: "language", score: 0.1 },
        { text: "/tools", description: "Lists registered skills, MCPs, and native tools, or invokes one.", source: "command", score: 0.05 },
        { text: "/sessions", description: "Lists managed harness sessions in this session.", source: "command", score: 0.05 },
        { text: "/settings", description: "Reads and writes harness configuration.", source: "command", score: 0.05 },
        { text: "/autopilot", description: "Proposes its own goals on a branch until interrupted.", source: "command", score: 0.05 },
        { text: "/ask", description: "Run a turn.", source: "command", score: 0.05 },
        { text: "Hello there", description: "Different case.", source: "language", score: 0 },
      ],
    });
    expect(seen.decide[0]).toContain("[/tools,/sessions,/settings,/autopilot,/ask,please export,hello there,Hello there]");
    expect(seen.suggest).toHaveLength(1);
    expect(seen.infer).toEqual([]);
    expect((await complete(engine, "   ")).completions.map((item) => item.text)).toEqual([
      "please export",
      "hello there",
      "/tools",
      "/sessions",
      "/settings",
      "/autopilot",
      "/ask",
      "Hello there",
    ]);
    expect(await complete(engine, "hel")).toEqual({
      completions: [{ text: "hello there", description: "A greeting.", source: "language", score: 1 }],
    });
    expect(seen.suggest).toHaveLength(3);
    const slash = interpreter({ suggest: () => ({ ok: true, suggestions }) });
    await complete(slash.engine, "/tools");
    expect(slash.seen.suggest).toEqual([]);
    const failed = interpreter({
      suggest: () => { throw new Error("down"); },
      decide: (_text, _context, options) => ({ choice: options[0]?.name ?? "", complicated: false }),
    });
    expect((await complete(failed.engine, "")).completions.map((item) => item.text)).toEqual(["/tools", "/sessions", "/settings", "/autopilot", "/ask"]);
    const refused = interpreter({ suggest: () => ({ ok: false }) });
    expect((await complete(refused.engine, "hel")).completions).toEqual([]);
    expect(refused.seen.decide).toEqual([]);
  });

  it("IN5.6 a model failure keeps command order, and the option window prefers commands", async () => {
    const commands = Array.from({ length: 18 }, (_, index) => ({ name: `c${String(index)}`, description: `command ${String(index)}` }));
    const full = interpreter({
      commands,
      suggest: () => ({ ok: true, suggestions: [{ text: "guess", description: "A guess." }] }),
      decide: () => ({ choice: "/c17", complicated: false, probabilities: { "/c17": 1 } }),
    });
    const predicted = await complete(full.engine, "");
    expect(predicted.completions).toHaveLength(20);
    expect(predicted.completions.map((item) => item.text)).toEqual([
      "/tools",
      "/sessions",
      "/settings",
      "/autopilot",
      ...Array.from({ length: 16 }, (_, index) => `/c${String(index)}`),
    ]);
    expect(predicted.completions.every((item) => item.score === 0)).toBe(true);
    expect(full.seen.suggest).toEqual([]);
    expect(full.seen.decide[0]).toContain("[/tools,/sessions,/settings,/autopilot,/c0,/c1,/c2,/c3,/c4,/c5,/c6,/c7,/c8,/c9,/c10,/c11,/c12,/c13,/c14,/c15]");
    const narrow = interpreter({
      maxOptions: 2,
      suggest: () => ({ ok: true, suggestions: [{ text: "guess", description: "A guess." }] }),
      decide: () => { throw new Error("down"); },
    });
    expect(await complete(narrow.engine, "/")).toEqual({
      completions: [
        { text: "/tools", description: "Lists registered skills, MCPs, and native tools, or invokes one.", source: "command", score: 0 },
        { text: "/sessions", description: "Lists managed harness sessions in this session.", source: "command", score: 0 },
      ],
    });
    const complicated = interpreter({ decide: () => ({ choice: "/ask", complicated: true, probabilities: { "/ask": 1 } }) });
    expect((await complete(complicated.engine, "/")).completions.map((item) => ({ text: item.text, score: item.score }))).toEqual([
      { text: "/tools", score: 0 },
      { text: "/sessions", score: 0 },
      { text: "/settings", score: 0 },
      { text: "/autopilot", score: 0 },
      { text: "/ask", score: 0 },
    ]);
    const unknown = interpreter({ decide: () => ({ choice: "nope", complicated: false }) });
    expect((await complete(unknown.engine, "/")).completions.map((item) => ({ text: item.text, score: item.score }))).toEqual([
      { text: "/tools", score: 0 },
      { text: "/sessions", score: 0 },
      { text: "/settings", score: 0 },
      { text: "/autopilot", score: 0 },
      { text: "/ask", score: 0 },
    ]);
    const infinite = interpreter({
      decide: () => ({ choice: "/ask", complicated: false, probabilities: { "/tools": Number.POSITIVE_INFINITY, "/sessions": 0, "/settings": 0, "/autopilot": 0, "/ask": 0 } }),
    });
    expect((await complete(infinite.engine, "/")).completions.map((item) => item.text)).toEqual(["/tools", "/sessions", "/settings", "/autopilot", "/ask"]);
    expect((await complete(infinite.engine, "/")).completions.every((item) => item.score === 0)).toBe(true);
  });
});
