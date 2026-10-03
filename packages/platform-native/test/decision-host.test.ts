import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { bytes, MODEL_HEADER, usage } from "@harness/cognitive";
import type { ModelDescriptor } from "@harness/cognitive";
import { connectPeer, CriteriaBookSchema, ensembleMember, forkId, parseCalibration } from "@harness/decision";
import type { DecisionEvent, Member } from "@harness/decision";
import { buildNativeDecision, loadDecisionSettings, localChatTier, NodeHost, openDecision, ARCHIVE_FILE, RULES_FILE } from "@harness/platform-native";
import type { NativeDecision } from "@harness/platform-native";
import { AgentWorker, sessionAgent } from "@harness/workers";
import type { WorkerEvent } from "@harness/core";
import { answering, cleanDirs, clientOf, ensembleOf, judgeDescriptor, PermissionWorker, tempDir, until } from "./decision-fixtures.ts";

afterEach(cleanDirs);

const write = (dir: string, file: string, json: unknown): void => {
  mkdirSync(join(dir, "settings"), { recursive: true });
  writeFileSync(join(dir, file), typeof json === "string" ? json : JSON.stringify(json));
};

// ---- settings ----------------------------------------------------------------------------------------------------

describe("loadDecisionSettings: the settings files, shipped and tweaked", () => {
  it("DHN11.1 the files shipped in @harness/decision parse", () => {
    const settings = loadDecisionSettings();
    expect(settings.dispatch.version).toBe("dispatch-1");
    expect(settings.permission).toBeDefined();
  });

  it("DHN11.2 a directory with no settings of its own reads the shipped ones", async () => {
    const dir = await tempDir();
    expect(loadDecisionSettings(dir)).toEqual(loadDecisionSettings());
  });

  it("DHN11.3 a file in <dir>/settings replaces the shipped file of its name", async () => {
    const dir = await tempDir();
    const shipped = JSON.parse(readFileSync(new URL("../../decision/data/dispatch.json", import.meta.url), "utf8"));
    write(dir, "settings/dispatch.json", { ...shipped, version: "dispatch-mine" });
    expect(loadDecisionSettings(dir).dispatch.version).toBe("dispatch-mine");
    expect(loadDecisionSettings(dir).stuck).toEqual(loadDecisionSettings().stuck);
  });

  it("DHN11.4 a file that is not JSON is an error that names it", async () => {
    const dir = await tempDir();
    write(dir, "settings/stuck.json", "{ nope");
    expect(() => loadDecisionSettings(dir)).toThrow(join(dir, "settings", "stuck.json"));
  });

  it("DHN11.5 a file that does not parse is an error that names the settings and the files read", async () => {
    const dir = await tempDir();
    write(dir, "settings/dispatch.json", { version: "" });
    expect(() => loadDecisionSettings(dir)).toThrow(/invalid dispatch settings[\s\S]*read from .*dispatch\.json/);
  });
});

// ---- the layer on a directory --------------------------------------------------------------------------------------

const ITEM = (id: string, kind: "permission" | "review") => ({ id, session: "s", kind, since: 1_000, blocked: kind === "permission" });
const ATTENTION = forkId("attention");

