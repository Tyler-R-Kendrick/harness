import { describe, expect, it } from "vitest";
import { compilePack, parseGraph, parsePack, serializePack } from "@harness/behavior";
import { axisSae, guide, guideSpec } from "./fixtures.ts";

describe("behavior packs", () => {
  it("BP1.1 compiling keeps only the SAE rows the graph uses and precomputes each state's steering", () => {
    const asked: string[] = [];
    const sae = axisSae();
    const pack = compilePack(guide, {
      ...sae,
      encoder: (i) => (asked.push(`enc${i}`), sae.encoder(i)),
      decoder: (i) => (asked.push(`dec${i}`), sae.decoder(i)),
    });
    expect(asked.sort()).toEqual(["dec2", "dec3", "enc0", "enc1"]);
    expect(pack.sense.map((s) => s.feature)).toEqual(["threat", "question"]);
    expect(Object.fromEntries(Object.entries(pack.steering).map(([k, v]) => [k, v ? Array.from(v) : v]))).toEqual({
      calm: [0, 0, 2, 0],
      curious: [0, 0, 3, 0],
      guarded: [0, 0, -1, 4],
    });
  });

  it("BP1.2 compiling refuses features beyond the SAE's width, or rows of the wrong length, whole", () => {
    const wide = parseGraph({ ...guideSpec, features: { ...guideSpec.features, threat: 99 } });
    expect(() => compilePack(wide, axisSae())).toThrow(/99.*width 16/);
    expect(() => compilePack(guide, { ...axisSae(), decoder: () => new Float32Array(3) })).toThrow(/decoder row.*4/);
  });

  it("BP1.3 a pack survives serialization as JSON, floats and all", () => {
    const pack = compilePack(guide, axisSae());
    const text = serializePack(pack);
    expect(typeof JSON.parse(text)).toBe("object");
    expect(parsePack(text)).toEqual(pack);
  });

  it("BP1.4 parsing refuses a tampered pack whole", () => {
    const good = JSON.parse(serializePack(compilePack(guide, axisSae()))) as Record<string, unknown>;
    const bad = (patch: (p: Record<string, unknown>) => void) => {
      const p = structuredClone(good);
      patch(p);
      return JSON.stringify(p);
    };
    expect(() => parsePack("not json")).toThrow(/JSON/);
    expect(() => parsePack(bad((p) => ((p["format"] as unknown) = "other")))).toThrow(/format/);
    expect(() => parsePack(bad((p) => ((p["graph"] as { initial: string }).initial = "asleep")))).toThrow(/initial state asleep/);
    expect(() => parsePack(bad((p) => ((p["dims"] as number) = 5)))).toThrow(/expected 5/);
    expect(() => parsePack(bad((p) => ((p["steering"] as Record<string, unknown>)["calm"] = "AAAAAA==")))).toThrow(/steering/);
    expect(() => parsePack(bad((p) => ((p["sense"] as { threshold: number }[])[0]!.threshold = Number.NaN)))).toThrow(/finite|threshold/);
  });
});
