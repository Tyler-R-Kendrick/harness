/**
 * Builds the playground into one self-contained HTML file: the page's markup and styles
 * (page.html), then the whole app (harness, terminal, shell) bundled into one inline
 * module script. That file is what gets published as an artifact, which allows no
 * scripts from other hosts, so nothing is left to load.
 *
 *   node packages/playground/build.ts [out.html]
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build } from "vite";

const here = new URL(".", import.meta.url).pathname;
const packages = new URL("..", import.meta.url).pathname;
const HARNESS = ["platform-browser", "runtime", "core", "cognitive", "workers", "client", "protocol", "models", "constrained", "behavior", "workflows"];

/** Build the page and return its HTML (the artifact's content: no doctype, html, head or body tags). */
export async function buildPlayground(options: { readonly minify?: boolean } = {}): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), "harness-playground-"));
  try {
    await build({
      configFile: false,
      logLevel: "warn",
      resolve: {
        alias: [
          // Each package's entry; its other exports (a package's data files) resolve as files.
          ...HARNESS.map((name) => ({ find: new RegExp(`^@harness/${name}$`), replacement: join(packages, name, "src/index.ts") })),
          // just-bash's browser bundle names node:zlib for gzip commands the page never runs.
          { find: /^node:zlib$/, replacement: join(here, "zlib-stub.ts") },
        ],
      },
      build: {
        outDir: out,
        emptyOutDir: true,
        target: "es2022",
        minify: options.minify ?? true,
        modulePreload: false,
        // Everything is inlined but WebAssembly: onnxruntime-web's (tens of MB each) is fetched from its CDN at run time (`onnxWasm`).
        assetsInlineLimit: (file: string) => !file.endsWith(".wasm"),
        rollupOptions: { input: join(here, "src/app.ts"), output: { format: "es", entryFileNames: "app.js", codeSplitting: false } },
      },
    });
    const js = readdirSync(out).filter((f) => f.endsWith(".js"));
    if (js.length !== 1) throw new Error(`expected one script, got ${js.join(", ")}`);
    const script = readFileSync(join(out, js[0]!), "utf8").replace(/<\/script/gi, "<\\/script");
    return `${readFileSync(join(here, "page.html"), "utf8")}\n<script type="module">\n${script}\n</script>\n`;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] ?? join(here, "dist/harness-playground.html");
  const html = await buildPlayground();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html);
  console.log(`${target}: ${(html.length / 1024 / 1024).toFixed(2)} MB`);
}
