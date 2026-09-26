import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerSandbox } from "@harness/platform-native";

// A real Docker daemon runs these (CI's runner has one). The image is any with a POSIX
// shell and node; it comes from the public ECR mirror of Docker's official images.
const IMAGE = "public.ecr.aws/docker/library/node:22-bookworm-slim";
const RUN = `t${process.pid}`;
const provider = (options: Partial<Parameters<typeof dockerSandbox>[0]> = {}) => dockerSandbox({ image: IMAGE, labels: { "harness.test": RUN }, ...options });
const text = async (s: ReadableStream<Uint8Array>) => new Response(s).text();
let sessions = 0;
const id = () => `${RUN}-${++sessions}`;

// Pull once, before any test's clock starts: a fresh runner has no image yet.
beforeAll(() => {
  const pulled = spawnSync("docker", ["pull", "-q", IMAGE], { encoding: "utf8" });
  if (pulled.status !== 0) throw new Error(`docker pull ${IMAGE} failed: ${pulled.stderr}`);
}, 300_000);

afterAll(() => {
  const listed = spawnSync("docker", ["ps", "-aq", "--filter", `label=harness.test=${RUN}`], { encoding: "utf8" }).stdout.trim();
  if (listed) spawnSync("docker", ["rm", "-f", ...listed.split("\n")]);
});

