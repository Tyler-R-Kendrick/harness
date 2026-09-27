import { describe, expect, it } from "vitest";
import { MemoryLibrary, parseWorkflow } from "@harness/workflows";
import type { WorkflowLibrary } from "@harness/workflows";
import { StagingLibrary } from "@harness/procedural";

// The staging library is a WorkflowLibrary: a WorkflowHost runs from it as from any
// other. These are the port's behaviors, held against the shared library's memory
// implementation and the staging library (on its default store and on one given to it).
const IMPLEMENTATIONS: [string, () => WorkflowLibrary][] = [
  ["MemoryLibrary", () => new MemoryLibrary()],
  ["StagingLibrary", () => new StagingLibrary()],
  ["StagingLibrary over a library of its own", () => new StagingLibrary(new MemoryLibrary())],
];

const workflow = (name: string) => parseWorkflow({ name, description: `the ${name} workflow`, inputs: { type: "object" }, code: `return ${JSON.stringify(name)};` });

describe.each(IMPLEMENTATIONS)("WorkflowLibrary contract (%s)", (_, make) => {
  it("PC1.C1 a workflow put is got back by name; an unknown name is undefined", async () => {
    const library = make();
    expect(await library.get("absent")).toBeUndefined();
    await library.put(workflow("greet"));
    expect(await library.get("greet")).toEqual(workflow("greet"));
  });

  it("PC1.C2 list gives every workflow, sorted by name", async () => {
    const library = make();
    for (const name of ["zeta", "alpha", "mid"]) await library.put(workflow(name));
    expect((await library.list()).map((w) => w.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("PC1.C3 a workflow that does not parse is refused and not kept", async () => {
    const library = make();
    await expect(library.put({ ...workflow("ok"), name: "Not Kebab" })).rejects.toThrow(/invalid workflow/);
    expect(await library.list()).toEqual([]);
  });
});
