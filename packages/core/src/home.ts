import type { DeliveryTask } from "./delivery.ts";
import type { ManagedHarnessSession } from "./interpreter.ts";

/**
 * One `.harness` directory. `sessions/<name>.json` is a managed session,
 * `worktrees/<id>.json` is a delivery task, and `skills/<name>/SKILL.md`
 * is an agent skill. `mergeHarnessHomes` lets a project directory replace
 * the same identity from the user directory.
 */
export interface HarnessSkill {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

export interface HarnessHome {
  readonly sessions: readonly ManagedHarnessSession[];
  readonly worktrees: readonly DeliveryTask[];
  readonly skills: readonly HarnessSkill[];
}

/** A file relative to a `.harness` directory, using `/` as the separator. */
export interface HarnessHomeFile {
  readonly path: string;
  readonly text: string;
}

const SESSION = /^sessions\/([A-Za-z][\w-]*)\.json$/;
const WORKTREE = /^worktrees\/([A-Za-z][\w-]*)\.json$/;
const SKILL_FILE = /^skills\/([A-Za-z][\w-]*)\/([A-Za-z0-9._-]+)$/;
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const DESCRIPTION_LIMIT = 1024;

const SESSION_KEYS = new Set(["name", "harness", "state"]);
const WORKTREE_KEYS = new Set(["id", "branch", "paths"]);

export function parseHarnessHome(files: readonly HarnessHomeFile[]): HarnessHome {
  const seen = new Set<string>();
  const sessions: ManagedHarnessSession[] = [];
  const worktrees: DeliveryTask[] = [];
  const skillFiles = new Map<string, { path: string; text: string }[]>();
  for (const file of files) {
    if (seen.has(file.path)) throw new TypeError(`${file.path} is listed twice`);
    seen.add(file.path);
    const session = SESSION.exec(file.path);
    if (session?.[1] !== undefined) {
      sessions.push(parseSession(file, session[1]));
      continue;
    }
    const worktree = WORKTREE.exec(file.path);
    if (worktree?.[1] !== undefined) {
      worktrees.push(parseWorktree(file, worktree[1]));
      continue;
    }
    const skill = SKILL_FILE.exec(file.path);
    if (skill?.[1] !== undefined && skill[2] !== undefined) {
      const listed = skillFiles.get(skill[1]) ?? [];
      listed.push({ path: skill[2], text: file.text });
      skillFiles.set(skill[1], listed);
      continue;
    }
    throw new TypeError(`${file.path} is not a harness definition`);
  }
  const skills: HarnessSkill[] = [];
  for (const [name, listed] of skillFiles) skills.push(parseSkill(name, listed));
  return { sessions, worktrees, skills };
}

/** The project entry replaces a user entry with the same identity and keeps every other entry where it was. */
export function mergeHarnessHomes(user: HarnessHome, project: HarnessHome): HarnessHome {
  return {
    sessions: overlay(user.sessions, project.sessions, (session) => session.name),
    worktrees: overlay(user.worktrees, project.worktrees, (task) => task.id),
    skills: overlay(user.skills, project.skills, (skill) => skill.name),
  };
}

/**
 * Names and descriptions of the home's skills, for an agent's instructions.
 * The skill body stays on the skill until a host activates it.
 */
export function instructionsWithSkills(system: string | undefined, home: HarnessHome): string | undefined {
  if (home.skills.length === 0) return system;
  const listed = home.skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
  const block = `Agent skills:\n${listed}`;
  return system === undefined ? block : `${system}\n\n${block}`;
}

function overlay<T>(base: readonly T[], over: readonly T[], key: (item: T) => string): T[] {
  const replacements = new Map(over.map((item) => [key(item), item]));
  const seen = new Set<string>();
  const merged = base.map((item) => {
    const id = key(item);
    seen.add(id);
    return replacements.get(id) ?? item;
  });
  for (const item of over) {
    if (!seen.has(key(item))) merged.push(item);
  }
  return merged;
}

function parseSession(file: HarnessHomeFile, stem: string): ManagedHarnessSession {
  const value = jsonObject(file);
  rejectUnknown(value, SESSION_KEYS, file.path);
  if (!Object.hasOwn(value, "state")) throw new TypeError(`${file.path} needs a state`);
  const name = requiredString(value["name"]);
  const harness = requiredString(value["harness"]);
  if (name !== stem || harness === undefined) throw new TypeError(`${file.path} needs a name matching the file and a harness`);
  return { name, harness, state: value["state"] };
}

function parseWorktree(file: HarnessHomeFile, stem: string): DeliveryTask {
  const value = jsonObject(file);
  rejectUnknown(value, WORKTREE_KEYS, file.path);
  const id = requiredString(value["id"]);
  const branch = requiredString(value["branch"]);
  const paths = stringList(value["paths"]);
  if (id !== stem || branch === undefined || paths === undefined) throw new TypeError(`${file.path} needs an id matching the file, a branch, and paths`);
  return { id, branch, paths };
}

function parseSkill(name: string, files: readonly { path: string; text: string }[]): HarnessSkill {
  const main = files.find((file) => file.path === "SKILL.md");
  const where = `skills/${name}/SKILL.md`;
  if (main === undefined) throw new TypeError(`${where} is missing`);
  const matter = frontmatter(main.text, where);
  if (matter.name !== name) throw new TypeError(`${where} name is ${matter.name}`);
  return {
    name,
    description: matter.description,
    content: main.text,
    files: files.filter((file) => file.path !== "SKILL.md").map((file) => ({ path: file.path, content: file.text })),
  };
}

function frontmatter(text: string, path: string): { name: string; description: string } {
  const fenced = FENCE.exec(text);
  if (fenced?.[1] === undefined) throw new TypeError(`${path} needs name and description frontmatter`);
  let name: string | undefined;
  let description: string | undefined;
  for (const line of fenced[1].split(/\r?\n/)) {
    const named = /^name: (.*)$/.exec(line);
    const described = /^description: (.*)$/.exec(line);
    if (named?.[1] !== undefined) {
      if (name !== undefined) throw new TypeError(`${path} repeats name`);
      name = named[1];
    } else if (described?.[1] !== undefined) {
      if (description !== undefined) throw new TypeError(`${path} repeats description`);
      description = described[1];
    } else {
      throw new TypeError(`${path} has unknown frontmatter`);
    }
  }
  if (name === undefined || description === undefined || description.length === 0 || description.length > DESCRIPTION_LIMIT) {
    throw new TypeError(`${path} needs a name and a description`);
  }
  return { name, description };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonObject(file: HarnessHomeFile): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    throw new TypeError(`${file.path} is not json`);
  }
  if (!isRecord(parsed)) throw new TypeError(`${file.path} must be an object`);
  return parsed;
}

function rejectUnknown(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${path} has unknown key ${key}`);
  }
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) return undefined;
    items.push(item);
  }
  return items;
}
