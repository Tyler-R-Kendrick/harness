import { describe, expect, it } from "vitest";
import { bytes } from "@harness/cognitive";
import { chooseModel, unfit } from "../src/model-choice.ts";
import type { Capabilities } from "../src/model-choice.ts";

const FIT = { gpuBytes: bytes(100_000_000), headroom: 1.5 };
const GPU: Capabilities = { webgpu: true, freeBytes: 10_000_000_000, saveData: false };
const big = { id: "org/big", downloadBytes: bytes(600_000_000), locality: "local" as const };
const small = { id: "org/small", downloadBytes: bytes(36_000_000), locality: "local" as const };
const hosted = { id: "org/hosted", downloadBytes: bytes(0), locality: "hosted" as const };

describe("choosing a model for what this browser can run (local first)", () => {
  it("MC1.1 a local model fits a browser with WebGPU and room for it; a hosted one downloads nothing and always fits", () => {
    expect(unfit(big, GPU, FIT)).toBeUndefined();
    expect(unfit(hosted, { webgpu: false, freeBytes: 0, saveData: true }, FIT)).toBeUndefined();
  });

  it("MC1.2 a local model does not fit when the browser asks to save data, has no WebGPU for a large model, has too little room, or did not keep it last time", () => {
    expect(unfit(big, { ...GPU, saveData: true }, FIT)).toBe("this browser asks to save data");
    expect(unfit(big, { ...GPU, webgpu: false }, FIT)).toBe("no WebGPU adapter for a 600 MB model");
    // A model under the WebGPU threshold runs on WebAssembly.
    expect(unfit(small, { ...GPU, webgpu: false }, FIT)).toBeUndefined();
    expect(unfit(big, { ...GPU, freeBytes: 800_000_000 }, FIT)).toBe("800 MB free for a 600 MB download");
    expect(unfit(big, { ...GPU, freeBytes: 900_000_000 }, FIT)).toBeUndefined();
    // A browser that does not say how much room it has is not refused for it.
    expect(unfit(big, { ...GPU, freeBytes: undefined }, FIT)).toBeUndefined();
    expect(unfit(big, GPU, FIT, { kept: false, reason: "QuotaExceededError" })).toBe("not kept in this browser last time (QuotaExceededError)");
  });

  it("MC1.3 the choice is the best-ranked candidate that fits, and says why the ones before it were skipped; with none, nothing is chosen", () => {
    const noGpu = { ...GPU, webgpu: false };
    expect(chooseModel([big, small, hosted], noGpu, FIT, () => undefined)).toEqual({ model: small, skipped: [{ id: "org/big", reason: "no WebGPU adapter for a 600 MB model" }] });
    expect(chooseModel([big, small], GPU, FIT, () => undefined)).toEqual({ model: big, skipped: [] });
    expect(chooseModel([big], noGpu, FIT, () => undefined)).toEqual({ skipped: [{ id: "org/big", reason: "no WebGPU adapter for a 600 MB model" }] });
    expect(chooseModel([big, small], GPU, FIT, (id) => (id === "org/big" ? { kept: false, reason: "full" } : undefined)).model).toBe(small);
    // A veto (a model that failed to load) skips a model that fits.
    expect(chooseModel([big, small], GPU, FIT, () => undefined, (id) => (id === "org/big" ? "could not load: out of memory" : undefined))).toEqual({ model: small, skipped: [{ id: "org/big", reason: "could not load: out of memory" }] });
  });

  it("MC1.4 a model this browser kept on an earlier visit downloads nothing: it needs no room and no data, only WebGPU when it is large", () => {
    const kept = { kept: true } as const;
    expect(unfit(big, { ...GPU, saveData: true, freeBytes: 0 }, FIT, kept)).toBeUndefined();
    expect(unfit(big, { ...GPU, webgpu: false }, FIT, kept)).toBe("no WebGPU adapter for a 600 MB model");
  });

  it("MC1.5 when a model is mandatory and none fits, the smallest one this browser can run at all is chosen anyway, and says why it would have been skipped; one that needs WebGPU it lacks never is", () => {
    const cramped = { ...GPU, webgpu: false, saveData: true, freeBytes: 1 };
    expect(chooseModel([big, small], cramped, FIT, () => undefined)).toEqual({ skipped: [{ id: "org/big", reason: "no WebGPU adapter for a 600 MB model" }, { id: "org/small", reason: "this browser asks to save data" }] });
    expect(chooseModel([big, small], cramped, FIT, () => undefined, undefined, true)).toEqual({ model: small, skipped: [{ id: "org/big", reason: "no WebGPU adapter for a 600 MB model" }], forced: "this browser asks to save data" });
    expect(chooseModel([big], cramped, FIT, () => undefined, undefined, true)).toEqual({ skipped: [{ id: "org/big", reason: "no WebGPU adapter for a 600 MB model" }] });
    // A model that failed to load (a veto) is never forced.
    expect(chooseModel([small], cramped, FIT, () => undefined, () => "could not load: x", true)).toEqual({ skipped: [{ id: "org/small", reason: "could not load: x" }] });
  });
});
