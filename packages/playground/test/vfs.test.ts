import { describe, expect, it } from "vitest";
import { Bash } from "just-bash";
import { diffVfs, vfsApproval, vfsTools, walk } from "../src/vfs.ts";

const HOME = "/home/user";
const opts = { toolCallId: "t", messages: [], context: undefined };

function shell(files: Record<string, string> = {}) {
  return new Bash({ files, cwd: HOME });
}

describe("the agent's tools on the shared virtual filesystem", () => {
  it("VF1.1 bash runs a command in the home directory and returns its output and exit code", async () => {
    const bash = shell({ [`${HOME}/a.txt`]: "alpha\n" });
    const tools = vfsTools(bash);
    expect(await tools.bash.execute!({ command: "pwd && cat a.txt" }, opts)).toEqual({ stdout: `${HOME}\nalpha\n`, stderr: "", exitCode: 0 });
    expect(await tools.bash.execute!({ command: "cat missing" }, opts)).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("missing") });
  });

  it("VF1.2 a long output is cut to the limit and says so", async () => {
    const tools = vfsTools(shell(), { maxOutput: 10 });
    const out = (await tools.bash.execute!({ command: "echo 0123456789abcdef" }, opts)) as { stdout: string };
    expect(out.stdout).toBe("0123456789\n[cut: 7 more characters]");
  });

  it("VF1.3 writeFile creates parent directories; readFile reads it back; relative paths are under home", async () => {
    const bash = shell();
    const tools = vfsTools(bash);
    expect(await tools.writeFile.execute!({ path: "notes/today.md", content: "# Today\n" }, opts)).toEqual({ success: true, path: `${HOME}/notes/today.md` });
    expect(await tools.readFile.execute!({ path: `${HOME}/notes/today.md` }, opts)).toEqual({ content: "# Today\n" });
    expect(await bash.readFile(`${HOME}/notes/today.md`)).toBe("# Today\n");
    expect(await tools.writeFile.execute!({ path: "/top.txt", content: "t" }, opts)).toEqual({ success: true, path: "/top.txt" });
  });

  it("VF1.4 what the tools change is what the terminal sees: they share one filesystem", async () => {
    const bash = shell();
    await vfsTools(bash).bash.execute!({ command: "echo shared > s.txt" }, opts);
    expect((await bash.exec("cat s.txt", { cwd: HOME })).stdout).toBe("shared\n");
  });
});

describe("approvals for the tools", () => {
  const ask = (policy: "ask" | "auto", toolName: string) => vfsApproval(() => policy)({ toolCall: { toolName } } as never);

  it("VF2.1 when asking, commands and writes need the person's approval; reads never do", () => {
    expect([ask("ask", "bash"), ask("ask", "writeFile"), ask("ask", "readFile")]).toEqual(["user-approval", "user-approval", "not-applicable"]);
  });

  it("VF2.2 on auto nothing asks", () => {
    expect([ask("auto", "bash"), ask("auto", "writeFile")]).toEqual(["not-applicable", "not-applicable"]);
  });
});

describe("walking and diffing the filesystem", () => {
  it("VF3.1 a walk lists every file under a root with its size and text, sorted, and skips what it cannot read", async () => {
    const bash = shell({ [`${HOME}/b.txt`]: "bb", [`${HOME}/d/a.txt`]: "a", "/etc/x": "no" });
    const files = await walk(bash.fs, HOME);
    expect([...files.keys()]).toEqual([`${HOME}/b.txt`, `${HOME}/d/a.txt`]);
    expect(files.get(`${HOME}/b.txt`)).toEqual({ size: 2, mtime: expect.any(Number), text: "bb" });
    expect(await walk(bash.fs, "/nowhere")).toEqual(new Map());
    expect((await walk(bash.fs, "/")).get("/etc/x")).toMatchObject({ size: 2, text: "no" });
  });

  it("VF3.4 links are listed with their target, never followed: a dangling link and a link to a parent are fine; a changed target is a modification", async () => {
    const bash = shell({ [`${HOME}/a.txt`]: "a" });
    await bash.exec("ln -s nowhere dangling; ln -s .. up; ln -s a.txt alias", { cwd: HOME });
    const files = await walk(bash.fs, HOME);
    expect([...files.keys()]).toEqual([`${HOME}/a.txt`, `${HOME}/alias`, `${HOME}/dangling`, `${HOME}/up`]);
    expect(files.get(`${HOME}/dangling`)).toMatchObject({ size: 0, link: "nowhere" });
    expect(files.get(`${HOME}/up`)).toMatchObject({ size: 0, link: ".." });
    await bash.exec("rm alias; ln -s dangling alias", { cwd: HOME });
    expect(diffVfs(files, await walk(bash.fs, HOME)).modified).toEqual([`${HOME}/alias`]);
  });

  it("VF3.2 a diff names what was added, modified and removed", async () => {
    const bash = shell({ [`${HOME}/keep`]: "k", [`${HOME}/edit`]: "1", [`${HOME}/gone`]: "g" });
    const before = await walk(bash.fs, HOME);
    await bash.exec("echo 2 > edit; rm gone; echo n > new", { cwd: HOME });
    expect(diffVfs(before, await walk(bash.fs, HOME))).toEqual({ added: [`${HOME}/new`], modified: [`${HOME}/edit`], removed: [`${HOME}/gone`] });
  });

  it("VF3.3 files over the text limit are listed with their size but no text", async () => {
    const bash = shell({ [`${HOME}/big`]: "x".repeat(20) });
    expect((await walk(bash.fs, HOME, { maxText: 10 })).get(`${HOME}/big`)).toEqual({ size: 20, mtime: expect.any(Number) });
  });

  it("VF3.5 a same-size edit to a file too large to keep as text is a modification (its time changed); touching a small file without changing it is not", async () => {
    const bash = shell({ [`${HOME}/big`]: "x".repeat(20), [`${HOME}/small`]: "s" });
    const before = await walk(bash.fs, HOME, { maxText: 10 });
    await bash.fs.writeFile(`${HOME}/big`, "y".repeat(20));
    await bash.fs.utimes(`${HOME}/big`, new Date(0), new Date(before.get(`${HOME}/big`)!.mtime + 1000));
    await bash.fs.utimes(`${HOME}/small`, new Date(0), new Date(before.get(`${HOME}/small`)!.mtime + 1000));
    expect(diffVfs(before, await walk(bash.fs, HOME, { maxText: 10 })).modified).toEqual([`${HOME}/big`]);
  });

  it("VF3.6 a walk given the last one reads again only the files whose size or time changed", async () => {
    const bash = shell({ [`${HOME}/same`]: "s", [`${HOME}/edited`]: "e" });
    const before = await walk(bash.fs, HOME);
    await bash.fs.writeFile(`${HOME}/edited`, "E");
    await bash.fs.utimes(`${HOME}/edited`, new Date(0), new Date(before.get(`${HOME}/edited`)!.mtime + 1000));
    const read: string[] = [];
    const fs = new Proxy(bash.fs, { get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target);
        if (key === "readFile") return (path: string) => (read.push(path), target.readFile(path));
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const after = await walk(fs, HOME, { previous: before });
    expect(read).toEqual([`${HOME}/edited`]);
    expect(after.get(`${HOME}/same`)?.text).toBe("s");
    expect(diffVfs(before, after).modified).toEqual([`${HOME}/edited`]);
  });
});
