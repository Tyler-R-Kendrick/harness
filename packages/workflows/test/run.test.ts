import { describe, expect, it } from "vitest";
import { checkWorkflow, runWorkflow } from "@harness/workflows";
import type { Effects } from "@harness/workflows";
import { MemoryStorage } from "@harness/testkit";

const deploy = `
// Deploy: migrate, deploy, then ask for release notes.
const migrated = await tools.migrate({ env: input.env });
const deployed = await tools.deploy({ env: input.env, after: migrated.version });
const notes = await tools.ask({ prompt: "Release notes for version " + deployed.version });
return { version: deployed.version, notes };`;
const TOOLS = { migrate: {}, deploy: {}, a: {}, b: {}, log: {} };

/** Effects that record what was performed, and can fail on a chosen call. */
function effects(failOn?: string) {
  const performed: string[] = [];
  let failed = false;
  const fx: Effects = {
    tool: async (name, args) => {
      if (name === failOn && !failed) {
        failed = true;
        throw new Error(`${name} is down`);
      }
      performed.push(`${name}:${JSON.stringify(args)}`);
      return { version: name === "migrate" ? 41 : 42 };
    },
    ask: async (prompt) => (performed.push(`ask:${prompt}`), "Fixed the login bug."),
  };
  return { fx, performed };
}
const run = (code: string, fx: Effects = effects().fx, journal = new MemoryStorage(), extra: { timeoutMs?: number } = {}) => runWorkflow({ name: "w", code, input: {}, effects: fx, journal, tools: TOOLS, ...extra });

