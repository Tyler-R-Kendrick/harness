import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowFiles } from "@harness/platform-native";

const run = promisify(execFile);
const CLI = new URL("../src/workflow-cli.ts", import.meta.url).pathname;
const env = { PATH: process.env["PATH"] ?? "", NODE_OPTIONS: "" };
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("harness-workflow CLI", () => {
  it("WC1.1 runs a workflow file durably, with library workflows as tools; running it again returns the recorded result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-"));
    dirs.push(dir);
    await new WorkflowFiles(join(dir, "lib")).put({ name: "double", description: "", inputs: {}, code: "return input.n * 2;" });
    const file = join(dir, "workflow.json");
    await writeFile(file, JSON.stringify({ name: "quadruple", description: "", inputs: {}, code: "const d = await tools.double({ n: input.n }); return await tools.double({ n: d });" }));
    const args = ["run", file, "--run", "r1", "--input", '{"n":3}', "--library", join(dir, "lib"), "--no-hosted"];
    const first = JSON.parse((await run(process.execPath, [CLI, ...args], { env })).stdout);
    expect(first).toEqual({ status: "completed", output: 12, replayed: 0, performed: 2 });
    const second = JSON.parse((await run(process.execPath, [CLI, ...args], { env })).stdout);
    expect(second).toEqual({ status: "completed", output: 12, replayed: 2, performed: 0 });
  });

  it("WC1.2 a failing workflow exits 1 with its error (a missing tool is one); a failing library workflow keeps the run to resume; bad usage exits 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-"));
    dirs.push(dir);
    const file = join(dir, "workflow.json");
    await writeFile(file, JSON.stringify({ name: "fails", description: "", inputs: {}, code: "throw new Error('nope');" }));
    await expect(run(process.execPath, [CLI, "run", file, "--run", "r1"], { env })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("Error: nope") });
    await writeFile(file, JSON.stringify({ name: "needs-tool", description: "", inputs: {}, code: "return tools.absent({});" }));
    await expect(run(process.execPath, [CLI, "run", file, "--run", "r2"], { env })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("Unknown tool: absent") });
    await new WorkflowFiles(join(dir, "lib")).put({ name: "broken", description: "", inputs: {}, code: "throw new Error('down');" });
    await writeFile(file, JSON.stringify({ name: "calls-broken", description: "", inputs: {}, code: "return tools.broken({});" }));
    await expect(run(process.execPath, [CLI, "run", file, "--run", "r3", "--library", join(dir, "lib")], { env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("run the same command again to resume") });
    await expect(run(process.execPath, [CLI, "run", file], { env })).rejects.toMatchObject({ code: 2 });
  });
});
