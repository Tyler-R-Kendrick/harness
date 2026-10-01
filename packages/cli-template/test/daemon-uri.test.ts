import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectDaemonSetting, readDaemonSettingFile, readDaemonSettingState, resolveDaemonTarget, writeDaemonSetting } from "../src/daemon-uri.ts";

const empty = { localSetting: "", userSetting: "", globalSetting: "", envSetting: "", devSocket: "" };

describe("the cli resolves a daemon uri before it spawns", () => {
  it("CT4.1 a workspace daemon uri wins over user and global", () => {
    expect(resolveDaemonTarget({ ...empty, localSetting: "/local.sock", userSetting: "/user.sock", globalSetting: "/global.sock", envSetting: "/env.sock", devSocket: "/dev.sock" })).toEqual({
      kind: "socket",
      path: "/local.sock",
    });
  });

  it("CT4.2 an empty workspace setting uses the user setting", () => {
    expect(resolveDaemonTarget({ ...empty, localSetting: "  ", userSetting: "/user.sock", globalSetting: "/global.sock", envSetting: "/env.sock", devSocket: "/dev.sock" })).toEqual({
      kind: "socket",
      path: "/user.sock",
    });
  });

  it("CT4.3 an empty workspace and user setting uses the global setting", () => {
    expect(resolveDaemonTarget({ ...empty, globalSetting: "unix:///global.sock", envSetting: "/env.sock", devSocket: "/dev.sock" })).toEqual({ kind: "socket", path: "/global.sock" });
  });

  it("CT4.4 an empty settings cascade uses HARNESS_DAEMON and then the dev socket", () => {
    expect(resolveDaemonTarget({ ...empty, envSetting: "/env.sock", devSocket: "/dev.sock" })).toEqual({ kind: "socket", path: "/env.sock" });
    expect(resolveDaemonTarget({ ...empty, devSocket: "/dev.sock" })).toEqual({ kind: "socket", path: "/dev.sock" });
  });

  it("CT4.5 every empty check self-hosts", () => {
    expect(resolveDaemonTarget(empty)).toEqual({ kind: "spawn" });
  });

  it("CT4.6 a blank check is empty and the next check is used", () => {
    expect(resolveDaemonTarget({ ...empty, localSetting: " \n", userSetting: "\t", globalSetting: "  /global.sock  " })).toEqual({ kind: "socket", path: "/global.sock" });
  });

  it("CT4.7 a relative daemon uri is rejected", () => {
    expect(() => resolveDaemonTarget({ ...empty, localSetting: "dev.sock", userSetting: "/user.sock" })).toThrow(/daemon uri must be an absolute unix socket/);
  });

  it("CT4.8 a unix:// uri is the absolute socket path", () => {
    expect(resolveDaemonTarget({ ...empty, localSetting: "unix:///var/run/harness.sock" })).toEqual({ kind: "socket", path: "/var/run/harness.sock" });
    expect(() => resolveDaemonTarget({ ...empty, localSetting: "unix://var/run/harness.sock" })).toThrow(/daemon uri must be an absolute unix socket/);
  });

  it("CT4.9 a settings file accepts an accepted value or a plain string", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-uri-file-"));
    const accepted = join(dir, "accepted.json");
    const plain = join(dir, "plain.json");
    const requested = join(dir, "requested.json");
    writeFileSync(accepted, `${JSON.stringify({ daemon: { requested: "  /accepted.sock  ", accepted: "  /accepted.sock  " } })}\n`);
    writeFileSync(plain, `${JSON.stringify({ daemon: " /plain.sock " })}\n`);
    writeFileSync(requested, `${JSON.stringify({ daemon: { requested: "/requested.sock" } })}\n`);
    expect(readDaemonSettingFile(accepted)).toBe("/accepted.sock");
    expect(readDaemonSettingState(accepted)).toEqual({ requested: "/accepted.sock", accepted: "/accepted.sock" });
    expect(readDaemonSettingFile(plain)).toBe("/plain.sock");
    expect(readDaemonSettingState(plain)).toEqual({ requested: "/plain.sock", accepted: "/plain.sock" });
    expect(readDaemonSettingFile(requested)).toBe("");
    expect(readDaemonSettingState(requested)).toEqual({ requested: "/requested.sock" });
  });

  it("CT4.10 a missing settings file is empty and a corrupt one is an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-uri-miss-"));
    const missing = join(dir, "missing.json");
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{");
    expect(readDaemonSettingFile(missing)).toBe("");
    expect(readDaemonSettingState(missing)).toBeUndefined();
    expect(() => readDaemonSettingFile(corrupt)).toThrow(`could not read daemon settings ${corrupt}`);
  });

  it("CT4.11 the nearest project .harness is the project check and the walk stops before home", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-uri-walk-"));
    const home = join(root, "home");
    const project = join(home, "proj");
    const nested = join(project, "app");
    mkdirSync(join(home, ".harness"), { recursive: true });
    mkdirSync(join(project, ".harness"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(home, ".harness", "settings.json"), `${JSON.stringify({ daemon: "/home.sock" })}\n`);
    writeFileSync(join(project, ".harness", "settings.json"), `${JSON.stringify({ daemon: "/project.sock" })}\n`);
    expect(projectDaemonSetting(nested, home)).toBe("/project.sock");
    mkdirSync(join(nested, ".harness"));
    expect(projectDaemonSetting(nested, home)).toBe("");
    expect(projectDaemonSetting(join(home, "other"), home)).toBe("");
  });

  it("CT4.12 writing a daemon setting keeps the accepted socket and unset clears it", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-uri-write-"));
    const file = join(dir, "settings.json");
    writeFileSync(file, `${JSON.stringify({ theme: "dark" })}\n`);
    writeDaemonSetting(file, { requested: "/next.sock", accepted: "/next.sock" });
    expect(readDaemonSettingFile(file)).toBe("/next.sock");
    expect(JSON.parse(readFileSync(file, "utf8")) as { theme: string }).toMatchObject({ theme: "dark" });
    writeDaemonSetting(file, {});
    expect(readDaemonSettingFile(file)).toBe("");
    expect(JSON.parse(readFileSync(file, "utf8")) as { theme: string }).toEqual({ theme: "dark" });
  });
});
