import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The token WebSocket clients must present: read from `file`, or made at random and kept
 * there, readable by its owner only (clients on this machine read it from there).
 */
export async function webSocketToken(file: string): Promise<string> {
  const saved = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (saved !== undefined) {
    const token = saved.trim();
    if (!token) throw new Error(`the WebSocket token file ${file} is empty`);
    return token;
  }
  const token = randomBytes(32).toString("base64url");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${token}\n`, { mode: 0o600, flag: "wx" });
  return token;
}
