import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { webSocketToken } from "@harness/platform-native";

const dir = () => mkdtempSync(join(tmpdir(), "harness-ws-"));

describe("webSocketToken", () => {
  it("WT1.1 without a token file, a random token is made and kept in one only its owner can read", async () => {
    const file = join(dir(), "nested", "ws-token");
    const token = await webSocketToken(file);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await webSocketToken(file)).toBe(token);
    expect(await webSocketToken(join(dir(), "other"))).not.toBe(token);
  });

  it("WT1.2 a token file that exists is read as it is, without its surrounding whitespace; an empty one is refused", async () => {
    const file = join(dir(), "given");
    writeFileSync(file, "  chosen-token\n");
    expect(await webSocketToken(file)).toBe("chosen-token");
    writeFileSync(file, "\n");
    await expect(webSocketToken(file)).rejects.toThrow(/empty/);
  });
});
