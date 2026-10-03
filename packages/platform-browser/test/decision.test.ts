import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CriteriaBookSchema, ensembleMember, forkId, parseCalibration, parsePolicy } from "@harness/decision";
import type { CalibrationBook, Member } from "@harness/decision";
import { BrowserHost, browserDecision, IndexedDbStorage } from "@harness/platform-browser";
import type { BrowserDecision, BrowserDecisionOptions } from "@harness/platform-browser";
import { answering, ensembleOf, PermissionWorker, shipped, tabOf, until } from "./decision-fixtures.ts";

const ME = { principal: "me", kind: "human" } as const;
const hosts: BrowserHost[] = [];
const layers: BrowserDecision[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(layers.splice(0).map((l) => l.close().catch(() => {})));
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

const ITEM = (id: string, kind: "permission" | "review") => ({ id, session: "s", kind, since: 1_000, blocked: kind === "permission" });

interface World {
  readonly host: BrowserHost;
  readonly ensemble: ReturnType<typeof ensembleOf>;
  readonly factory: IDBFactory;
  readonly logs: string[];
}

async function world(over: { readonly factory?: IDBFactory; readonly judges?: Parameters<typeof ensembleOf>[0] } = {}): Promise<World> {
  const ensemble = ensembleOf(over.judges ?? { judge: answering() });
  const host = await BrowserHost.start({ worker: new PermissionWorker(), identity: ME, cognitive: ensemble, log: () => {} });
  hosts.push(host);
  return { host, ensemble, factory: over.factory ?? new IDBFactory(), logs: [] };
}

/** The layer on the world's host and database; closed after the test. */
async function layerOn(w: World, options: Partial<BrowserDecisionOptions> = {}): Promise<BrowserDecision> {
  const decision = await browserDecision({ ensemble: w.ensemble, runtime: w.host.runtime, factory: w.factory, tickMs: 10, log: (m) => void w.logs.push(m), ...shipped(), ...options });
  layers.push(decision);
  return decision;
}

/** A second run of the same page: its own host and ensemble, the same databases. */
async function restart(w: World, options: Partial<BrowserDecisionOptions> = {}): Promise<{ w: World; decision: BrowserDecision }> {
  const next = await world({ factory: w.factory });
  return { w: next, decision: await layerOn(next, options) };
}

const book = (member = "m"): CalibrationBook =>
  parseCalibration({
    entries: [
      {
        fork: "permission.risk",
        member,
        version: "v1",
        question: "risk",
        calibrator: { kind: "temperature", temperature: 1.5 },
        fitted: { n: 40, at: 1000, eceBefore: 0.2, eceAfter: 0.05, brierBefore: 0.3, brierAfter: 0.2 },
      },
    ],
  });

describe("browserDecision: what the layer keeps in IndexedDB", () => {
  it("DBD1.1 decisions are kept across a restart of the page, and the next one has a new id", async () => {
    const w = await world();
    const first = await layerOn(w);
    const made = await first.layer.decideNamed("attention", ITEM("a", "review"));
    await first.close();
    const second = await restart(w);
    expect((await second.decision.layer.records()).map((r) => r.id)).toEqual([made.id]);
    expect((await second.decision.layer.decideNamed("attention", ITEM("b", "review"))).id).not.toBe(made.id);
  });

  it("DBD1.2 a calibration book that is installed is stored and comes back; the book given is only the one to start from", async () => {
    const w = await world();
    const first = await layerOn(w, { calibration: book("given") });
    expect(first.layer.calibration().entries.map((e) => e.member)).toEqual(["given"]);
    await first.layer.install(book("installed"));
    await first.settled();
    await first.close();
    const second = await restart(w, { calibration: book("given") });
    expect(second.decision.layer.calibration().entries.map((e) => e.member)).toEqual(["installed"]);
  });

  it("DBD1.3 with nothing stored and no book given the layer starts uncalibrated", async () => {
    const w = await world();
    expect((await layerOn(w)).layer.calibration().entries).toEqual([]);
  });

  it("DBD1.4 learned rules and their lifecycle are stored as they change and come back", async () => {
    const w = await world();
    const first = await layerOn(w, { members: [] });
    for (let i = 0; i < 16; i++) {
      const kind = i % 2 === 0 ? "permission" : "review";
      const decision = await first.layer.decideNamed("attention", ITEM(`h${i}`, kind), { session: `train-${i}` });
      await first.layer.outcome(decision.id, { at: 2_000, source: "human", kind: "overridden", label: kind === "permission" ? "urgent" : "low" });
    }
    const induced = await first.layer.induce({ fork: forkId("attention"), fields: ["kind"], minSupport: 4, minPurity: 0.9, maxRules: 5, maxConditions: 1 });
    expect(induced.rules).toHaveLength(2);
    await first.close();
    const second = await restart(w, { members: [] });
    expect(second.decision.layer.rules(forkId("attention")).rules.map((r) => [r.rule.action, r.state])).toEqual(induced.rules.map((r) => [r.rule.action, r.state]));
  });

  it("DBD1.5 the criteria archive is stored when it changes and comes back", async () => {
    const w = await world();
    const first = await layerOn(w);
    first.layer.archive.seed(CriteriaBookSchema.parse({ fork: "stuck", version: "v0", questions: { q: { type: "boolean", instructions: "stuck?", criteria: {} } } }));
    await first.layer.rollback(forkId("stuck"), "v0");
    await first.close();
    const second = await restart(w);
    expect(second.decision.layer.archive.active(forkId("stuck"))?.version).toBe("v0");
  });

  it("DBD1.6 state in the stored databases that the layer refuses stops it from starting, naming the database, and leaves the page able to try again", async () => {
    const w = await world();
    const state = new IndexedDbStorage({ name: "harness-decision-state", key: "rules", factory: w.factory });
    await state.save({ lifecycle: "garbage", rules: [] });
    await state.close();
    await expect(layerOn(w)).rejects.toThrow("cannot use the decision state stored in harness-decision-state");
    expect(w.ensemble.operation("decision.status")).toBeUndefined();
  });

  it("DBD1.7 a stored calibration book that is not a book is refused too", async () => {
    const w = await world();
    const state = new IndexedDbStorage({ name: "harness-decision-state", key: "calibration", factory: w.factory });
    await state.save({ entries: "none" });
    await state.close();
    await expect(layerOn(w)).rejects.toThrow("cannot use the decision state");
  });

  it("DBD1.8 the databases are named after the layer, so two layers on one origin do not share their history", async () => {
    const w = await world();
    const mine = await layerOn(w, { name: "mine" });
    await mine.layer.decideNamed("attention", ITEM("a", "review"));
    await mine.close();
    const other = await restart(w, { name: "other" });
    expect(await other.decision.layer.records()).toEqual([]);
    const again = await restart(w, { name: "mine" });
    expect(await again.decision.layer.records()).toHaveLength(1);
  });

  it("DBD1.13 without an authority nothing is permitted or forbidden by rule", async () => {
    const w = await world();
    const { authority: _authority, ...rest } = shipped();
    const decision = await browserDecision({ ensemble: w.ensemble, runtime: w.host.runtime, factory: w.factory, tickMs: 10, log: () => {}, ...rest });
    layers.push(decision);
    const risk = await decision.layer.decideNamed("permission.risk", { tool: "Bash", command: "ls" });
    expect(risk.rung).toBe("model");
  });

  it("DBD1.9 the records kept can be capped", async () => {
    const w = await world();
    const capped = await layerOn(w, { maxRecords: 2 });
    for (let i = 0; i < 4; i++) await capped.layer.decideNamed("attention", ITEM(`i${i}`, "review"));
    expect(await capped.layer.records()).toHaveLength(2);
  });

  it("DBD1.10 the page's own IndexedDB is the default", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const w = await world();
    const decision = await browserDecision({ ensemble: w.ensemble, runtime: w.host.runtime, tickMs: 10, log: () => {}, ...shipped() });
    layers.push(decision);
    const made = await decision.layer.decideNamed("attention", ITEM("a", "review"));
    await decision.close();
    const next = await world({});
    const again = await browserDecision({ ensemble: next.ensemble, runtime: next.host.runtime, tickMs: 10, log: () => {}, ...shipped() });
    layers.push(again);
    expect((await again.layer.records()).map((r) => r.id)).toEqual([made.id]);
  });

  it("DBD1.11 without a clock and entropy of its own the layer uses the page's: a policy that explores takes a random option", async () => {
    const w = await world();
    const { policy: shippedPolicy, ...rest } = shipped();
    const policy = parsePolicy({ ...shippedPolicy, forks: { attention: { explore: 1 } } });
    const decision = await layerOn(w, { ...rest, policy });
    const before = Date.now();
    const decisions = [];
    for (let i = 0; i < 30; i++) decisions.push(await decision.layer.decideNamed("attention", ITEM(`i${i}`, "review")));
    expect(decisions.every((d) => d.explored && d.record.at >= before)).toBe(true);
    expect(new Set(decisions.map((d) => d.action)).size).toBeGreaterThan(1);
  });

  it("DBD1.12 a save that fails is logged, and the calibration is still the one in use", async () => {
    const w = await world();
    const decision = await layerOn(w);
    vi.spyOn(IndexedDbStorage.prototype, "save").mockRejectedValue(new Error("quota exceeded"));
    await decision.layer.install(book());
    await decision.settled();
    expect(w.logs).toEqual(["decision: cannot save the calibration: quota exceeded"]);
    expect(decision.layer.calibration().entries).toHaveLength(1);
  });
});

