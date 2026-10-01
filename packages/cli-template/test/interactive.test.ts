import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { openInteractive } from "@harness/cli-template";
import type { InteractiveClient } from "@harness/cli-template";
import { NodeHost } from "@harness/platform-native";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonSchema, tool } from "ai";
import { harnessWorker } from "@harness/platform-native";
import { scriptedHarness } from "@harness/testkit";
import { EchoWorker } from "@harness/workers";
import type { Worker } from "@harness/workers";
import { InputInterpreter } from "@harness/core";
import { openSessionConsole } from "../src/console.ts";
import { openSessionFrame, paint } from "../src/present.ts";
import { applyScreen, blankScreen, screenLines } from "../src/screen.ts";

const hosts: NodeHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

function stream(host: NodeHost) {
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  host.attach(toHost, fromHost);
  return ndJsonStream(Writable.toWeb(toHost), Readable.toWeb(fromHost) as ReadableStream<Uint8Array>);
}

/** What those bytes show. The same walker the session uses, including a last-row scroll. */
function renderScreen(bytes: string, height?: number): string {
  const screen = blankScreen();
  applyScreen(screen, bytes, "other", height);
  return screenLines(screen).join("\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
}

function lastRow(rows: readonly string[], match: (row: string) => boolean): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row !== undefined && match(row)) return index;
  }
  return -1;
}

async function started(): Promise<{ host: NodeHost; cli: InteractiveClient }> {
  const host = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" } });
  hosts.push(host);
  return { host, cli: await openInteractive(stream(host)) };
}

function manualSections(message: string): Record<string, string> {
  const headings = ["NAME", "SYNOPSIS", "DESCRIPTION", "OPTIONS", "EXAMPLES", "SEE ALSO"];
  let cursor = 0;
  const at: number[] = [];
  for (const heading of headings) {
    const found = message.indexOf(heading, cursor);
    expect(found).toBeGreaterThanOrEqual(cursor);
    at.push(found);
    cursor = found + heading.length;
  }
  const sections: Record<string, string> = {};
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    const start = at[index]! + heading.length;
    const end = at[index + 1] ?? message.length;
    sections[heading] = message.slice(start, end).trim();
  }
  for (const heading of headings) expect(sections[heading]?.length ?? 0).toBeGreaterThan(0);
  return sections;
}

function turns(host: NodeHost): number {
  return host.daemon.snapshot().sessions.reduce((count, session) => {
    const log = session.log as { entries: { payload: unknown }[] };
    return count + log.entries.filter((entry) => JSON.stringify(entry.payload).includes("turn.started")).length;
  }, 0);
}

