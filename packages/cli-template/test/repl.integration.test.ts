import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = new URL("../../../", import.meta.url).pathname;

function cliEnv(cache: string, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: "", XDG_CACHE_HOME: cache, HOME: home };
  delete env["HARNESS_DAEMON"];
  return env;
}

describe("the cli stays connected to the daemon it starts", () => {
  it("CT1.4 a typed line is answered by the daemon the cli started", async () => {
    const cache = mkdtempSync(join(tmpdir(), "harness-cli-ct14-"));
    const home = mkdtempSync(join(tmpdir(), "harness-cli-ct14-home-"));
    const child = spawn(process.execPath, [join(repo, "packages/cli-template/src/main.ts"), "--daemon", join(repo, "packages/platform-native/src/main.ts")], {
      cwd: home,
      env: cliEnv(cache, home),
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
    expect(out).toContain("Type a message.");
    expect(out).not.toContain("/ask");
  });

  it("CT2.12 a color run marks work and emphasizes replies; NO_COLOR stays plain", async () => {
    const cache = mkdtempSync(join(tmpdir(), "harness-cli-fmt-"));
    const home = mkdtempSync(join(tmpdir(), "harness-cli-fmt-home-"));
    const entry = join(repo, "packages/platform-native/src/main.ts");
    const main = join(repo, "packages/cli-template/src/main.ts");
    const marked = "show **bold** and `code` and ```fenced``` tail";
    const colorEnv = cliEnv(cache, home);
    colorEnv["FORCE_COLOR"] = "1";
    delete colorEnv["NO_COLOR"];
    const colored = spawn(process.execPath, [main, "--daemon", entry, "--worker", "echo", "--no-hosted"], {
      cwd: home,
      env: colorEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    colored.stdout?.setEncoding("utf8");
    colored.stderr?.setEncoding("utf8");
    colored.stdout?.on("data", (chunk: string) => (out += chunk));
    colored.stderr?.on("data", (chunk: string) => (err += chunk));
    const waitFor = async (ready: () => boolean) => {
      const start = Date.now();
      while (!ready()) {
        if (colored.exitCode !== null || colored.signalCode !== null) throw new Error(`cli exited early ${colored.exitCode ?? colored.signalCode}: ${err || out}`);
        if (Date.now() - start > 8000) throw new Error(`timed out: ${err || out}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    };
    await waitFor(() => out.includes("\x1b[36m>"));
    colored.stdin?.write(`${marked}\n`);
    await waitFor(() => out.includes("\x1b[1mbold"));
    expect(out.indexOf("⠋"), err || out).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("⠋")).toBeLessThan(out.indexOf("\x1b[1mbold"));
    expect(out).not.toContain("**bold**");
    expect(out).toContain("\x1b[35mcode");
    expect(out).not.toContain("`code`");
    expect(out).toContain("\x1b[34mfenced");
    expect(out).not.toContain("```fenced```");
    expect(out).toContain("\x1b[2mType a message");
    expect(out).toContain("\x1b[97mecho:");
    await waitFor(() => out.lastIndexOf("\x1b[36m>") > out.indexOf("\x1b[1mbold"));
    colored.stdin?.write("\nplain\n");
    await waitFor(() => out.includes("echo: plain"));
    expect(out).toContain("echo: plain");
    expect(err).not.toContain("prompt must be a string");
    colored.stdin?.end();
    const [code] = (await once(colored, "exit")) as [number | null];
    expect(code, err || out).toBe(0);
    const plainCache = mkdtempSync(join(tmpdir(), "harness-cli-fmt-plain-"));
    const plainHome = mkdtempSync(join(tmpdir(), "harness-cli-fmt-plain-home-"));
    const plainEnv = cliEnv(plainCache, plainHome);
    plainEnv["NO_COLOR"] = "1";
    delete plainEnv["FORCE_COLOR"];
    const plain = spawn(process.execPath, [main, "--daemon", entry, "--worker", "echo", "--no-hosted"], {
      cwd: plainHome,
      env: plainEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let plainOut = "";
    let plainErr = "";
    plain.stdout?.setEncoding("utf8");
    plain.stderr?.setEncoding("utf8");
    plain.stdout?.on("data", (chunk: string) => (plainOut += chunk));
    plain.stderr?.on("data", (chunk: string) => (plainErr += chunk));
    plain.stdin?.write("plain\n");
    plain.stdin?.end();
    try {
      const [plainCode] = (await once(plain, "exit")) as [number | null];
      expect(plainCode, plainErr || plainOut).toBe(0);
      expect(plainOut).toContain("Type a message");
      expect(plainOut).toContain("echo: plain");
      expect(plainOut).not.toMatch(/\x1b\[\d/);
    } finally {
      const parent = plain.pid;
      if (parent !== undefined) spawnSync("pkill", ["-P", String(parent)]);
      if (plain.exitCode === null && plain.signalCode === null) plain.kill("SIGKILL");
      const colorParent = colored.pid;
      if (colorParent !== undefined) spawnSync("pkill", ["-P", String(colorParent)]);
      if (colored.exitCode === null && colored.signalCode === null) colored.kill("SIGKILL");
    }
  }, 20_000);

  it("CT2.13 a failed turn is the error role and the ready prompt returns", async () => {
    const cache = mkdtempSync(join(tmpdir(), "harness-cli-fail-"));
    const home = mkdtempSync(join(tmpdir(), "harness-cli-fail-home-"));
    const entry = join(repo, "packages/platform-native/src/main.ts");
    const main = join(repo, "packages/cli-template/src/main.ts");
    const env = cliEnv(cache, home);
    env["FORCE_COLOR"] = "1";
    delete env["NO_COLOR"];
    const child = spawn(process.execPath, [main, "--daemon", entry, "--worker", "echo", "--no-hosted"], {
      cwd: home,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (out += chunk));
    child.stderr?.on("data", (chunk: string) => (err += chunk));
    const waitFor = async (ready: () => boolean) => {
      const start = Date.now();
      while (!ready()) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`cli exited early ${child.exitCode ?? child.signalCode}: ${err || out}`);
        if (Date.now() - start > 8000) throw new Error(`timed out: ${err || out}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    };
    const notice = "\x1b[31mModel call failed: model offline";
    try {
      await waitFor(() => out.includes("\x1b[36m>"));
      child.stdin?.write("!fail\n");
      await waitFor(() => out.includes(notice));
      expect(out, err || out).toContain(notice);
      expect(out).not.toContain("\x1b[97mModel call failed");
      await waitFor(() => out.lastIndexOf("\x1b[36m>") > out.indexOf(notice));
      expect(out.lastIndexOf("\x1b[36m>")).toBeGreaterThan(out.indexOf(notice));
      child.stdin?.end();
      const [code] = (await once(child, "exit")) as [number | null];
      expect(code, err || out).toBe(0);
    } finally {
      const parent = child.pid;
      if (parent !== undefined) spawnSync("pkill", ["-P", String(parent)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 20_000);

  it("CT2.14 a thread shows its response state and slash commands stay available", async () => {
    const cache = mkdtempSync(join(tmpdir(), "harness-cli-state-"));
    const home = mkdtempSync(join(tmpdir(), "harness-cli-state-home-"));
    const child = spawn(process.execPath, [join(repo, "packages/cli-template/src/main.ts"), "--daemon", join(repo, "packages/platform-native/src/main.ts"), "--worker", "echo", "--no-hosted"], {
      cwd: home,
      env: cliEnv(cache, home),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (out += chunk));
    child.stderr?.on("data", (chunk: string) => (err += chunk));
    const waitFor = async (ready: () => boolean) => {
      const start = Date.now();
      while (!ready()) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`cli exited early ${child.exitCode ?? child.signalCode}: ${err || out}`);
        if (Date.now() - start > 8000) throw new Error(`timed out: ${err || out}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    };
    try {
      await waitFor(() => out.includes("> "));
      child.stdin?.write("hi\n");
      await waitFor(() => out.includes("responding") && out.includes("echo: hi"));
      expect(out.indexOf("responding"), err || out).toBeLessThan(out.indexOf("echo: hi"));
      await waitFor(() => out.lastIndexOf("> ") > out.indexOf("echo: hi"));
      child.stdin?.write("ping !permission\n");
      await waitFor(() => out.includes("Allow"));
      child.stdin?.write("/sessions\n");
      await waitFor(() => /daemon ses_\S+ permission/.test(out));
      expect(out, err || out).toMatch(/daemon ses_\S+ permission/);
      expect(out).not.toContain("unknown permission choice");
      child.stdin?.write("allow\n");
      await waitFor(() => out.includes("echo: ping !permission") && out.lastIndexOf("> ") > out.indexOf("echo: ping !permission"));
      expect(out.lastIndexOf("> "), err || out).toBeGreaterThan(out.indexOf("echo: ping !permission"));
      child.stdin?.end();
      const [code] = (await once(child, "exit")) as [number | null];
      expect(code, err || out).toBe(0);
    } finally {
      const parent = child.pid;
      if (parent !== undefined) spawnSync("pkill", ["-P", String(parent)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 20_000);

  it("CT2.6 dev:cli answers with the local catalog model, not Claude Code or the echo worker", async () => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["dev-cli"]).toBeUndefined();
    expect(pkg.scripts["dev-daemon"]).toBeUndefined();
    expect(pkg.scripts["dev:cli"]).toContain("--daemon packages/platform-native/src/main.ts");
    expect(pkg.scripts["dev:cli"]).toContain("--worker ensemble");
    expect(pkg.scripts["dev:cli"]).toContain("--no-hosted");
    expect(pkg.scripts["dev:cli"]).toContain("--llama-server");
    expect(pkg.scripts["dev:cli"]).toContain("${XDG_CACHE_HOME:-$HOME/.cache}/harness/bin/llama-server");
    expect(pkg.scripts["dev:cli"]).not.toContain("--worker harness");
    expect(pkg.scripts["dev:cli"]).not.toContain("--harness");
    expect(pkg.scripts["dev:cli"]).not.toContain("claude");
    expect(pkg.scripts["dev:cli"]).not.toContain("echo");
    expect(pkg.scripts["dev:cli"]).not.toContain("model-cache");
    expect(pkg.scripts["dev:daemon"]).toContain("--watch");
    expect(pkg.scripts["dev:daemon"]).toContain("dev.sock");
  });

  it("CT2.7 two Ctrl+C presses clear the session and session resume reloads it", async () => {
    const cache = mkdtempSync(join(tmpdir(), "harness-cli-exit-"));
    const home = mkdtempSync(join(tmpdir(), "harness-cli-exit-home-"));
    const env = cliEnv(cache, home);
    const args = [join(repo, "packages/cli-template/src/main.ts"), "--daemon", join(repo, "packages/platform-native/src/main.ts")];
    const first = spawn(process.execPath, args, { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    first.stdout?.setEncoding("utf8");
    first.stderr?.setEncoding("utf8");
    first.stdout?.on("data", (chunk: string) => (out += chunk));
    first.stderr?.on("data", (chunk: string) => (err += chunk));
    const waitFor = async (ready: () => boolean) => {
      const start = Date.now();
      while (!ready()) {
        if (first.exitCode !== null || first.signalCode !== null) throw new Error(`cli exited early ${first.exitCode ?? first.signalCode}: ${err || out}`);
        if (Date.now() - start > 8000) throw new Error(`timed out: ${err || out}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    };
    const interrupt = async () => {
      first.kill("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 80));
    };
    try {
      await waitFor(() => out.includes("> "));
      first.stdin?.write("fff\n");
      await waitFor(() => out.includes("echo: fff"));
      await interrupt();
      await waitFor(() => out.includes("Press Ctrl+C again to exit."));
      expect(out).not.toContain("session resume");
      first.stdin?.write("still\n");
      await waitFor(() => out.includes("echo: still"));
      await interrupt();
      await waitFor(() => out.split("Press Ctrl+C again to exit.").length - 1 >= 2);
      expect(out).not.toContain("session resume");
      first.kill("SIGINT");
      const [code, signal] = (await once(first, "exit")) as [number | null, NodeJS.Signals | null];
      expect(signal ?? code, err || out).toBe(0);
    } finally {
      if (first.exitCode === null && first.signalCode === null) first.kill("SIGKILL");
    }
    const resumed = out.match(/npm run dev:cli -- session resume (ses_\S+)/);
    expect(resumed?.[1], err || out).toBeTruthy();
    expect(out).toContain("Session context cleared.");
    expect(out).not.toContain("\x1b[3J");
    expect(out).not.toContain("\x1b[H\x1b[J");
    const cleared = out.indexOf("Session context cleared.\n");
    expect(cleared, err || out).toBeGreaterThan(out.indexOf("echo: still"));
    const id = resumed?.[1] ?? "";
    const second = spawn(process.execPath, [...args, "session", "resume", id], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
    let again = "";
    let againErr = "";
    second.stdout?.setEncoding("utf8");
    second.stderr?.setEncoding("utf8");
    second.stdout?.on("data", (chunk: string) => (again += chunk));
    second.stderr?.on("data", (chunk: string) => (againErr += chunk));
    second.stdin?.write("/sessions\n");
    second.stdin?.end();
    const [againCode] = (await once(second, "exit")) as [number | null];
    expect(againCode, againErr || again).toBe(0);
    expect(again.match(/ses_[A-Za-z0-9]+/g)).toEqual([id]);
  }, 20_000);

  it("CT2.8 a --worker value stays with the flag the daemon parses", async () => {
    const cache = mkdtempSync(join(tmpdir(), "harness-cli-worker-"));
    const home = mkdtempSync(join(tmpdir(), "harness-cli-worker-home-"));
    const child = spawn(
      process.execPath,
      [join(repo, "packages/cli-template/src/main.ts"), "--daemon", join(repo, "packages/platform-native/src/main.ts"), "--worker", "echo", "--no-hosted"],
      { cwd: home, env: cliEnv(cache, home), stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (out += chunk));
    child.stderr?.on("data", (chunk: string) => (err += chunk));
    const started = Date.now();
    let asked = false;
    try {
      while (!out.includes("echo: fff")) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`cli exited ${child.exitCode ?? child.signalCode}: ${err || out}`);
        if (Date.now() - started > 8000) throw new Error(`timed out: ${err || out}`);
        if (!asked && out.includes("> ")) {
          asked = true;
          child.stdin?.write("fff\n");
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(err).not.toContain("argument is ambiguous");
    } finally {
      const parent = child.pid;
      if (parent !== undefined) spawnSync("pkill", ["-P", String(parent)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("CT2.11 session resume after a daemon flag value reloads that session", async () => {
    const cache = mkdtempSync(join(tmpdir(), "harness-cli-resume-"));
    const home = mkdtempSync(join(tmpdir(), "harness-cli-resume-home-"));
    const env = cliEnv(cache, home);
    const entry = join(repo, "packages/platform-native/src/main.ts");
    const main = join(repo, "packages/cli-template/src/main.ts");
    const first = spawn(process.execPath, [main, "--daemon", entry], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    first.stdout?.setEncoding("utf8");
    first.stderr?.setEncoding("utf8");
    first.stdout?.on("data", (chunk: string) => (out += chunk));
    first.stderr?.on("data", (chunk: string) => (err += chunk));
    first.stdin?.write("/sessions\n");
    first.stdin?.end();
    const [code] = (await once(first, "exit")) as [number | null];
    expect(code, err || out).toBe(0);
    const id = out.match(/ses_[A-Za-z0-9]+/)?.[0] ?? "";
    expect(id, err || out).not.toBe("");
    const missing = spawn(process.execPath, [main, "--daemon", entry, "--worker", "echo", "session", "resume"], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
    let missingOut = "";
    let missingErr = "";
    missing.stdout?.setEncoding("utf8");
    missing.stderr?.setEncoding("utf8");
    missing.stdout?.on("data", (chunk: string) => (missingOut += chunk));
    missing.stderr?.on("data", (chunk: string) => (missingErr += chunk));
    missing.stdin?.end();
    const [missingCode] = (await once(missing, "exit")) as [number | null];
    expect(missingCode, missingErr || missingOut).toBe(2);
    expect(missingErr).toContain("usage: harness-cli session resume <session_id>");
    expect(`${missingErr}\n${missingOut}`).not.toContain("Unexpected argument 'session'");
    const second = spawn(
      process.execPath,
      [main, "--daemon", entry, "--worker", "echo", "--no-hosted", "--llama-server", join(cache, "llama-server"), "session", "resume", id],
      { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let again = "";
    let againErr = "";
    second.stdout?.setEncoding("utf8");
    second.stderr?.setEncoding("utf8");
    second.stdout?.on("data", (chunk: string) => (again += chunk));
    second.stderr?.on("data", (chunk: string) => (againErr += chunk));
    second.stdin?.write("/sessions\nagain\n");
    second.stdin?.end();
    try {
      const [againCode] = (await once(second, "exit")) as [number | null];
      const combined = `${againErr}\n${again}`;
      expect(againCode, combined).toBe(0);
      expect(combined).not.toContain("Unexpected argument 'session'");
      expect(combined).not.toContain("ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL");
      expect(again.match(/ses_[A-Za-z0-9]+/g)).toEqual([id]);
      expect(again).toContain("echo: again");
    } finally {
      const parent = second.pid;
      if (parent !== undefined) spawnSync("pkill", ["-P", String(parent)]);
      if (second.exitCode === null && second.signalCode === null) second.kill("SIGKILL");
    }
  }, 20_000);

  it("CT2.9 a workspace daemon uri wins over user and global settings", async () => {
    const cache = mkdtempSync(join(tmpdir(), "harness-cli-uri-"));
    const home = mkdtempSync(join(tmpdir(), "harness-cli-uri-home-"));
    const project = mkdtempSync(join(tmpdir(), "harness-cli-uri-proj-"));
    const sock = join(cache, "live.sock");
    const env = cliEnv(cache, home);
    env["HARNESS_DAEMON"] = "/missing/env.sock";
    mkdirSync(join(home, ".harness"), { recursive: true });
    mkdirSync(join(project, ".harness"), { recursive: true });
    mkdirSync(join(cache, "harness"), { recursive: true });
    writeFileSync(join(home, ".harness", "settings.json"), `${JSON.stringify({ daemon: "/missing/user.sock" })}\n`);
    writeFileSync(join(project, ".harness", "settings.json"), `${JSON.stringify({ daemon: { requested: sock, accepted: sock } })}\n`);
    writeFileSync(join(cache, "harness", "dev.sock"), "");
    const daemon = spawn(process.execPath, [join(repo, "packages/platform-native/src/main.ts"), "--socket", sock, "--worker", "echo", "--state", join(cache, "state.json")], {
      cwd: project,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let daemonErr = "";
    daemon.stderr?.setEncoding("utf8");
    daemon.stderr?.on("data", (chunk: string) => (daemonErr += chunk));
    const started = Date.now();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      while (!existsSync(sock)) {
        if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error(`daemon exited ${daemon.exitCode ?? daemon.signalCode}: ${daemonErr}`);
        if (Date.now() - started > 8000) throw new Error(`daemon socket timed out: ${daemonErr}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      child = spawn(process.execPath, [join(repo, "packages/cli-template/src/main.ts"), "--daemon", join(cache, "missing-entry.ts"), "--worker", "echo", "--no-hosted"], {
      cwd: project,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (out += chunk));
    child.stderr?.on("data", (chunk: string) => (err += chunk));
    let asked = false;
      while (!out.includes("echo: fff")) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`cli exited ${child.exitCode ?? child.signalCode}: ${err || out}`);
        if (Date.now() - started > 8000) throw new Error(`timed out: ${err || out}`);
        if (!asked && out.includes("> ")) {
          asked = true;
          child.stdin?.write("fff\n");
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(out).toContain(`harness cli on ${sock}`);
      expect(out).not.toContain("harness cli connected");
    } finally {
      const parent = child?.pid;
      if (parent !== undefined) spawnSync("pkill", ["-P", String(parent)]);
      if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
    }
  }, 20_000);

  it("CT2.10 a non-empty daemon uri that is not listening does not self-host", async () => {
    const cache = mkdtempSync(join(tmpdir(), "harness-cli-absent-"));
    const home = mkdtempSync(join(tmpdir(), "harness-cli-absent-home-"));
    const project = mkdtempSync(join(tmpdir(), "harness-cli-absent-proj-"));
    const sock = join(cache, "absent.sock");
    mkdirSync(join(home, ".harness"), { recursive: true });
    writeFileSync(join(home, ".harness", "settings.json"), `${JSON.stringify({ daemon: sock })}\n`);
    const child = spawn(process.execPath, [join(repo, "packages/cli-template/src/main.ts"), "--daemon", join(repo, "packages/platform-native/src/main.ts"), "--worker", "echo"], {
      cwd: project,
      env: cliEnv(cache, home),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (out += chunk));
    child.stderr?.on("data", (chunk: string) => (err += chunk));
    child.stdin?.end();
    try {
      const [code] = (await once(child, "exit")) as [number | null];
      expect(code, err || out).not.toBe(0);
      expect(out).not.toContain("echo:");
      expect(out).not.toContain("harness cli connected");
      expect(err).toMatch(/ENOENT|ECONNREFUSED|connect/);
    } finally {
      const parent = child.pid;
      if (parent !== undefined) spawnSync("pkill", ["-P", String(parent)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
