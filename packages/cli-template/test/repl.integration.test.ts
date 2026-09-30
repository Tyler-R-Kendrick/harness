import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

const repo = new URL("../../../", import.meta.url).pathname;

describe("the cli stays connected to the daemon it starts", () => {
  it("CT1.4 a typed line is answered by the daemon the cli started", async () => {
    const child = spawn(process.execPath, ["packages/cli-template/src/main.ts", "--daemon", "packages/platform-native/src/main.ts"], {
      cwd: repo,
      env: { ...process.env, NODE_OPTIONS: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (out += chunk));
    child.stderr?.on("data", (chunk: string) => (err += chunk));
    child.stdin?.write("fff\nsecond\n");
    child.stdin?.end();
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code, err || out).toBe(0);
    expect(out).toContain("echo: fff");
    expect(out).toContain("echo: second");
    expect(out).toContain("Type a message or /ask <message>");
  });

  it("CT2.6 dev-cli starts a harness session instead of the echo worker", async () => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as { scripts: { "dev-cli": string } };
    expect(pkg.scripts["dev-cli"]).toContain("--daemon packages/platform-native/src/main.ts");
    expect(pkg.scripts["dev-cli"]).toContain("--worker harness");
    expect(pkg.scripts["dev-cli"]).toContain("--harness claude-code");
    expect(pkg.scripts["dev-cli"]).not.toContain("ensemble");
    expect(pkg.scripts["dev-cli"]).not.toContain("echo");
  });
});
