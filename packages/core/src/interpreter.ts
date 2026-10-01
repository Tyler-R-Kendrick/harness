import { Autopilot } from "./autopilot.ts";
import type { AutopilotPorts, AutopilotUpdate } from "./autopilot.ts";
import { HookBus } from "./hooks.ts";
import type { HookEvent } from "./hooks.ts";

const CONTEXT_LIMIT = 2000;
const BUS_DEPTH = 8;
const DRAIN_ROUNDS = 8;
const ACTORS = ["actor.parser", "actor.decider", "actor.inferencer", "actor.eliciter"] as const;

const SLASH = /^\s*\/([A-Za-z][\w-]*)?(?:\s+([\s\S]*))?\s*$/;

type ActorId = (typeof ACTORS)[number];

/** mcp, skill, and native tool registrations. All three are invoked through `/tools`. */
export type ToolKind = "mcp" | "skill" | "tool";

export interface RegisteredTool {
  readonly kind: ToolKind;
  readonly name: string;
  readonly description: string;
}

export interface HarnessCommand {
  readonly name: string;
  readonly description: string;
}

/** One piece of harness configuration. `values` closes the set that can be accepted. */
export interface SettingSpec {
  readonly key: string;
  readonly description: string;
  readonly fallback: string;
  readonly values?: readonly string[];
}

/** Requested, accepted, and effective layers of one setting. Absent layers were never set. */
export interface SettingEntry {
  readonly key: string;
  readonly description: string;
  readonly effective: string;
  readonly requested?: string;
  readonly accepted?: string;
}

/** A named session of a managed harness instance inside the current session. */
export interface ManagedHarnessSession {
  readonly name: string;
  readonly harness: string;
  readonly state: unknown;
}

/** Where `/sessions` lists instances and its export and resume subcommands perform their effect. */
export interface ManagedHarnesses {
  readonly sessions: readonly ManagedHarnessSession[];
  readonly writeFile: (filename: string, contents: string) => void | Promise<void>;
  readonly copy: (text: string) => void | Promise<void>;
  readonly resume: (session: ManagedHarnessSession) => void | Promise<void>;
}

export type InputAction =
  | { readonly type: "list-tools"; readonly tools: readonly RegisteredTool[] }
  | { readonly type: "invoke-tool"; readonly tool: RegisteredTool; readonly argument: string }
  | { readonly type: "harness-command"; readonly name: string; readonly argument: string }
  | { readonly type: "list-sessions"; readonly sessions: readonly { readonly name: string; readonly harness: string }[] }
  | { readonly type: "new-session" }
  | { readonly type: "session-btw"; readonly question: string }
  | { readonly type: "session-bg" }
  | { readonly type: "session-switch"; readonly session: string }
  | { readonly type: "session-fork"; readonly thread?: string; readonly message?: string }
  | { readonly type: "exported"; readonly sessions: readonly { readonly name: string; readonly harness: string }[]; readonly destination: { readonly type: "file"; readonly filename: string } | { readonly type: "clipboard" } }
  | { readonly type: "resumed"; readonly harness: string; readonly session: string }
  | { readonly type: "command-usage"; readonly name: string; readonly message: string }
  | { readonly type: "help"; readonly name: string; readonly message: string }
  | { readonly type: "autopilot"; readonly view: "started"; readonly running: true; readonly steering?: string }
  | { readonly type: "autopilot"; readonly view: "stopped"; readonly running: false }
  | { readonly type: "autopilot"; readonly view: "updates"; readonly updates: readonly AutopilotUpdate[] }
  | { readonly type: "autopilot"; readonly view: "applied"; readonly update: AutopilotUpdate }
  | { readonly type: "settings"; readonly view: "list"; readonly entries: readonly SettingEntry[] }
  | { readonly type: "settings"; readonly view: "show" | "unset"; readonly entry: SettingEntry }
  | { readonly type: "settings"; readonly view: "set"; readonly applied: boolean; readonly entry: SettingEntry }
  | { readonly type: "message"; readonly text: string }
  | { readonly type: "unknown-command"; readonly name: string }
  | { readonly type: "unknown-tool"; readonly name: string }
  | { readonly type: "elicit"; readonly question: string };

export interface DecisionAnswer {
  readonly choice: string;
  readonly complicated: boolean;
  readonly probabilities?: Readonly<Record<string, number>>;
}

export type InferenceAnswer = { readonly ok: true; readonly action: InputAction } | { readonly ok: false };

/** One ranked guess for the instruction a person is typing or about to type. */
export interface Completion {
  readonly text: string;
  readonly description: string;
  readonly source: "command" | "language";
  readonly score: number;
}

export type SuggestionAnswer =
  | { readonly ok: true; readonly suggestions: readonly { readonly text: string; readonly description: string }[] }
  | { readonly ok: false };

export interface InputContext {
  readonly turns: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
}

export interface DecisionRequest {
  readonly text: string;
  readonly context: string;
  readonly options: readonly { readonly name: string; readonly description: string }[];
}

export interface InferenceRequest {
  readonly text: string;
  readonly context: string;
  readonly tools: readonly RegisteredTool[];
  readonly commands: readonly HarnessCommand[];
}

export interface InputInterpreterPorts {
  decide(request: DecisionRequest): DecisionAnswer | Promise<DecisionAnswer>;
  infer(request: InferenceRequest): InferenceAnswer | Promise<InferenceAnswer>;
  suggest?(request: { readonly text: string; readonly context: string }): SuggestionAnswer | Promise<SuggestionAnswer>;
}

interface TurnText {
  readonly text: string;
  readonly context: string;
}

/**
 * Decomposes a turn's new text into one action. Actors are plugins on a hook bus this
 * interpreter owns, so a turn does not share the daemon's causal depth. The daemon does
 * not route turns here yet.
 */
export class InputInterpreter {
  readonly #tools: readonly RegisteredTool[];
  readonly #commands: readonly HarnessCommand[];
  readonly #maxOptions: number;
  readonly #byKey = new Map<string, RegisteredTool>();
  readonly #ports: InputInterpreterPorts;
  readonly #harnesses: ManagedHarnesses | undefined;
  readonly #settings: readonly SettingSpec[] | undefined;
  readonly #autopilot: Autopilot;
  readonly #settingState = new Map<string, { requested: string; accepted?: string }>();
  readonly #bus = new HookBus({ maxDepth: BUS_DEPTH });
  #at = 0;