describe("openDecision: a layer on a directory's files", () => {
  it("DHN6.1 decisions are kept across a restart, and the next one has a new id", async () => {
    const dir = await tempDir();
    const first = await openDecision({ dir });
    const made = await first.layer.decideNamed("attention", ITEM("a", "review"));
    await first.settled();
    const again = await openDecision({ dir });
    expect((await again.layer.records()).map((r) => r.id)).toEqual([made.id]);
    expect((await again.layer.decideNamed("attention", ITEM("b", "review"))).id).not.toBe(made.id);
  });

  it("DHN6.2 a calibration book that is installed is written to calibration.json, and read back when the directory is opened again", async () => {
    const dir = await tempDir();
    const book = parseCalibration({
      entries: [
        {
          fork: "permission.risk",
          member: "m",
          version: "v1",
          question: "risk",
          calibrator: { kind: "temperature", temperature: 1.5 },
          fitted: { n: 40, at: 1000, eceBefore: 0.2, eceAfter: 0.05, brierBefore: 0.3, brierAfter: 0.2 },
        },
      ],
    });
    const first = await openDecision({ dir });
    await first.layer.install(book);
    expect(JSON.parse(readFileSync(join(dir, "calibration.json"), "utf8")).entries).toHaveLength(1);
    expect((await openDecision({ dir })).layer.calibration().entries).toHaveLength(1);
  });

  it("DHN6.3 a calibration that cannot be saved is logged, and the book is still the one in use", async () => {
    const dir = await tempDir();
    const logs: string[] = [];
    const opened = await openDecision({ dir, log: (m) => void logs.push(m) });
    // a directory where the file goes: the atomic write cannot replace it
    mkdirSync(join(dir, "calibration.json", "inside"), { recursive: true });
    await opened.layer.install(parseCalibration({ entries: [] }));
    expect(logs).toEqual([expect.stringMatching(/^decision: cannot save calibration\.json: /)]);
    expect(opened.layer.calibration().entries).toEqual([]);
  });

  it("DHN6.15 a problem is survivable when nobody listens for it", async () => {
    const dir = await tempDir();
    const opened = await openDecision({ dir });
    mkdirSync(join(dir, "calibration.json", "inside"), { recursive: true });
    await expect(opened.layer.install(parseCalibration({ entries: [] }))).resolves.toBeUndefined();
  });

  it("DHN6.4 learned rules are written as they change and come back with their lifecycle", async () => {
    const dir = await tempDir();
    const first = await openDecision({ dir });
    for (let i = 0; i < 16; i++) {
      const kind = i % 2 === 0 ? "permission" : "review";
      const decision = await first.layer.decideNamed("attention", ITEM(`h${i}`, kind), { session: `train-${i}` });
      await first.layer.outcome(decision.id, { at: 2_000, source: "human", kind: "overridden", label: kind === "permission" ? "urgent" : "low" });
    }
    const induced = await first.layer.induce({ fork: ATTENTION, fields: ["kind"], minSupport: 4, minPurity: 0.9, maxRules: 5, maxConditions: 1 });
    expect(induced.rules).toHaveLength(2);
    await first.settled();
    expect(existsSync(join(dir, RULES_FILE))).toBe(true);
    const again = await openDecision({ dir });
    expect(again.layer.rules(ATTENTION).rules.map((r) => [r.rule.action, r.state])).toEqual(induced.rules.map((r) => [r.rule.action, r.state]));
  });

  it("DHN6.5 an archive of criteria that is changed is written, and read when the directory is opened again", async () => {
    const dir = await tempDir();
    const book = CriteriaBookSchema.parse({ fork: "stuck", version: "v0", questions: { q: { type: "boolean", instructions: "is it stuck?", criteria: {} } } });
    const first = await openDecision({ dir });
    first.layer.archive.seed(book);
    await first.layer.rollback(forkId("stuck"), "v0");
    await first.settled();
    expect(existsSync(join(dir, ARCHIVE_FILE))).toBe(true);
    expect((await openDecision({ dir })).layer.archive.active(forkId("stuck"))?.version).toBe("v0");
  });

  it("DHN6.6 learned state that is not valid stops the layer from opening, with the files named", async () => {
    const dir = await tempDir();
    write(dir, RULES_FILE, { lifecycle: "garbage", rules: [] });
    await expect(openDecision({ dir })).rejects.toThrow(join(dir, RULES_FILE));
  });

  it("DHN6.7 a state file that is not JSON is an error that names it", async () => {
    const dir = await tempDir();
    write(dir, ARCHIVE_FILE, "{ truncated");
    await expect(openDecision({ dir })).rejects.toThrow(ARCHIVE_FILE);
  });

  it("DHN6.8 a line of the log that cannot be read is logged with its file and line, and the rest is kept", async () => {
    const dir = await tempDir();
    const first = await openDecision({ dir });
    await first.layer.decideNamed("attention", ITEM("a", "review"));
    await first.settled();
    const file = join(dir, "decisions.jsonl");
    writeFileSync(file, `${readFileSync(file, "utf8")}not json\n`);
    const logs: string[] = [];
    const again = await openDecision({ dir, log: (m) => logs.push(m) });
    expect(await again.layer.records()).toHaveLength(1);
    expect(logs).toEqual([expect.stringContaining(`decision: ${file} line 2:`)]);
  });

  it("DHN6.16 a last line cut short by a crash is logged as cut off the file", async () => {
    const dir = await tempDir();
    const first = await openDecision({ dir });
    await first.layer.decideNamed("attention", ITEM("a", "review"));
    await first.settled();
    const file = join(dir, "decisions.jsonl");
    writeFileSync(file, `${readFileSync(file, "utf8")}{"v":1,"t":"rec`);
    const logs: string[] = [];
    await openDecision({ dir, log: (m) => void logs.push(m) });
    expect(logs).toEqual([expect.stringMatching(/line 2: truncated last line: .* \(cut off the file\)$/)]);
  });

  it("DHN6.9 the records kept can be capped", async () => {
    const dir = await tempDir();
    const opened = await openDecision({ dir, maxRecords: 2 });
    for (let i = 0; i < 4; i++) await opened.layer.decideNamed("attention", ITEM(`i${i}`, "review"));
    expect(await opened.layer.records()).toHaveLength(2);
  });

  it("DHN6.10 the members it is given are the ones it asks, and the judge the one that verifies", async () => {
    const dir = await tempDir();
    const asked: string[] = [];
    const member: Member = { id: "mine", version: "v1", ask: async () => (asked.push("mine"), {}) };
    const judge: Member = { id: "verifier", version: "v1", ask: async () => (asked.push("verifier"), {}) };
    const opened = await openDecision({ dir, members: [member], judge });
    const status = await opened.layer.status();
    expect(status.members.map((m) => m.id)).toEqual(["mine"]);
    expect(status.judge?.id).toBe("verifier");
    await opened.layer.decideNamed("attention", ITEM("a", "review"));
    expect(asked[0]).toBe("mine");
  });

  it("DHN6.11 decisions are published as events when a sink is given", async () => {
    const dir = await tempDir();
    const events: DecisionEvent[] = [];
    const opened = await openDecision({ dir, publish: (e) => void events.push(e) });
    await opened.layer.decideNamed("attention", ITEM("a", "review"));
    expect(events.map((e) => [e.type, e.payload.fork])).toEqual([["decision.made", "attention"]]);
  });

  it("DHN6.12 the clock and the entropy are the ones it is given", async () => {
    const dir = await tempDir();
    const opened = await openDecision({ dir, clock: { now: () => 42_000 }, entropy: { bytes: (n) => new Uint8Array(n) } });
    const decision = await opened.layer.decideNamed("attention", ITEM("a", "review"));
    expect(decision.record.at).toBe(42_000);
  });

  it("DHN6.14 without entropy of its own the layer draws from the system's: a policy that explores takes a random option", async () => {
    const dir = await tempDir();
    const shipped = JSON.parse(readFileSync(new URL("../../decision/data/policy.json", import.meta.url), "utf8"));
    write(dir, "policy.json", { ...shipped, forks: { attention: { explore: 1 } } });
    const ensemble = ensembleOf({ judge: answering({ boolean: 0.95, level: "last" }) });
    const opened = await openDecision({ dir, members: [ensembleMember(ensemble)] });
    const decisions = [];
    for (let i = 0; i < 30; i++) decisions.push(await opened.layer.decideNamed("attention", ITEM(`i${i}`, "review")));
    expect(decisions.every((d) => d.explored)).toBe(true);
    // a random choice among the actions: not always the same one
    expect(new Set(decisions.map((d) => d.action)).size).toBeGreaterThan(1);
  });

  it("DHN6.13 without a clock the time is the system's", async () => {
    const dir = await tempDir();
    const before = Date.now();
    const decision = await (await openDecision({ dir })).layer.decideNamed("attention", ITEM("a", "review"));
    expect(decision.record.at).toBeGreaterThanOrEqual(before);
  });
});

