import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { ArtifactText } from "@harness/cognitive";

/** A template id is one filename segment, so it cannot leave the template directory. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Answer-template bodies kept as files, so a person's correction can replace one. */
export function directoryTemplates(dir: string): ArtifactText {
  const path = (id: string): string => {
    if (!SEGMENT.test(id)) throw new Error(`a template id is one filename segment: ${id}`);
    return `${dir}/${id}.txt`;
  };
  return {
    async read(id) {
      try {
        return await readFile(path(id), "utf8");
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error["code"] === "ENOENT") return undefined;
        throw error;
      }
    },
    async write(id, content) {
      const file = path(id);
      await mkdir(dir, { recursive: true });
      await writeFile(file, content);
    },
  };
}