  constructor(
    registry: { readonly tools: readonly RegisteredTool[]; readonly commands: readonly HarnessCommand[]; readonly maxOptions?: number; readonly harnesses?: ManagedHarnesses; readonly settings?: readonly SettingSpec[]; readonly settingState?: Readonly<Record<string, { readonly requested: string; readonly accepted?: string }>>; readonly autopilot?: AutopilotPorts },
    ports: InputInterpreterPorts,
  ) {
    this.#maxOptions = checkedMax(registry.maxOptions);
    this.#tools = [...registry.tools];
    this.#commands = [...registry.commands];
    this.#ports = ports;
    this.#harnesses = checkedHarnesses(registry.harnesses);
    this.#settings = checkedSettings(registry.settings);
    this.#seed(registry.settingState);
    this.#autopilot = new Autopilot(registry.autopilot ?? { survey: () => [], implement: () => "" });
    for (const tool of this.#tools) {
      const key = `${tool.kind}:${tool.name}`;
      if (this.#byKey.has(key)) throw new TypeError(`duplicated tool ${key}`);
      this.#byKey.set(key, tool);
    }
    const seenCommands = new Set<string>();
    for (const command of this.#commands) {
      if (command.name === "tools" || command.name === "sessions" || command.name === "session" || command.name === "settings" || command.name === "autopilot" || command.name === "help") throw new TypeError(`harness command ${command.name} is built in`);
      if (seenCommands.has(command.name)) throw new TypeError(`duplicated command ${command.name}`);
      seenCommands.add(command.name);
    }
    this.#bus.subscribe("actor.parser", { types: ["input.received"] });
    this.#bus.subscribe("actor.decider", { types: ["intent.decide"] });
    this.#bus.subscribe("actor.inferencer", { types: ["intent.infer"] });
    this.#bus.subscribe("actor.eliciter", { types: ["intent.unresolved"] });
  }

  #seed(state: Readonly<Record<string, { readonly requested: string; readonly accepted?: string }>> | undefined): void {
    if (state === undefined || this.#settings === undefined) return;
    const known = new Set(this.#settings.map((spec) => spec.key));
    for (const [key, value] of Object.entries(state)) {
      if (!known.has(key)) continue;
      if (value.accepted === undefined) this.#settingState.set(key, { requested: value.requested });
      else this.#settingState.set(key, { requested: value.requested, accepted: value.accepted });
    }
  }

  helpPage(): string {
    return harnessManual(this.#commands);
  }

  async submit(text: string, context: InputContext, at: number): Promise<{ readonly action: InputAction }> {
    this.#at = at;
    const start = this.#bus.head();
    this.#publish("input.received", "input", { text, context: renderContext(context.turns) }, undefined, `in-${String(start)}`);
    return { action: await this.#drain(start) };
  }

  events(): readonly HookEvent[] {
    return this.#bus.toJSON().events;
  }

  get autopilot(): Autopilot {
    return this.#autopilot;
  }

  /**
   * Typeahead for the text a person has typed, or a prediction when that text is empty.
   * Command and subcommand candidates stay in command-tree order and do not call inference.
   * Natural language is the only completion that uses inference, and only for a non-slash
   * prefix whose command rows still fit in the option window.
   */
  async complete(prefix: string, context: InputContext): Promise<{ readonly completions: readonly Completion[] }> {
    const body = prefix.replace(/^\s+/, "");
    const commands = commandCandidates(body, commandTree(this.#tools, this.#harnesses?.sessions ?? [], this.#settings ?? [], this.#autopilot.updates(), this.#commands));
    const language = body.startsWith("/") || commands.length >= this.#maxOptions
      ? []
      : await languageCandidates(body, renderContext(context.turns), this.#ports.suggest);
    const seen = new Set(commands.map((candidate) => candidate.text));
    const merged = [...commands];
    for (const candidate of language) {
      if (seen.has(candidate.text)) continue;
      seen.add(candidate.text);
      merged.push(candidate);
    }
    return { completions: scoreCompletions(merged.slice(0, this.#maxOptions)) };
  }

  async #drain(start: number): Promise<InputAction> {
    for (let round = 0; round < DRAIN_ROUNDS; round++) {
      let progress = false;
      for (const actor of ACTORS) {
        const polled = this.#bus.poll(actor);
        if (!polled.ok) throw new Error(polled.error.message);
        const batch = polled.value;
        if (batch.length === 0) continue;
        for (const event of batch) await this.#handle(actor, event);
        const last = batch[batch.length - 1];
        if (last === undefined) continue;
        const acked = this.#bus.ack(actor, last.offset);
        if (!acked.ok) throw new Error(acked.error.message);
        progress = true;
      }
      const action = this.#actionSince(start);
      if (action !== undefined) return action;
      if (!progress) break;
    }
    throw new Error("interpreter did not settle");
  }

  async #handle(actor: ActorId, event: HookEvent): Promise<void> {
    const body = turnOf(event);
    if (actor === "actor.parser") {
      if (this.#autopilot.running && !autopilotLine(body.text)) this.#autopilot.interrupt();
      const action = await this.#slash(body.text);
      this.#publish(action === undefined ? "intent.decide" : "action.ready", actor, action === undefined ? body : { action }, event, "");
      return;
    }
    if (actor === "actor.decider") {
      const action = await this.#decide(body);
      this.#publish(action === undefined ? "intent.infer" : "action.ready", actor, action === undefined ? body : { action }, event, "");
      return;
    }
    if (actor === "actor.inferencer") {
      const action = await this.#infer(body);
      this.#publish(action === undefined ? "intent.unresolved" : "action.ready", actor, action === undefined ? body : { action }, event, "");
      return;
    }
    this.#publish("action.ready", actor, { action: { type: "elicit", question: `What should this do?\n${body.text}` } }, event, "");
  }

  async #slash(text: string): Promise<InputAction | undefined> {
    const match = SLASH.exec(text);
    if (match === null) return undefined;
    const name = match[1] ?? "";
    const raw = (match[2] ?? "").trim();
    if (name === "") return { type: "unknown-command", name: "" };
    if (name === "help") return this.#harnessHelp(raw);
    if (requestsHelp(raw)) return this.#help(name, raw);
    if (name === "tools") return this.#toolsCommand(raw);
    if (name === "sessions") return this.#sessionsCommand(raw);
    if (name === "settings") return this.#settingsCommand(raw);
    if (name === "autopilot") return this.#autopilotCommand(raw);
    if (!this.#commands.some((command) => command.name === name)) return { type: "unknown-command", name };
    return { type: "harness-command", name, argument: raw };
  }

  #help(name: string, raw: string): InputAction {
    const subject = helpSubject(raw);
    if (name === "tools") return this.#toolsHelp(subject);
    if (name === "sessions") return this.#sessionsHelp(subject);
    if (name === "settings") return this.#settingsHelp(subject);
    if (name === "autopilot") return this.#autopilotHelp(subject);
    const command = this.#commands.find((item) => item.name === name);
    if (command === undefined) return { type: "unknown-command", name };
    return { type: "help", name: command.name, message: manual(`${command.name} - ${command.description}`, `/${command.name} [argument]`, command.description, [`/${command.name}`, `/${command.name} --help`], ["/help"]) };
  }

  #harnessHelp(raw: string): InputAction {
    if (helpSubject(raw) !== undefined) return { type: "command-usage", name: "help", message: "usage: /help" };
    return { type: "help", name: "help", message: this.helpPage() };
  }

  #toolsHelp(subject: string | undefined): InputAction {
    const synopsis = "/tools [name | kind:name] [argument]";
    if (subject === undefined) {
      const listed = this.#tools.map(toolLine);
      const description = listed.length === 0 ? TOOLS_LEAD : [TOOLS_LEAD, ...listed].join("\n");
      return { type: "help", name: "tools", message: manual(`tools - ${TOOLS_LEAD}`, synopsis, description, ["/tools", "/tools --help"], ["/help"]) };
    }
    if (subject.includes(":")) {
      const tool = this.#byKey.get(subject);
      if (tool === undefined) return { type: "unknown-tool", name: subject };
      return { type: "help", name: `tools ${subject}`, message: toolManual(`tools ${subject}`, subject, [toolLine(tool)]) };
    }
    const matches = this.#tools.filter((tool) => tool.name === subject);
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only !== undefined) return { type: "help", name: `tools ${subject}`, message: toolManual(`tools ${subject}`, subject, [toolLine(only)]) };
    if (matches.length > 1) return { type: "help", name: `tools ${subject}`, message: toolManual(`tools ${subject}`, subject, matches.map(toolLine)) };
    return { type: "unknown-tool", name: subject };
  }

  #sessionsHelp(subject: string | undefined): InputAction {
    if (subject === undefined) {
      return { type: "help", name: "sessions", message: manual("sessions - Lists managed harness sessions in this session.", SESSIONS_SYNOPSIS, "Lists managed harness sessions in this session. With no arguments it lists them. fork starts a session from a point in a conversation. btw asks a side question, bg hands the active turn to the background, and switch inspects a session.", ["/sessions", "/sessions fork", "/sessions --help"], ["/help"]) };
    }
    if (subject === "new") {
      return { type: "help", name: "sessions new", message: manual("sessions new - Starts another harness session.", "/sessions new", "Starts another harness session.", ["/sessions new", "/sessions new --help"], ["/sessions"]) };
    }
    if (subject === "export") {
      return { type: "help", name: "sessions export", message: manual("sessions export - Writes sessions as JSON.", "/sessions export [session] [--clipboard | --file <filename>]", "Writes the named session, or every managed session, as JSON. The default destination is a file.", ["/sessions export", "/sessions export --help"], ["/sessions"]) };
    }
    if (subject === "resume") {
      return { type: "help", name: "sessions resume", message: manual("sessions resume - Resumes one managed harness session.", "/sessions resume <harness> [session]", "Resumes one managed harness session.", ["/sessions resume <harness>", "/sessions resume --help"], ["/sessions"]) };
    }
    if (subject === "fork") {
      return { type: "help", name: "sessions fork", message: manual("sessions fork - Starts a session from a point in the conversation.", FORK_SYNOPSIS, "Starts a session from a point in the conversation. With neither a thread id nor a message id, forks at the end of the active thread. A thread id alone forks at the end of that thread. A message id alone forks through that message. Both fork through that message on that thread.", ["/sessions fork", "/sessions fork --thread <id>", "/sessions fork --message <id>", "/sessions fork --help"], ["/sessions"]) };
    }
    if (subject === "btw") {
      return { type: "help", name: "sessions btw", message: manual("sessions btw - Asks about the main thread.", "/sessions btw <question>", "Asks about the main thread. A later question on the same fork sees later main-thread updates. The question and the answer stay off the main transcript, and the main thread keeps running.", ["/sessions btw <question>", "/sessions btw --help"], ["/sessions"]) };
    }
    if (subject === "bg") {
      return { type: "help", name: "sessions bg", message: manual("sessions bg - Sends the active turn to the background.", "/sessions bg", "Sends the active turn to the background and answers later lines on a new main. When the background turn finishes, its result merges into that main.", ["/sessions bg", "/sessions bg --help"], ["/sessions"]) };
    }
    if (subject === "switch") {
      return { type: "help", name: "sessions switch", message: manual("sessions switch - Inspects one session.", "/sessions switch <session>", "Use it to inspect a session's identity and recent content. It does not move the input queue, cancel the main thread, or merge background work.", ["/sessions switch <session>", "/sessions switch --help"], ["/sessions"]) };
    }
    return { type: "command-usage", name: "sessions", message: SESSIONS_USAGE };
  }

  #settingsHelp(subject: string | undefined): InputAction {
    if (subject === undefined) {
      const catalog = (this.#settings ?? []).map((spec) => `${spec.key}: ${spec.description}`);
      const description = catalog.length === 0 ? SETTINGS_LEAD : [SETTINGS_LEAD, ...catalog].join("\n");
      return { type: "help", name: "settings", message: manual(`settings - ${SETTINGS_LEAD}`, "/settings [key] [value | --unset]", description, ["/settings", "/settings --help"], ["/help"]) };
    }
    const specs = this.#settings;
    if (specs === undefined) return { type: "command-usage", name: "settings", message: "no settings are configured" };
    const spec = specs.find((item) => item.key === subject);
    if (spec === undefined) return { type: "command-usage", name: "settings", message: `no setting ${subject}` };
    const parts = [spec.description, `fallback: ${spec.fallback}`];
    if (spec.values !== undefined) parts.push(`values: ${spec.values.join(", ")}`);
    return { type: "help", name: `settings ${spec.key}`, message: manual(`settings ${spec.key} - ${spec.description}`, `/settings ${spec.key} [value | --unset]`, parts.join("\n"), [`/settings ${spec.key}`, `/settings ${spec.key} --help`], ["/settings"]) };
  }

  #settingsCommand(raw: string): InputAction {
    const parsed = parseSettings(raw);
    if (!parsed.ok) return { type: "command-usage", name: "settings", message: parsed.message };
    const specs = this.#settings;
    if (specs === undefined) return { type: "command-usage", name: "settings", message: "no settings are configured" };
    if (parsed.op === "list") return { type: "settings", view: "list", entries: specs.map((spec) => this.#settingView(spec)) };
    const spec = specs.find((item) => item.key === parsed.key);
    if (spec === undefined) return { type: "command-usage", name: "settings", message: `no setting ${parsed.key}` };
    if (parsed.op === "show") return { type: "settings", view: "show", entry: this.#settingView(spec) };
    if (parsed.op === "unset") {
      this.#settingState.delete(spec.key);
      return { type: "settings", view: "unset", entry: this.#settingView(spec) };
    }
    const allowed = spec.values === undefined || spec.values.includes(parsed.value);
    const previous = this.#settingState.get(spec.key)?.accepted;
    const accepted = allowed ? parsed.value : previous;
    this.#settingState.set(spec.key, accepted === undefined ? { requested: parsed.value } : { requested: parsed.value, accepted });
    return { type: "settings", view: "set", applied: allowed, entry: this.#settingView(spec) };
  }

  #settingView(spec: SettingSpec): SettingEntry {
    const state = this.#settingState.get(spec.key);
    const accepted = state?.accepted;
    return {
      key: spec.key,
      description: spec.description,
      effective: accepted ?? spec.fallback,
      ...(state?.requested === undefined ? {} : { requested: state.requested }),
      ...(accepted === undefined ? {} : { accepted }),
    };
  }

  async #sessionsCommand(raw: string): Promise<InputAction> {
    if (raw === "") return this.#listSessions();
    const gap = raw.search(/\s/);
    const token = gap === -1 ? raw : raw.slice(0, gap);
    const rest = gap === -1 ? "" : raw.slice(gap).trim();
    if (token === "new") {
      if (rest !== "") return { type: "command-usage", name: "new", message: "usage: /sessions new" };
      return { type: "new-session" };
    }
    if (token === "export") return this.#exportCommand(rest);
    if (token === "resume") return this.#resumeCommand(rest);
    if (token === "fork") return this.#forkCommand(rest);
    if (token === "btw") {
      if (rest === "" || rest.startsWith("--")) return { type: "command-usage", name: "btw", message: "usage: /sessions btw <question>" };
      return { type: "session-btw", question: rest };
    }
    if (token === "bg") {
      if (rest !== "") return { type: "command-usage", name: "bg", message: "usage: /sessions bg" };
      return { type: "session-bg" };
    }
    if (token === "switch") {
      if (rest === "" || /\s/.test(rest)) return { type: "command-usage", name: "switch", message: "usage: /sessions switch <session>" };
      return { type: "session-switch", session: rest };
    }
    return { type: "command-usage", name: "sessions", message: SESSIONS_USAGE };
  }

  #forkCommand(raw: string): InputAction {
    const parsed = parseFork(raw);
    if (!parsed.ok) return { type: "command-usage", name: "fork", message: parsed.message };
    return { type: "session-fork", ...(parsed.thread === undefined ? {} : { thread: parsed.thread }), ...(parsed.message === undefined ? {} : { message: parsed.message }) };
  }

  #listSessions(): InputAction {
    const managed = this.#harnesses;
    if (managed === undefined) return { type: "command-usage", name: "sessions", message: "no harness sessions are managed in this session" };
    return { type: "list-sessions", sessions: managed.sessions.map((session) => ({ name: session.name, harness: session.harness })) };
  }

  async #exportCommand(raw: string): Promise<InputAction> {
    const parsed = parseExport(raw);
    if (!parsed.ok) return { type: "command-usage", name: "export", message: parsed.message };
    const managed = this.#harnesses;
    if (managed === undefined) return { type: "command-usage", name: "export", message: "no harness sessions are managed in this session" };
    if (parsed.session === undefined) return this.#writeExport(managed, managed.sessions, managed.sessions.map(exportedSession), parsed);
    const chosen = managed.sessions.find((session) => session.name === parsed.session);
    if (chosen === undefined) return { type: "command-usage", name: "export", message: `no harness session ${parsed.session}` };
    return this.#writeExport(managed, [chosen], exportedSession(chosen), parsed);
  }

  async #writeExport(managed: ManagedHarnesses, chosen: readonly ManagedHarnessSession[], payload: unknown, parsed: ExportLine): Promise<InputAction> {
    const contents = `${JSON.stringify(payload, null, 2)}\n`;
    const sessions = chosen.map((session) => ({ name: session.name, harness: session.harness }));
    if (parsed.destination === "clipboard") {
      await managed.copy(contents);
      return { type: "exported", sessions, destination: { type: "clipboard" } };
    }
    const filename = parsed.filename ?? (parsed.session === undefined ? "harness-sessions.json" : `${parsed.session}.json`);
    await managed.writeFile(filename, contents);
    return { type: "exported", sessions, destination: { type: "file", filename } };
  }

  async #resumeCommand(raw: string): Promise<InputAction> {
    const parsed = parseResume(raw);
    if (!parsed.ok) return { type: "command-usage", name: "resume", message: parsed.message };
    const managed = this.#harnesses;
    if (managed === undefined) return { type: "command-usage", name: "resume", message: "no harness sessions are managed in this session" };
    const matches = managed.sessions.filter((session) => session.harness === parsed.harness && (parsed.session === undefined || session.name === parsed.session));
    const found = matches.length === 1 ? matches[0] : undefined;
    if (found === undefined) {
      const message = parsed.session !== undefined ? `no session ${parsed.session} on ${parsed.harness}` : matches.length === 0 ? `no harness ${parsed.harness}` : `harness ${parsed.harness} has more than one session`;
      return { type: "command-usage", name: "resume", message };
    }
    await managed.resume(found);
    return { type: "resumed", harness: found.harness, session: found.name };
  }

  #toolsCommand(raw: string): InputAction {
    if (raw === "") return { type: "list-tools", tools: this.#tools };
    const gap = raw.search(/\s/);
    const token = gap === -1 ? raw : raw.slice(0, gap);
    const argument = gap === -1 ? "" : raw.slice(gap).trim();
    if (token.includes(":")) {
      const tool = this.#byKey.get(token);
      if (tool === undefined) return { type: "unknown-tool", name: token };
      return { type: "invoke-tool", tool, argument };
    }
    const matches = this.#tools.filter((tool) => tool.name === token);
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only !== undefined) return { type: "invoke-tool", tool: only, argument };
    if (matches.length > 1) {
      const choices = matches.map((tool) => `${tool.kind}:${tool.name}`).join("\n");
      return { type: "elicit", question: `Which ${token}?\n${choices}` };
    }
    return { type: "unknown-tool", name: token };
  }

