import { describe, expect, it } from "vitest";
import { applyImageProcessorDefaults } from "@harness/models";

describe("transformers.js image processor defaults", () => {
  it("TB1.1 a config with mean/std but no do_normalize gets Python's default of normalizing", () => {
    // Qwen3.5's preprocessor_config.json omits do_normalize; Python defaults it to true,
    // transformers.js 4.3.0 reads it as undefined and feeds unnormalized pixels (red looks pink).
    const ip: Record<string, unknown> = { image_mean: [0.5, 0.5, 0.5], image_std: [0.5, 0.5, 0.5], do_normalize: undefined };
    applyImageProcessorDefaults(ip);
    expect(ip["do_normalize"]).toBe(true);
  });

  it("TB1.2 an explicit setting, or a processor without mean/std, is left alone", () => {
    const off: Record<string, unknown> = { image_mean: [0.5], image_std: [0.5], do_normalize: false };
    applyImageProcessorDefaults(off);
    expect(off["do_normalize"]).toBe(false);
    const none: Record<string, unknown> = {};
    applyImageProcessorDefaults(none);
    expect(none["do_normalize"]).toBeUndefined();
    applyImageProcessorDefaults(undefined);
  });
});
