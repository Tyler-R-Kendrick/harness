import { describe, expect, it } from "vitest";
import { checkWorkflow, runWorkflow } from "@harness/workflows";
import type { Effects } from "@harness/workflows";
import { MemoryStorage } from "@harness/testkit";

const deploy = `
// Deploy: migrate, deploy, then ask for release notes.
async function workflow(input, ctx) {
  const migrated = await ctx.tool("migrate", { env: input.env });
  const deployed = await ctx.tool("deploy", { env: input.env, after: migrated.version });
  const notes = await ctx.ask("Release notes for version " + deployed.version);
  return { version: deployed.version, notes };
}`;

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

describe("durable workflows", () => {
  it("WF1.1 a workflow runs its code in the sandbox, calling tools and the model through its effects", async () => {
    const { fx, performed } = effects();
    const result = await runWorkflow({ name: "deploy", code: deploy, input: { env: "staging" }, effects: fx, journal: new MemoryStorage() });
    expect(result).toEqual({ status: "completed", output: { version: 42, notes: "Fixed the login bug." }, replayed: 0, performed: 3 });
    expect(performed).toEqual(['migrate:{"env":"staging"}', 'deploy:{"env":"staging","after":41}', "ask:Release notes for version 42"]);
  });

  it("WF1.2 a run that stops on a failing effect resumes by replay: finished steps are not performed again", async () => {
    const journal = new MemoryStorage();
    const { fx, performed } = effects("deploy");
    await expect(runWorkflow({ name: "deploy", code: deploy, input: { env: "staging" }, effects: fx, journal })).rejects.toThrow("deploy is down");
    expect(await journal.load()).toMatchObject({ status: "running", entries: [{ op: "tool", request: { name: "migrate", args: { env: "staging" } }, result: { version: 41 } }] });
    const resumed = await runWorkflow({ name: "deploy", code: deploy, input: { env: "staging" }, effects: fx, journal });
    expect(resumed).toMatchObject({ status: "completed", replayed: 1, performed: 2 });
    expect(performed.filter((p) => p.startsWith("migrate"))).toHaveLength(1);
  });

  it("WF1.3 a finished run returns its recorded output without running again", async () => {
    const journal = new MemoryStorage();
    const first = effects();
    await runWorkflow({ name: "deploy", code: deploy, input: { env: "staging" }, effects: first.fx, journal });
    const again = effects();
    expect(await runWorkflow({ name: "deploy", code: deploy, input: { env: "staging" }, effects: again.fx, journal })).toEqual({ status: "completed", output: { version: 42, notes: "Fixed the login bug." }, replayed: 3, performed: 0 });
    expect(again.performed).toEqual([]);
  });

  it("WF1.4 a journal is bound to its code and input, and replay that diverges from it is refused", async () => {
    const journal = new MemoryStorage();
    const { fx } = effects("deploy");
    await expect(runWorkflow({ name: "deploy", code: deploy, input: { env: "staging" }, effects: fx, journal })).rejects.toThrow();
    await expect(runWorkflow({ name: "deploy", code: `${deploy}\n`, input: { env: "staging" }, effects: fx, journal })).rejects.toThrow("this run was started with other code or input");
    await expect(runWorkflow({ name: "deploy", code: deploy, input: { env: "prod" }, effects: fx, journal })).rejects.toThrow("this run was started with other code or input");
    // A journal whose steps do not match what the code does now (e.g. edited by hand).
    await journal.save({ ...((await journal.load()) as object), entries: [{ op: "tool", request: { name: "rollback", args: {} }, result: null }] });
    await expect(runWorkflow({ name: "deploy", code: deploy, input: { env: "staging" }, effects: fx, journal })).rejects.toThrow('step 1 diverged: the journal has tool {"args":{},"name":"rollback"}, the code asked for tool {"args":{"env":"staging"},"name":"migrate"}');
    await journal.save({ format: "other" });
    await expect(runWorkflow({ name: "deploy", code: deploy, input: {}, effects: fx, journal })).rejects.toThrow(/invalid workflow journal/);
  });

  it("WF1.5 workflow code is deterministic: no clock, no randomness, no host; an error in it fails the run and is recorded", async () => {
    const run = (code: string) => runWorkflow({ name: "w", code, input: {}, effects: effects().fx, journal: new MemoryStorage() });
    expect(await run("async function workflow() { return Math.random(); }")).toMatchObject({ status: "failed", error: expect.stringMatching(/Math.random is not available in a workflow/) });
    expect(await run("async function workflow() { return Date.now(); }")).toMatchObject({ status: "failed", error: expect.stringMatching(/Date is not available in a workflow/) });
    expect(await run("async function workflow() { return new Date(); }")).toMatchObject({ status: "failed", error: expect.stringMatching(/Date is not available/) });
    expect(await run("async function workflow() { return typeof fetch + typeof process + typeof require + typeof setTimeout; }")).toMatchObject({ status: "completed", output: "undefinedundefinedundefinedundefined" });
    const journal = new MemoryStorage();
    expect(await runWorkflow({ name: "w", code: "async function workflow(input) { throw new Error('bad input ' + input.x); }", input: { x: 1 }, effects: effects().fx, journal })).toEqual({ status: "failed", error: "Error: bad input 1", replayed: 0, performed: 0 });
    expect(await journal.load()).toMatchObject({ status: "failed", error: "Error: bad input 1" });
  });

  it("WF1.6 a workflow that loops forever is stopped by its budget", async () => {
    const result = await runWorkflow({ name: "w", code: "function workflow() { for (;;) {} }", input: {}, effects: effects().fx, journal: new MemoryStorage(), budget: 1000 });
    expect(result).toMatchObject({ status: "failed", error: expect.stringMatching(/interrupted/) });
  });

  it("WF1.7 workflow code is checked before it is kept: it must compile and define workflow(input, ctx)", async () => {
    expect(await checkWorkflow(deploy)).toEqual({ ok: true });
    expect(await checkWorkflow("async function workflow( {")).toMatchObject({ ok: false, error: expect.stringMatching(/SyntaxError/) });
    expect(await checkWorkflow("const x = 1;")).toEqual({ ok: false, error: "the code does not define function workflow(input, ctx)" });
    expect(await checkWorkflow("throw new Error('top')")).toMatchObject({ ok: false, error: expect.stringMatching(/top/) });
  });

  it("WF1.8 a workflow awaiting something that never settles fails instead of hanging; parallel effects run in call order", async () => {
    const hang = await runWorkflow({ name: "w", code: "async function workflow() { await new Promise(() => {}); }", input: {}, effects: effects().fx, journal: new MemoryStorage() });
    expect(hang).toMatchObject({ status: "failed", error: "the workflow is waiting on nothing: it can never finish" });
    const { fx, performed } = effects();
    const parallel = await runWorkflow({ name: "w", code: "async function workflow(i, ctx) { return Promise.all([ctx.tool('a', {}), ctx.tool('b', {}), ctx.ask('c')]); }", input: {}, effects: fx, journal: new MemoryStorage() });
    expect(parallel).toMatchObject({ status: "completed", performed: 3 });
    expect(performed).toEqual(["a:{}", "b:{}", "ask:c"]);
  });

  it("WF1.9 once an effect fails, the calls already made after it are not performed, and the code cannot catch the failure", async () => {
    const { fx, performed } = effects("a");
    const code = "async function workflow(i, ctx) { const p = [ctx.tool('a', {}), ctx.tool('b', {})]; try { await p[0]; } catch (e) { return 'caught'; } return p[1]; }";
    await expect(runWorkflow({ name: "w", code, input: {}, effects: fx, journal: new MemoryStorage() })).rejects.toThrow("a is down");
    expect(performed).toEqual([]);
  });
});