// ---- beside a running host -------------------------------------------------------------------------------------------

const CRITICAL = { boolean: 0.95, level: "last" } as const;

interface WorldOptions {
  readonly judges?: Parameters<typeof ensembleOf>[0];
  readonly dir?: string;
  readonly tickMs?: number;
  readonly decision?: Partial<Parameters<typeof buildNativeDecision>[0]>;
}

async function world(options: WorldOptions = {}) {
  const dir = options.dir ?? (await tempDir());
  const ensemble = ensembleOf(options.judges ?? { judge: answering(CRITICAL) });
  const logs: string[] = [];
  const decision = await buildNativeDecision({ dir, ensemble, log: (m) => void logs.push(m), tickMs: options.tickMs ?? 20, ...options.decision });
  const host = await NodeHost.start({ worker: new PermissionWorker(), identity: { principal: "alice", kind: "human" }, cognitive: ensemble, tickMs: 50 });
  await decision.attach(host.runtime);
  const client = clientOf(host);
  await client.initialize();
  const { sessionId } = await client.connection.newSession({ cwd: "/work", mcpServers: [] });
  const close = async () => {
    await decision.stop();
    await host.close();
    await decision.settled();
  };
  return { dir, ensemble, logs, decision, host, client, sessionId, close };
}

/** Prompts and answers the permission request when `choose` says (the person at the client). */
function prompt(w: Awaited<ReturnType<typeof world>>, text: string) {
  let choose!: (optionId: string) => void;
  const chosen = new Promise<string>((resolve) => (choose = resolve));
  w.client.answer = async () => ({ outcome: { outcome: "selected", optionId: await chosen } });
  const done = w.client.connection.prompt({ sessionId: w.sessionId, prompt: [{ type: "text", text }] });
  return { choose, done };
}

