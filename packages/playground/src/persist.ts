/**
 * What the playground keeps across reloads, in the viewer's browser: the daemon's
 * snapshot (its sessions and logs), each session's agent conversation (kept by the
 * worker, `storedConversations`), the shared filesystem, and the page's own state (the
 * current session, the settings, the turns).
 * Every store is a `SnapshotStorage` (IndexedDB in the page), read back through a parser,
 * and allowed to fail: without storage the playground simply starts fresh.
 */
import type { IFileSystem } from "just-bash";
import { z } from "zod";
import type { SnapshotStorage } from "@harness/core";
import { GENERATIONS } from "./engine.ts";
import type { TraceEvent } from "./trace.ts";

const vfsSnapshot = z.object({
  version: z.literal(1),
  files: z.record(z.string(), z.custom<Uint8Array>((v) => v instanceof Uint8Array)),
  dirs: z.array(z.string()),
  links: z.record(z.string(), z.string()).default({}),
});

/** The filesystem under a root: every file's bytes, every directory (empty ones too) and every link's target. */
export type VfsSnapshot = z.infer<typeof vfsSnapshot>;

export function parseVfsSnapshot(value: unknown): VfsSnapshot | undefined {
  const parsed = vfsSnapshot.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export async function snapshotVfs(fs: IFileSystem, root: string): Promise<VfsSnapshot> {
  const files: Record<string, Uint8Array> = {};
  const dirs: string[] = [];
  const links: Record<string, string> = {};
  const visit = async (dir: string): Promise<void> => {
    for (const name of [...(await fs.readdir(dir))].sort()) {
      const path = `${dir}/${name}`;
      const stat = await fs.lstat(path);
      if (stat.isSymbolicLink) links[path] = await fs.readlink(path);
      else if (stat.isDirectory) {
        dirs.push(path);
        await visit(path);
      } else files[path] = await fs.readFileBuffer(path);
    }
  };
  await visit(root);
  return { version: 1, files, dirs, links };
}

/** Make the filesystem under `root` exactly the snapshot's. */
export async function restoreVfs(fs: IFileSystem, root: string, snapshot: VfsSnapshot): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  for (const name of await fs.readdir(root)) await fs.rm(`${root}/${name}`, { recursive: true, force: true });
  for (const dir of snapshot.dirs) await fs.mkdir(dir, { recursive: true });
  for (const [path, bytes] of Object.entries(snapshot.files)) {
    await fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await fs.writeFile(path, bytes);
  }
  for (const [path, target] of Object.entries(snapshot.links)) {
    await fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await fs.symlink(target, path);
  }
}

const turnReport = z.object({
  stopReason: z.enum(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]),
  diff: z.object({ added: z.array(z.string()), modified: z.array(z.string()), removed: z.array(z.string()) }),
  toolCalls: z.number(),
  modelCalls: z.number(),
  ms: z.number(),
});

const pageState = z.object({
  version: z.literal(1),
  sessionId: z.string().optional(),
  settings: z.object({
    worker: z.string(),
    tier: z.enum(["quick", "default", "complex"]),
    approval: z.enum(["ask", "auto"]),
    generate: z
      .enum(["ask", ...GENERATIONS])
      // Generation never asks any more: a page kept when it asked first runs on auto.
      .transform((g) => (g === "ask" ? "auto" : g))
      .default("auto"),
    decide: z
      .string()
      .min(1)
      // Pages kept when this was "model" or "lexical": "model" meant the decision model, which auto now picks.
      .transform((d) => (d === "model" ? "auto" : d))
      .default("auto"),
    writer: z.string().min(1).default("auto"),
  }),
  turns: z.array(z.object({ prompt: z.string(), report: turnReport })),
});

/** The page's own state: the session it was on, its settings, and the turns it ran. */
export type PageState = z.infer<typeof pageState>;