  async #decide(body: TurnText): Promise<InputAction | undefined> {
    try {
      const answer = await this.#ports.decide({ text: body.text, context: body.context, options: this.#options() });
      return this.#fromDecision(body.text, answer);
    } catch {
      return undefined;
    }
  }

  #fromDecision(text: string, answer: DecisionAnswer): InputAction | undefined {
    if (answer.complicated || answer.choice === "complicated" || answer.choice === "use-tool") return undefined;
    if (answer.choice === "message") return { type: "message", text };
    if (this.#tools.length + 2 > this.#maxOptions) return undefined;
    const tool = this.#tools.find((candidate) => this.#optionName(candidate) === answer.choice);
    if (tool === undefined) return undefined;
    return { type: "invoke-tool", tool, argument: text };
  }

  #options(): DecisionRequest["options"] {
    const message = { name: "message", description: "The text is a message." };
    const complicated = { name: "complicated", description: "The intent needs a generator." };
    if (this.#tools.length + 2 > this.#maxOptions) return [message, { name: "use-tool", description: "Use a registered tool." }, complicated];
    return [message, ...this.#tools.map((tool) => ({ name: this.#optionName(tool), description: tool.description })), complicated];
  }

  #optionName(tool: RegisteredTool): string {
    const clash = this.#tools.some((other) => other.name === tool.name && other.kind !== tool.kind);
    return clash ? `${tool.kind}:${tool.name}` : tool.name;
  }

  async #infer(body: TurnText): Promise<InputAction | undefined> {
    try {
      const answer = await this.#ports.infer({ text: body.text, context: body.context, tools: this.#tools, commands: this.#commands });
      if (!answer.ok) return undefined;
      return this.#accept(answer.action);
    } catch {
      return undefined;
    }
  }

  #accept(action: InputAction): InputAction | undefined {
    if (action.type === "message") return { type: "message", text: action.text };
    if (action.type === "list-tools") return { type: "list-tools", tools: this.#tools };
    if (action.type === "harness-command" && this.#knownCommand(action.name)) {
      return { type: "harness-command", name: action.name, argument: action.argument };
    }
    if (action.type === "invoke-tool") {
      const tool = this.#tools.find((candidate) => candidate.kind === action.tool.kind && candidate.name === action.tool.name);
      if (tool === undefined) return undefined;
      return { type: "invoke-tool", tool, argument: action.argument };
    }
    return undefined;
  }

  #knownCommand(name: string): boolean {
    return name === "tools" || this.#commands.some((command) => command.name === name);
  }

  #publish(type: string, source: string, payload: unknown, cause: HookEvent | undefined, correlationId: string): HookEvent {
    const published = this.#bus.publish(
      { type, source, payload, ...(cause === undefined ? { correlationId } : { cause: cause.eventId }) },
      this.#at,
    );
    if (!published.ok) throw new Error(published.error.message);
    return published.value;
  }

  #actionSince(start: number): InputAction | undefined {
    const ready = this.#bus.toJSON().events.find((event) => event.offset >= start && event.type === "action.ready");
    if (ready === undefined) return undefined;
    return actionOf(ready);
  }

  #autopilotCommand(raw: string): InputAction {
    if (raw === "updates") return { type: "autopilot", view: "updates", updates: this.#autopilot.updates() };
    if (raw === "stop") {
      this.#autopilot.interrupt();
      return { type: "autopilot", view: "stopped", running: false };
    }
    const applied = /^apply\s+(\S+)$/.exec(raw);
    if (applied !== null) return { type: "autopilot", view: "applied", update: this.#autopilot.apply(applied[1] ?? "") };
    if (raw === "apply" || raw.startsWith("apply ") || raw.startsWith("updates ") || raw.startsWith("stop ")) {
      return { type: "command-usage", name: "autopilot", message: AUTOPILOT_USAGE };
    }
    const steering = raw === "" ? undefined : raw;
    this.#autopilot.start(steering);
    return { type: "autopilot", view: "started", running: true, ...(steering === undefined ? {} : { steering }) };
  }

  #autopilotHelp(subject: string | undefined): InputAction {
    if (subject === "updates") return { type: "help", name: "autopilot updates", message: manual("autopilot updates - Lists harness updates.", "/autopilot updates", "Lists harness updates. Each one is the reviewable branch and its release notes.", ["/autopilot updates", "/autopilot updates --help"], ["/autopilot"]) };
    if (subject === "apply") return { type: "help", name: "autopilot apply", message: manual("autopilot apply - Marks one update applied.", "/autopilot apply <id>", "Marks one update applied. It does not change the trunk.", ["/autopilot apply <id>", "/autopilot apply --help"], ["/autopilot"]) };
    if (subject === "stop") return { type: "help", name: "autopilot stop", message: manual("autopilot stop - Interrupts the run.", "/autopilot stop", "Interrupts the run.", ["/autopilot stop", "/autopilot stop --help"], ["/autopilot"]) };
    return { type: "help", name: "autopilot", message: manual("autopilot - Proposes its own goals on a branch until interrupted.", "/autopilot [instructions]", AUTOPILOT_BODY, ["/autopilot", "/autopilot --help"], ["/help"]) };
  }
}