describe("the interactive cli drives one daemon session", () => {
  it("CT1.5 two plain lines share one session and both replies return", async () => {
    const { host, cli } = await started();
    expect(await cli.line("one")).toBe("echo: one");
    expect(await cli.line("two")).toBe("echo: two");
    expect(host.daemon.snapshot().sessions).toHaveLength(1);
  });

  it("CT1.6 / and /help list the built-in commands and do not start a worker turn", async () => {
    const { host, cli } = await started();
    const slash = await cli.line("/");
    const help = await cli.line("/help");
    for (const text of [slash, help]) {
      expect(text).toMatch(/sessions/);
      expect(text).toMatch(/settings/);
      expect(text).toMatch(/tools/);
      expect(text).toMatch(/autopilot/);
      expect(text).not.toMatch(/rubber/);
    }
    expect(await cli.line("/autopilot apply --help")).toMatch(/does not change the trunk/);
    expect(turns(host)).toBe(0);
    expect(JSON.stringify(host.daemon.snapshot())).not.toContain("/help");
  });

  it("CT1.7 an unknown slash command is reported and adds no worker turn", async () => {
    const { host, cli } = await started();
    expect(await cli.line("/rubber")).toMatch(/unknown command \/rubber/);
    expect(turns(host)).toBe(0);
  });

  it("CT1.8 typeahead on a /se prefix offers sessions and settings", async () => {
    const { cli } = await started();
    const offered = await cli.complete("/se");
    expect(offered.some((text) => text.includes("sessions"))).toBe(true);
    expect(offered.some((text) => text.includes("settings"))).toBe(true);
  });

  it("CT1.9 a permission request waits for the next line and allow echoes the prompt", async () => {
    const { cli } = await started();
    const armed = cli.armPermission();
    let settled = false;
    const pending = cli.line("hello !permission").then((text) => {
      settled = true;
      return text;
    });
    expect(await armed).toMatch(/allow/i);
    expect(settled).toBe(false);
    expect(await cli.line("allow")).toBe("echo: hello !permission");
    expect(await pending).toBe("echo: hello !permission");
  });

  it("CT1.10 a deny choice answers the waiting permission and is not a new prompt", async () => {
    const { host, cli } = await started();
    const armed = cli.armPermission();
    const pending = cli.line("hello !permission");
    expect(await armed).toMatch(/deny/i);
    expect(await cli.line("deny")).toBe("permission denied");
    expect(await pending).toBe("permission denied");
    expect(turns(host)).toBe(1);
  });

  it("CT1.11 /sessions lists the live daemon session", async () => {
    const { host, cli } = await started();
    const id = host.daemon.snapshot().sessions[0]!.id;
    expect(await cli.line("/sessions")).toContain(id);
    expect(turns(host)).toBe(0);
  });

  it("CT5.2 /sessions names each thread's response state while a turn is open", async () => {
    const { cli } = await started();
    expect(await cli.line("/sessions")).toMatch(/daemon ses_\S+ idle/);
    const pending = cli.line("hello !permission");
    expect(await cli.armPermission()).toMatch(/allow/i);
    expect(await cli.line("/sessions")).toMatch(/daemon ses_\S+ permission/);
    expect(await cli.line("allow")).toBe("echo: hello !permission");
    expect(await pending).toBe("echo: hello !permission");
    expect(await cli.line("/sessions")).toMatch(/daemon ses_\S+ idle/);
  });

  it("CT1.12 a failed model call is the reply, not a blank line", async () => {
    const worker: Worker = {
      async run(command, emit) {
        emit({
          type: "update",
          sessionId: command.sessionId,
          turnId: command.turnId,
          update: { sessionUpdate: "notice", severity: "error", title: "Model call failed", description: "OAuth access token refresh failed with status 401." },
        });
        emit({ type: "end", sessionId: command.sessionId, turnId: command.turnId, stopReason: "refusal" });
      },
      cancel() {},
      permission() {},
    };
    const host = await NodeHost.start({ worker, identity: { principal: "me", kind: "human" } });
    hosts.push(host);
    const cli = await openInteractive(stream(host));
    const text = await cli.line("what can you do?");
    expect(text).toContain("OAuth access token refresh failed");
    expect(text).not.toBe("");
    expect(cli.turnParts()).toEqual([{ error: true, text: "Model call failed: OAuth access token refresh failed with status 401." }]);
  });

  it("CT2.1 /ask is not a command and does not start a turn", async () => {
    const { host, cli } = await started();
    expect(await cli.line("/ask")).toMatch(/unknown command \/ask/);
    expect(await cli.line("/ask hi")).toMatch(/unknown command \/ask/);
    expect(await cli.line("/ask --help")).toMatch(/unknown command \/ask/);
    expect(await cli.complete("/")).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\/ask\b/)]));
    expect(turns(host)).toBe(0);
  });

  it("CT2.4 a bare help line is the chat guide and does not start a turn", async () => {
    const { host, cli } = await started();
    const help = await cli.line("help");
    expect(help).toBe(await cli.line("/help"));
    expect(help).not.toMatch(/\/ask/);
    expect(help).toMatch(/Type a message/);
    expect(help).toMatch(/sessions/);
    expect(turns(host)).toBe(0);
  });

  it("CT2.5 /tools help describes the tools command and does not start a turn", async () => {
    const { host, cli } = await started();
    const text = await cli.line("/tools help");
    const page = manualSections(text);
    expect(page["SYNOPSIS"]).toBe("/tools [name | kind:name] [argument]");
    expect(text).not.toMatch(/unknown tool/);
    expect(turns(host)).toBe(0);
  });

  it("CT5.1 --help on a slash command is a man page and does not run the command", async () => {
    const forecast = { kind: "tool" as const, name: "forecast", description: "Forecast for a city." };
    const host = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" } });
    hosts.push(host);
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-help-"));
    const file = join(dir, "settings.json");
    const cli = await openInteractive(stream(host), {
      tools: [forecast],
      settingsFile: file,
      daemonSetting: { requested: "/tmp/kept.sock", accepted: "/tmp/kept.sock" },
    });
    const listed = await cli.line("/tools");
    expect(listed).toContain("forecast");
    expect(listed).toContain("Forecast for a city.");
    const tools = await cli.line("/tools --help");
    const toolsPage = manualSections(tools);
    expect(toolsPage["SYNOPSIS"]).toBe("/tools [name | kind:name] [argument]");
    expect(toolsPage["DESCRIPTION"]).toContain("forecast");
    expect(toolsPage["DESCRIPTION"]).toContain("Forecast for a city.");
    expect(toolsPage["OPTIONS"]).toContain("--help");
    expect(toolsPage["OPTIONS"]).toMatch(/does not run/);
    const one = await cli.line("/tools forecast --help");
    const onePage = manualSections(one);
    expect(onePage["DESCRIPTION"]).toContain("Forecast for a city.");
    expect(onePage["DESCRIPTION"]).not.toContain("mcp ");
    expect(one).not.toBe("tool forecast");
    const qualified = await cli.line("/tools tool:forecast say hi --help");
    expect(qualified).not.toBe("tool forecast say hi");
    expect(manualSections(qualified)["DESCRIPTION"]).toContain("Forecast for a city.");
    expect(await cli.line("/tools missing --help")).toBe("unknown tool missing");
    const before = cli.sessionId();
    const sessionsBefore = host.daemon.snapshot().sessions.length;
    expect(manualSections(await cli.line("/sessions new --help"))["SYNOPSIS"]).toBe("/sessions new");
    expect(await cli.line("/sessions new extra")).toBe("usage: /sessions new");
    expect(await cli.line("/new")).toBe("unknown command /new");
    expect(await cli.line("/new --help")).toBe("unknown command /new");
    expect(await cli.complete("/")).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\/new\b/)]));
    expect(await cli.complete("/sessions ")).toEqual(expect.arrayContaining(["/sessions new"]));
    expect(cli.sessionId()).toBe(before);
    expect(host.daemon.snapshot().sessions).toHaveLength(sessionsBefore);
    for (const line of ["/sessions --help", "/sessions export --help", "/sessions resume --help", "/autopilot --help", "/autopilot updates --help", "/autopilot apply --help", "/autopilot stop --help", "/settings --help"]) {
      const page = manualSections(await cli.line(line));
      expect(page["NAME"]?.length ?? 0).toBeGreaterThan(0);
      expect(page["SEE ALSO"]?.length ?? 0).toBeGreaterThan(0);
    }
    expect(cli.sessionId()).toBe(before);
    expect(await cli.line("/autopilot updates")).toBe("");
    expect(await cli.line("/settings daemon /tmp/kept.sock")).toBe("daemon=/tmp/kept.sock");
    const setting = await cli.line("/settings daemon --help");
    const settingPage = manualSections(setting);
    expect(settingPage["NAME"]?.length ?? 0).toBeGreaterThan(0);
    expect(settingPage["SEE ALSO"]?.length ?? 0).toBeGreaterThan(0);
    expect(await cli.line("/settings daemon")).toBe("daemon=/tmp/kept.sock");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ daemon: { requested: "/tmp/kept.sock", accepted: "/tmp/kept.sock" } });
    expect(await cli.line("/nope --help")).toBe("unknown command /nope");
    const guide = await cli.line("/help");
    expect(guide).toMatch(/Type a message/);
    expect(guide).toMatch(/sessions/);
    expect(guide).not.toContain("/new");
    expect(turns(host)).toBe(0);
    const bare = await started();
    const empty = manualSections(await bare.cli.line("/tools --help"));
    expect(empty["DESCRIPTION"]).not.toMatch(/(?:tool|skill|mcp) \S+:/);
    expect(empty["DESCRIPTION"]).not.toContain("forecast");
  });

  it("CT5.3 /help is the man page of the harness commands and hooks", async () => {
    const { host, cli } = await started();
    const help = await cli.line("/help");
    const page = manualSections(help);
    expect(page["SYNOPSIS"]).toBe("/help");
    expect(page["OPTIONS"]).toMatch(/does not run/);
    expect(page["DESCRIPTION"]).toMatch(/Type a message/);
    for (const synopsis of [
      "/tools [name | kind:name] [argument]",
      "/sessions [new | export | resume | fork | btw | bg | switch]",
      "/sessions new",
      "/sessions export [session] [--clipboard | --file <filename>]",
      "/sessions resume <harness> [session]",
      "/sessions fork [--thread <id>] [--message <id>]",
      "/sessions btw <question>",
      "/sessions bg",
      "/sessions switch <session>",
      "/settings [key] [value | --unset]",
      "/autopilot [instructions]",
      "/autopilot updates",
      "/autopilot apply <id>",
      "/autopilot stop",
    ]) expect(page["DESCRIPTION"]).toContain(synopsis);
    for (const hook of [
      "behavior.changed",
      "behavior.raised",
      "session.created",
      "session.attached",
      "session.detached",
      "turn.started",
      "turn.ended",
      "permission.requested",
      "permission.resolved",
      "capability.added",
      "capability.revoked",
      "input.received",
      "intent.decide",
      "intent.infer",
      "intent.unresolved",
      "action.ready",
      "branch.intention",
      "branch.result",
      "branch.failure",
      "branch.correction",
      "dialogue.script.built",
      "dialogue.script.put",
      "dialogue.script.promoted",
      "dialogue.script.retired",
      "dialogue.document.put",
      "procedural.approval.requested",
      "procedural.approval.decided",
      "procedural.plan.completed",
    ]) expect(page["DESCRIPTION"]).toContain(hook);
    expect(help).not.toContain("/new");
    expect(help).not.toMatch(/\/ask/);
    expect(help).not.toMatch(/rubber/);
    expect(await cli.line("/")).toBe(help);
    expect(await cli.line("help")).toBe(help);
    expect(await cli.line("/help --help")).toBe(help);
    expect(await cli.line("/help extra")).toBe("usage: /help");
    expect(turns(host)).toBe(0);
    expect(JSON.stringify(host.daemon.snapshot())).not.toContain("/help");
  });

  it("CT3.7 /settings daemon stores the socket the next start reads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-set-"));
    const file = join(dir, "settings.json");
    const host = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" } });
    hosts.push(host);
    const cli = await openInteractive(stream(host), { settingsFile: file, daemonSetting: { requested: "/tmp/old.sock", accepted: "/tmp/old.sock" } });
    expect(await cli.line("/settings daemon")).toBe("daemon=/tmp/old.sock");
    expect(await cli.line("/settings daemon /tmp/new.sock")).toBe("daemon=/tmp/new.sock");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ daemon: { requested: "/tmp/new.sock", accepted: "/tmp/new.sock" } });
    expect(await cli.line("/settings daemon --unset")).toBe("daemon=");
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("daemon");
    const requested = await openInteractive(stream(host), { settingsFile: join(dir, "requested.json"), daemonSetting: { requested: "/tmp/refused.sock" } });
    expect(await requested.line("/settings daemon")).toBe("daemon=");
  });

  it("CT6.1 /sessions btw answers from the main thread, including a later update, and stays off that transcript", async () => {
    const { host, cli } = await started();
    const main = cli.sessionId();
    const sessionsBefore = host.daemon.snapshot().sessions.length;
    expect(manualSections(await cli.line("/sessions btw --help"))["SYNOPSIS"]).toBe("/sessions btw <question>");
    expect(await cli.line("/sessions btw")).toBe("usage: /sessions btw <question>");
    expect(await cli.line("/sessions btw --nope")).toBe("usage: /sessions btw <question>");
    expect(await cli.line("/btw what now")).toBe("unknown command /btw");
    expect(await cli.line("/session btw what now")).toBe("unknown command /session");
    expect(cli.sessionId()).toBe(main);
    expect(host.daemon.snapshot().sessions).toHaveLength(sessionsBefore);
    expect(await cli.line("alpha-fact")).toBe("echo: alpha-fact");
    const first = await cli.line("/sessions btw what is on the main thread?");
    expect(first).toContain("alpha-fact");
    expect(first).not.toContain("beta-fact");
    expect(cli.sessionId()).toBe(main);
    expect(await cli.line("beta-fact")).toBe("echo: beta-fact");
    const second = await cli.line("/sessions btw what changed?");
    expect(second).toContain("alpha-fact");
    expect(second).toContain("beta-fact");
    expect(cli.sessionId()).toBe(main);
    const mainLog = JSON.stringify(host.daemon.snapshot().sessions.find((session) => session.id === main));
    expect(mainLog).not.toContain("what is on the main thread?");
    expect(mainLog).not.toContain("what changed?");
    expect(mainLog).not.toContain("cancelled");
    expect(host.daemon.snapshot().sessions).toHaveLength(sessionsBefore + 1);
  });

  it("CT6.2 /sessions bg answers the next line before the background turn finishes, then merges that result", async () => {
    let released = false;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = () => {
        if (released) return;
        released = true;
        resolve();
      };
    });
    let holds = 0;
    const host = await NodeHost.start({
      worker: new EchoWorker({
        pause: () => {
          holds += 1;
          return holds === 1 ? gate : Promise.resolve();
        },
      }),
      identity: { principal: "me", kind: "human" },
    });
    hosts.push(host);
    try {
      const cli = await openInteractive(stream(host));
      const original = cli.sessionId();
      expect(await cli.line("/sessions bg extra")).toBe("usage: /sessions bg");
      expect(await cli.line("/bg")).toBe("unknown command /bg");
      expect(await cli.line("/session bg")).toBe("unknown command /session");
      expect(cli.sessionId()).toBe(original);
      expect(host.daemon.snapshot().sessions).toHaveLength(1);
      let finished = false;
      const pending = cli.line("slow-work").then((text) => {
        finished = true;
        return text;
      });
      for (let attempt = 0; attempt < 200 && holds === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(holds).toBe(1);
      expect(finished).toBe(false);
      expect(await cli.line("/sessions bg")).toContain(original);
      const next = cli.sessionId();
      expect(next).not.toBe(original);
      const quick = await cli.line("fast-work");
      expect(finished).toBe(false);
      expect(quick).toBe("echo: fast-work");
      const midway = await cli.line(`/sessions switch ${next}`);
      expect(midway).toContain(next);
      expect(midway).toContain("fast-work");
      expect(midway).not.toContain("echo: slow-work");
      releaseGate();
      expect(await pending).toBe("echo: slow-work");
      const viewed = await cli.line(`/sessions switch ${next}`);
      expect(viewed).toContain("echo: slow-work");
      expect(viewed).toContain("echo: fast-work");
      expect(cli.sessionId()).toBe(next);
      expect(host.daemon.snapshot().sessions.map((session) => session.id)).toEqual(expect.arrayContaining([original, next]));
    } finally {
      releaseGate();
    }
  });

  it("CT6.3 /sessions switch shows the chosen session and an unknown id leaves that inspection in place", async () => {
    const { host, cli } = await started();
    const first = cli.sessionId();
    expect(await cli.line("from-first")).toBe("echo: from-first");
    const made = await cli.line("/sessions new");
    const second = made.slice("session ".length);
    expect(await cli.line("from-second")).toBe("echo: from-second");
    expect(await cli.line("/sessions switch")).toBe("usage: /sessions switch <session>");
    expect(await cli.line(`/sessions switch ${first} extra`)).toBe("usage: /sessions switch <session>");
    expect(await cli.line("/switch")).toBe("unknown command /switch");
    expect(await cli.line("/session switch")).toBe("unknown command /session");
    expect(cli.sessionId()).toBe(second);
    const seeFirst = await cli.line(`/sessions switch ${first}`);
    expect(seeFirst).toContain(first);
    expect(seeFirst).toContain("from-first");
    expect(seeFirst).not.toContain("from-second");
    expect(cli.sessionId()).toBe(second);
    const seeSecond = await cli.line(`/sessions switch ${second}`);
    expect(seeSecond).toContain(second);
    expect(seeSecond).toContain("from-second");
    const unknown = await cli.line("/sessions switch ses_NOT_A_SESSION");
    expect(unknown).toContain("no session ses_NOT_A_SESSION");
    expect(unknown).toContain(second);
    expect(unknown).toContain("from-second");
    expect(cli.sessionId()).toBe(second);
    expect(await cli.line("still-main")).toBe("echo: still-main");
    expect(cli.sessionId()).toBe(second);
    const stillFirst = await cli.line(`/sessions switch ${first}`);
    expect(stillFirst).toContain("from-first");
    expect(stillFirst).not.toContain("still-main");
    const ids = host.daemon.snapshot().sessions.map((session) => session.id);
    expect(ids).toContain(first);
    expect(ids).toContain(second);
    expect(manualSections(await cli.line("/sessions switch --help"))["SYNOPSIS"]).toBe("/sessions switch <session>");
    expect(cli.sessionId()).toBe(second);
    expect(host.daemon.snapshot().sessions.map((session) => session.id)).toEqual(expect.arrayContaining([first, second]));
  });

  it("CT6.4 /sessions fork copies the conversation through the chosen point and leaves the original", async () => {
    const { host, cli } = await started();
    const original = cli.sessionId();
    const count = () => host.daemon.snapshot().sessions.length;
    const before = count();
    const listed = await cli.line("/sessions");
    expect(listed).toContain(original);
    expect(listed).toContain("daemon");
    expect(count()).toBe(before);
    expect(await cli.line("/session")).toBe("unknown command /session");
    expect(await cli.line("/btw")).toBe("unknown command /btw");
    expect(await cli.line("/bg")).toBe("unknown command /bg");
    expect(await cli.line("/switch")).toBe("unknown command /switch");
    expect(await cli.line("/fork")).toBe("unknown command /fork");
    expect(count()).toBe(before);
    const sessionsHelp = await cli.line("/sessions --help");
    expect(manualSections(sessionsHelp)["SYNOPSIS"]).toBe("/sessions [new | export | resume | fork | btw | bg | switch]");
    expect(sessionsHelp).not.toContain(original);
    const forkHelp = await cli.line("/sessions fork --help");
    expect(manualSections(forkHelp)["SYNOPSIS"]).toBe("/sessions fork [--thread <id>] [--message <id>]");
    expect(count()).toBe(before);
    expect(await cli.line("alpha-line")).toBe("echo: alpha-line");
    expect(await cli.line("beta-line")).toBe("echo: beta-line");
    expect(await cli.line("gamma-line")).toBe("echo: gamma-line");
    const viewed = await cli.line(`/sessions switch ${original}`);
    const userMessage = (report: string, text: string): string => {
      const line = report.split("\n").find((row) => row.startsWith("user ") && row.endsWith(`: ${text}`));
      const id = line?.slice("user ".length).split(":")[0]?.trim();
      if (id === undefined || id.length === 0) throw new Error(`no user message for ${text} in ${report}`);
      return id;
    };
    const opened = (reply: string): string => {
      expect(reply.startsWith("session ")).toBe(true);
      return reply.slice("session ".length);
    };
    const alphaId = userMessage(viewed, "alpha-line");
    const betaId = userMessage(viewed, "beta-line");
    const endId = opened(await cli.line("/sessions fork"));
    expect(endId).not.toBe(original);
    expect(cli.sessionId()).toBe(endId);
    expect(count()).toBe(before + 1);
    const endView = await cli.line(`/sessions switch ${endId}`);
    expect(endView).toContain("alpha-line");
    expect(endView).toContain("beta-line");
    expect(endView).toContain("gamma-line");
    expect(await cli.line("later-only")).toBe("echo: later-only");
    expect(await cli.line(`/sessions switch ${endId}`)).toContain("later-only");
    const originalAfter = await cli.line(`/sessions switch ${original}`);
    expect(originalAfter).toContain("gamma-line");
    expect(originalAfter).not.toContain("later-only");
    const threadId = opened(await cli.line(`/sessions fork --thread ${original}`));
    const threadView = await cli.line(`/sessions switch ${threadId}`);
    expect(threadView).toContain("alpha-line");
    expect(threadView).toContain("gamma-line");
    expect(threadView).not.toContain("later-only");
    expect(await cli.line(`/sessions switch ${original}`)).not.toContain("later-only");
    const messageId = opened(await cli.line(`/sessions fork --message ${betaId}`));
    const messageView = await cli.line(`/sessions switch ${messageId}`);
    expect(messageView).toContain("alpha-line");
    expect(messageView).toContain("beta-line");
    expect(messageView).not.toContain("gamma-line");
    expect(messageView).not.toContain("echo: beta-line");
    expect(messageView).not.toContain("later-only");
    expect(await cli.line(`/sessions switch ${original}`)).toContain("gamma-line");
    const bothId = opened(await cli.line(`/sessions fork --thread ${original} --message ${alphaId}`));
    const bothView = await cli.line(`/sessions switch ${bothId}`);
    expect(bothView).toContain("alpha-line");
    expect(bothView).not.toContain("beta-line");
    expect(bothView).not.toContain("echo: alpha-line");
    const reversedId = opened(await cli.line(`/sessions fork --message ${alphaId} --thread ${original}`));
    const reversedView = await cli.line(`/sessions switch ${reversedId}`);
    expect(reversedView).toContain("alpha-line");
    expect(reversedView).not.toContain("beta-line");
    const held = count();
    expect(await cli.line("/sessions fork --thread ses_NOT_A_THREAD")).toContain("no session ses_NOT_A_THREAD");
    expect(await cli.line("/sessions fork --message m_NOT_A_MESSAGE")).toContain("no message m_NOT_A_MESSAGE");
    expect(await cli.line(`/sessions fork --thread ${betaId}`)).toContain(`no session ${betaId}`);
    expect(await cli.line(`/sessions fork --message ${original}`)).toContain(`no message ${original}`);
    expect(await cli.line(`/sessions fork ${original}`)).toBe("usage: /sessions fork [--thread <id>] [--message <id>]");
    expect(await cli.line("/sessions fork --thread")).toBe("usage: /sessions fork [--thread <id>] [--message <id>]");
    expect(await cli.line("/sessions fork --nope")).toBe("usage: /sessions fork [--thread <id>] [--message <id>]");
    expect(count()).toBe(held);
    const made = opened(await cli.line("/sessions new"));
    expect(await cli.line("other-thread-line")).toBe("echo: other-thread-line");
    const otherId = userMessage(await cli.line(`/sessions switch ${made}`), "other-thread-line");
    const mismatched = count();
    const rejected = await cli.line(`/sessions fork --thread ${original} --message ${otherId}`);
    expect(rejected).toContain(`no message ${otherId}`);
    expect(rejected).toContain(original);
    expect(count()).toBe(mismatched);
    expect(await cli.line(`/sessions switch ${original}`)).not.toContain("other-thread-line");
    const onlyMessage = opened(await cli.line(`/sessions fork --message ${otherId}`));
    const onlyView = await cli.line(`/sessions switch ${onlyMessage}`);
    expect(onlyView).toContain("other-thread-line");
    expect(onlyView).not.toContain("gamma-line");
    const again = count();
    const roster = await cli.line("/sessions");
    expect(roster).toContain(original);
    expect(roster).toContain(endId);
    expect(roster).toContain(made);
    expect(count()).toBe(again);
    expect(await cli.line(`/sessions switch ${original}`)).toContain("gamma-line");
  });

  it("TU2.1 a streamed thought collapses in the session frame and the answer stays whole", async () => {
    const token = "trace-9k2";
    const piece = "y".repeat(20);
    const bulky = `${token}\n${piece.repeat(20)}`;
    const worker: Worker = {
      async run(command, emit) {
        const base = { sessionId: command.sessionId, turnId: command.turnId };
        const thought = (text: string) => {
          emit({
            type: "update",
            ...base,
            update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } },
          });
        };
        thought(`${token}\n`);
        for (let delta = 0; delta < 20; delta += 1) thought(piece);
        emit({
          type: "update",
          ...base,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "settled-answer-4m" } },
        });
        emit({ type: "end", ...base, stopReason: "end_turn" });
      },
      cancel() {
        return undefined;
      },
      permission() {
        return undefined;
      },
    };
    const host = await NodeHost.start({ worker, identity: { principal: "me", kind: "human" } });
    hosts.push(host);
    const cli = await openInteractive(stream(host));
    const frame = openSessionFrame({ tty: true, color: true });
    let screen = "";
    const take = (): void => {
      screen += frame.draw();
    };
    cli.watch((state) => {
      frame.activity(state);
      take();
    });
    cli.follow((event) => {
      if (event.kind === "thought") frame.intermediate(event.text);
      else if (event.kind === "error") frame.fail(event.text);
      else frame.chunk(event.text);
      take();
    });
    expect(await cli.line("look")).toBe("settled-answer-4m");
    frame.settle();
    take();
    const picture = frame.frame();
    const shown = renderScreen(screen);
    expect(picture.length).toBeLessThan(bulky.length);
    expect(picture).toContain("trace-9k2");
    expect(picture).toContain("settled-answer-4m");
    expect(picture).not.toContain("y".repeat(80));
    expect(shown.length).toBeLessThan(bulky.length);
    expect(shown).toContain("trace-9k2");
    expect(shown).toContain("settled-answer-4m");
    expect(shown).not.toContain("y".repeat(40));
    expect(shown).not.toContain("✶");
    expect(shown.split(token)).toHaveLength(2);
    const rows = picture.split("\n");
    if (rows.at(-1) === "> ") rows.pop();
    expect(shown).toBe(rows.join("\n"));
  });

  it("TU3.3 a TTY uses the alternate screen and mouse reporting, a typed line still replies, and the first interrupt does not clear", async () => {
    const { cli } = await started();
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    const frame = openSessionFrame({ tty: true, color: true, ...{ rows: 3 } });
    const settle = (line: string): void => {
      frame.activity("responding");
      frame.chunk(line);
      frame.activity("idle");
      frame.settle();
    };
    for (let index = 0; index < 6; index += 1) settle(`line-${index}`);
    let armed = 0;
    let exited = false;
    const session = openSessionConsole({
      input,
      output,
      tty: true,
      color: true,
      frame,
      onArm() {
        armed += 1;
      },
      onExit() {
        exited = true;
      },
    });
    expect(text).toContain("\x1b[?1049h");
    expect(text.indexOf("\x1b[?1049h")).toBeLessThan(text.indexOf("\x1b[?1000h"));
    expect(text).toContain("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    expect(text).not.toContain("\x1b[?1003h");
    expect(text).not.toContain("\x1b[?1007h");
    expect(text).not.toContain("\x1b[3J");

    input.write("partial\x1b[<64;1;1M\n");
    expect(await session.next()).toBe("partial");
    expect(await cli.line("partial")).toBe("echo: partial");
    expect(frame.frame().startsWith("line-2\nline-3\nline-4\n")).toBe(true);

    input.write("hello");
    input.write("\x1b[<0;4;4M\x1b[<0;4;4m");
    expect(frame.caret()).toBe(1);
    input.write("\n");
    expect(await session.next()).toBe("hello");
    expect(await cli.line("hello")).toBe("echo: hello");

    input.write("\u0003");
    expect(armed).toBe(1);
    expect(exited).toBe(false);
    expect(text).toContain("Press Ctrl+C again to exit.");
    expect(text).not.toContain("Session context cleared.");
    input.write("still\n");
    expect(await session.next()).toBe("still");
    expect(await cli.line("still")).toBe("echo: still");

    session.close();
    expect(text).toContain("\x1b[?1000l\x1b[?1002l\x1b[?1006l");
    expect(text.indexOf("\x1b[?1000l")).toBeLessThan(text.indexOf("\x1b[?1049l"));
    expect(text).not.toContain("\x1b[3J");
    expect(text).not.toContain("\x1b[H\x1b[J");

    const quietIn = new PassThrough();
    const quietOut = new PassThrough();
    let quiet = "";
    quietOut.setEncoding("utf8");
    quietOut.on("data", (chunk: string) => {
      quiet += chunk;
    });
    const piped = openSessionConsole({
      input: quietIn,
      output: quietOut,
      tty: false,
      color: false,
      frame: openSessionFrame({ tty: false, color: false }),
      onArm() {
        return undefined;
      },
      onExit() {
        return undefined;
      },
    });
    quietIn.write("piped\n");
    expect(await piped.next()).toBe("piped");
    piped.close();
    expect(quiet).not.toContain("?1000h");
    expect(quiet).not.toContain("?1006h");
    expect(quiet).not.toContain("?1000l");
    expect(quiet).not.toContain("?1049h");
    expect(quiet).not.toContain("?1049l");
    expect(quiet).not.toContain("\x1b[6n");
  });

  it("TU3.6 a click uses the cursor row reported for the session view", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    const frame = openSessionFrame({ tty: true, color: true, ...{ rows: 3 } });
    const settle = (line: string): void => {
      frame.activity("responding");
      frame.chunk(line);
      frame.activity("idle");
      frame.settle();
    };
    output.write(paint("harness cli connected\n", "hint", true));
    output.write(paint("Type a message. /help lists commands.\n", "hint", true));
    const session = openSessionConsole({
      input,
      output,
      tty: true,
      color: true,
      frame,
      onArm() {
        return undefined;
      },
      onExit() {
        return undefined;
      },
    });
    expect(text).toContain("\x1b[6n");
    session.show();
    input.write("\x1b[3;1R");
    settle("plain-row");
    settle("second-row");
    session.paint();
    session.show();
    const rows = renderScreen(text).split("\n");
    const plain = rows.findIndex((row) => row === "plain-row");
    expect(plain).toBeGreaterThanOrEqual(0);
    input.write(`\x1b[<0;1;${plain + 1}M\x1b[<0;1;${plain + 1}m`);
    expect(frame.selection()).toBe("plain-row");
    expect(frame.caret()).toBeUndefined();
    input.write("hello");
    const after = renderScreen(text).split("\n");
    const prompt = lastRow(after, (row) => row.startsWith(">"));
    expect(after[prompt]).toBe("> hello");
    input.write(`\x1b[<0;4;${prompt + 1}M\x1b[<0;4;${prompt + 1}m`);
    expect(frame.caret()).toBe(1);
    expect(frame.frame().endsWith("> hello")).toBe(true);
    session.close();
  });

  it("TU3.7 a wheel leaves the next typed character on the prompt", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    const frame = openSessionFrame({ tty: true, color: true, ...{ rows: 3 } });
    const settle = (line: string): void => {
      frame.activity("responding");
      frame.chunk(line);
      frame.activity("idle");
      frame.settle();
    };
    for (let index = 0; index < 6; index += 1) settle(`line-${index}`);
    const session = openSessionConsole({
      input,
      output,
      tty: true,
      color: true,
      frame,
      onArm() {
        return undefined;
      },
      onExit() {
        return undefined;
      },
    });
    input.write("\x1b[2;1R");
    input.write("\x1b[<64;1;1M");
    input.write("Z");
    const shown = renderScreen(text);
    expect(shown).toContain("> Z");
    expect(shown).not.toMatch(/line-\dZ/);
    expect(shown).not.toContain("line-5Z");
    session.close();
  });

  it("TU3.8 a click after a submitted line hits the drawn answer and the prompt", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    output.write(paint("harness cli connected\n", "hint", true));
    output.write(paint("Type a message. /help lists commands.\n", "hint", true));
    const frame = openSessionFrame({ tty: true, color: true, rows: 8 });
    const session = openSessionConsole({
      input,
      output,
      tty: true,
      color: true,
      frame,
      onArm() {
        return undefined;
      },
      onExit() {
        return undefined;
      },
    });
    session.show();
    input.write("\x1b[3;1R");
    input.write("hi\n");
    expect(await session.next()).toBe("hi");
    session.show();
    frame.activity("responding");
    frame.chunk("answer-row");
    frame.activity("idle");
    frame.settle();
    session.paint();
    session.show();
    const rows = renderScreen(text).split("\n");
    const answer = rows.findIndex((row) => row === "answer-row");
    const prompt = rows.findIndex((row) => row === ">");
    expect(answer).toBe(3);
    expect(prompt).toBe(4);
    input.write(`\x1b[<0;1;${answer + 1}M\x1b[<0;1;${answer + 1}m`);
    expect(frame.selection()).toBe("answer-row");
    expect(frame.caret()).toBeUndefined();
    input.write(`\x1b[<0;1;${prompt + 1}M\x1b[<0;1;${prompt + 1}m`);
    expect(frame.caret()).toBe(0);
    expect(frame.selection()).toBe("");
    session.close();
  });

  it("TU3.9 a click after the terminal scrolls hits the answer on its new row", async () => {
    const height = 4;
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    output.write(paint("harness cli connected\n", "hint", true));
    output.write(paint("Type a message. /help lists commands.\n", "hint", true));
    const frame = openSessionFrame({ tty: true, color: true, rows: height - 1 });
    const session = openSessionConsole({
      input,
      output,
      tty: true,
      color: true,
      frame,
      height,
      onArm() {
        return undefined;
      },
      onExit() {
        return undefined;
      },
    });
    session.show();
    input.write("\x1b[3;1R");
    input.write("hi\n");
    expect(await session.next()).toBe("hi");
    session.show();
    const writeAnswer = (line: string): void => {
      frame.activity("responding");
      frame.chunk(line);
      frame.activity("idle");
      frame.settle();
      session.paint();
      session.show();
    };
    writeAnswer("answer-row");
    writeAnswer("later-row");
    const rows = renderScreen(text, height).split("\n");
    const answer = rows.findIndex((row) => row === "answer-row");
    const prompt = rows.findIndex((row) => row === ">");
    expect(answer).toBeGreaterThanOrEqual(0);
    expect(answer + 1).not.toBe(3);
    expect(prompt).toBe(rows.length - 1);
    input.write(`\x1b[<0;1;${answer + 1}M\x1b[<0;1;${answer + 1}m`);
    expect(frame.selection()).toBe("answer-row");
    expect(frame.caret()).toBeUndefined();
    input.write(`\x1b[<0;1;${prompt + 1}M\x1b[<0;1;${prompt + 1}m`);
    expect(frame.caret()).toBe(0);
    expect(frame.selection()).toBe("");
    session.close();
  });

  it("TU3.10 a click on a drawn URL selects that URL", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    output.write(paint("harness cli connected\n", "hint", true));
    output.write(paint("Type a message. /help lists commands.\n", "hint", true));
    const frame = openSessionFrame({ tty: true, color: true, rows: 8 });
    const session = openSessionConsole({
      input,
      output,
      tty: true,
      color: true,
      frame,
      onArm() {
        return undefined;
      },
      onExit() {
        return undefined;
      },
    });
    session.show();
    input.write("\x1b[3;1R");
    input.write("hi\n");
    expect(await session.next()).toBe("hi");
    session.show();
    frame.activity("responding");
    frame.chunk("see https://example.com/docs now");
    frame.activity("idle");
    frame.settle();
    session.paint();
    session.show();
    const rows = renderScreen(text).split("\n");
    const answer = rows.findIndex((row) => row.includes("https://example.com/docs"));
    const line = rows[answer] ?? "";
    const start = line.indexOf("https://example.com/docs");
    expect(answer).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(0);
    input.write(`\x1b[<0;${start + 1};${answer + 1}M\x1b[<0;${start + 1};${answer + 1}m`);
    expect(frame.selection()).toBe("https://example.com/docs");
    expect(frame.selection()).not.toBe(line);
    expect(frame.caret()).toBeUndefined();
    expect(text).toMatch(/\x1b\[7m(?:\x1b\[[0-9;]*m)*https:\/\/example\.com\/docs\x1b\[27m/);
    session.close();
  });

  it("TU3.11 a click after the exit hint and a permission line still hits the answer", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    output.write(paint("harness cli connected\n", "hint", true));
    output.write(paint("Type a message. /help lists commands.\n", "hint", true));
    const frame = openSessionFrame({ tty: true, color: true, rows: 8 });
    const session = openSessionConsole({
      input,
      output,
      tty: true,
      color: true,
      frame,
      onArm() {
        return undefined;
      },
      onExit() {
        return undefined;
      },
    });
    session.show();
    input.write("\x1b[3;1R");
    input.write("hi\n");
    expect(await session.next()).toBe("hi");
    session.show();
    frame.activity("responding");
    frame.chunk("answer-row");
    frame.activity("idle");
    frame.settle();
    session.paint();
    session.interrupt();
    output.write(paint("allow this tool?\n", "warning", true));
    session.show();
    const rows = renderScreen(text).split("\n");
    const answer = rows.findIndex((row) => row === "answer-row");
    const permission = rows.findIndex((row) => row.includes("allow this tool?"));
    const prompt = lastRow(rows, (row) => row === ">");
    expect(answer).toBeGreaterThanOrEqual(0);
    expect(permission).toBeGreaterThan(answer);
    expect(prompt).toBe(rows.length - 1);
    const click = (y: number): void => {
      input.write(`\x1b[<0;1;${y}M\x1b[<0;1;${y}m`);
    };
    click(permission + 1);
    expect(frame.selection()).toBe("");
    expect(frame.caret()).toBeUndefined();
    click(answer + 1);
    expect(frame.selection()).toBe("answer-row");
    expect(frame.caret()).toBeUndefined();
    click(prompt + 1);
    expect(frame.caret()).toBe(0);
    expect(frame.selection()).toBe("");
    session.close();
  });

  it("TU3.12 a click after the exit hint and a permission line still hits the answer once the screen scrolls", async () => {
    const height = 6;
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    output.write(paint("harness cli connected\n", "hint", true));
    output.write(paint("Type a message. /help lists commands.\n", "hint", true));
    const frame = openSessionFrame({ tty: true, color: true, rows: 8 });
    const session = openSessionConsole({
      input,
      output,
      tty: true,
      color: true,
      frame,
      height,
      onArm() {
        return undefined;
      },
      onExit() {
        return undefined;
      },
    });
    session.show();
    input.write("\x1b[3;1R");
    input.write("hi\n");
    expect(await session.next()).toBe("hi");
    session.show();
    frame.activity("responding");
    frame.chunk("answer-row");
    frame.activity("idle");
    frame.settle();
    session.paint();
    session.interrupt();
    output.write(paint("allow this tool?\n", "warning", true));
    session.show();
    const rows = renderScreen(text, height).split("\n");
    const answer = rows.findIndex((row) => row === "answer-row");
    const permission = rows.findIndex((row) => row.includes("allow this tool?"));
    const prompt = lastRow(rows, (row) => row === ">");
    expect(rows).not.toContain("harness cli connected");
    expect(answer).toBeGreaterThanOrEqual(0);
    expect(permission).toBeGreaterThan(answer);
    expect(prompt).toBe(rows.length - 1);
    const click = (y: number): void => {
      input.write(`\x1b[<0;1;${y}M\x1b[<0;1;${y}m`);
    };
    click(permission + 1);
    expect(frame.selection()).toBe("");
    expect(frame.caret()).toBeUndefined();
    click(answer + 1);
    expect(frame.selection()).toBe("answer-row");
    expect(frame.caret()).toBeUndefined();
    click(prompt + 1);
    expect(frame.caret()).toBe(0);
    expect(frame.selection()).toBe("");
    session.close();
  });

  it("TU3.13 a wheel after the exit hint repaints the picture and the old answer row selects its new text", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    output.write(paint("harness cli connected\n", "hint", true));
    output.write(paint("Type a message. /help lists commands.\n", "hint", true));
    const frame = openSessionFrame({ tty: true, color: true, rows: 3 });
    const session = openSessionConsole({
      input,
      output,
      tty: true,
      color: true,
      frame,
      onArm() {
        return undefined;
      },
      onExit() {
        return undefined;
      },
    });
    session.show();
    input.write("\x1b[3;1R");
    const turn = async (word: string, answer: string): Promise<void> => {
      input.write(`${word}\n`);
      expect(await session.next()).toBe(word);
      session.show();
      frame.activity("responding");
      frame.chunk(answer);
      frame.activity("idle");
      frame.settle();
      session.paint();
      session.show();
    };
    await turn("one", "ans-one");
    await turn("two", "ans-two");
    await turn("three", "ans-three");
    await turn("four", "ans-four");
    const click = (y: number): void => {
      input.write(`\x1b[<0;1;${y}M\x1b[<0;1;${y}m`);
    };
    let rows = renderScreen(text).split("\n");
    const tail = rows.findIndex((row) => row === "ans-four");
    expect(tail).toBeGreaterThanOrEqual(0);
    click(tail + 1);
    expect(frame.selection()).toBe("ans-four");
    session.interrupt();
    output.write(paint("allow this tool?\n", "warning", true));
    session.show();
    rows = renderScreen(text).split("\n");
    const windowAt = rows.findIndex((row, index) => row === "ans-three" && rows[index + 1] === "> four" && rows[index + 2] === "ans-four");
    const hint = rows.findIndex((row) => row === "Press Ctrl+C again to exit.");
    expect(windowAt).toBeGreaterThanOrEqual(0);
    expect(hint).toBeGreaterThan(windowAt + 2);
    const hintText = rows[hint];
    input.write("\x1b[<64;1;1M");
    expect(frame.frame().startsWith("> three\nans-three\n> four")).toBe(true);
    rows = renderScreen(text).split("\n");
    expect(rows.slice(windowAt, windowAt + 3)).toEqual(["> three", "ans-three", "> four"]);
    expect(rows[hint]).toBe(hintText);
    click(windowAt + 1);
    expect(frame.selection()).toBe("> three");
    session.close();
  });

  it("TU3.14 a wheel after the exit hint on a full screen keeps the hint and a single prompt", async () => {
    const height = 10;
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    output.write(paint("harness cli connected\n", "hint", true));
    output.write(paint("Type a message. /help lists commands.\n", "hint", true));
    const frame = openSessionFrame({ tty: true, color: true, rows: height - 1 });
    const session = openSessionConsole({
      input,
      output,
      tty: true,
      color: true,
      frame,
      height,
      onArm() {
        return undefined;
      },
      onExit() {
        return undefined;
      },
    });
    session.show();
    input.write("\x1b[3;1R");
    for (let index = 1; index <= 8; index += 1) {
      const word = `u${index}`;
      input.write(`${word}\n`);
      expect(await session.next()).toBe(word);
      session.show();
      frame.activity("responding");
      frame.chunk(`a${index}`);
      frame.activity("idle");
      frame.settle();
      session.paint();
      session.show();
    }
    session.interrupt();
    let rows = renderScreen(text, height).split("\n");
    const hint = rows.findIndex((row) => row === "Press Ctrl+C again to exit.");
    expect(hint).toBeGreaterThanOrEqual(0);
    expect(rows.filter((row) => row === ">" || row === "> >")).toEqual([">"]);
    const hintText = rows[hint];
    input.write("\x1b[<64;1;1M");
    expect(frame.frame().startsWith("> u4\n")).toBe(true);
    rows = renderScreen(text, height).split("\n");
    expect(rows[hint]).toBe(hintText);
    expect(rows[0]).not.toBe("> u4");
    expect(rows.filter((row) => row === ">" || row === "> >")).toEqual([">"]);
    const held = rows.slice(0, 9);
    frame.activity("responding");
    frame.chunk("later-answer");
    frame.activity("idle");
    frame.settle();
    session.paint();
    session.show();
    rows = renderScreen(text, height).split("\n");
    expect(rows.slice(0, 9)).toEqual(held);
    expect(rows.at(-1)).toBe(">");
    expect(rows).not.toContain("> >");
    session.close();
  });

  it("TU3.16 a short transcript pins the prompt to the last row", async () => {
    const height = 8;
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });
    output.write(paint("harness cli connected\n", "hint", true));
    output.write(paint("Type a message. /help lists commands.\n", "hint", true));
    const frame = openSessionFrame({ tty: true, color: true, rows: height - 1 });
    const session = openSessionConsole({
      input,
      output,
      tty: true,
      color: true,
      frame,
      height,
      onArm() {
        return undefined;
      },
      onExit() {
        return undefined;
      },
    });
    session.show();
    input.write("\x1b[3;1R");
    let rows = renderScreen(text, height).split("\n");
    expect(rows[0]).toBe("harness cli connected");
    expect(rows[1]).toBe("Type a message. /help lists commands.");
    expect(rows.findIndex((row) => row === ">")).toBe(height - 1);
    expect(rows.at(-1)).toBe(">");
    input.write("hi\n");
    expect(await session.next()).toBe("hi");
    session.show();
    frame.activity("thinking");
    session.paint();
    session.show();
    rows = renderScreen(text, height).split("\n");
    const spinning = rows.findIndex((row) => row.includes("thinking"));
    expect(spinning).toBeGreaterThanOrEqual(0);
    expect(spinning).toBeLessThan(height - 1);
    expect(rows.at(-1)).toBe(">");
    expect(rows[0]).toBe("harness cli connected");
    frame.activity("responding");
    frame.chunk("answer-row");
    frame.activity("idle");
    frame.settle();
    session.paint();
    session.show();
    rows = renderScreen(text, height).split("\n");
    const user = rows.findIndex((row) => row === "> hi");
    const answer = rows.findIndex((row) => row === "answer-row");
    const prompt = rows.findIndex((row) => row === ">");
    expect(rows[0]).toBe("harness cli connected");
    expect(user).toBeGreaterThanOrEqual(0);
    expect(user).toBeLessThan(answer);
    expect(answer).toBeGreaterThanOrEqual(0);
    expect(prompt).toBe(height - 1);
    expect(rows.at(-1)).toBe(">");
    expect(prompt - answer).toBeGreaterThan(1);
    expect(rows.slice(answer + 1, prompt).every((row) => row === "")).toBe(true);
    expect(rows.filter((row) => row === ">" || row === "> >")).toEqual([">"]);
    expect(rows.some((row) => row.includes("thinking"))).toBe(false);
    input.write(`\x1b[<0;1;${answer + 1}M\x1b[<0;1;${answer + 1}m`);
    expect(frame.selection()).toBe("answer-row");
    expect(frame.caret()).toBeUndefined();
    input.write(`\x1b[<0;1;${prompt + 1}M\x1b[<0;1;${prompt + 1}m`);
    expect(frame.caret()).toBe(0);
    expect(frame.selection()).toBe("");
    frame.activity("responding");
    frame.chunk("later-row");
    frame.activity("idle");
    frame.settle();
    session.paint();
    session.show();
    rows = renderScreen(text, height).split("\n");
    expect(rows[0]).toBe("harness cli connected");
    expect(rows.findIndex((row) => row === "answer-row")).toBe(answer);
    expect(rows.findIndex((row) => row === ">")).toBe(height - 1);
    expect(rows.at(-1)).toBe(">");
    expect(rows.filter((row) => row === ">" || row === "> >")).toEqual([">"]);
    const later = rows.findIndex((row) => row === "later-row");
    expect(later).toBeGreaterThan(answer);
    expect(later).toBeLessThan(height - 1);
    expect(rows.slice(later + 1, height - 1).every((row) => row === "")).toBe(true);
    input.write(`\x1b[<0;1;${later + 1}M\x1b[<0;1;${later + 1}m`);
    expect(frame.selection()).toBe("later-row");
    input.write("again\n");
    expect(await session.next()).toBe("again");
    session.show();
    frame.activity("responding");
    frame.chunk("third-row");
    frame.activity("idle");
    frame.settle();
    session.paint();
    session.show();
    rows = renderScreen(text, height).split("\n");
    expect(rows[0]).toBe("harness cli connected");
    expect(rows[1]).toBe("Type a message. /help lists commands.");
    expect(rows.findIndex((row) => row === "> again")).toBeGreaterThan(later);
    expect(rows.findIndex((row) => row === ">")).toBe(height - 1);
    expect(rows.filter((row) => row === ">" || row === "> >")).toEqual([">"]);
    session.close();
  });

  it("TU3.15 tab accepts a command prefix from the session prompt while inference throws", async () => {
    const engine = new InputInterpreter(
      { tools: [], commands: [] },
      {
        decide: () => { throw new Error("down"); },
        infer: () => { throw new Error("down"); },
        suggest: () => { throw new Error("down"); },
      },
    );
    const open = () => {
      const input = new PassThrough();
      const output = new PassThrough();
      let text = "";
      output.setEncoding("utf8");
      output.on("data", (chunk: string) => {
        text += chunk;
      });
      const session = openSessionConsole({
        input,
        output,
        tty: true,
        color: false,
        frame: openSessionFrame({ tty: true, color: false }),
        complete: async (prefix) => (await engine.complete(prefix, { turns: [] })).completions.map((item) => item.text),
        onArm() {
          return undefined;
        },
        onExit() {
          return undefined;
        },
      });
      return { input, session, text: () => text };
    };
    const offered = open();
    offered.input.write("/se");
    offered.input.write("\t");
    const offeredAt = Date.now();
    while (!offered.text().includes("/sessions") || !offered.text().includes("/settings")) {
      if (Date.now() - offeredAt > 1000) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(offered.text()).toContain("/sessions");
    expect(offered.text()).toContain("/settings");
    offered.session.close();
    const accept = async (): Promise<string> => {
      const prompt = open();
      prompt.input.write("/sessions n");
      prompt.input.write("\t");
      const completedAt = Date.now();
      while (!prompt.text().includes("/sessions new")) {
        if (Date.now() - completedAt > 1000) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      prompt.input.write("\n");
      const line = (await prompt.session.next()) ?? "";
      prompt.session.close();
      return line;
    };
    const first = await accept();
    const second = await accept();
    process.stdout.write(`typeahead accepted ${first}\n`);
    process.stdout.write(`typeahead accepted ${second}\n`);
    expect(first).toBe("/sessions new");
    expect(second).toBe(first);
  });
});

