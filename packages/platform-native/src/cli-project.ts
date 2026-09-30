import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const NAME = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*$/;

function filesOf(templateDir: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(join(templateDir, "template.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("files" in parsed) || !Array.isArray(parsed.files)) throw new TypeError("cli template files must be a list");
  if (!parsed.files.every((file) => typeof file === "string" && file.length > 0)) throw new TypeError("cli template files must be a list");
  return parsed.files;
}

/** Write a CLI project at `dest` by copying the daemon-client template and naming the package. */
export function generateCliProject(templateDir: string, dest: string, name: string): void {
  if (!NAME.test(name)) throw new TypeError("cli name must be a package name");
  for (const file of filesOf(templateDir)) {
    const target = join(dest, file);
    mkdirSync(dirname(target), { recursive: true });
    if (file === "package.json") {
      const pkg: unknown = JSON.parse(readFileSync(join(templateDir, file), "utf8"));
      if (typeof pkg !== "object" || pkg === null) throw new TypeError("cli template package must be an object");
      writeFileSync(target, `${JSON.stringify({ ...pkg, name }, null, 2)}\n`);
    } else {
      writeFileSync(target, readFileSync(join(templateDir, file)));
    }
  }
}
