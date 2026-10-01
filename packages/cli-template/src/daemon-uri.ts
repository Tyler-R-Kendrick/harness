import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Absolute unix socket path. `unix:///path` and `/path` are the same socket. */
export function socketPath(uri: string): string {
  const trimmed = uri.trim();
  const path = trimmed.startsWith("unix://") ? trimmed.slice("unix://".length) : trimmed;
  if (!path.startsWith("/")) throw new Error("daemon uri must be an absolute unix socket");
  return path;
}

/** First non-empty check wins: workspace, then user, then global, then the environment and dev socket. */
export function resolveDaemonTarget(checks: {
  readonly localSetting: string;
  readonly userSetting: string;
  readonly globalSetting: string;
  readonly envSetting: string;
  readonly devSocket: string;
}): { readonly kind: "socket"; readonly path: string } | { readonly kind: "spawn" } {
  for (const candidate of [checks.localSetting, checks.userSetting, checks.globalSetting, checks.envSetting, checks.devSocket]) {
    if (candidate.trim().length === 0) continue;
    return { kind: "socket", path: socketPath(candidate) };
  }
  return { kind: "spawn" };
}

function readSettingsObject(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`could not read daemon settings ${file}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`could not read daemon settings ${file}`);
  return parsed as Record<string, unknown>;
}

function daemonField(file: string): unknown {
  const object = readSettingsObject(file);
  if (object === undefined) return undefined;
  return object["daemon"];
}

/** Effective daemon socket from a `/settings` file. A missing file is empty. */
export function readDaemonSettingFile(file: string): string {
  const value = daemonField(file);
  if (typeof value === "string") return value.trim();
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  const accepted = (value as Record<string, unknown>)["accepted"];
  return typeof accepted === "string" ? accepted.trim() : "";
}

/** Requested and accepted `daemon` value, for the interpreter's initial state. */
export function readDaemonSettingState(file: string): { readonly requested: string; readonly accepted?: string } | undefined {
  const value = daemonField(file);
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length === 0) return undefined;
    return { requested: text, accepted: text };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const requested = typeof record["requested"] === "string" ? record["requested"].trim() : undefined;
  const accepted = typeof record["accepted"] === "string" ? record["accepted"].trim() : undefined;
  if (requested === undefined && accepted === undefined) return undefined;
  if (accepted === undefined) return { requested: requested ?? "" };
  if (requested === undefined) return { requested: accepted, accepted };
  return { requested, accepted };
}

/** Settings file of the nearest workspace `.harness` at or below `start`, stopping before `stop`. */
export function projectSettingsFile(start: string, stop: string): string | undefined {
  let dir = resolve(start);
  const halt = resolve(stop);
  while (dir !== halt) {
    const home = join(dir, ".harness");
    if (existsSync(home)) return join(home, "settings.json");
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** The workspace daemon socket. A missing workspace is empty. */
export function projectDaemonSetting(start: string, stop: string): string {
  const file = projectSettingsFile(start, stop);
  return file === undefined ? "" : readDaemonSettingFile(file);
}

/** Persist one `/settings daemon` result into the settings file for that layer. */
export function writeDaemonSetting(file: string, entry: { readonly requested?: string; readonly accepted?: string }): void {
  const current = readSettingsObject(file) ?? {};
  if (entry.requested === undefined && entry.accepted === undefined) delete current["daemon"];
  else {
    const stored: { requested?: string; accepted?: string } = {};
    if (entry.requested !== undefined) stored.requested = entry.requested;
    if (entry.accepted !== undefined) stored.accepted = entry.accepted;
    current["daemon"] = stored;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
}
