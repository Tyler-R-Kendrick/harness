import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileStorage } from "@harness/platform-native";

const dir = () => mkdtempSync(join(tmpdir(), "harness-fs-"));

describe("FileStorage", () => {
  it("FS1.1 a leftover temp file from a crashed save is ignored", async () => {
    const d = dir();
    const path = join(d, "state.json");
    await new FileStorage(path).save({ good: true });
    writeFileSync(join(d, "state.json.tmp-999-1"), '{"torn":');
    expect(await new FileStorage(path).load()).toEqual({ good: true });
  });

  it("FS1.2 a corrupt snapshot fails loudly instead of loading as empty", async () => {
    const path = join(dir(), "state.json");
    writeFileSync(path, "{not json");
    await expect(new FileStorage(path).load()).rejects.toThrow(/corrupt/);
  });

  it("FS1.3 saving leaves no temp files behind", async () => {
    const d = dir();
    const storage = new FileStorage(join(d, "state.json"));
    await Promise.all([1, 2, 3].map((n) => storage.save({ n })));
    expect(readdirSync(d)).toEqual(["state.json"]);
  });
});
