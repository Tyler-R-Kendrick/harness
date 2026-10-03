import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const children: ChildProcessWithoutNullStreams[] = [];

interface Launched {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  /** Everything the daemon wrote to stderr so far. */
  stderr(): string;
  /** The URL it printed as "systemone listening on <url>". */
  url(): Promise<string>;
  /** Resolves with the first match once stderr holds one. */
  until(pattern: RegExp): Promise<RegExpExecArray>;
}

/** Launch the daemon as an editor would (ACP on stdio, which stays open until a test ends it), with the cognitive core offline. */
function launch(args: readonly string[], stdio = true): Launched {
  const dir = mkdtempSync(join(tmpdir(), "harness-systemone-"));
  const child = spawn(process.execPath, [MAIN, ...(stdio ? ["--stdio"] : []), "--worker", "echo", "--state", join(dir, "state.json"), ...args], {
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  children.push(child);
  let stderr = "";
  const listeners: (() => void)[] = [];
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    for (const l of listeners.splice(0)) l();
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  const until = (pattern: RegExp): Promise<RegExpExecArray> =>
    new Promise((resolve, reject) => {
      const check = () => {
        const found = pattern.exec(stderr);
        if (found) return resolve(found);
        listeners.push(check);
      };
      check();
      void exited.then((code) => reject(new Error(`the daemon exited (${code}) before stderr matched ${pattern}:\n${stderr}`)));
    });
  const url = async (): Promise<string> => (await until(/systemone listening on (http:\/\/\S+)/))[1]!;
  return { child, exited, stderr: () => stderr, url, until };
}

const cognitive = (dir = mkdtempSync(join(tmpdir(), "harness-cache-"))) => ["--cognitive", "--no-hosted", "--model-cache", dir];

afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});

const json = { "content-type": "application/json" };
const valid = JSON.stringify({ model: "harness-ensemble", state: "I was charged twice", questions: { urgent: { type: "noul", instructions: "Is this urgent?" } } });

describe("harness --systemone", () => {
  it("DHK9.1 serves GET /v1/models, listing the harness ensemble, and says where it listens", async () => {
    const d = launch([...cognitive(), "--systemone", "0"]);
    const url = await d.url();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
    const res = await fetch(`${url}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: { name: string }[] };
    expect(body.models.map((m) => m.name)).toEqual(["harness-ensemble"]);
  });

  it("DHK9.2 a well-formed request with no judge to answer it gets a well-formed upstream error, and the daemon carries on", async () => {
    const d = launch([...cognitive(), "--systemone", "0"]);
    const url = await d.url();
    const res = await fetch(`${url}/v1/systemone`, { method: "POST", headers: json, body: valid });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ detail: { error_type: "upstream_error", message: expect.stringContaining("no judge") } });
    expect((await fetch(`${url}/v1/models`)).status).toBe(200);
  });

  it("DHK9.3 malformed JSON is a 422 in the wire's shape, and the daemon carries on", async () => {
    const d = launch([...cognitive(), "--systemone", "0"]);
    const url = await d.url();
    const res = await fetch(`${url}/v1/systemone`, { method: "POST", headers: json, body: "{ not json" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ detail: [{ loc: ["body"], type: "json_invalid" }] });
    expect((await fetch(`${url}/v1/models`)).status).toBe(200);
  });

  it("DHK9.4 each request is logged to stderr by method, path and status, never its body", async () => {
    const d = launch([...cognitive(), "--systemone", "0"]);
    const url = await d.url();
    await fetch(`${url}/v1/models`);
    await fetch(`${url}/v1/systemone`, { method: "POST", headers: json, body: valid });
    await d.until(/systemone: GET \/v1\/models 200 \d+ms/);
    await d.until(/systemone: POST \/v1\/systemone 502 \d+ms/);
    expect(d.stderr()).not.toContain("charged twice");
  });

  it("DHK9.5 with a token file every request needs its token, read without the whitespace around it", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "harness-token-")), "token");
    writeFileSync(file, "  s3cret-token\n");
    const d = launch([...cognitive(), "--systemone", "0", "--systemone-token-file", file]);
    const url = await d.url();
    expect((await fetch(`${url}/v1/models`)).status).toBe(401);
    expect((await fetch(`${url}/v1/models`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${url}/v1/models`, { headers: { authorization: "Bearer s3cret-token" } })).status).toBe(200);
    const post = await fetch(`${url}/v1/systemone`, { method: "POST", headers: { ...json, authorization: "Bearer s3cret-token" }, body: "{ not json" });
    expect(post.status).toBe(422);
    expect(d.stderr()).not.toContain("s3cret-token");
  });

  it("DHK9.6 ending the daemon's input shuts it down cleanly, closing the System One port with it", async () => {
    const d = launch([...cognitive(), "--systemone", "0"]);
    const url = await d.url();
    expect((await fetch(`${url}/v1/models`)).status).toBe(200);
    d.child.stdin.end();
    expect(await d.exited).toBe(0);
    await expect(fetch(`${url}/v1/models`)).rejects.toBeDefined();
  });

  it("DHK9.7 a termination signal shuts it down cleanly too", async () => {
    const d = launch([...cognitive(), "--systemone", "0"]);
    await d.url();
    d.child.kill("SIGTERM");
    expect(await d.exited).toBe(0);
  });

  it("DHK9.8 a port that is taken stops the daemon with a message that names it", async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const port = (taken.address() as { port: number }).port;
    try {
      const d = launch([...cognitive(), "--systemone", String(port)]);
      expect(await d.exited).toBe(1);
      expect(d.stderr()).toContain(`cannot listen on port ${port}`);
    } finally {
      taken.close();
    }
  });
});