const weather = tool({
  description: "Weather for a city.",
  inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
  execute: async ({ city }) => ({ city, sky: "clear" }),
});

describe("the interactive cli drives a harness session", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  async function harnessChat() {
    const script = scriptedHarness((prompt) => {
      if (prompt === "weather?") return { text: "Lagos:", tool: { name: "weather", input: { city: "Lagos" } } };
      const current = script.log.turns.at(-1)!;
      const prior = script.log.turns.filter((turn) => turn.sessionId === current.sessionId).length - 1;
      return prior === 0 ? `harness:${prompt}` : `continued:${prompt}`;
    });
    const hosted = harnessWorker({
      harness: script,
      sandboxRoot: mkdtempSync(join(tmpdir(), "harness-cli-")),
      tools: { weather },
      toolApproval: { weather: "user-approval" },
    });
    const host = await NodeHost.start({ worker: hosted.worker, identity: { principal: "me", kind: "human" } });
    hosts.push(host);
    closers.push(() => hosted.close());
    return { host, harness: script, cli: await openInteractive(stream(host)) };
  }

  it("CT3.1 a typed line is the harness agent's reply", async () => {
    const { cli } = await harnessChat();
    expect(await cli.line("alpha")).toBe("harness:alpha");
  });

  it("CT3.2 a second line continues that same harness session", async () => {
    const { cli, harness } = await harnessChat();
    expect(await cli.line("alpha")).toBe("harness:alpha");
    expect(await cli.line("beta")).toBe("continued:beta");
    expect(harness.log.started).toHaveLength(1);
    expect(harness.log.turns.map((turn) => turn.sessionId)).toEqual([harness.log.started[0], harness.log.started[0]]);
  });

  it("CT3.3 listing sessions includes the live harness session", async () => {
    const { cli, harness } = await harnessChat();
    await cli.line("alpha");
    const id = harness.log.started[0]!;
    expect(await cli.line("/sessions")).toContain(id);
  });

  it("CT3.4 resuming a session continues it instead of starting a blank one", async () => {
    const { cli, harness } = await harnessChat();
    expect(await cli.line("alpha")).toBe("harness:alpha");
    const first = harness.log.started[0]!;
    expect(await cli.line("/sessions new")).toContain("ses_");
    expect(await cli.line("beta")).toBe("harness:beta");
    expect(harness.log.started).toHaveLength(2);
    expect(harness.log.turns[1]!.sessionId).not.toBe(first);
    expect(await cli.line("/sessions")).toContain(first);
    expect(await cli.line(`/sessions resume daemon ${first}`)).toBe(`resumed daemon ${first}`);
    expect(await cli.line("gamma")).toBe("continued:gamma");
    expect(harness.log.turns.at(-1)!.sessionId).toBe(first);
  });

  it("CT3.5 the next line answers a harness tool approval", async () => {
    const { cli } = await harnessChat();
    const armed = cli.armPermission();
    const pending = cli.line("weather?");
    expect(await armed).toMatch(/weather/);
    expect(await armed).toMatch(/allow/);
    expect(await cli.line("allow")).toBe('Lagos: {"city":"Lagos","sky":"clear"}');
    expect(await pending).toBe('Lagos: {"city":"Lagos","sky":"clear"}');
  });

  it("CT3.6 leaving clears the live session and a resume loads that same one", async () => {
    const { host, cli, harness } = await harnessChat();
    expect(await cli.line("alpha")).toBe("harness:alpha");
    const id = await cli.leave();
    expect(id).toBe(harness.log.started[0]);
    expect(cli.sessionId()).toBe("");
    await expect(cli.line("later")).rejects.toThrow(/session context cleared/);
    const again = await openInteractive(stream(host), { resume: id });
    expect(await again.line("gamma")).toBe("continued:gamma");
    expect(harness.log.turns.at(-1)!.sessionId).toBe(id);
  });
});
