import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowFiles } from "@harness/platform-native";
import { tool } from "ai";
import { z } from "zod";
import { parseWorkflow, WorkflowHost } from "@harness/workflows";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const count = parseWorkflow({ name: "count", description: "counts", inputs: { type: "object" }, code: "const n = await tools.next({}); return n + input.base;" });

describe("workflow files", () => {
  it("WX1.1 workflows are kept one file each, listed by name; unknown or unsafe names are absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflows-"));
    dirs.push(dir);
    const files = new WorkflowFiles(dir);
    expect(await files.list()).toEqual([]);
    await files.put(count);
    await files.put({ ...count, name: "another" });
    expect((await files.list()).map((w) => w.name)).toEqual(["another", "count"]);
    expect(await files.get("count")).toEqual(count);
    expect(await files.get("../etc/passwd")).toBeUndefined();
    expect(await files.get("missing")).toBeUndefined();
    await expect(new WorkflowFiles(join(dir, "count.json")).list()).rejects.toThrow();
  });

  it("WX1.2 a run's journal is a file, so a run resumes after a restart; run ids cannot escape the directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflows-"));
    dirs.push(dir);
    const files = new WorkflowFiles(dir);
    await files.put(count);
    let calls = 0;
    const host = () => new WorkflowHost({ library: new WorkflowFiles(dir), journal: (r) => files.journal(r), ask: async () => "", tools: { next: tool({ inputSchema: z.object({}).loose(), execute: async () => ++calls }) } });
    expect(await host().run("count", { base: 10 }, "../../escape")).toMatchObject({ status: "completed", output: 11 });
    expect(await host().run("count", { base: 10 }, "../../escape")).toMatchObject({ status: "completed", output: 11, replayed: 1, performed: 0 });
    expect(calls).toBe(1);
    expect(await readdir(join(dir, ".runs"))).toEqual(["%2E%2E%2F%2E%2E%2Fescape.json"]);
  });
});