describe("harness --systemone: options", () => {
  const refused = async (args: readonly string[], message: RegExp, stdio = true) => {
    const d = launch(args, stdio);
    expect(await d.exited).toBe(2);
    expect(d.stderr()).toMatch(message);
  };

  it("DHK10.1 --systemone needs the cognitive core", async () => {
    await refused(["--systemone", "0"], /--systemone needs --cognitive \(or --worker ensemble\)/);
  });

  it("DHK10.2 the port must be a whole number from 0 to 65535", async () => {
    for (const port of ["abc", "-1", "65536", "1.5", "", "0x10", "1e3", " 80"]) await refused([...cognitive(), `--systemone=${port}`], new RegExp(`--systemone takes a port number \\(0 for any free one\\), not "${port}"`));
  });

  it("DHK10.3 a token file needs --systemone", async () => {
    await refused(["--systemone-token-file", "/nowhere"], /--systemone-token-file needs --systemone/);
  });

  it("DHK10.4 an empty token file is an error, and so is one that cannot be read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-token-"));
    writeFileSync(join(dir, "empty"), " \n");
    await refused([...cognitive(), "--systemone", "0", "--systemone-token-file", join(dir, "empty")], /is empty: a token is required/);
    await refused([...cognitive(), "--systemone", "0", "--systemone-token-file", join(dir, "missing")], new RegExp(`cannot read ${join(dir, "missing")}`));
  });

  it("DHK10.5 the usage text names the options", async () => {
    await refused([], /--systemone <port> \[--systemone-token-file <file>\]/, false);
  });
});

describe("harness --systemone with --worker ensemble", () => {
  it("DHK10.6 serves the ensemble the worker runs on, with no --cognitive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cache-"));
    const child = spawn(process.execPath, [MAIN, "--stdio", "--worker", "ensemble", "--no-hosted", "--model-cache", dir, "--state", join(dir, "state.json"), "--systemone", "0"], {
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => void (stderr += chunk.toString("utf8")));
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setInterval(() => {
        const found = /systemone listening on (http:\/\/\S+)/.exec(stderr)?.[1];
        if (found) {
          clearInterval(timer);
          resolve(found);
        }
      }, 25);
      child.on("exit", () => {
        clearInterval(timer);
        reject(new Error(stderr));
      });
    });
    expect((await fetch(`${url}/v1/models`)).status).toBe(200);
  });
});