// Containers start slower on a loaded machine than an in-process test runs.
describe("dockerSandbox: an AI SDK network sandbox in a container of its own", { timeout: 60_000 }, () => {
  it("DS1.1 commands run inside the session's container, not on this machine", async () => {
    const box = await provider().createSession({ sessionId: id() });
    expect(box.defaultWorkingDirectory).toBe("/workspace");
    expect(await box.run({ command: "pwd" })).toEqual({ exitCode: 0, stdout: "/workspace\n", stderr: "" });
    expect((await box.run({ command: "cat /etc/debian_version" })).exitCode).toBe(0);
    // a file on this machine is not there
    const here = join(mkdtempSync(join(tmpdir(), "harness-host-")), "secret.txt");
    writeFileSync(here, "host only");
    expect((await box.run({ command: `cat ${here}` })).exitCode).not.toBe(0);
    expect(await box.run({ command: "mkdir -p a && cd a && echo oops >&2; exit 3" })).toEqual({ exitCode: 3, stdout: "", stderr: "oops\n" });
    expect((await box.run({ command: "pwd; echo $X", workingDirectory: "a", env: { X: "set" } })).stdout).toBe("/workspace/a\nset\n");
    await box.destroy();
  });

  it("DS1.2 files read and write inside the container as text, bytes and streams; a missing file reads as null", async () => {
    const box = await provider().createSession({ sessionId: id() });
    await box.writeBinaryFile({ path: "b.bin", content: new Uint8Array([0, 1, 2, 255]) });
    expect(await box.readBinaryFile({ path: "/workspace/b.bin" })).toEqual(new Uint8Array([0, 1, 2, 255]));
    await box.writeFile({ path: "deep/c.txt", content: new Blob(["streamed"]).stream() });
    expect(await text((await box.readFile({ path: "deep/c.txt" }))!)).toBe("streamed");
    await box.writeTextFile({ path: "/tmp/lines.txt", content: "one\ntwo\nthree\n" });
    expect(await box.readTextFile({ path: "/tmp/lines.txt", startLine: 2, endLine: 3 })).toBe("two\nthree");
    expect(await box.readTextFile({ path: "/tmp/lines.txt" })).toBe("one\ntwo\nthree\n");
    expect((await box.run({ command: "cat deep/c.txt" })).stdout).toBe("streamed");
    expect(await box.readTextFile({ path: "missing.txt" })).toBeNull();
    expect(await box.readBinaryFile({ path: "missing.bin" })).toBeNull();
    expect(await box.readFile({ path: "missing" })).toBeNull();
    await box.destroy();
  });

  it("DS1.3 spawned commands stream their output and can be waited on, or killed with what they started", async () => {
    const box = await provider().createSession({ sessionId: id() });
    const echo = await box.spawn({ command: "echo out; echo err >&2" });
    expect(await text(echo.stdout)).toBe("out\n");
    expect(await text(echo.stderr)).toBe("err\n");
    expect(await echo.wait()).toEqual({ exitCode: 0 });
    const long = await box.spawn({ command: "sleep 300 & sleep 300; wait" });
    await new Promise((r) => setTimeout(r, 300));
    await long.kill();
    expect((await long.wait()).exitCode).not.toBe(0);
    // what the command started ended with it (the image has no ps; the container itself runs sleep infinity)
    const sleeping = async () => (await box.run({ command: "for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < $f; echo; done 2>/dev/null | grep -c '^sleep 300' || true" })).stdout.trim();
    for (let i = 0; i < 20 && (await sleeping()) !== "0"; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await sleeping()).toBe("0");
    await long.kill();
    await box.destroy();
  });

  it("DS1.4 the session's port is published on this machine's loopback, so a bridge in the container is reachable", async () => {
    const box = await provider().createSession({ sessionId: id() });
    const [port] = box.ports;
    expect(port).toBeGreaterThan(0);
    await box.spawn({ command: `node -e "require('http').createServer((q, r) => r.end('from the container')).listen(${port}, '0.0.0.0')"` });
    const { url } = await box.getPortEndpoint({ port: port! });
    expect(url).toBe(`http://127.0.0.1:${port}`);
    let reply = "";
    for (let i = 0; i < 50 && !reply; i++) reply = await fetch(url).then((r) => r.text(), () => new Promise<string>((r) => setTimeout(() => r(""), 100)));
    expect(reply).toBe("from the container");
    expect(await box.getPortUrl({ port: port!, protocol: "ws" })).toBe(`ws://127.0.0.1:${port}`);
    await expect(box.getPortEndpoint({ port: port! + 1 })).rejects.toThrow(/not published/);
    await box.destroy();
  });

  it("DS1.5 a new container runs its setup, then the first-create hook, once; stopping ends its commands and keeps its files; resuming finds them; destroying removes it", async () => {
    const sandboxes = provider({ setup: "echo ready > /opt/setup-ran" });
    const sessionId = id();
    const firsts: string[] = [];
    const box = await sandboxes.createSession({ sessionId, onFirstCreate: async (s) => void firsts.push((await s.readTextFile({ path: "/opt/setup-ran" }))!) });
    expect(firsts).toEqual(["ready\n"]);
    await box.writeTextFile({ path: "keep.txt", content: "kept" });
    const long = await box.spawn({ command: "sleep 300" });
    await box.stop();
    expect((await long.wait()).exitCode).not.toBe(0);
    const again = await sandboxes.resumeSession!({ sessionId });
    expect(again.ports).toEqual(box.ports);
    expect(await again.readTextFile({ path: "keep.txt" })).toBe("kept");
    // creating an existing session reuses it: no setup or first-create hook again
    const same = await sandboxes.createSession({ sessionId, onFirstCreate: async () => void firsts.push("again") });
    expect(firsts).toEqual(["ready\n"]);
    expect(await same.readTextFile({ path: "keep.txt" })).toBe("kept");
    await again.destroy();
    await expect(sandboxes.resumeSession!({ sessionId })).rejects.toThrow(/no sandbox/);
  });

  it("DS1.6 a setup that fails leaves no container behind", async () => {
    const sessionId = id();
    await expect(provider({ setup: "echo broken >&2; exit 7" }).createSession({ sessionId })).rejects.toThrow(/setup failed \(exit 7\): broken/);
    await expect(provider().resumeSession!({ sessionId })).rejects.toThrow(/no sandbox/);
  });

  it("DS1.7 without a network a container has only loopback and no port; the environment and mounts given reach it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-mount-"));
    writeFileSync(join(dir, "shared.txt"), "shared");
    const box = await provider({ network: "none", env: { GREETING: "hello" }, mounts: [{ source: dir, target: "/mnt/in", readonly: true }] }).createSession({ sessionId: id() });
    expect(box.ports).toEqual([]);
    expect((await box.run({ command: "ls /sys/class/net" })).stdout.trim()).toBe("lo");
    expect((await box.run({ command: "echo $GREETING; cat /mnt/in/shared.txt" })).stdout).toBe("hello\nshared");
    expect((await box.run({ command: "touch /mnt/in/nope" })).exitCode).not.toBe(0);
    await expect(box.getPortEndpoint({ port: 1 })).rejects.toThrow(/not published/);
    await box.destroy();
  });

  it("DS1.8 failures say what failed: an image that cannot run, a file that cannot be read or written, a docker CLI that is not there", async () => {
    await expect(provider({ image: "harness-no-such-image:0" }).createSession({ sessionId: id() })).rejects.toThrow(/starting a container for .* failed/);
    const dir = mkdtempSync(join(tmpdir(), "harness-mount-"));
    const box = await provider({ mounts: [{ source: dir, target: "/mnt/ro", readonly: true }] }).createSession({ sessionId: id() });
    await expect(box.readTextFile({ path: "/tmp" })).rejects.toThrow(/reading \/tmp in .* failed/);
    await expect(box.writeTextFile({ path: "/mnt/ro/x.txt", content: "no" })).rejects.toThrow(/writing \/mnt\/ro\/x.txt in .* failed/);
    await box.destroy();
    await expect(provider({ docker: "/nonexistent/docker" }).createSession({ sessionId: id() })).rejects.toThrow(/ENOENT/);
  });

  it("DS1.9 environment values reach commands but never the docker command line, where other users could read them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-docker-cli-"));
    const log = join(dir, "argv.log");
    const cli = join(dir, "docker");
    writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec docker "$@"\n`);
    chmodSync(cli, 0o755);
    const box = await provider({ docker: cli, env: { API_KEY: "s3cret-at-create" } }).createSession({ sessionId: id() });
    expect((await box.run({ command: "echo $API_KEY $OTHER", env: { OTHER: "s3cret-per-command" } })).stdout).toBe("s3cret-at-create s3cret-per-command\n");
    const argv = readFileSync(log, "utf8");
    expect(argv).toMatch(/-e API_KEY/);
    expect(argv).not.toMatch(/s3cret/);
    await box.destroy();
  });

  it("DS1.10 session ids that read alike once made safe for docker still get containers of their own", async () => {
    const sandboxes = provider();
    const a = await sandboxes.createSession({ sessionId: `${RUN}-a/b` });
    const b = await sandboxes.createSession({ sessionId: `${RUN}-a_b` });
    await a.writeTextFile({ path: "who", content: "a" });
    expect(await b.readTextFile({ path: "who" })).toBeNull();
    await a.destroy();
    await b.destroy();
  });

  it("DS1.11 a mount whose path docker's mount syntax cannot carry is refused", () => {
    expect(() => provider({ mounts: [{ source: "/tmp/a,b", target: "/mnt" }] })).toThrow(/mount path .* cannot contain a comma/);
  });
});