describe("buildNativeDecision: the layer beside a running daemon", () => {
  it("DHN7.1 the decision operations are served by the ensemble the host offers, on the ensemble's judgment models", async () => {
    const w = await world();
    const status = (await w.ensemble.operation("decision.status")!({})) as { members: { id: string }[]; forks: { id: string }[] };
    expect(status.members.map((m) => m.id)).toEqual(["ensemble"]);
    expect(status.forks.map((f) => f.id)).toContain("permission.risk");
    const peer = await connectPeer(w.host.runtime, { principal: "audit", kind: "plugin" });
    const { capabilities } = (await peer.call("_harness/capabilities/list", {})) as { capabilities: { name: string }[] };
    expect(capabilities.map((c) => c.name)).toContain("decision");
    peer.close();
    await w.close();
  });

  it("DHN7.2 a permission request is annotated and put in front of the person without being answered; the person's choice becomes the decision's outcome", async () => {
    const w = await world();
    const { choose, done } = prompt(w, "rm -rf build");
    await until(() => w.client.permissions.length === 1, "the request to reach the client");
    await until(() => w.decision.layer.inbox.list().some((i) => i.text?.includes("(risk:")), "the annotation");
    const [item] = w.decision.layer.inbox.list();
    expect(item).toMatchObject({ kind: "permission", blocked: true, text: expect.stringMatching(/^Bash: rm -rf build \(risk: \w+\)$/) });
    // nothing answered it: the request is still open
    expect(w.host.daemon.pendingPermissions().map((p) => p.sessionId)).toEqual([w.sessionId]);
    const [decided] = await w.decision.layer.records({ fork: forkId("permission.risk") });
    expect(decided).toMatchObject({ session: w.sessionId, rung: "model", member: expect.any(String), input: { tool: "Bash", command: "rm -rf build" } });
    expect(decided!.outcome).toBeUndefined();

    choose("allow");
    expect((await done).stopReason).toBe("end_turn");
    await until(async () => (await w.decision.layer.record(decided!.id))?.outcome !== undefined, "the outcome");
    expect((await w.decision.layer.record(decided!.id))!.outcome).toMatchObject({ source: "human", kind: "approved" });
    expect(w.decision.layer.inbox.list().filter((i) => i.kind === "permission")).toEqual([]);
    expect(w.logs).toEqual([]);
    await w.close();
  });

  it("DHN7.3 each decision is published on the daemon's hook bus as decision.made, for other plugins", async () => {
    const w = await world();
    const audit = await connectPeer(w.host.runtime, { principal: "audit", kind: "plugin" });
    await audit.call("_harness/hooks/subscribe", { types: ["decision.*"] });
    const { choose, done } = prompt(w, "rm -rf build");
    await until(() => w.decision.layer.inbox.list().some((i) => i.text?.includes("(risk:")), "the annotation");
    const polled = (await audit.call("_harness/hooks/poll", {})) as { events: { type: string; source: string; sessionId: string; payload: { fork: string; rung: string } }[] };
    expect(polled.events.map((e) => [e.type, e.source, e.sessionId, e.payload.fork, e.payload.rung])).toEqual([["decision.made", "host", w.sessionId, "permission.risk", "model"]]);
    choose("deny");
    await done;
    audit.close();
    await w.close();
  });

  it("DHN7.4 the plugin is driven by the host's ticker, and pump handles what is on the bus at once", async () => {
    const w = await world({ tickMs: 5_000 });
    const { choose, done } = prompt(w, "ls");
    await until(() => w.client.permissions.length === 1, "the request");
    // the ticker has a long period: only the first tick at attach has run, so the request is handled by pump
    expect(await w.decision.pump()).toBeGreaterThan(0);
    expect(w.decision.layer.inbox.list()).toHaveLength(1);
    choose("deny");
    await done;
    await w.close();
  });

  it("DHN7.5 stopping the plugin ends its handling of events and hangs up its connection", async () => {
    const w = await world();
    await w.decision.stop();
    const { choose, done } = prompt(w, "ls");
    await until(() => w.client.permissions.length === 1, "the request");
    await new Promise((r) => setTimeout(r, 120));
    expect(w.decision.layer.inbox.list()).toEqual([]);
    expect(await w.decision.layer.records()).toEqual([]);
    expect(await w.decision.pump()).toBe(0);
    choose("deny");
    await done;
    await w.decision.stop();
    await w.host.close();
    await w.decision.settled();
  });

  it("DHN7.6 a failure while handling an event is logged with the event, and the loop goes on", async () => {
    const dir = await tempDir();
    const ensemble = ensembleOf({ judge: answering(CRITICAL) });
    const logs: string[] = [];
    const decision = await buildNativeDecision({ dir, ensemble, log: (m) => void logs.push(m), tickMs: 10 });
    const host = await NodeHost.start({ worker: new PermissionWorker(), identity: { principal: "alice", kind: "human" }, cognitive: ensemble });
    await decision.attach({
      connect: (identity, send) => host.runtime.connect(identity, send),
      publish: (e) => host.runtime.publish(e),
      daemon: {
        pendingPermission: () => {
          throw new Error("facts are down");
        },
        readLog: () => [],
        sessions: () => [],
      },
    });
    const client = clientOf(host);
    await client.initialize();
    const { sessionId } = await client.connection.newSession({ cwd: "/work", mcpServers: [] });
    client.answer = async () => ({ outcome: { outcome: "selected", optionId: "allow" } });
    await client.connection.prompt({ sessionId, prompt: [{ type: "text", text: "ls" }] });
    await until(() => logs.some((l) => l.includes("handling permission.requested")), "the log");
    expect(logs.find((l) => l.includes("handling permission.requested"))).toMatch(/^decision: handling permission\.requested \(.+\): facts are down$/);
    await decision.stop();
    await host.close();
    await decision.settled();
  });

  it("DHN7.7 a bus that fails is logged, not thrown", async () => {
    const dir = await tempDir();
    const ensemble = ensembleOf();
    const logs: string[] = [];
    const decision = await buildNativeDecision({ dir, ensemble, log: (m) => void logs.push(m), tickMs: 10 });
    const host = await NodeHost.start({ worker: new PermissionWorker(), identity: { principal: "alice", kind: "human" }, cognitive: ensemble });
    await decision.attach({
      connect: (identity, send) => {
        const connection = host.runtime.connect(identity, send);
        return {
          disconnect: () => connection.disconnect(),
          receive: (message) => {
            // everything after the subscription fails to reach the daemon, so a poll never answers
            if ((message as { method?: string }).method === "_harness/hooks/poll") throw new Error("bus is down");
            connection.receive(message);
          },
        };
      },
      publish: (e) => host.runtime.publish(e),
      daemon: host.daemon,
    });
    await until(() => logs.some((l) => l.startsWith("decision: the hook bus:")), "the bus failure to be logged");
    expect(logs[0]).toContain("bus is down");
    await decision.stop();
    await host.close();
  });

  it("DHN7.11 a failure that is not an Error is logged as it reads", async () => {
    const dir = await tempDir();
    const ensemble = ensembleOf();
    const logs: string[] = [];
    const decision = await buildNativeDecision({ dir, ensemble, log: (m) => void logs.push(m) });
    const host = await NodeHost.start({ worker: new PermissionWorker(), identity: { principal: "alice", kind: "human" }, cognitive: ensemble });
    await decision.attach({
      connect: (identity, send) => {
        const connection = host.runtime.connect(identity, send);
        return {
          disconnect: () => connection.disconnect(),
          receive: (message) => {
            if ((message as { method?: string }).method === "_harness/hooks/poll") throw "the bus is down";
            connection.receive(message);
          },
        };
      },
      publish: (e) => host.runtime.publish(e),
      daemon: host.daemon,
    });
    // the first tick ran at attach; the failure is the plugin's report of its poll
    await until(() => logs.length > 0, "the failure to be logged");
    expect(logs[0]).toBe("decision: the hook bus: the bus is down");
    await decision.stop();
    await host.close();
  });

  it("DHN7.13 with assess the attention fork ranks what is put in the inbox", async () => {
    const w = await world({ decision: { assess: true } });
    const { choose, done } = prompt(w, "ls");
    await until(() => w.client.permissions.length === 1, "the request");
    await until(() => w.decision.layer.inbox.list().some((i) => i.urgency !== undefined), "the item to be ranked");
    choose("deny");
    await done;
    await w.close();
  });

  it("DHN7.12 the layer works with the default tick", async () => {
    const dir = await tempDir();
    const ensemble = ensembleOf({ judge: answering(CRITICAL) });
    const decision = await buildNativeDecision({ dir, ensemble, log: () => {} });
    const host = await NodeHost.start({ worker: new PermissionWorker(), identity: { principal: "alice", kind: "human" }, cognitive: ensemble });
    await decision.attach(host.runtime);
    expect(await decision.pump()).toBe(0);
    await decision.stop();
    await host.close();
  });

  it("DHN7.8 the dispatch planner decides with the layer: routine work moves to the small tier", async () => {
    const w = await world({ judges: { judge: answering(CRITICAL) } });
    const dispatch = w.decision.dispatch({ small: "S", large: "L" });
    expect(dispatch.tiers).toEqual({ small: "S", large: "L" });
    const choice = await dispatch.plan({ sessionId: "s1", stepNumber: 1, messages: [{ role: "user", content: "rename it everywhere" }], toolNames: [], contextTokens: 40_000 });
    expect(choice).toBe("small");
    expect((await w.decision.layer.records({ fork: forkId("dispatch") }))[0]).toMatchObject({ action: "small", session: "s1" });
    dispatch.onError!(new Error("late"), { sessionId: "s1", stepNumber: 1, messages: [], toolNames: [], contextTokens: 0 });
    expect(w.logs).toEqual(["decision: dispatch: late"]);
    await w.close();
  });

  it("DHN7.9 the layer asks the ensemble: a judge that is down leaves the decision to a person, with the fork's fallback", async () => {
    const w = await world({ judges: {} });
    const decision = await w.decision.layer.decideNamed("attention", ITEM("a", "review"));
    expect(decision).toMatchObject({ rung: "human", needsHuman: true });
    await w.close();
  });

  it("DHN7.10 decision state is kept in the directory across a restart of the layer", async () => {
    const dir = await tempDir();
    const first = await world({ dir });
    const made = await first.decision.layer.decideNamed("attention", ITEM("a", "review"));
    await first.close();
    const second = await world({ dir });
    expect((await second.decision.layer.records()).map((r) => r.id)).toEqual([made.id]);
    await second.close();
  });
});