describe("durable workflows (AI SDK code mode)", () => {
  it("WF1.1 a workflow runs its code in code mode, calling tools and the model through its effects", async () => {
    const { fx, performed } = effects();
    const result = await runWorkflow({ name: "deploy", code: deploy, input: { env: "staging" }, effects: fx, journal: new MemoryStorage(), tools: TOOLS });
    expect(result).toEqual({ status: "completed", output: { version: 42, notes: "Fixed the login bug." }, replayed: 0, performed: 3 });
    expect(performed).toEqual(['migrate:{"env":"staging"}', 'deploy:{"env":"staging","after":41}', "ask:Release notes for version 42"]);
  });

  it("WF1.2 a run that stops on a failing effect resumes by replay: finished steps are not performed again", async () => {
    const journal = new MemoryStorage();
    const { fx, performed } = effects("deploy");
    const go = () => runWorkflow({ name: "deploy", code: deploy, input: { env: "staging" }, effects: fx, journal, tools: TOOLS });
    await expect(go()).rejects.toMatchObject({ message: "deploy is down" });
    expect(await journal.load()).toMatchObject({ status: "running", entries: [{ seq: 0, op: "tool", request: { name: "migrate", args: { env: "staging" } }, result: { version: 41 } }] });
    expect(await go()).toMatchObject({ status: "completed", replayed: 1, performed: 2 });
    expect(performed.filter((p) => p.startsWith("migrate"))).toHaveLength(1);
  });

  it("WF1.3 a finished run returns its recorded output without running again", async () => {
    const journal = new MemoryStorage();
    await runWorkflow({ name: "deploy", code: deploy, input: { env: "staging" }, effects: effects().fx, journal, tools: TOOLS });
    const again = effects();
    expect(await runWorkflow({ name: "deploy", code: deploy, input: { env: "staging" }, effects: again.fx, journal, tools: TOOLS })).toEqual({ status: "completed", output: { version: 42, notes: "Fixed the login bug." }, replayed: 3, performed: 0 });
    expect(again.performed).toEqual([]);
  });

  it("WF1.4 a journal is bound to its code and input, and replay that diverges from it is refused", async () => {
    const journal = new MemoryStorage();
    const { fx } = effects("deploy");
    const go = (code: string, input: unknown) => runWorkflow({ name: "deploy", code, input, effects: fx, journal, tools: TOOLS });
    await expect(go(deploy, { env: "staging" })).rejects.toMatchObject({ message: "deploy is down" });
    await expect(go(`${deploy}\n`, { env: "staging" })).rejects.toThrow("this run was started with other code or input");
    await expect(go(deploy, { env: "prod" })).rejects.toThrow("this run was started with other code or input");
    // A journal whose steps do not match what the code does now (e.g. edited by hand).
    await journal.save({ ...((await journal.load()) as object), entries: [{ seq: 0, op: "tool", request: { name: "rollback", args: {} }, result: null }] });
    await expect(go(deploy, { env: "staging" })).rejects.toThrow('step 1 diverged: the journal has tool {"args":{},"name":"rollback"}, the code asked for tool {"args":{"env":"staging"},"name":"migrate"}');
    await journal.save({ format: "other" });
    await expect(go(deploy, {})).rejects.toThrow(/invalid workflow journal/);
  });

  it("WF1.5 the code is isolated from the host; code that is not deterministic cannot resume with different effects; an error fails the run and is recorded", async () => {
    expect(await run("return typeof fetch + typeof process + typeof require + typeof setTimeout;")).toMatchObject({ status: "completed", output: "undefinedundefinedundefinedundefined" });
    const journal = new MemoryStorage();
    const flaky = effects("b");
    const code = "await tools.log({ r: Math.random() }); return tools.b({});";
    await expect(run(code, flaky.fx, journal)).rejects.toMatchObject({ message: "b is down" });
    await expect(run(code, flaky.fx, journal)).rejects.toThrow(/step 1 diverged: the journal has tool \{"args":\{"r":[0-9.e-]+\},"name":"log"\}/);
    expect(flaky.performed.filter((p) => p.startsWith("log"))).toHaveLength(1);
    const failing = new MemoryStorage();
    expect(await runWorkflow({ name: "w", code: "throw new Error('bad input ' + input.x);", input: { x: 1 }, effects: effects().fx, journal: failing })).toEqual({ status: "failed", error: expect.stringContaining("bad input 1"), replayed: 0, performed: 0 });
    expect(await failing.load()).toMatchObject({ status: "failed", error: expect.stringContaining("bad input 1") });
  });

  it("WF1.6 a workflow that loops forever is stopped by its time limit", async () => {
    expect(await run("for (;;) {}", effects().fx, new MemoryStorage(), { timeoutMs: 300 })).toMatchObject({ status: "failed", error: expect.stringMatching(/timed out/) });
  });

  it("WF1.7 workflow code is checked before it is kept: it must parse (JavaScript or TypeScript); nothing runs", () => {
    expect(checkWorkflow(deploy)).toEqual({ ok: true });
    expect(checkWorkflow("const n: number = await tools.count({}); return n;")).toEqual({ ok: true });
    expect(checkWorkflow("return (")).toMatchObject({ ok: false, error: expect.stringMatching(/^SyntaxError: /) });
    expect(checkWorkflow("throw new Error('top')")).toEqual({ ok: true });
  });

  it("WF1.8 parallel calls are numbered in the order the code makes them, and replay", async () => {
    const journal = new MemoryStorage();
    let slow = true;
    const fx: Effects = {
      // a finishes after b, the first time
      tool: async (name) => (name === "a" && slow ? new Promise((r) => setTimeout(() => r("A"), 30)) : name.toUpperCase()),
      ask: async () => "C",
    };
    const code = "return Promise.all([tools.a({}), tools.b({}), tools.ask({ prompt: 'c' })]);";
    expect(await run(code, fx, journal)).toMatchObject({ status: "completed", output: ["A", "B", "C"], performed: 3 });
    expect(((await journal.load()) as { entries: { seq: number; request: unknown }[] }).entries.map((e) => e.seq)).toEqual([1, 2, 0]);
    slow = false;
    const replay = new MemoryStorage();
    await replay.save({ ...((await journal.load()) as object), status: "running" });
    expect(await run(code, fx, replay)).toMatchObject({ status: "completed", output: ["A", "B", "C"], replayed: 3, performed: 0 });
  });

  it("WF1.9 once an effect fails the run stops: the code cannot catch the failure, and later calls are not performed", async () => {
    const { fx, performed } = effects("a");
    const code = "try { await tools.a({}); } catch (e) { await tools.b({}); return 'caught'; } return 'done';";
    await expect(run(code, fx)).rejects.toMatchObject({ message: "a is down" });
    expect(performed).toEqual([]);
  });

  it("WF1.10 whatever the code throws is reported; code that does not parse fails the run; no result is null", async () => {
    expect(await run("throw 'plain';")).toMatchObject({ status: "failed", error: expect.stringContaining("plain") });
    expect(await run("throw { message: 'no name' };")).toMatchObject({ status: "failed", error: expect.stringContaining("no name") });
    expect(await run("return (")).toMatchObject({ status: "failed", error: expect.stringMatching(/unexpected token/i) });
    expect(await run("")).toMatchObject({ status: "completed", output: null });
  });

  it("WF1.11 a workflow cannot take more than its memory or stack, and the next run is unaffected", async () => {
    expect(await run("return new Array(2e7).fill(1.5).length;")).toMatchObject({ status: "failed", error: expect.stringMatching(/memory/i) });
    expect(await run("function f(n) { return n === 0 ? 0 : 1 + f(n - 1); } return f(1e6);")).toMatchObject({ status: "failed", error: expect.stringMatching(/stack/i) });
    expect(await run("return 1;")).toMatchObject({ status: "completed", output: 1 });
  });

  it("WF1.12 a question can carry a constraint, which is parsed and journaled with it; one that is not a constraint fails the run", async () => {
    const asked: unknown[] = [];
    const fx: Effects = { tool: async () => null, ask: async (prompt, constraint) => (asked.push([prompt, constraint]), "Paris") };
    const journal = new MemoryStorage();
    expect(await run("return tools.ask({ prompt: 'capital?', constraint: { type: 'regex', pattern: '[A-Z][a-z]+' } });", fx, journal)).toMatchObject({ status: "completed", output: "Paris" });
    expect(asked).toEqual([["capital?", { type: "regex", pattern: "[A-Z][a-z]+" }]]);
    expect(await journal.load()).toMatchObject({ entries: [{ op: "ask", request: { prompt: "capital?", constraint: { type: "regex", pattern: "[A-Z][a-z]+" } } }] });
    expect(await run("return tools.ask({ prompt: 'x', constraint: { type: 'telepathy' } });", fx)).toMatchObject({ status: "failed", error: expect.stringMatching(/not one/) });
  });

  it("WF1.13 tools are only those offered, each call checked against its input schema; none may be named ask", async () => {
    const seen: unknown[] = [];
    const fx: Effects = { tool: async (name, args) => (seen.push([name, args]), "ok"), ask: async () => "" };
    expect(await runWorkflow({ name: "w", code: "return tools.nope({});", input: {}, effects: fx, journal: new MemoryStorage() })).toMatchObject({ status: "failed", error: expect.stringMatching(/Unknown tool: nope/) });
    const typed = { add: { description: "Adds.", inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } } };
    expect(await runWorkflow({ name: "w", code: "return tools.add({ n: 'x' });", input: {}, effects: fx, journal: new MemoryStorage(), tools: typed })).toMatchObject({ status: "failed" });
    expect(await runWorkflow({ name: "w", code: "return tools.add({ n: 1 });", input: {}, effects: fx, journal: new MemoryStorage(), tools: typed })).toMatchObject({ status: "completed", output: "ok" });
    expect(seen).toEqual([["add", { n: 1 }]]);
    await expect(runWorkflow({ name: "w", code: "", input: {}, effects: fx, journal: new MemoryStorage(), tools: { ask: {} } })).rejects.toThrow("a tool cannot be named ask: tools.ask is the model");
  });

  it("WF1.14 a journal matches requests whatever the order of their keys", async () => {
    const journal = new MemoryStorage();
    const { fx, performed } = effects("b");
    const code = "const r = await tools.a({ y: 1, x: 2 }); return tools.b(r);";
    await expect(run(code, fx, journal)).rejects.toMatchObject({ message: "b is down" });
    // the same request, saved with its keys in another order
    const saved = (await journal.load()) as { entries: { request: unknown }[] };
    await journal.save({ ...saved, entries: [{ ...saved.entries[0], request: { args: { x: 2, y: 1 }, name: "a" } }] });
    expect(await run(code, fx, journal)).toMatchObject({ status: "completed", replayed: 1, performed: 1 });
    expect(performed.filter((p) => p.startsWith("a:"))).toHaveLength(1);
  });

  it("WF1.15 a finished run is not run again: its recorded output is returned even from code that would answer differently", async () => {
    const journal = new MemoryStorage();
    const first = await run("return Math.random();", effects().fx, journal);
    expect(await run("return Math.random();", effects().fx, journal)).toEqual(first);
  });

  it("WF1.16 the journal names its format; a failed run's journal loads again and the run fails the same way", async () => {
    const journal = new MemoryStorage();
    const failed = await run("throw new Error('no');", effects().fx, journal);
    expect(await journal.load()).toMatchObject({ format: "harness.workflow-run/v2", workflow: "w", status: "failed", error: "Error: no" });
    expect(await run("throw new Error('no');", effects().fx, journal)).toEqual(failed);
  });

  it("WF1.17 a given time limit applies: code within the default limit but past it fails", async () => {
    const code = "let n = 0; for (let i = 0; i < 5e6; i++) n += i; return 'done';";
    expect(await run(code, effects().fx, new MemoryStorage(), { timeoutMs: 50 })).toMatchObject({ status: "failed", error: expect.stringMatching(/timed out after 50ms/) });
    expect(await run(code)).toMatchObject({ status: "completed", output: "done" });
  });

  it("WF1.18 a failure says what the code threw, and adds a tool's own error only when a tool call is what failed", async () => {
    expect(await run("throw new Error('mine');")).toEqual({ status: "failed", error: "Error: mine", replayed: 0, performed: 0 });
    const caught = "try { await tools.ask({ prompt: 'x', constraint: { type: 'telepathy' } }); } catch { throw new Error('mine'); }";
    expect(await run(caught)).toEqual({ status: "failed", error: "Error: mine", replayed: 0, performed: 0 });
    expect(await run("return tools.ask({ prompt: 'x', constraint: 3 });")).toMatchObject({ status: "failed", error: expect.stringMatching(/Host tool failed.* tools\.ask was given a constraint that is not one: 3$/s) });
  });

  it("WF1.19 a call the code makes after another has failed is not performed", async () => {
    const performed: string[] = [];
    const fx: Effects = {
      tool: async (name) => {
        if (name === "a") throw new Error("a is down");
        if (name === "wait") await new Promise((r) => setTimeout(r, 50));
        performed.push(name);
        return null;
      },
      ask: async () => "",
    };
    const code = "const late = (async () => { await tools.wait({}); return tools.b({}); })(); await tools.a({}); return late;";
    await expect(runWorkflow({ name: "w", code, input: {}, effects: fx, journal: new MemoryStorage(), tools: { a: {}, b: {}, wait: {} } })).rejects.toMatchObject({ message: "a is down" });
    await new Promise((r) => setTimeout(r, 100));
    expect(performed).toEqual(["wait"]);
  });
});
