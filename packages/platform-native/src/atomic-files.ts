import { randomBytes } from "node:crypto";
import { chmod, chown, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** The file operations a replacement uses, each replaceable (tests inject failures; the CLI uses the file system's). */
export interface FileOps {
  readonly readFile: (path: string) => Promise<Buffer>;
  /** Create a file that must not exist, write it, and flush it to disk. */
  readonly writeFile: (path: string, content: Buffer | string, mode: number) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
}

const fileSystem: FileOps = {
  readFile: (path) => readFile(path),
  writeFile: async (path, content, mode) => {
    const file = await open(path, "wx", mode);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
  },
  rename,
  unlink,
};

interface Staged {
  readonly target: string;
  readonly temp: string;
  /** What the target held when it was read: what it is restored to. */
  readonly before: Buffer;
  readonly mode: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const temporary = (target: string) => join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);

/**
 * Replace several files, all or none as far as a file system allows. Each new content is
 * written to a temporary file beside its target and flushed to disk first, so that a full
 * disk or an unwritable directory is found before anything is replaced; then every target is
 * read again and must still hold what it held when it was read (a file edited meanwhile
 * stops the write); then the temporary files are renamed over the targets in order, and if
 * one rename fails the ones already done are put back from the backups kept in memory.
 * A symlink is followed (the file it names is replaced), and a file keeps its mode and,
 * when it can be kept, its owner. Limits: a rename is atomic, the set of renames is not: a
 * crash between two of them leaves some files replaced; and putting a file back can fail
 * as the rename did, in which case the failure names it.
 */
export async function replaceFiles(entries: readonly { readonly path: string; readonly content: string }[], ops: Partial<FileOps> = {}): Promise<void> {
  const fs: FileOps = { ...fileSystem, ...ops };
  const staged: Staged[] = [];
  const discard = async (temps: readonly string[]) => {
    for (const temp of temps) await fs.unlink(temp).catch(() => {});
  };
  let stagedFor = "";
  try {
    for (const { path, content } of entries) {
      stagedFor = path;
      const target = await realpath(path);
      const before = await fs.readFile(target);
      const info = await stat(target);
      const temp = temporary(target);
      // Recorded before it is written: a write that fails part way leaves a file to remove.
      staged.push({ target, temp, before, mode: info.mode & 0o7777 });
      await fs.writeFile(temp, content, info.mode & 0o7777);
      // What was written: the mode as the file had it (the umask may have narrowed the one given), and the owner where the platform lets us.
      await chmod(temp, info.mode & 0o7777);
      await chown(temp, info.uid, info.gid).catch(() => {});
    }
  } catch (e) {
    await discard(staged.map((s) => s.temp));
    throw new Error(`nothing was written: cannot prepare ${stagedFor}: ${message(e)}`);
  }
  for (const s of staged) {
    const now = await fs.readFile(s.target).catch(() => undefined);
    if (now === undefined || !now.equals(s.before)) {
      await discard(staged.map((t) => t.temp));
      throw new Error(`nothing was written: ${s.target} changed while the files were being prepared`);
    }
  }
  const done: Staged[] = [];
  for (const s of staged) {
    try {
      await fs.rename(s.temp, s.target);
      done.push(s);
    } catch (e) {
      await discard(staged.map((t) => t.temp));
      const putBack: string[] = [];
      const lost: string[] = [];
      for (const d of [...done].reverse()) {
        const temp = temporary(d.target);
        try {
          await fs.writeFile(temp, d.before, d.mode);
          await chmod(temp, d.mode);
          await fs.rename(temp, d.target);
          putBack.push(d.target);
        } catch (restoring) {
          await discard([temp]);
          lost.push(`could NOT put back ${d.target} (${message(restoring)}): it holds the new content`);
        }
      }
      const tail = [...(putBack.length ? [`the files replaced before it were put back: ${putBack.join(", ")}`] : []), ...lost, ...(done.length === 0 ? ["no file was changed"] : [])];
      throw new Error(`cannot replace ${s.target}: ${message(e)}; ${tail.join("; ")}`);
    }
  }
}