describe("the verifier and the small tier", () => {
  it("DHN8.1 a verifier is the ensemble's under an identity of its own when there is more than one judgment model", async () => {
    const dir = await tempDir();
    const decision = await buildNativeDecision({ dir, ensemble: ensembleOf({ a: answering(), b: answering() }), log: () => {} });
    const status = await decision.layer.status();
    expect(status.members.map((m) => m.id)).toEqual(["ensemble"]);
    expect(status.judge?.id).toBe("ensemble-verifier");
  });

  it("DHN8.2 with one judgment model there is no verifier distinct from the member", async () => {
    const decision = await buildNativeDecision({ dir: await tempDir(), ensemble: ensembleOf({ a: answering() }), log: () => {} });
    expect((await decision.layer.status()).judge).toBeUndefined();
  });

  it("DHN8.3 a verifier can be given, or switched off", async () => {
    const mine: Member = { id: "mine", version: "v1", ask: async () => ({}) };
    const given = await buildNativeDecision({ dir: await tempDir(), ensemble: ensembleOf({ a: answering(), b: answering() }), judge: mine, log: () => {} });
    expect((await given.layer.status()).judge?.id).toBe("mine");
    const off = await buildNativeDecision({ dir: await tempDir(), ensemble: ensembleOf({ a: answering(), b: answering() }), judge: false, log: () => {} });
    expect((await off.layer.status()).judge).toBeUndefined();
  });

  it("DHN8.4 members can replace the ensemble as the layer's members", async () => {
    const mine: Member = { id: "mine", version: "v1", ask: async () => ({}) };
    const decision = await buildNativeDecision({ dir: await tempDir(), ensemble: ensembleOf(), members: [mine], log: () => {} });
    expect((await decision.layer.status()).members.map((m) => m.id)).toEqual(["mine"]);
  });

  it("DHN8.5 an installed layer cannot be installed twice on one ensemble", async () => {
    const ensemble = ensembleOf();
    await buildNativeDecision({ dir: await tempDir(), ensemble, log: () => {} });
    await expect(buildNativeDecision({ dir: await tempDir(), ensemble, log: () => {} })).rejects.toThrow("extension decision is already installed");
  });

  it("DHN8.6 pump and stop are harmless before the layer is attached to a host", async () => {
    const decision: NativeDecision = await buildNativeDecision({ dir: await tempDir(), ensemble: ensembleOf(), log: () => {} });
    expect(await decision.pump()).toBe(0);
    await decision.stop();
  });

  const chat = (id: string, locality: "local" | "hosted", ports: ModelDescriptor["ports"] = ["generator"], score = 50): ModelDescriptor => {
    const base = judgeDescriptor(id);
    const { artifact: _artifact, ...rest } = base;
    const benchmarks = [{ benchmark: "b", task: "chat", metric: "m", score, higherIsBetter: true }];
    return (locality === "local" ? { ...base, tasks: ["chat"], ports, benchmarks } : { ...rest, tasks: ["chat"], ports, benchmarks, locality: "hosted", runtime: "ai-gateway", run: { model: "x/y" }, downloadBytes: bytes(0) }) as ModelDescriptor;
  };
  /** A generator that says its own id. */
  const saying = (id: string) => ({
    generator: new MockLanguageModelV4({
      doGenerate: async () => ({ content: [{ type: "text" as const, text: id }], finishReason: { unified: "stop" as const, raw: undefined }, usage: usage(), warnings: [] }),
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "stream-start" as const, warnings: [] },
          { type: "text-start" as const, id: "0" },
          { type: "text-delta" as const, id: "0", delta: id },
          { type: "text-end" as const, id: "0" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: usage() },
        ]),
      }),
    }),
  });
  const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }];

  it("DHN8.7 the small tier is answered by the local generator, even when a hosted one scores higher", async () => {
    const ensemble = ensembleOf();
    ensemble.register(chat("local-small", "local", ["generator"], 10), async () => saying("local-small"));
    ensemble.register(chat("hosted-big", "hosted", ["generator"], 90), async () => saying("hosted-big"));
    expect(ensemble.candidates("chat")[0]!.id).toBe("hosted-big");
    const tier = localChatTier(ensemble)!;
    expect(tier).toBeDefined();
    const generated = await tier.doGenerate({ prompt });
    expect(generated.response?.headers?.[MODEL_HEADER]).toBe("local-small");
    expect(generated.content).toEqual([{ type: "text", text: "local-small" }]);
    expect((await tier.doStream({ prompt })).response?.headers?.[MODEL_HEADER]).toBe("local-small");
  });

  it("DHN8.9 the small tier is the best of the local generators, and the hosted one is not its failover", async () => {
    const ensemble = ensembleOf();
    ensemble.register(chat("local-weak", "local", ["generator"], 10), async () => saying("local-weak"));
    ensemble.register(chat("local-strong", "local", ["generator"], 40), async () => saying("local-strong"));
    let hostedCalls = 0;
    ensemble.register(chat("hosted-big", "hosted", ["generator"], 90), async () => (hostedCalls++, saying("hosted-big")));
    expect((await localChatTier(ensemble)!.doGenerate({ prompt })).response?.headers?.[MODEL_HEADER]).toBe("local-strong");
    ensemble.revoke("local-strong", "gone");
    ensemble.revoke("local-weak", "gone");
    expect(localChatTier(ensemble)).toBeUndefined();
    expect(hostedCalls).toBe(0);
  });

  it("DHN8.8 a hosted generator, a local model that does not generate, or no model at all is not a small tier", () => {
    expect(localChatTier(ensembleOf())).toBeUndefined();
    const hosted = ensembleOf();
    hosted.register(chat("hosted-chat", "hosted"), async () => ({}));
    expect(localChatTier(hosted)).toBeUndefined();
    const embedder = ensembleOf();
    embedder.register(chat("embedder", "local", ["embedder"]), async () => ({}));
    expect(localChatTier(embedder)).toBeUndefined();
  });
});


