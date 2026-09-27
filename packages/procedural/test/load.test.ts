import { describe, expect, it } from "vitest";

// Imported inside the test, not at the top of the file: a module that throws while it
// loads (a malformed schema) then fails this test instead of silently collecting none.
describe("the package loads", () => {
  it("PG1.44 every module of the package builds its schemas when imported", async () => {
    const pkg = await import("@harness/procedural");
    expect(Object.keys(pkg)).toEqual(expect.arrayContaining(["CandidateDocumentSchema", "OverlayEventSchema", "ScoredTrajectorySchema", "SettingsSchema", "canonicalJson"]));
  });
});
