import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CandidateDocumentSchema, FORMAT, GraphIdSchema, revisionId, RevisionRecordSchema, seedGraph } from "@harness/procedural";
import { proceduralStore } from "@harness/platform-native";

const run = promisify(execFile);
const CLI = new URL("../src/procedural-cli.ts", import.meta.url).pathname;
const env = { PATH: process.env["PATH"] ?? "", NODE_OPTIONS: "" };
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const expert = {
  format: FORMAT,
  nodeTypes: ["ACTION", "REASONING", "STATUS"],
  relations: ["LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO"],
  nodes: [
    { id: "Start", type: "STATUS", description: "The task begins." },
    { id: "search", type: "ACTION", description: "Search the index." },
    { id: "End", type: "STATUS", description: "Answered." },
  ],
  edges: [
    { from: "Start", relation: "LEADS_TO", to: "search", condition: null, guidance: "Search first.", pitfalls: "" },
    { from: "search", relation: "LEADS_TO", to: "End", condition: "found", guidance: "Answer.", pitfalls: "" },
  ],
};

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "procedural-cli-"));
  dirs.push(dir);
  const cli = async (...args: string[]) => run(process.execPath, [CLI, ...args, "--procedural", join(dir, "store")], { env });
  const json = async (...args: string[]) => JSON.parse((await cli(...args)).stdout) as Record<string, unknown>;
  return { dir, cli, json };
}

describe("harness-procedural CLI", () => {
  it("PX2.45 import makes a graph file head, a second import is proposed, history lists both, and export prints JSON or Mermaid", async () => {
    const { dir, cli, json } = await setup();
    const file = join(dir, "graph.json");
    await writeFile(file, JSON.stringify(expert));
    const head = revisionId(CandidateDocumentSchema.parse(expert));
    expect(await json("import", "team/search", file)).toEqual({ status: "head", revision: head });
    expect(await json("import", "team/search")).toEqual({ status: "proposed", revision: revisionId(seedGraph()), head });
    const history = await json("history", "team/search");
    expect(history).toMatchObject({ head, heads: [head], revisions: [{ id: head, origin: "import" }, { id: revisionId(seedGraph()), decision: { kind: "pending-approval" } }] });
    expect(JSON.parse((await cli("export", "team/search")).stdout)).toEqual(expert);
    expect((await cli("export", "team/search", "--format", "mermaid")).stdout).toContain('  n1 -->|"LEADS_TO<br/>when: found"| n2');
    await cli("export", "team/search", "--format", "mermaid", "--no-overlay", "--out", join(dir, "graph.mmd"));
    expect(await readFile(join(dir, "graph.mmd"), "utf8")).toMatch(/^flowchart TD\n/);
  });

  it("PX2.46 revert moves the head back to an earlier head in the store the daemon uses", async () => {
    const { dir, json } = await setup();
    const graph = GraphIdSchema.parse("team/search");
    const store = proceduralStore(join(dir, "store"));
    const seed = revisionId(seedGraph());
    const next = CandidateDocumentSchema.parse(expert);
    await store.revisions.put(RevisionRecordSchema.parse({ id: seed, graph, parents: [], document: seedGraph(), edits: null, origin: "import", evidence: {}, decision: { kind: "head" }, at: 0 }));
    await store.heads.set(graph, undefined, seed);
    await store.revisions.put(RevisionRecordSchema.parse({ id: revisionId(next), graph, parents: [seed], document: next, edits: null, origin: "dream", evidence: {}, decision: { kind: "head" }, at: 1 }));
    await store.heads.set(graph, seed, revisionId(next));
    expect(await json("revert", "team/search")).toEqual({ status: "reverted", from: revisionId(next), to: seed });
    expect(await json("history", "team/search")).toMatchObject({ head: seed, heads: [seed, revisionId(next), seed], revisions: [{ id: seed, origin: "import" }, { id: revisionId(next), origin: "dream" }] });
  });

  it("PX2.47 results a caller handles exit 1 with the result; a dream that cannot run (no head) exits 1; bad usage exits 2", async () => {
    const { dir, cli } = await setup();
    await expect(cli("export", "none")).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("graph none has no head") });
    await expect(cli("revert", "none")).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"refused"') });
    await writeFile(join(dir, "bad.json"), JSON.stringify({ format: "other" }));
    await expect(cli("import", "g", join(dir, "bad.json"))).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"invalid"') });
    await expect(cli("dream", "g", "--no-hosted", "--model-cache", join(dir, "models"), "--state", join(dir, "absent-state.json"))).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("no-head") });
    await expect(cli("export", "Not A Graph")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("invalid procedural.export input") });
    await expect(cli("frobnicate", "g")).rejects.toMatchObject({ code: 2 });
    await expect(cli("history")).rejects.toMatchObject({ code: 2 });
    await expect(cli("history", "g", "extra")).rejects.toMatchObject({ code: 2 });
  });

  it("PX2.62 dream with a model (and optionally the daemon's state file for logs) runs the host's dream: a graph with no head is a result the caller handles", async () => {
    const { dir, cli } = await setup();
    await writeFile(join(dir, "state.json"), JSON.stringify({ version: 1, sessions: [], hooks: {} }));
    await expect(cli("dream", "g", "--model", "provider/model", "--state", join(dir, "state.json"))).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"status": "no-head"') });
    await expect(cli("dream", "g", "--model", "provider/model")).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"no-head"') });
  });
});