interface ExportLine {
  readonly ok: true;
  readonly destination: "file" | "clipboard";
  readonly session?: string;
  readonly filename?: string;
}

type SettingsParse =
  | { readonly ok: true; readonly op: "list" }
  | { readonly ok: true; readonly op: "show"; readonly key: string }
  | { readonly ok: true; readonly op: "unset"; readonly key: string }
  | { readonly ok: true; readonly op: "set"; readonly key: string; readonly value: string }
  | { readonly ok: false; readonly message: string };

function checkedSettings(settings: readonly SettingSpec[] | undefined): readonly SettingSpec[] | undefined {
  if (settings === undefined) return undefined;
  const keys = new Set<string>();
  const copy: SettingSpec[] = [];
  for (const spec of settings) {
    if (!/^[A-Za-z][\w-]*$/.test(spec.key)) throw new TypeError(`setting ${spec.key} is invalid`);
    if (keys.has(spec.key)) throw new TypeError(`duplicated setting ${spec.key}`);
    keys.add(spec.key);
    if (spec.values === undefined) {
      copy.push({ key: spec.key, description: spec.description, fallback: spec.fallback });
      continue;
    }
    if (spec.values.length === 0 || !spec.values.includes(spec.fallback)) throw new TypeError(`setting ${spec.key} fallback is not one of its values`);
    const values = new Set<string>();
    for (const value of spec.values) {
      if (values.has(value)) throw new TypeError(`duplicated setting value ${value}`);
      values.add(value);
    }
    copy.push({ key: spec.key, description: spec.description, fallback: spec.fallback, values: [...spec.values] });
  }
  return copy;
}

