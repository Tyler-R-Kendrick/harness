import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { makeSteerable } from "@harness/models";
import writeFileAtomic from "write-file-atomic";
import type { Tap } from "@harness/models";

/**
 * The local kernel's model file: the verified export, patched with a steering tap at
 * one layer (see makeSteerable), written once next to the model cache and reused.
 */
export async function steerableModel(options: {
  /** The verified source export on disk. */
  readonly source: string;
  readonly tap: Tap;
  /** Where patched files are kept. */
  readonly dir: string;
  readonly patch?: (bytes: Uint8Array, tap: Tap) => Uint8Array;
}): Promise<string> {
  const key = createHash("sha256").update(`${options.source}\n${options.tap.node}\n${options.tap.layer}`).digest("hex").slice(0, 24);
  const target = join(options.dir, `${key}-l${options.tap.layer}.onnx`);
  if (await stat(target).then((s) => s.isFile(), () => false)) return target;
  const patched = (options.patch ?? makeSteerable)(await readFile(options.source), options.tap);
  await mkdir(options.dir, { recursive: true });
  await writeFileAtomic(target, Buffer.from(patched.buffer, patched.byteOffset, patched.byteLength), { mode: 0o600 });
  return target;
}
