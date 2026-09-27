import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LlamaServerProcess } from "@harness/platform-native";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A stand-in llama-server: records its argv, answers /health 503 twice then 200. */
async function fakeServer(behaviour: "ok" | "crash" | "hang" = "ok"): Promise<{ binary: string; argsFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "fake-llama-"));
  dirs.push(dir);
  const argsFile = join(dir, "args.json");
  const binary = join(dir, "llama-server");
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require("node:fs"); const http = require("node:http");
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
if (${JSON.stringify(behaviour)} === "crash") { process.stderr.write("error: unknown model architecture 'chat-9b'\\n"); process.exit(1); }
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
let polls = 0;
http.createServer((req, res) => {
  if (req.url === "/health") { polls++; const ready = ${JSON.stringify(behaviour)} === "ok" && polls > 2; res.writeHead(ready ? 200 : 503); res.end(ready ? '{"status":"ok"}' : '{"status":"loading model"}'); return; }
  res.writeHead(404); res.end();
}).listen(port, "127.0.0.1");
`,
  );
  await chmod(binary, 0o755);
  return { binary, argsFile };
}

describe("llama-server process", () => {
  it("LP1.1 starts the server on a free local port with the model and --jinja, and waits until it is healthy", async () => {
    const { binary, argsFile } = await fakeServer();
    const server = await LlamaServerProcess.start({ binary, model: "/models/generator-a.gguf", contextSize: 8192, pollMs: 20 });
    try {
      expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect((await fetch(`${server.baseUrl}/health`)).status).toBe(200);
      const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
      expect(args).toEqual(expect.arrayContaining(["-m", "/models/generator-a.gguf", "--host", "127.0.0.1", "--jinja", "-c", "8192"]));
      expect(args).not.toContain("--mmproj");
    } finally {
      await server.stop();
    }
    await expect(fetch(`${server.baseUrl}/health`)).rejects.toThrow();
  });

  it("LP1.2 a vision model gets its projector", async () => {
    const { binary, argsFile } = await fakeServer();
    const server = await LlamaServerProcess.start({ binary, model: "/m/ocr-a.gguf", mmproj: "/m/mmproj.gguf", pollMs: 20 });
    await server.stop();
    expect(JSON.parse(await readFile(argsFile, "utf8"))).toEqual(expect.arrayContaining(["--mmproj", "/m/mmproj.gguf"]));
  });

  it("LP1.3 a server that exits while starting is an error carrying its stderr", async () => {
    const { binary } = await fakeServer("crash");
    await expect(LlamaServerProcess.start({ binary, model: "/m/x.gguf", pollMs: 20 })).rejects.toThrow(/exited.*unknown model architecture/s);
  });

  it("LP1.4 a server that never becomes healthy is killed after the timeout", async () => {
    const { binary } = await fakeServer("hang");
    await expect(LlamaServerProcess.start({ binary, model: "/m/x.gguf", pollMs: 20, readyTimeoutMs: 300 })).rejects.toThrow(/not ready after 300 ms/);
  });
});
