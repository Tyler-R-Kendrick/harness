import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const template = "packages/cli-template";

describe("the daemon generates a cli from the client template", () => {
  it("CP1.1 a generated cli project is the template with its own package name", () => {
    const dest = mkdtempSync(join(tmpdir(), "harness-cli-"));
    const result = spawnSync(process.execPath, ["packages/platform-native/src/main.ts", "--new-cli", dest, "--cli-name", "acme-cli"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const generated = JSON.parse(readFileSync(join(dest, "package.json"), "utf8")) as { name: string };
    expect(generated.name).toBe("acme-cli");
    expect(readFileSync(join(dest, "src/client.ts"), "utf8")).toBe(readFileSync(join(template, "src/client.ts"), "utf8"));
    expect(readFileSync(join(dest, "src/main.ts"), "utf8")).toBe(readFileSync(join(template, "src/main.ts"), "utf8"));
  });

  it("CP1.2 a name that is not a package name writes nothing", () => {
    const dest = mkdtempSync(join(tmpdir(), "harness-cli-"));
    const result = spawnSync(process.execPath, ["packages/platform-native/src/main.ts", "--new-cli", dest, "--cli-name", ""], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cli name/);
    expect(() => readFileSync(join(dest, "package.json"), "utf8")).toThrow();
  });
});