export function parsePageState(value: unknown): PageState | undefined {
  const parsed = pageState.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Storage whose failures (none at all, a failed load or save) are reported rather than
 * thrown: a failed load is no state. After a failed load, saves are skipped until a load
 * succeeds, so a value that could not be read is never overwritten; `clear` always writes.
 */
export function resilient(storage: SnapshotStorage | (() => SnapshotStorage), report: (error: string) => void): SnapshotStorage & { clear(): Promise<void> } {
  let inner: SnapshotStorage | undefined;
  try {
    inner = typeof storage === "function" ? storage() : storage;
  } catch (e) {
    report(`storage unavailable: ${message(e)}`);
  }
  let unreadable = false;
  let told = false;
  const write = (value: unknown) => inner?.save(value).catch((e: unknown) => report(`save failed: ${message(e)}`));
  return {
    load: async () =>
      inner?.load().then(
        (value) => {
          unreadable = false;
          return value;
        },
        (e: unknown) => {
          unreadable = true;
          told = false;
          report(`load failed: ${message(e)}`);
          return undefined;
        },
      ),
    save: async (value) => {
      if (!unreadable) return write(value);
      if (!told) report("not saving: the stored value could not be read");
      told = true;
    },
    clear: async () => write(undefined),
  };
}

/**
 * Storage whose failures are reported and passed on, for a reader with a fallback of its
 * own (the agent worker keeps a conversation it could not load in memory, and does not
 * overwrite it); storage that cannot be opened fails every call.
 */
export function reported(storage: SnapshotStorage | (() => SnapshotStorage), report: (error: string) => void): SnapshotStorage {
  let inner: SnapshotStorage;
  try {
    inner = typeof storage === "function" ? storage() : storage;
  } catch (e) {
    report(`storage unavailable: ${message(e)}`);
    inner = { load: () => Promise.reject(e), save: () => Promise.reject(e) };
  }
  const passOn = (what: string) => (e: unknown) => {
    report(`${what} failed: ${message(e)}`);
    throw e;
  };
  return { load: () => inner.load().catch(passOn("load")), save: (value) => inner.save(value).catch(passOn("save")) };
}

/** One save at a time: requests while one runs become a single save after it, which sees the latest state. */
export class Coalesced {
  readonly #save: () => Promise<void>;
  readonly #report: (error: string) => void;
  #running: Promise<void> = Promise.resolve();
  #pending = false;

  constructor(save: () => Promise<void>, report: (error: string) => void) {
    this.#save = save;
    this.#report = report;
  }

  request(): void {
    if (this.#pending) return;
    this.#pending = true;
    this.#running = this.#running.then(() => {
      this.#pending = false;
      return this.#save().catch((e: unknown) => this.#report(`save failed: ${message(e)}`));
    });
  }

  /** Wait for the saves requested so far. */
  flush(): Promise<void> {
    return this.#running;
  }
}

const traceEvent = z.object({
  seq: z.number().int(),
  at: z.number(),
  kind: z.enum(["acp", "worker", "model", "tool", "vfs", "hook", "host"]),
  name: z.string(),
  detail: z.unknown().optional(),
  direction: z.enum(["in", "out"]).optional(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  phase: z.enum(["start", "end"]).optional(),
  spanOf: z.number().int().optional(),
  duration: z.number().optional(),
});
const storedTrace = z.object({ version: z.literal(1), events: z.array(traceEvent) });

/** A stored timeline's events, or undefined when what is stored is not one. */
export function parseTrace(value: unknown): TraceEvent[] | undefined {
  const parsed = storedTrace.safeParse(value);
  return parsed.success ? (parsed.data.events as TraceEvent[]) : undefined;
}

/**
 * An event as plain data to store: its detail written as JSON (bytes named by their
 * size), cut to a preview past `maxDetail` characters, or a note when it cannot be written.
 */
export function storableEvent(event: TraceEvent, options: { readonly maxDetail?: number } = {}): TraceEvent {
  const { detail, ...rest } = event;
  if (detail === undefined) return rest;
  const max = options.maxDetail ?? 16_000;
  let text: string | undefined;
  try {
    text = JSON.stringify(detail, (_key, value: unknown) => (value instanceof Uint8Array ? `[${value.length} bytes]` : value));
  } catch (e) {
    return { ...rest, detail: { unstorable: message(e) } };
  }
  if (text === undefined) return rest;
  return { ...rest, detail: text.length > max ? { cut: `${text.length} characters`, preview: text.slice(0, max) } : (JSON.parse(text) as unknown) };
}
