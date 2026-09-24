import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseCatalog } from "@harness/cognitive";
import type { Catalog } from "@harness/cognitive";

const require = createRequire(import.meta.url);

/**
 * Read and parse a catalog (catalog.json + benchmarks.json) at startup: a package's own
 * data files by default, or a directory holding tweaked copies.
 */
export function loadCatalog(from: { readonly package: "@harness/cognitive" | "@harness/memory" } | { readonly dir: string } = { package: "@harness/cognitive" }): Catalog {
  const path = (file: string) => ("dir" in from ? join(from.dir, file) : require.resolve(`${from.package}/data/${file}`));
  const read = (file: string): unknown => JSON.parse(readFileSync(path(file), "utf8"));
  return parseCatalog(read("catalog.json"), read("benchmarks.json"));
}
