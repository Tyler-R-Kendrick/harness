import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { hostSandbox } from "@harness/platform-native";

const root = () => mkdtempSync(join(tmpdir(), "harness-sandboxes-"));
const text = async (s: ReadableStream<Uint8Array>) => new Response(s).text();

describe("hostSandbox: an AI SDK network sandbox that runs on this machine, unisolated", () => {
  it("HX1.1 a session is a directory of its own, where commands run and files resolve", async () => {
    const box = await hostSandbox({ root: root() }).createSession({ sessionId: "s1" });
    expect(box.id).toBe("s1");
    expect(box.defaultWorkingDirectory).toMatch(/s1$/);
    expect(await box.run({ command: "pwd" })).toEqual({ exitCode: 0, stdout: `${box.defaultWorkingDirectory}\n`, stderr: "" });
    await box.writeTextFile({ path: "a/note.txt", content: "hi" });
    expect(await box.readTextFile({ path: join(box.defaultWorkingDirectory, "a/note.txt") })).toBe("hi");
    expect(await box.run({ command: "cat note.txt; echo oops >&2; exit 3", workingDirectory: "a", env: { X: "1" } })).toEqual({ exitCode: 3, stdout: "hi", stderr: "oops\n" });
    expect((await box.run({ command: "echo $X", env: { X: "set" } })).stdout).toBe("set\n");
    await box.destroy();
  });

  it("HX1.2 files read and write as text, bytes and streams; a missing file reads as null", async () => {
    const box = await hostSandbox({ root: root() }).createSession();
    await box.writeBinaryFile({ path: "b.bin", content: new Uint8Array([1, 2, 3]) });
    expect(await box.readBinaryFile({ path: "b.bin" })).toEqual(new Uint8Array([1, 2, 3]));
    await box.writeFile({ path: "c.txt", content: new Blob(["streamed"]).stream() });
    expect(await text((await box.readFile({ path: "c.txt" }))!)).toBe("streamed");
    await box.writeTextFile({ path: "lines.txt", content: "one\ntwo\nthree\n" });
    expect(await box.readTextFile({ path: "lines.txt", startLine: 2, endLine: 3 })).toBe("two\nthree");
    expect([await box.readFile({ path: "none" }), await box.readBinaryFile({ path: "none" }), await box.readTextFile({ path: "none" })]).toEqual([null, null, null]);
    await box.destroy();
  });

  it("HX1.3 spawned processes stream their output and can be waited on or killed", async () => {
    const box = await hostSandbox({ root: root() }).createSession();
    const p = await box.spawn({ command: "printf 'out'; printf 'err' >&2" });
    const [out, err, exit] = await Promise.all([text(p.stdout), text(p.stderr), p.wait()]);
    expect({ out, err, exit }).toEqual({ out: "out", err: "err", exit: { exitCode: 0 } });
    const long = await box.spawn({ command: "sleep 30" });
    await long.kill();
    expect((await long.wait()).exitCode).not.toBe(0);
    await box.destroy();
  });

  it("HX1.4 each session exposes a free loopback port a bridge can listen on and the host reach", async () => {
    const box = await hostSandbox({ root: root() }).createSession();
    expect(box.ports).toHaveLength(1);
    const port = box.ports[0]!;
    expect(await box.getPortEndpoint({ port, protocol: "ws" })).toEqual({ url: `ws://127.0.0.1:${port}` });
    expect(await box.getPortUrl({ port })).toBe(`http://127.0.0.1:${port}`);
    await expect(box.getPortEndpoint({ port: port + 1 })).rejects.toThrow(/not exposed/);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await box.destroy();
  });

  it("HX1.5 a fresh session runs its first-create hook once; resuming finds the same directory; destroy removes it", async () => {
    const provider = hostSandbox({ root: root() });
    let firsts = 0;
    const box = await provider.createSession({ sessionId: "keep", onFirstCreate: async (s) => void (firsts++, await s.writeTextFile({ path: "marker", content: "x" })) });
    await box.stop();
    const again = await provider.resumeSession!({ sessionId: "keep" });
    expect(await again.readTextFile({ path: "marker" })).toBe("x");
    expect(firsts).toBe(1);
    expect(again.restricted().description).toBe(again.description);
    await again.destroy();
    expect(existsSync(again.defaultWorkingDirectory)).toBe(false);
    await expect(provider.resumeSession!({ sessionId: "keep" })).rejects.toThrow(/no sandbox/);
  });

  it("HX1.6 stopping a session ends the commands still running in it, with what they started; finished ones are left alone", async () => {
    const provider = hostSandbox({ root: root() });
    const box = await provider.createSession({ sessionId: "s6" });
    await box.run({ command: "true" });
    const bridge = await box.spawn({ command: "sleep 30 & wait" });
    const running = box.run({ command: "sleep 30" });
    // the same session resumed elsewhere in the process still reaches what the first handle started
    const resumed = await provider.resumeSession!({ sessionId: "s6" });
    await resumed.stop();
    expect((await bridge.wait()).exitCode).not.toBe(0);
    expect((await running).exitCode).not.toBe(0);
    expect(existsSync(box.defaultWorkingDirectory)).toBe(true);
    expect((await box.run({ command: "echo still usable" })).stdout).toBe("still usable\n");
    await box.destroy();
  });

  it("HX1.7 destroying a session ends its running commands and removes its directory", async () => {
    const box = await hostSandbox({ root: root() }).createSession();
    const long = await box.spawn({ command: "sleep 30" });
    await box.destroy();
    expect((await long.wait()).exitCode).not.toBe(0);
    expect(existsSync(box.defaultWorkingDirectory)).toBe(false);
  });
});
