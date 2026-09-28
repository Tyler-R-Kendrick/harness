import { describe, expect, it } from "vitest";
import { Dialogue } from "@harness/dialogue";
import type { Decision, Outcome, Step } from "@harness/dialogue";
import { settings, textModel, vectorEmbedder } from "./helpers.ts";

async function answered(d: Dialogue, s: Step, outcome: Outcome): Promise<Decision> {
  const decision = await d.respond(s);
  d.observe(s, decision, outcome);
  await d.idle();
  return decision;
}
const at = (scope: string | undefined, utterance: string, sessionId = "s-1"): Step => ({ sessionId, utterance, ...(scope === undefined ? {} : { scope }) });

describe("scopes: what is learned in a project answers there", () => {
  it("SC1.1 a scoped script answers only steps in its scope; one without a scope answers in every scope", async () => {
    const d = new Dialogue({
      settings: settings(),
      book: { scripts: [{ id: "config", intent: "c", scope: "/repo/a", patterns: ["where is the config"], reply: ["In a.toml."] }, { id: "hi", intent: "h", patterns: ["hi"], reply: ["Hi."] }] },
    });
    expect(await d.respond(at("/repo/a", "where is the config"))).toMatchObject({ kind: "reply", script: "config" });
    expect(await d.respond(at("/repo/b", "where is the config"))).toMatchObject({ kind: "pass" });
    expect(await d.respond(at(undefined, "where is the config"))).toMatchObject({ kind: "pass" });
    expect(await d.respond(at("/repo/b", "hi"))).toMatchObject({ kind: "reply", script: "hi" });
  });

  it("SC1.2 steps are clustered within their scope, and a script built from them keeps the scope", async () => {
    const d = new Dialogue({ settings: settings() });
    for (const [n, s] of [[1, "a"], [2, "b"]] as const) await answered(d, at("/repo/a", `where is my order number ${n}`, s), `Checking order ${n}.`);
    await answered(d, at("/repo/b", "where is my order number 3", "c"), "Checking order 3.");
    expect(d.script("s1")).toMatchObject({ scope: "/repo/a" });
    expect((d.save() as { clusters: { scope?: string }[] }).clusters.map((c) => c.scope)).toEqual(["/repo/a", "/repo/b"]);
    await answered(d, at("/repo/b", "where is my order number 4", "d"), "Checking order 4.");
    expect(d.script("s2")).toMatchObject({ scope: "/repo/b" });
  });

  it("SC1.3 a result script, and a tool's cluster, are scoped too", async () => {
    const d = new Dialogue({ settings: settings(), book: { scripts: [{ id: "track", intent: "t", scope: "/repo/a", result: { tool: "track" }, reply: ["Found."] }] } });
    const result = (scope: string, sessionId: string) => ({ ...at(scope, "how is it", sessionId), result: { tool: "track", input: {}, output: {} } });
    expect(await d.respond(result("/repo/a", "a"))).toMatchObject({ kind: "reply", script: "track" });
    await answered(d, result("/repo/b", "a"), "Here.");
    await answered(d, result("/repo/c", "b"), "There.");
    expect((d.save() as { clusters: { scope?: string; tool?: string }[] }).clusters).toMatchObject([{ tool: "track", scope: "/repo/b" }, { tool: "track", scope: "/repo/c" }]);
  });

  it("SC1.4 a drafted script and its follow-ups keep the scope of the steps drafted from", async () => {
    const drafter = textModel(() => JSON.stringify({ intent: "i", exemplars: ["e"], slots: [], reply: [{ text: "We're open from " }, { generate: "time" }, { text: "." }], followUps: [{ intent: "f", exemplars: ["f"], slots: [], reply: [{ text: "F." }] }] }));
    const d = new Dialogue({ settings: settings({ induce: { determined: 0.4 } }), drafter, embedder: vectorEmbedder({}) });
    await answered(d, at("/p", "when do you open", "a"), "We're open from nine in the morning.");
    await answered(d, at("/p", "when do you open", "b"), "Doors open at 9am, see you then!");
    expect(d.scripts.map((s) => s.scope)).toEqual(["/p", "/p"]);
  });

  it("SC1.5 a retired shape without a scope is not built again in any scope; a scoped one only in its own", async () => {
    const teach = async (d: Dialogue, scope: string | undefined, sessions: readonly string[]) => {
      for (const [i, s] of sessions.entries()) await answered(d, at(scope, `where is my order number ${i + 1}`, s), `Checking order ${i + 1}.`);
    };
    const d = new Dialogue({ settings: settings({ promote: { retireMargin: 1 } }) });
    await teach(d, undefined, ["a", "b"]);
    d.feedback("s1", "harmful");
    await teach(d, "/repo", ["c", "d"]);
    expect(d.scripts.map((s) => s.id)).toEqual(["s1"]);
    const e = new Dialogue({ settings: settings({ promote: { retireMargin: 1 } }) });
    await teach(e, "/a", ["a", "b"]);
    e.feedback("s1", "harmful");
    await teach(e, "/b", ["c", "d"]);
    expect(e.scripts.map((s) => [s.id, s.scope])).toEqual([
      ["s1", "/a"],
      ["s2", "/b"],
    ]);
  });
});
