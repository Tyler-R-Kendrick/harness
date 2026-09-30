import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { openInteractive } from "@harness/cli-template";
import type { InteractiveClient } from "@harness/cli-template";
import { NodeHost } from "@harness/platform-native";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonSchema, tool } from "ai";
import { harnessWorker } from "@harness/platform-native";
import { scriptedHarness } from "@harness/testkit";
import { EchoWorker } from "@harness/workers";

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

async function started(): Promise<{ host: NodeHost; cli: InteractiveClient }> {
  const host = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" } });
  hosts.push(host);
  return { host, cli: await openInteractive(stream(host)) };
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

  it("CT2.1 /ask sends the message as a turn and does not treat it as an unknown command", async () => {
    const { host, cli } = await started();
    expect(await cli.line("/ask hi")).toBe("echo: hi");
    expect(turns(host)).toBe(1);
    expect(JSON.stringify(host.daemon.snapshot())).not.toContain("/ask");
  });

  it("CT2.2 /ask with no message is usage and does not start a turn", async () => {
    const { host, cli } = await started();
    expect(await cli.line("/ask")).toMatch(/usage: \/ask/);
    expect(await cli.line("/ask   ")).toMatch(/usage: \/ask/);
    expect(turns(host)).toBe(0);
  });

  it("CT2.3 /ask --help describes the command and does not start a turn", async () => {
    const { host, cli } = await started();
    expect(await cli.line("/ask --help")).toMatch(/session agent/);
    expect(turns(host)).toBe(0);
  });

  it("CT2.4 a bare help line is the chat guide and does not start a turn", async () => {
    const { host, cli } = await started();
    const help = await cli.line("help");
    expect(help).toBe(await cli.line("/help"));
    expect(help).toMatch(/\/ask/);
    expect(help).toMatch(/sessions/);
    expect(turns(host)).toBe(0);
  });

  it("CT2.5 /tools help describes the tools command and does not start a turn", async () => {
    const { host, cli } = await started();
    const text = await cli.line("/tools help");
    expect(text).toMatch(/usage: \/tools/);
    expect(text).not.toMatch(/unknown tool/);
    expect(turns(host)).toBe(0);
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
    expect(await cli.line("/new")).toContain("ses_");
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
});
