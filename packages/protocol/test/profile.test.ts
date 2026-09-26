import { describe, expect, it } from "vitest";
import { HARNESS_METHODS, HARNESS_PROFILE_VERSION, ACP_PROTOCOL_VERSION } from "@harness/protocol";

describe("_harness profile", () => {
  it("PR1.1 every profile method is a namespaced ACP extension", () => {
    const methods = Object.values(HARNESS_METHODS);
    expect(new Set(methods).size).toBe(methods.length);
    for (const m of methods) expect(m).toMatch(/^_harness\/[a-z]+\/[a-z]+$/);
  });

  it("PR1.2 the profile and base ACP versions are pinned integers", () => {
    expect(HARNESS_PROFILE_VERSION).toBe(1);
    expect(ACP_PROTOCOL_VERSION).toBe(1);
  });
});
