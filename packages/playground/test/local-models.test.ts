import { describe, expect, it } from "vitest";
import { bytes } from "@harness/cognitive";
import { LocalModels } from "../src/local-models.ts";
import type { Role } from "../src/local-models.ts";
import type { Capabilities, Past } from "../src/model-choice.ts";

const SETTINGS = { gpuBytes: bytes(100_000_000), headroom: 1.5 };
const GPU: Capabilities = { webgpu: true, freeBytes: 10_000_000_000, saveData: false };
const ROLE: Role = { kind: "thing", command: "pick", alone: { slug: "alone", status: "stand-in alone" }, instead: "the stand-in serves", fellBack: "fell back" };
const model = (id: string, size: number) => ({ id, name: id.toUpperCase(), downloadBytes: bytes(size), locality: "local" as const });
const first = model("first", 36_000_000);
const second = model("second", 30_000_000);

/** Models whose loads the test settles by hand. */
function harness(past: (id: string) => Past | undefined = () => undefined) {
  const loads: { id: string; ok: (port: string) => void; fail: (reason: string) => void }[] = [];
  const changes: string[] = [];
  const models = new LocalModels<string>({
    ranked: [first, second],
    settings: SETTINGS,
    past,
    load: (m) => new Promise((ok, fail) => loads.push({ id: m.id, ok, fail: (reason) => fail(new Error(reason)) })),
    onChange: (m) => changes.push(`${m.id}:${m.phase()}`),
    role: ROLE,
  });
  models.detected(GPU);
  return { models, loads, changes };
}

describe("a role's local models", () => {
  it("LM1.1 ready() during loading waits for the load and answers its port; ready() again answers it at once", async () => {
    const { models, loads } = harness();
    const waiting = models.ready("first");
    expect(loads.map((l) => l.id)).toEqual(["first"]);
    expect(models.phase("first")).toBe("loading");
    loads[0]!.ok("port-1");
    expect(await waiting).toBe("port-1");
    expect(await models.ready("first")).toBe("port-1");
    expect(loads).toHaveLength(1);
  });

  it("LM1.2 ready() after a failed load answers nothing without loading it again, and says why", async () => {
    const { models, loads } = harness();
    const waiting = models.ready("first");
    loads[0]!.fail("no memory");
    expect(await waiting).toBeUndefined();
    expect(await models.ready("first")).toBeUndefined();
    expect(loads).toHaveLength(1);
    expect(models.status("first")).toContain("could not load (no memory)");
  });

  it("LM1.3 auto moves past the model that failed to load to the next that fits, and answers that one's port", async () => {
    const { models, loads } = harness();
    const waiting = models.ready("auto");
    expect(loads.map((l) => l.id)).toEqual(["first"]);
    loads[0]!.fail("no memory");
    await Promise.resolve();
    await Promise.resolve();
    expect(loads.map((l) => l.id)).toEqual(["first", "second"]);
    loads[1]!.ok("port-2");
    expect(await waiting).toBe("port-2");
    expect(models.current("auto")?.id).toBe("second");
  });

  it("LM1.4 a named slug that fails answers nothing rather than moving on to another model", async () => {
    const { models, loads } = harness();
    const waiting = models.ready("first");
    loads[0]!.fail("boom");
    expect(await waiting).toBeUndefined();
    expect(loads.map((l) => l.id)).toEqual(["first"]);
  });

  it("LM1.5 want() loads auto's pick on its own; a named model only when asked, or when the browser did not refuse to keep it", () => {
    const named = harness();
    named.models.want("first", false);
    expect(named.loads.map((l) => l.id)).toEqual(["first"]);
    const refused = harness((id) => (id === "first" ? { kept: false, reason: "QuotaExceededError" } : undefined));
    refused.models.want("first", false);
    expect(refused.loads).toEqual([]);
    refused.models.want("first", true);
    expect(refused.loads.map((l) => l.id)).toEqual(["first"]);
    const auto = harness();
    auto.models.want("auto", false);
    expect(auto.loads.map((l) => l.id)).toEqual(["first"]);
  });

  it("LM1.6 every load, ready and failure is announced with the model it happened to", async () => {
    const { models, loads, changes } = harness();
    const waiting = models.ready("first");
    loads[0]!.ok("port");
    await waiting;
    expect(changes).toEqual(["first:loading", "first:ready"]);
  });
});
