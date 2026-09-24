import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";

export interface LlamaServerStart {
  /** Path to llama.cpp's llama-server binary. */
  readonly binary: string;
  readonly model: string;
  /** Multimodal projector, for vision models such as OvisOCR2. */
  readonly mmproj?: string;
  readonly contextSize?: number;
  readonly args?: readonly string[];
  readonly readyTimeoutMs?: number;
  readonly pollMs?: number;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      s.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

/**
 * A llama-server child process bound to loopback, serving one model. `start`
 * resolves once /health reports the model loaded.
 */
export class LlamaServerProcess {
  readonly baseUrl: string;
  readonly #child: ChildProcess;

  private constructor(baseUrl: string, child: ChildProcess) {
    this.baseUrl = baseUrl;
    this.#child = child;
  }

  static async start(options: LlamaServerStart): Promise<LlamaServerProcess> {
    const port = await freePort();
    const args = [
      "-m",
      options.model,
      ...(options.mmproj ? ["--mmproj", options.mmproj] : []),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--jinja",
      "-c",
      String(options.contextSize ?? 16384),
      ...(options.args ?? []),
    ];
    const child = spawn(options.binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    let exited: number | null | undefined;
    child.once("exit", (code) => (exited = code));
    const spawnError = new Promise<never>((_, reject) => child.once("error", reject));
    spawnError.catch(() => undefined);
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + (options.readyTimeoutMs ?? 600_000);
    const poll = options.pollMs ?? 500;
    for (;;) {
      if (exited !== undefined) throw new Error(`llama-server exited with code ${exited} while starting: ${stderr.trim()}`);
      try {
        const health = await Promise.race([fetch(`${baseUrl}/health`), spawnError]);
        if (health.status === 200) return new LlamaServerProcess(baseUrl, child);
      } catch (e) {
        if (exited === undefined && child.exitCode === null && child.pid === undefined) throw e;
      }
      if (Date.now() >= deadline) {
        child.kill("SIGKILL");
        throw new Error(`llama-server not ready after ${options.readyTimeoutMs ?? 600_000} ms: ${stderr.trim()}`);
      }
      await sleep(poll);
    }
  }

  async stop(): Promise<void> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    const done = new Promise<void>((resolve) => this.#child.once("exit", () => resolve()));
    this.#child.kill("SIGTERM");
    const timer = setTimeout(() => this.#child.kill("SIGKILL"), 5000);
    await done;
    clearTimeout(timer);
  }
}