function parseSettings(raw: string): SettingsParse {
  const tokens = raw.split(/\s+/).filter((token) => token !== "");
  const unknown = tokens.find((token) => token.startsWith("--") && token !== "--unset");
  if (unknown !== undefined) return { ok: false, message: `unknown flag ${unknown}` };
  const keys = tokens.filter((token) => token !== "--unset");
  if (tokens.includes("--unset")) {
    if (keys.length !== 1) return { ok: false, message: "usage: /settings <key> --unset" };
    return { ok: true, op: "unset", key: keys[0] ?? "" };
  }
  if (keys.length === 0) return { ok: true, op: "list" };
  const key = keys[0] ?? "";
  if (keys.length === 1) return { ok: true, op: "show", key };
  return { ok: true, op: "set", key, value: keys.slice(1).join(" ") };
}

function checkedHarnesses(harnesses: ManagedHarnesses | undefined): ManagedHarnesses | undefined {
  if (harnesses === undefined) return undefined;
  const names = new Set<string>();
  for (const session of harnesses.sessions) {
    if (!/^[A-Za-z][\w-]*$/.test(session.name)) throw new TypeError(`session name ${session.name} is invalid`);
    if (session.harness.trim() === "" || /\s/.test(session.harness)) throw new TypeError(`harness ${session.harness} is invalid`);
    if (names.has(session.name)) throw new TypeError(`duplicated session ${session.name}`);
    names.add(session.name);
  }
  return harnesses;
}

