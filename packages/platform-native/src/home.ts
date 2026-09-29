import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mergeHarnessHomes, parseHarnessHome } from "@harness/core";
import type { HarnessHome, HarnessHomeFile } from "@harness/core";

/** Read one `.harness` directory. A path that is not there is an empty home. */
export function readHarnessHome(root: string): HarnessHome {
  if (!existsSync(root)) return { sessions: [], worktrees: [], skills: [] };
  if (!statSync(root).isDirectory()) throw new TypeError(`${root} is not a directory`);
  const files: HarnessHomeFile[] = [];
  readFolder(root, "sessions", ".json", files);
  readFolder(root, "worktrees", ".json", files);
  readSkills(root, files);
  return parseHarnessHome(files);
}

/**
 * The nearest `.harness` directory at `start` or a parent, stopping before `stop`
 * (the user home, whose `.harness` is the user layer).
 */
export function discoverProjectHome(start: string, stop: string): string | undefined {
  let dir = resolve(start);
  const halt = resolve(stop);
  while (dir !== halt) {
    const candidate = join(dir, ".harness");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** User layer, then the project layer discovered from `start` up to `stop`. The project identity wins. */
export function loadDiscoveredHarnessHome(places: { readonly userRoot: string; readonly start: string; readonly stop: string }): HarnessHome {
  const user = readHarnessHome(places.userRoot);
  const project = discoverProjectHome(places.start, places.stop);
  return project === undefined ? user : mergeHarnessHomes(user, readHarnessHome(project));
}

function readFolder(root: string, folder: string, suffix: string, files: HarnessHomeFile[]): void {
  const dir = join(root, folder);
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) throw new TypeError(`${dir} is not a directory`);
  for (const name of names(dir)) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    if (!statSync(full).isFile()) throw new TypeError(`${full} is not a file`);
    if (!name.endsWith(suffix)) throw new TypeError(`${full} is not a ${folder} definition`);
    files.push({ path: `${folder}/${name}`, text: readFileSync(full, "utf8") });
  }
}

function readSkills(root: string, files: HarnessHomeFile[]): void {
  const dir = join(root, "skills");
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) throw new TypeError(`${dir} is not a directory`);
  for (const name of names(dir)) {
    if (name.startsWith(".")) continue;
    const skillDir = join(dir, name);
    if (!statSync(skillDir).isDirectory()) throw new TypeError(`${skillDir} is not a skill directory`);
    for (const fileName of names(skillDir)) {
      if (fileName.startsWith(".")) continue;
      const full = join(skillDir, fileName);
      if (!statSync(full).isFile()) throw new TypeError(`${full} is not a file`);
      files.push({ path: `skills/${name}/${fileName}`, text: readFileSync(full, "utf8") });
    }
  }
}

function names(dir: string): string[] {
  return readdirSync(dir).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