const prompt = (tab: Awaited<ReturnType<typeof tabOf>>, text: string) => {
  let choose!: (optionId: string) => void;
  const chosen = new Promise<string>((resolve) => (choose = resolve));
  tab.answer = async () => ({ outcome: { outcome: "selected", optionId: await chosen } });
  const done = tab.connection.prompt({ sessionId: tab.sessionId, prompt: [{ type: "text", text }] });
  return { choose, done };
};

describe("browserDecision beside a running browser host", () => {
  it("DBD2.1 the decision operations are served by the ensemble the host offers", async () => {
    const w = await world();
    const decision = await layerOn(w);
    const status = (await w.ensemble.operation("decision.status")!({})) as { members: { id: string }[]; forks: { id: string }[] };
    expect(status.members.map((m) => m.id)).toEqual(["ensemble"]);
    expect(status.forks.map((f) => f.id)).toContain("permission.risk");
    expect(decision.layer.members().map((m) => m.id)).toEqual(["ensemble"]);
  });

  it("DBD2.2 a permission request is annotated and put in front of the person without being answered; the person's choice becomes the decision's outcome", async () => {
    const w = await world();
    const decision = await layerOn(w);
    const tab = await tabOf(w.host);
    const { choose, done } = prompt(tab, "rm -rf build");
    await until(() => tab.permissions.length === 1, "the request to reach the tab");
    await until(() => decision.layer.inbox.list().some((i) => i.text?.includes("(risk:")), "the annotation");
    expect(decision.layer.inbox.list()).toMatchObject([{ kind: "permission", blocked: true, text: expect.stringMatching(/^Bash: rm -rf build \(risk: \w+\)$/) }]);
    expect(w.host.daemon.pendingPermissions()).toHaveLength(1);
    const [decided] = await decision.layer.records({ fork: forkId("permission.risk") });
    expect(decided).toMatchObject({ session: tab.sessionId, rung: "model", input: { tool: "Bash", command: "rm -rf build" } });
    choose("deny");
    expect((await done).stopReason).toBe("end_turn");
    await until(async () => (await decision.layer.record(decided!.id))?.outcome !== undefined, "the outcome");
    expect((await decision.layer.record(decided!.id))!.outcome).toMatchObject({ source: "human", kind: "denied" });
    expect(w.logs).toEqual([]);
    tab.hangUp();
  });

  it("DBD2.3 each decision is published on the daemon's hook bus as decision.made", async () => {
    const w = await world();
    const decision = await layerOn(w);
    const received: unknown[] = [];
    const peer = w.host.runtime.connect({ principal: "audit", kind: "plugin" }, (m) => void received.push(m));
    peer.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    peer.receive({ jsonrpc: "2.0", id: 2, method: "_harness/hooks/subscribe", params: { types: ["decision.*"] } });
    await decision.layer.decideNamed("attention", ITEM("a", "review"), { session: "s9" });
    peer.receive({ jsonrpc: "2.0", id: 3, method: "_harness/hooks/poll", params: {} });
    const poll = received.find((m) => (m as { id?: number }).id === 3) as { result: { events: { type: string; source: string; sessionId: string; payload: { fork: string } }[] } };
    expect(poll.result.events.map((e) => [e.type, e.source, e.sessionId, e.payload.fork])).toEqual([["decision.made", "host", "s9", "attention"]]);
    peer.disconnect();
  });

  it("DBD2.4 stopping the plugin ends its handling of events and hangs up its connection; closing also waits for the saves and releases the databases", async () => {
    const w = await world();
    const decision = await layerOn(w);
    await decision.stop();
    const tab = await tabOf(w.host);
    const { choose, done } = prompt(tab, "ls");
    await until(() => tab.permissions.length === 1, "the request");
    await new Promise((r) => setTimeout(r, 60));
    expect(decision.layer.inbox.list()).toEqual([]);
    expect(await decision.pump()).toBe(0);
    choose("deny");
    await done;
    await decision.close();
    tab.hangUp();
  });

  it("DBD2.5 a plugin that cannot connect withdraws the layer's operations and releases its databases, so the page can try again", async () => {
    const w = await world();
    const broken = { ...w.host.runtime, connect: () => ({ receive: () => { throw new Error("no peers here"); }, disconnect: () => {} }) } as unknown as BrowserDecisionOptions["runtime"];
    await expect(layerOn(w, { runtime: broken })).rejects.toThrow("no peers here");
    expect(w.ensemble.operation("decision.status")).toBeUndefined();
    const again = await layerOn(w);
    expect(w.ensemble.operation("decision.status")).toBeDefined();
    expect(again.layer.members()).toHaveLength(1);
  });

  it("DBD2.12 a closed layer withdraws its operations, and the layer can be created again on the same ensemble", async () => {
    const w = await world();
    const first = await layerOn(w);
    expect(w.ensemble.operation("decision.status")).toBeDefined();
    await first.close();
    expect(w.ensemble.operation("decision.status")).toBeUndefined();
    expect(w.ensemble.extensions()).not.toContain("decision");
    const again = await layerOn(w);
    expect(w.ensemble.operation("decision.status")).toBeDefined();
    expect(again.layer.members()).toHaveLength(1);
    await again.close();
    await again.close();
    expect(w.ensemble.operation("decision.status")).toBeUndefined();
  });

  it("DBD2.6 a failure while handling an event goes to the log and the loop goes on", async () => {
    const w = await world();
    const failing = { connect: w.host.runtime.connect.bind(w.host.runtime), publish: w.host.runtime.publish.bind(w.host.runtime), daemon: { pendingPermission: () => { throw new Error("facts down"); }, readLog: () => [], sessions: () => [] } };
    await layerOn(w, { runtime: failing });
    const tab = await tabOf(w.host);
    tab.answer = async () => ({ outcome: { outcome: "selected", optionId: "allow" } });
    await tab.connection.prompt({ sessionId: tab.sessionId, prompt: [{ type: "text", text: "ls" }] });
    await until(() => w.logs.some((l) => l.includes("handling permission.requested")), "the log");
    expect(w.logs[0]).toMatch(/^decision: handling permission\.requested \(.+\): facts down$/);
    tab.hangUp();
  });

  it("DBD2.7 without a log of its own it reports on the console", async () => {
    const w = await world();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = { connect: w.host.runtime.connect.bind(w.host.runtime), publish: w.host.runtime.publish.bind(w.host.runtime), daemon: { pendingPermission: () => { throw new Error("facts down"); }, readLog: () => [], sessions: () => [] } };
    const decision = await browserDecision({ ensemble: w.ensemble, runtime: failing, factory: w.factory, tickMs: 10, ...shipped() });
    layers.push(decision);
    const tab = await tabOf(w.host);
    tab.answer = async () => ({ outcome: { outcome: "selected", optionId: "allow" } });
    await tab.connection.prompt({ sessionId: tab.sessionId, prompt: [{ type: "text", text: "ls" }] });
    await until(() => spy.mock.calls.length > 0, "the console");
    expect(String(spy.mock.calls[0]![0])).toContain("decision: handling permission.requested");
    tab.hangUp();
  });

  it("DBD2.8 the dispatch planner decides with the layer, and its failures are logged", async () => {
    const w = await world();
    const decision = await layerOn(w);
    const dispatch = decision.dispatch({ small: "S", large: "L" });
    expect(await dispatch.plan({ sessionId: "s1", stepNumber: 1, messages: [{ role: "user", content: "rename it everywhere" }], toolNames: [], contextTokens: 40_000 })).toBe("small");
    dispatch.onError!(new Error("late"), { sessionId: "s1", stepNumber: 1, messages: [], toolNames: [], contextTokens: 0 });
    expect(w.logs).toEqual(["decision: dispatch: late"]);
  });

  it("DBD2.9 members and the judge can be given; with more than one judgment model the ensemble also verifies", async () => {
    const w = await world({ judges: { a: answering(), b: answering() } });
    const verified = await layerOn(w);
    expect((await verified.layer.status()).judge?.id).toBe("ensemble-verifier");
    await verified.close();
    const mine: Member = { id: "mine", version: "v1", ask: async () => ({}) };
    const second = await restart(w, { members: [mine], judge: mine });
    expect(second.decision.layer.members().map((m) => m.id)).toEqual(["mine"]);
    expect((await second.decision.layer.status()).judge?.id).toBe("mine");
    await second.decision.close();
    const third = await restart(w, { judge: false, members: [ensembleMember(w.ensemble)] });
    expect((await third.decision.layer.status()).judge).toBeUndefined();
  });

  it("DBD2.10 with assess the attention fork ranks what the plugin puts in the inbox", async () => {
    const w = await world();
    const decision = await layerOn(w, { assess: true });
    const tab = await tabOf(w.host);
    const { choose, done } = prompt(tab, "ls");
    await until(() => decision.layer.inbox.list().some((i) => i.urgency !== undefined), "the item to be ranked");
    choose("deny");
    await done;
    tab.hangUp();
  });

  it("DBD2.11 the plugin is pumped on a timer at the default period when none is given", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const w = await world();
      const spy = vi.spyOn(globalThis, "setInterval");
      const decision = await browserDecision({ ensemble: w.ensemble, runtime: w.host.runtime, factory: w.factory, log: () => {}, ...shipped() });
      layers.push(decision);
      expect(spy.mock.calls.map((c) => c[1])).toContain(500);
    } finally {
      vi.useRealTimers();
    }
  });
});