describe("a session agent dispatched by the layer", () => {
  /** A model that answers one text, remembering that it was called. */
  const speaking = (said: string, calls: string[]) =>
    new MockLanguageModelV4({
      doStream: async () => {
        calls.push(said);
        return {
          stream: convertArrayToReadableStream([
            { type: "stream-start" as const, warnings: [] },
            { type: "text-start" as const, id: "0" },
            { type: "text-delta" as const, id: "0", delta: said },
            { type: "text-end" as const, id: "0" },
            { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: usage() },
          ]),
        };
      },
    });

  async function turn(judges: Parameters<typeof ensembleOf>[0], text: string) {
    const calls: string[] = [];
    const large = speaking("from the large model", calls);
    const small = speaking("from the small model", calls);
    const dir = await tempDir();
    const decision = await buildNativeDecision({ dir, ensemble: ensembleOf(judges), log: () => {} });
    const agent = sessionAgent({ model: large, dispatch: decision.dispatch({ small, large }) });
    const events: WorkerEvent[] = [];
    await new AgentWorker({ agent }).run({ type: "prompt", sessionId: "s1", turnId: "t1", prompt: [{ type: "text", text }], cwd: "/" }, (e) => events.push(e));
    return { calls, decision, events };
  }

  it("DHN10.1 routine work is moved by the layer's dispatch fork to the small tier, and the decision is recorded for the session", async () => {
    const { calls, decision, events } = await turn({ judge: answering(CRITICAL) }, "rename the variable everywhere");
    expect(calls).toEqual(["from the small model"]);
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "end_turn" });
    expect((await decision.layer.records({ fork: forkId("dispatch") }))[0]).toMatchObject({ session: "s1", action: "small", input: { task: "rename the variable everywhere", current: "large" } });
  });

  it("DHN10.2 with no judge to ask the step stays on the session's own model", async () => {
    const { calls, decision } = await turn({}, "rename the variable everywhere");
    expect(calls).toEqual(["from the large model"]);
    expect((await decision.layer.records({ fork: forkId("dispatch") }))[0]).toMatchObject({ rung: "human", action: "stay" });
  });
});
