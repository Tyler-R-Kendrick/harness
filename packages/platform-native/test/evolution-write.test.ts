import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rename as realRename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SeededEntropy } from "@harness/testkit";
import { evolutionCommand } from "../src/evolution-command.ts";
import type { EvolutionDeps } from "../src/evolution-command.ts";
import { replaceFiles } from "../src/atomic-files.ts";
import { evaluateSimText } from "./evolution-sim.ts";
import { proposing, SETTINGS, textScenario } from "./evolution-world.ts";
import type { TextScenario } from "./evolution-world.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "evo-w-"));
  dirs.push(d);
  return d;
};
const read = (p: string) => readFileSync(p, "utf8");

describe("replacing several files together (EH13.40 to EH13.44)", () => {
  it("EH13.40 every file gets its new content, and nothing else is left in the directory", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.txt"), "a0");
    writeFileSync(join(dir, "b.txt"), "b0");
    await replaceFiles([
      { path: join(dir, "a.txt"), content: "a1" },
      { path: join(dir, "b.txt"), content: "b1" },
    ]);
    expect([read(join(dir, "a.txt")), read(join(dir, "b.txt"))]).toEqual(["a1", "b1"]);
    expect(readdirSync(dir).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("EH13.41 a file's mode is kept, and a symlink's target is replaced, not the link", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "real.txt"), "r0");
    chmodSync(join(dir, "real.txt"), 0o640);
    symlinkSync(join(dir, "real.txt"), join(dir, "link.txt"));
    await replaceFiles([{ path: join(dir, "link.txt"), content: "r1" }]);
    expect(read(join(dir, "real.txt"))).toBe("r1");
    expect(statSync(join(dir, "real.txt")).mode & 0o777).toBe(0o640);
    expect(statSync(join(dir, "link.txt")).isSymbolicLink()).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["link.txt", "real.txt"]);
  });

  it("EH13.42 when preparing a file fails nothing is replaced and the temporary files are removed", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.txt"), "a0");
    writeFileSync(join(dir, "b.txt"), "b0");
    let n = 0;
    await expect(
      replaceFiles(
        [
          { path: join(dir, "a.txt"), content: "a1" },
          { path: join(dir, "b.txt"), content: "b1" },
        ],
        {
          writeFile: async (path, content, mode) => {
            if (++n === 2) throw new Error("disk full");
            const { writeFile } = await import("node:fs/promises");
            await writeFile(path, content, { flag: "wx", mode });
          },
        },
      ),
    ).rejects.toThrow(`nothing was written: cannot prepare ${join(dir, "b.txt")}: disk full`);
    expect([read(join(dir, "a.txt")), read(join(dir, "b.txt"))]).toEqual(["a0", "b0"]);
    expect(readdirSync(dir).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("EH13.43 a target that changed while the files were prepared stops the write before any is replaced", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.txt"), "a0");
    writeFileSync(join(dir, "b.txt"), "b0");
    let n = 0;
    await expect(
      replaceFiles(
        [
          { path: join(dir, "a.txt"), content: "a1" },
          { path: join(dir, "b.txt"), content: "b1" },
        ],
        {
          writeFile: async (path, content, mode) => {
            const { writeFile } = await import("node:fs/promises");
            await writeFile(path, content, { flag: "wx", mode });
            // Someone edits the first file after it was read, before the swap.
            if (++n === 2) writeFileSync(join(dir, "a.txt"), "edited by hand");
          },
        },
      ),
    ).rejects.toThrow(`nothing was written: ${join(dir, "a.txt")} changed while the files were being prepared`);
    expect([read(join(dir, "a.txt")), read(join(dir, "b.txt"))]).toEqual(["edited by hand", "b0"]);
    expect(readdirSync(dir).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("EH13.44 when a swap fails the files already swapped are put back from the backups kept, and the failure says so; when putting one back fails too, it is named", async () => {
    const dir = tmp();
    for (const f of ["a", "b", "c"]) writeFileSync(join(dir, `${f}.txt`), `${f}0`);
    const entries = ["a", "b", "c"].map((f) => ({ path: join(dir, `${f}.txt`), content: `${f}1` }));
    // The third swap fails; the first two are restored.
    await expect(
      replaceFiles(entries, {
        rename: async (from, to) => {
          if (to === join(dir, "c.txt") && read(from) === "c1") throw new Error("read-only file system");
          await realRename(from, to);
        },
      }),
    ).rejects.toThrow(`cannot replace ${join(dir, "c.txt")}: read-only file system; the files replaced before it were put back: ${join(dir, "b.txt")}, ${join(dir, "a.txt")}`);
    expect(["a", "b", "c"].map((f) => read(join(dir, `${f}.txt`)))).toEqual(["a0", "b0", "c0"]);
    expect(readdirSync(dir).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
    // The second swap fails after the first: nothing else was replaced, so the first is restored and named.
    await expect(
      replaceFiles(entries, {
        rename: async (from, to) => {
          if (to === join(dir, "b.txt")) throw new Error("denied");
          await realRename(from, to);
        },
      }),
    ).rejects.toThrow(`cannot replace ${join(dir, "b.txt")}: denied; the files replaced before it were put back: ${join(dir, "a.txt")}`);
    // With the first swap failing, no file had been touched.
    await expect(
      replaceFiles(entries, {
        rename: async () => {
          throw new Error("denied");
        },
      }),
    ).rejects.toThrow(`cannot replace ${join(dir, "a.txt")}: denied; no file was changed`);
    expect(["a", "b", "c"].map((f) => read(join(dir, `${f}.txt`)))).toEqual(["a0", "b0", "c0"]);
    expect(readdirSync(dir).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
    // Putting back fails too: the file is named, holding the new content.
    let calls = 0;
    await expect(
      replaceFiles(entries.slice(0, 2), {
        rename: async (from, to) => {
          calls++;
          if (calls >= 2) throw new Error(`no rename ${calls}`);
          await realRename(from, to);
        },
      }),
    ).rejects.toThrow(`cannot replace ${join(dir, "b.txt")}: no rename 2; could NOT put back ${join(dir, "a.txt")} (no rename 3): it holds the new content`);
    expect(read(join(dir, "a.txt"))).toBe("a1");
    expect(readdirSync(dir).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
  });
});

describe("documents --write is all or nothing (EH13.45)", () => {
  async function cli(args: readonly string[], deps: EvolutionDeps = {}) {
    let out = "";
    let err = "";
    const code = await evolutionCommand(args, { stdout: (s) => void (out += s), stderr: (s) => void (err += s) }, { evaluate: evaluateSimText, entropy: new SeededEntropy(7), ...deps });
    return { code, out, err };
  }

  /** A finished run whose incumbent changed both a text document (agent) and a JSON document (policy). */
  async function twoChanged(): Promise<TextScenario & { policy: string }> {
    const s = textScenario(tmp());
    writeFileSync(join(s.dir, "settings.json"), JSON.stringify({ ...SETTINGS, budget: { min: 2, max: 2 }, candidates: 1 }));
    const both = {
      summary: "both",
      edits: [
        { id: "a", hypothesis: "verify helps", targets: "failures", ops: [{ op: "edit", document: "agent", old: "verify: off", new: "verify: on" }] },
        { id: "b", hypothesis: "b", targets: "t", ops: [{ op: "add", document: "policy", path: "/rules/x", value: true }] },
      ],
    };
    const p = proposing(() => both);
    expect((await cli(["run", "--config", s.config, "--model", "m", "--max-rounds", "1"], { languageModel: () => p.model })).code).toBe(0);
    return { ...s, policy: join(s.dir, "policy.json") };
  }

  it("EH13.45 a swap that fails leaves every file as it was, removes the temporary files and says what happened; without the failure both are written", async () => {
    const s = await twoChanged();
    const before = [read(s.agent), read(s.policy)];
    const failing = await cli(["documents", "--config", s.config, "--write"], {
      files: {
        rename: async (from, to) => {
          if (to === s.policy && from !== s.policy) throw new Error("read-only file system");
          await realRename(from, to);
        },
      },
    });
    expect(failing.code).toBe(1);
    expect(failing.err).toBe(`cannot replace ${s.policy}: read-only file system; the files replaced before it were put back: ${s.agent}\n`);
    expect(failing.out).not.toContain("wrote");
    expect([read(s.agent), read(s.policy)]).toEqual(before);
    expect(readdirSync(s.dir).filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(existsSync(`${s.state}.lock`)).toBe(false);
    const ok = await cli(["documents", "--config", s.config, "--write"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain(`wrote ${s.agent}\nwrote ${s.policy}\n`);
    expect(read(s.agent)).toBe("You are an agent.\nverify: on\nbe brief\n");
    expect(JSON.parse(read(s.policy))).toMatchObject({ rules: { x: true } });
  });
});