function parseExport(raw: string): ExportLine | { readonly ok: false; readonly message: string } {
  const tokens = raw.split(/\s+/).filter((token) => token !== "");
  let session: string | undefined;
  let destination: "file" | "clipboard" = "file";
  let filename: string | undefined;
  let chose = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    if (token === "--clipboard") {
      if (chose) return { ok: false, message: "choose --clipboard or --file" };
      destination = "clipboard";
      chose = true;
      continue;
    }
    if (token === "--file") {
      if (chose) return { ok: false, message: "choose --clipboard or --file" };
      const next = tokens[index + 1];
      if (next === undefined || next.startsWith("--") || !/^[A-Za-z0-9._-]+$/.test(next) || next === "." || next === "..") {
        return { ok: false, message: next === undefined || next.startsWith("--") ? "usage: /sessions export [session] [--clipboard | --file <filename>]" : `filename ${next} is not a file name` };
      }
      filename = next;
      destination = "file";
      chose = true;
      index += 1;
      continue;
    }
    if (token.startsWith("--")) return { ok: false, message: `unknown flag ${token}` };
    if (session !== undefined) return { ok: false, message: "usage: /sessions export [session] [--clipboard | --file <filename>]" };
    session = token;
  }
  return { ok: true, destination, ...(session === undefined ? {} : { session }), ...(filename === undefined ? {} : { filename }) };
}

const FORK_SYNOPSIS = "/sessions fork [--thread <id>] [--message <id>]";
const FORK_USAGE = "usage: /sessions fork [--thread <id>] [--message <id>]";

function parseFork(raw: string): { readonly ok: true; readonly thread?: string; readonly message?: string } | { readonly ok: false; readonly message: string } {
  const tokens = raw.split(/\s+/).filter((token) => token !== "");
  let thread: string | undefined;
  let message: string | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    if (token !== "--thread" && token !== "--message") return { ok: false, message: FORK_USAGE };
    const next = tokens[index + 1];
    if (next === undefined || next.startsWith("--")) return { ok: false, message: FORK_USAGE };
    if (token === "--thread") {
      if (thread !== undefined) return { ok: false, message: FORK_USAGE };
      thread = next;
    } else {
      if (message !== undefined) return { ok: false, message: FORK_USAGE };
      message = next;
    }
    index += 1;
  }
  return { ok: true, ...(thread === undefined ? {} : { thread }), ...(message === undefined ? {} : { message }) };
}

function parseResume(raw: string): { readonly ok: true; readonly harness: string; readonly session?: string } | { readonly ok: false; readonly message: string } {
  const tokens = raw.split(/\s+/).filter((token) => token !== "");
  const harness = tokens[0];
  const extra = tokens[2];
  if (harness === undefined || extra !== undefined) return { ok: false, message: "usage: /sessions resume <harness> [session]" };
  const session = tokens[1];
  return { ok: true, harness, ...(session === undefined ? {} : { session }) };
}

function exportedSession(session: ManagedHarnessSession): { name: string; harness: string; state: unknown } {
  return { name: session.name, harness: session.harness, state: session.state };
}

const SESSIONS_SYNOPSIS = "/sessions [new | export | resume | fork | btw | bg | switch]";
const SESSIONS_USAGE = "usage: /sessions [new | export | resume | fork | btw | bg | switch]";
const TOOLS_LEAD = "Lists registered skills, MCPs, and native tools, or invokes one.";
const SETTINGS_LEAD = "Reads and writes harness configuration.";
const AUTOPILOT_BODY = "Proposes its own goals until interrupted. Instructions are the goal. Goals are upgrades, known vulnerabilities, research, and performance experiments recorded as Open Experiment Standard 0.1.0 documents. Each goal is a harness update on branch autopilot/<id> with release notes, and it is not applied to the trunk until /autopilot apply <id>.";
const AUTOPILOT_USAGE = "usage: /autopilot [instructions | updates | apply <id> | stop]";
const AUTOPILOT_DESCRIPTION = "Proposes its own goals on a branch until interrupted.";

function autopilotLine(text: string): boolean {
  const match = SLASH.exec(text);
  return match !== null && (match[1] ?? "") === "autopilot";
}

function requestsHelp(raw: string): boolean {
  return raw.split(/\s+/).includes("--help");
}

function helpSubject(raw: string): string | undefined {
  return raw.split(/\s+/).find((token) => token !== "" && !token.startsWith("--"));
}

function toolLine(tool: RegisteredTool): string {
  return `${tool.kind} ${tool.name}: ${tool.description}`;
}

function toolManual(name: string, subject: string, lines: readonly string[]): string {
  return manual(`${name} - ${lines[0] ?? subject}`, `/tools ${subject} [argument]`, lines.join("\n"), [`/tools ${subject}`, `/tools ${subject} --help`], ["/tools"]);
}

