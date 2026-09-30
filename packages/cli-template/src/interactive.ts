import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { Client, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { InputInterpreter } from "@harness/core";
import type { InputAction, ManagedHarnessSession } from "@harness/core";

type AcpStream = ConstructorParameters<typeof ClientSideConnection>[1];

/** The active daemon session the prompt can drive: plain turns, slash commands, typeahead, session resume, and permission choices. */
export interface InteractiveClient {
  line(text: string): Promise<string>;
  complete(prefix: string): Promise<readonly string[]>;
  /** Resolves with the permission request once the daemon asks. Does not choose an option. */
  armPermission(): Promise<string>;
  cancel(): void;
}

interface PendingPermission {
  readonly options: readonly { readonly optionId: string; readonly name: string }[];
  readonly resolve: (response: RequestPermissionResponse) => void;
}

const HELP = /^\s*\/(?:help)?\s*$/;

/** Open an ACP session and answer later lines on the active one. `/new` starts another; `/sessions resume` loads one back. Permission waits for the next line. */
export async function openInteractive(stream: AcpStream): Promise<InteractiveClient> {
  let reply = "";
  let inflight: Promise<string> | undefined;
  let waiting: PendingPermission | undefined;
  let notice: string | undefined;
  let armed: ((text: string) => void) | undefined;
  let at = 0;

  const client: Client = {
    async sessionUpdate(params) {
      const update = params.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") reply += update.content.text;
    },
    requestPermission(params) {
      notice = permissionText(params);
      const publish = armed;
      armed = undefined;
      publish?.(notice);
      return new Promise((resolve) => {
        waiting = {
          options: params.options.map((option) => ({ optionId: option.optionId, name: option.name })),
          resolve,
        };
      });
    },
  };
  const acp = new ClientSideConnection(() => client, stream);
  await acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const opened = await acp.newSession({ cwd: process.cwd(), mcpServers: [] });
  let active = opened.sessionId;
  const sessions: ManagedHarnessSession[] = [];
  const track = (id: string) => {
    if (sessions.some((session) => session.name === id)) return;
    sessions.push({ name: id, harness: "daemon", state: { sessionId: id } });
  };
  track(active);
  const interpreter = new InputInterpreter(
    {
      tools: [],
      commands: [
        { name: "ask", description: "Send the rest of the line to the session agent." },
        { name: "new", description: "Start another harness session." },
      ],
      harnesses: {
        sessions,
        writeFile: () => undefined,
        copy: () => undefined,
        resume: async (found) => {
          await acp.loadSession({ sessionId: found.name, cwd: process.cwd(), mcpServers: [] });
          active = found.name;
        },
      },
    },
    {
      decide: () => ({ choice: "message", complicated: true }),
      infer: () => ({ ok: false }),
    },
  );

  async function commands(prefix: string): Promise<readonly string[]> {
    const { completions } = await interpreter.complete(prefix, { turns: [] });
    return completions.map((item) => item.text);
  }

  async function guide(): Promise<string> {
    const names = await commands("/");
    return ["Talk by typing a message, or /ask <message>. A line that starts with / is a command, not a message.", ...names, "Add --help to a command to describe it."].join("\n");
  }

  async function refresh(): Promise<void> {
    const listed = await acp.listSessions({});
    for (const session of listed.sessions) track(session.sessionId);
  }

  function send(message: string): Promise<string> {
    reply = "";
    const turn = acp.prompt({ sessionId: active, prompt: [{ type: "text", text: message }] }).then(() => reply);
    inflight = turn;
    return turn;
  }

  return {
    async line(text: string): Promise<string> {
      if (waiting) {
        const pending = waiting;
        waiting = undefined;
        notice = undefined;
        const optionId = matchChoice(text, pending.options);
        const turn = inflight;
        inflight = undefined;
        if (optionId === undefined) {
          pending.resolve({ outcome: { outcome: "cancelled" } });
          await turn?.catch(() => undefined);
          return "unknown permission choice";
        }
        pending.resolve({ outcome: { outcome: "selected", optionId } });
        return (await turn) ?? "";
      }
      if (text.trim().length === 0) throw new TypeError("prompt must be a string");
      if (text.trim().toLowerCase() === "help" || HELP.test(text)) return guide();
      const ask = asked(text);
      if (ask !== undefined) {
        if (ask.message.length === 0) return "usage: /ask <message>";
        return send(ask.message);
      }
      const slash = text.replace(/^(\s*\/(?!ask\b)[A-Za-z][\w-]*)\s+help\s*$/, "$1 --help");
      if (slash.trimStart().startsWith("/")) {
        if (/^\s*\/sessions\b/.test(slash)) await refresh();
        const { action } = await interpreter.submit(slash, { turns: [] }, at);
        at += 1;
        if (action.type === "harness-command" && action.name === "new") {
          if (action.argument !== "") return "usage: /new";
          const created = await acp.newSession({ cwd: process.cwd(), mcpServers: [] });
          track(created.sessionId);
          active = created.sessionId;
          return `session ${created.sessionId}`;
        }
        return render(action);
      }
      return send(text);
    },
    complete: (prefix) => commands(prefix),
    armPermission() {
      if (notice !== undefined && waiting) return Promise.resolve(notice);
      return new Promise((resolve) => {
        armed = resolve;
      });
    },
    cancel() {
      if (!waiting) return;
      waiting.resolve({ outcome: { outcome: "cancelled" } });
      waiting = undefined;
      notice = undefined;
    },
  };
}

/** `/ask` and `/ask <message>`. `--help` stays with the interpreter. */
function asked(text: string): { message: string } | undefined {
  const match = /^\s*\/ask(?:\s+([\s\S]*))?\s*$/.exec(text);
  if (match === null) return undefined;
  const rest = (match[1] ?? "").trim();
  if (rest.split(/\s+/).includes("--help")) return undefined;
  return { message: rest };
}

function permissionText(params: RequestPermissionRequest): string {
  const title = params.toolCall.title;
  const heading = typeof title === "string" && title.length > 0 ? title : "permission";
  return [heading, ...params.options.map((option) => `${option.optionId} ${option.name}`)].join("\n");
}

function matchChoice(text: string, options: PendingPermission["options"]): string | undefined {
  const typed = text.trim().toLowerCase();
  return options.find((option) => option.optionId.toLowerCase() === typed || option.name.toLowerCase() === typed)?.optionId;
}

function render(action: InputAction): string {
  switch (action.type) {
    case "help":
    case "command-usage":
      return action.message;
    case "unknown-command":
      return `unknown command /${action.name}`;
    case "unknown-tool":
      return `unknown tool ${action.name}`;
    case "list-sessions":
      return action.sessions.map((session) => `${session.harness} ${session.name}`).join("\n");
    case "list-tools":
      return action.tools.map((tool) => `${tool.kind} ${tool.name}: ${tool.description}`).join("\n");
    case "invoke-tool":
      return `${action.tool.kind} ${action.tool.name} ${action.argument}`.trim();
    case "harness-command":
      return `/${action.name} ${action.argument}`.trim();
    case "exported":
      return action.destination.type === "clipboard" ? "copied" : action.destination.filename;
    case "resumed":
      return `resumed ${action.harness} ${action.session}`;
    case "settings":
      if (action.view === "list") return action.entries.map((entry) => `${entry.key}=${entry.effective}`).join("\n");
      return `${action.entry.key}=${action.entry.effective}`;
    case "message":
      return action.text;
    case "elicit":
      return action.question;
    case "autopilot":
      if (action.view === "updates") return action.updates.map((update) => update.id).join("\n");
      if (action.view === "applied") return action.update.id;
      return action.view;
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}