const COMMANDS: readonly { readonly synopsis: string; readonly description: string }[] = [
  { synopsis: "/tools [name | kind:name] [argument]", description: TOOLS_LEAD },
  { synopsis: SESSIONS_SYNOPSIS, description: "Lists managed harness sessions in this session." },
  { synopsis: "/sessions new", description: "Starts another harness session." },
  { synopsis: "/sessions export [session] [--clipboard | --file <filename>]", description: "Writes the named session, or every managed session, as JSON. The default destination is a file." },
  { synopsis: "/sessions resume <harness> [session]", description: "Resumes one managed harness session." },
  { synopsis: FORK_SYNOPSIS, description: "Starts a session from a point in the conversation." },
  { synopsis: "/sessions btw <question>", description: "Asks about the main thread. The question and the answer stay off the main transcript, and the main thread keeps running." },
  { synopsis: "/sessions bg", description: "Sends the active turn to the background and answers later lines on a new main." },
  { synopsis: "/sessions switch <session>", description: "Inspects a session's identity and recent content." },
  { synopsis: "/settings [key] [value | --unset]", description: SETTINGS_LEAD },
  { synopsis: "/autopilot [instructions]", description: AUTOPILOT_DESCRIPTION },
  { synopsis: "/autopilot updates", description: "Lists harness updates. Each one is the reviewable branch and its release notes." },
  { synopsis: "/autopilot apply <id>", description: "Marks one update applied. It does not change the trunk." },
  { synopsis: "/autopilot stop", description: "Interrupts the run." },
];

const HOOKS: readonly { readonly name: string; readonly description: string }[] = [
  { name: "behavior.changed", description: "A session's behavior state changed." },
  { name: "behavior.raised", description: "A host raised an event on a session's behavior graph." },
  { name: "session.created", description: "A session was created." },
  { name: "session.attached", description: "A node attached to a session." },
  { name: "session.detached", description: "A node detached from a session." },
  { name: "turn.started", description: "A turn started." },
  { name: "turn.ended", description: "A turn ended." },
  { name: "permission.requested", description: "A turn asked for permission." },
  { name: "permission.resolved", description: "A permission request was resolved." },
  { name: "capability.added", description: "A capability was offered." },
  { name: "capability.revoked", description: "A capability was revoked." },
  { name: "input.received", description: "A line was submitted to the interpreter." },
  { name: "intent.decide", description: "The parser left the line for the decision model." },
  { name: "intent.infer", description: "The decision model left the line for the generator." },
  { name: "intent.unresolved", description: "The generator left the line unresolved." },
  { name: "action.ready", description: "An action is ready to run." },
  { name: "branch.intention", description: "A branch named the node it is about to run." },
  { name: "branch.result", description: "A branch finished a node." },
  { name: "branch.failure", description: "A branch recorded a node failure." },
  { name: "branch.correction", description: "A branch selected another path." },
  { name: "dialogue.script.built", description: "A dialogue script was built." },
  { name: "dialogue.script.put", description: "A dialogue script was stored." },
  { name: "dialogue.script.promoted", description: "A dialogue script became active." },
  { name: "dialogue.script.retired", description: "A dialogue script left the active set." },
  { name: "dialogue.document.put", description: "A dialogue document was stored." },
  { name: "procedural.approval.requested", description: "A procedural core edit is waiting for approval." },
  { name: "procedural.approval.decided", description: "A procedural approval was approved or declined." },
  { name: "procedural.plan.completed", description: "A procedural plan run ended." },
];

function harnessManual(commands: readonly HarnessCommand[]): string {
  const lines = [
    "Type a message. A line that starts with / is a command, not a message.",
    "Add --help to a command to describe it.",
    "",
    ...COMMANDS.flatMap((command) => [command.synopsis, `    ${command.description}`]),
    ...commands.flatMap((command) => [`/${command.name} [argument]`, `    ${command.description}`]),
    "",
    "Hooks",
    ...HOOKS.flatMap((hook) => [hook.name, `    ${hook.description}`]),
  ];
  return manual("help - Describes the harness commands and hook events.", "/help", lines.join("\n"), ["/help", "/sessions --help"], ["/tools", "/sessions", "/settings", "/autopilot"]);
}

function manual(name: string, synopsis: string, description: string, examples: readonly string[], see: readonly string[]): string {
  return ["NAME", name, "SYNOPSIS", synopsis, "DESCRIPTION", description, "OPTIONS", "--help\n    Describes this command and does not run it.", "EXAMPLES", examples.join("\n"), "SEE ALSO", see.join("\n")].join("\n");
}

function checkedMax(value: number | undefined): number {
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || value < 2 || value > 20) throw new TypeError(`maxOptions ${String(value)} is outside 2..20`);
  return value;
}

/** Newest turns that fit in {@link CONTEXT_LIMIT} characters, joined chronologically. */
function renderContext(turns: InputContext["turns"]): string {
  const kept: string[] = [];
  let used = 0;
  for (const turn of [...turns].reverse()) {
    const line = turn.text;
    const extra = kept.length === 0 ? line.length : line.length + 1;
    if (used + extra <= CONTEXT_LIMIT) {
      kept.push(line);
      used += extra;
    } else {
      if (kept.length === 0) kept.push(line.slice(-CONTEXT_LIMIT));
      break;
    }
  }
  return kept.reverse().join("\n");
}

function turnOf(event: HookEvent): TurnText {
  return event.payload as TurnText;
}

function actionOf(event: HookEvent): InputAction {
  return (event.payload as { action: InputAction }).action;
}

interface Choice {
  readonly token: string;
  readonly description: string;
  readonly children: readonly Choice[];
}

interface Candidate {
  readonly text: string;
  readonly description: string;
  readonly source: "command" | "language";
}

function commandTree(tools: readonly RegisteredTool[], sessions: readonly ManagedHarnessSession[], settings: readonly SettingSpec[], updates: readonly AutopilotUpdate[], commands: readonly HarnessCommand[]): Choice[] {
  return [toolsChoice(tools), sessionsChoice(sessions), settingsChoice(settings), autopilotChoice(updates), ...commands.map(commandChoice)];
}

function autopilotChoice(updates: readonly AutopilotUpdate[]): Choice {
  return {
    token: "/autopilot",
    description: AUTOPILOT_DESCRIPTION,
    children: [
      { token: "updates", description: "Lists harness updates.", children: [helpChoice("/autopilot updates")] },
      {
        token: "apply",
        description: "Marks one update applied. It does not change the trunk.",
        children: [
          ...updates.map((update) => ({ token: update.id, description: `Applies update ${update.id}.`, children: [] })),
          helpChoice("/autopilot apply"),
        ],
      },
      { token: "stop", description: "Interrupts the run.", children: [helpChoice("/autopilot stop")] },
      helpChoice("/autopilot"),
    ],
  };
}

function commandChoice(command: HarnessCommand): Choice {
  return { token: `/${command.name}`, description: command.description, children: [helpChoice(`/${command.name}`)] };
}

function toolsChoice(tools: readonly RegisteredTool[]): Choice {
  const bare: Choice[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    const same = tools.filter((item) => item.name === tool.name);
    bare.push({
      token: tool.name,
      description: same.map((item) => `${item.kind} ${item.name}: ${item.description}`).join("\n"),
      children: [helpChoice(`/tools ${tool.name}`)],
    });
  }
  const qualified = tools.map((tool) => ({
    token: `${tool.kind}:${tool.name}`,
    description: `${tool.kind} ${tool.name}: ${tool.description}`,
    children: [helpChoice(`/tools ${tool.kind}:${tool.name}`)],
  }));
  return {
    token: "/tools",
    description: "Lists registered skills, MCPs, and native tools, or invokes one.",
    children: [...bare, ...qualified, helpChoice("/tools")],
  };
}

function sessionsChoice(sessions: readonly ManagedHarnessSession[]): Choice {
  const exportNames = sessions.map((session) => ({
    token: session.name,
    description: `Exports session ${session.name}.`,
    children: exportFlags(`/sessions export ${session.name}`),
  }));
  const harnesses: string[] = [];
  for (const session of sessions) if (!harnesses.includes(session.harness)) harnesses.push(session.harness);
  const resumeNames = harnesses.map((harness) => ({
    token: harness,
    description: `Resumes harness ${harness}.`,
    children: [
      ...sessions.filter((session) => session.harness === harness).map((session) => ({
        token: session.name,
        description: `Resumes session ${session.name} on ${harness}.`,
        children: [helpChoice(`/sessions resume ${harness} ${session.name}`)],
      })),
      helpChoice(`/sessions resume ${harness}`),
    ],
  }));
  return {
    token: "/sessions",
    description: "Lists managed harness sessions in this session.",
    children: [
      { token: "new", description: "Starts another harness session.", children: [helpChoice("/sessions new")] },
      { token: "export", description: "Writes the named session, or every managed session, as JSON. The default destination is a file.", children: [...exportNames, ...exportFlags("/sessions export")] },
      { token: "resume", description: "Resumes one managed harness session.", children: [...resumeNames, helpChoice("/sessions resume")] },
      {
        token: "fork",
        description: "Starts a session from a point in the conversation.",
        children: [
          { token: "--thread", description: "Forks at the end of this thread.", children: [] },
          { token: "--message", description: "Forks through this message.", children: [] },
          helpChoice("/sessions fork"),
        ],
      },
      { token: "btw", description: "Asks about the main thread. A later question sees later updates.", children: [helpChoice("/sessions btw")] },
      { token: "bg", description: "Sends the active turn to the background.", children: [helpChoice("/sessions bg")] },
      { token: "switch", description: "Inspects a session's identity and recent content.", children: [helpChoice("/sessions switch")] },
      helpChoice("/sessions"),
    ],
  };
}

function exportFlags(path: string): Choice[] {
  return [
    { token: "--clipboard", description: "Copies the export to the clipboard.", children: [] },
    { token: "--file", description: "Writes the export to a named file.", children: [] },
    helpChoice(path),
  ];
}

function settingsChoice(settings: readonly SettingSpec[]): Choice {
  if (settings.length === 0) return { token: "/settings", description: "Reads and writes harness configuration.", children: [helpChoice("/settings")] };
  const keys = settings.map((spec) => ({
    token: spec.key,
    description: spec.description,
    children: [
      ...(spec.values ?? []).map((value) => ({ token: value, description: `Sets ${spec.key} to ${value}.`, children: [helpChoice(`/settings ${spec.key} ${value}`)] })),
      { token: "--unset", description: "Restores the setting to its fallback.", children: [] },
      helpChoice(`/settings ${spec.key}`),
    ],
  }));
  return {
    token: "/settings",
    description: "Reads and writes harness configuration.",
    children: [
      ...keys,
      { token: "--unset", description: "Restores the setting to its fallback.", children: settings.map((spec) => ({ token: spec.key, description: spec.description, children: [] })) },
      helpChoice("/settings"),
    ],
  };
}

function helpChoice(path: string): Choice {
  return { token: "--help", description: `Describes ${path}.`, children: [] };
}

function commandCandidates(body: string, roots: readonly Choice[]): Candidate[] {
  if (body === "") return roots.map((root) => leaf("", root));
  if (!body.startsWith("/")) return [];
  return descend(body, /\s$/.test(body), roots, "");
}

function descend(remainder: string, trailing: boolean, options: readonly Choice[], parent: string): Candidate[] {
  const text = remainder.trim();
  if (text === "") return options.map((option) => leaf(parent, option));
  const consumed = longestConsumed(options, text);
  if (consumed === undefined) return options.filter((option) => option.token.startsWith(text)).map((option) => leaf(parent, option));
  const after = text.slice(consumed.token.length);
  const path = join(parent, consumed.token);
  if (after === "") return trailing ? consumed.children.map((option) => leaf(path, option)) : [leaf(parent, consumed), ...consumed.children.map((option) => leaf(path, option))];
  return descend(after.trimStart(), trailing, consumed.children, path);
}

function longestConsumed(options: readonly Choice[], text: string): Choice | undefined {
  let found: Choice | undefined;
  for (const option of options) {
    if ((text === option.token || text.startsWith(`${option.token} `)) && (found === undefined || option.token.length > found.token.length)) found = option;
  }
  return found;
}

function join(parent: string, token: string): string {
  return parent === "" ? token : `${parent} ${token}`;
}

function leaf(parent: string, option: Choice): Candidate {
  return { text: join(parent, option.token), description: option.description, source: "command" };
}

async function languageCandidates(body: string, context: string, suggest: InputInterpreterPorts["suggest"]): Promise<Candidate[]> {
  if (suggest === undefined) return [];
  try {
    const answer = await suggest({ text: body, context });
    if (!answer.ok) return [];
    const seen = new Set<string>();
    const out: Candidate[] = [];
    for (const suggestion of answer.suggestions) {
      if (suggestion.text.trim() === "" || seen.has(suggestion.text)) continue;
      if (body !== "" && !suggestion.text.startsWith(body)) continue;
      seen.add(suggestion.text);
      out.push({ text: suggestion.text, description: suggestion.description, source: "language" });
    }
    return out;
  } catch {
    return [];
  }
}

function scoreCompletions(candidates: readonly Candidate[]): Completion[] {
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only !== undefined) return [{ text: only.text, description: only.description, source: only.source, score: 1 }];
  return candidates.map((candidate) => ({ text: candidate.text, description: candidate.description, source: candidate.source, score: 0 }));
}
