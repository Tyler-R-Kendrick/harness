import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probability } from "@harness/cognitive";
import { AuthoritySchema, forkId, parseCalibration, parsePolicy } from "@harness/decision";
import type { CalibrationBook } from "@harness/decision";
import { decisionFiles } from "@harness/platform-native";

const require = createRequire(import.meta.url);
const shippedJson = (file: string): unknown => JSON.parse(readFileSync(require.resolve(`@harness/decision/data/${file}`), "utf8"));

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "harness-decision-dir-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const book = (member = "m"): CalibrationBook =>
  parseCalibration({
    entries: [
      {
        fork: "permission.risk",
        member,
        version: "v1",
        question: "risk",
        calibrator: { kind: "temperature", temperature: 1.5 },
        fitted: { n: 40, at: 1000, eceBefore: 0.2, eceAfter: 0.05, brierBefore: 0.3, brierAfter: 0.2 },
      },
    ],
  });
const write = (dir: string, name: string, json: unknown): void => writeFileSync(join(dir, name), typeof json === "string" ? json : JSON.stringify(json));

describe("decisionFiles: what a directory holds", () => {
  it("DHK7.1 a directory with none of the files gets the files shipped with the decision layer, and an empty log", async () => {
    const files = await decisionFiles(await tempDir());
    expect(files.policy).toEqual(parsePolicy(shippedJson("policy.json")));
    expect(files.authority).toEqual(AuthoritySchema.parse(shippedJson("permission.json")));
    expect(files.calibration).toEqual(parseCalibration(shippedJson("calibration.json")));
    expect(files.calibration.entries).toEqual([]);
    expect(await files.log.size()).toBe(0);
  });

  it("DHK7.2 the directory's own policy, authority and calibration are used instead", async () => {
    const dir = await tempDir();
    const shipped = shippedJson("policy.json") as { default: object };
    write(dir, "policy.json", { ...shipped, version: "mine", $schema: "x" });
    write(dir, "authority.json", { version: "my-authority", default: "deny", rules: [] });
    write(dir, "calibration.json", book("mine"));
    const files = await decisionFiles(dir);
    expect(files.policy.version).toBe("mine");
    expect(files.authority).toEqual({ version: "my-authority", default: "deny", rules: [] });
    expect(files.calibration.entries.map((e) => e.member)).toEqual(["mine"]);
  });

  it("DHK7.3 each file is looked for on its own: one present does not take the others' place", async () => {
    const dir = await tempDir();
    write(dir, "authority.json", { version: "only", default: "allow", rules: [] });
    const files = await decisionFiles(dir);
    expect(files.authority.version).toBe("only");
    expect(files.policy).toEqual(parsePolicy(shippedJson("policy.json")));
    expect(files.calibration.entries).toEqual([]);
  });

  it("DHK7.4 the log lives in decisions.jsonl of the directory, opened with the options given, and the directory is made when missing", async () => {
    const dir = join(await tempDir(), "deep", "dir");
    const files = await decisionFiles(dir, { maxRecords: 1 });
    expect(files.log.file).toBe(join(dir, "decisions.jsonl"));
    expect(existsSync(dir)).toBe(true);
    const a = await files.log.next();
    const b = await files.log.next();
    for (const id of [a, b]) {
      await files.log.append({
        id,
        fork: forkId("a.b"),
        forkVersion: "1",
        at: 1,
        input: null,
        rung: "rule",
        policy: "p",
        answers: {},
        action: null,
        confidence: probability(1),
        propensity: probability(1),
        explored: false,
        mode: "active",
        trace: [],
      });
    }
    expect(await files.log.size()).toBe(1);
  });
});

describe("decisionFiles: errors name the file", () => {
  it("DHK7.5 a file that is not JSON is named, and is not replaced by the shipped one", async () => {
    for (const name of ["policy.json", "authority.json", "calibration.json"]) {
      const dir = await tempDir();
      write(dir, name, "{ not json");
      const error = await decisionFiles(dir).then(
        () => undefined,
        (e: unknown) => e as Error & { code?: string },
      );
      expect(error?.message, name).toContain(join(dir, name));
      expect(error?.message, name).toMatch(/not valid JSON/);
      expect(error).toMatchObject({ name: "DecisionError", code: "invalid" });
    }
  });

  it("DHK7.6 a policy, authority or calibration book that does not meet its schema is named with what is wrong", async () => {
    const cases: [string, unknown, RegExp][] = [
      ["policy.json", { version: "x", default: { act: 2 }, forks: {} }, /act/],
      ["authority.json", { version: "x", default: "maybe", rules: [] }, /default/],
      ["calibration.json", { entries: [book().entries[0], book().entries[0]] }, /more than one entry/],
    ];
    for (const [name, json, what] of cases) {
      const dir = await tempDir();
      write(dir, name, json);
      const error = await decisionFiles(dir).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error?.message, name).toContain(join(dir, name));
      expect(error?.message, name).toMatch(what);
      expect(error).toMatchObject({ name: "DecisionError", code: "invalid" });
    }
  });

  it("DHK7.7 a file that cannot be read is named", async () => {
    const dir = await tempDir();
    mkdirSync(join(dir, "policy.json"));
    await expect(decisionFiles(dir)).rejects.toMatchObject({ name: "DecisionError", code: "unavailable", message: expect.stringContaining(join(dir, "policy.json")) });
  });
});

describe("decisionFiles: saving the calibration", () => {
  it("DHK7.8 a saved book is written whole, is what the next open reads, and is what calibration then says", async () => {
    const dir = await tempDir();
    const files = await decisionFiles(dir);
    await files.saveCalibration(book("saved"));
    expect(files.calibration.entries.map((e) => e.member)).toEqual(["saved"]);
    expect(JSON.parse(readFileSync(join(dir, "calibration.json"), "utf8"))).toEqual(book("saved"));
    expect(readFileSync(join(dir, "calibration.json"), "utf8").endsWith("\n")).toBe(true);
    expect((await decisionFiles(dir)).calibration).toEqual(book("saved"));
    expect(readdirSync(dir).filter((f) => f !== "calibration.json")).toEqual([]);
  });

  it("DHK7.9 a book that is not a calibration book is refused and nothing is written", async () => {
    const dir = await tempDir();
    const files = await decisionFiles(dir);
    expect(() => files.saveCalibration({ entries: [book().entries[0]!, book().entries[0]!] })).toThrow(/more than one entry/);
    expect(existsSync(join(dir, "calibration.json"))).toBe(false);
    expect(files.calibration.entries).toEqual([]);
  });

  it("DHK7.10 saves made together land in the order they were made", async () => {
    const dir = await tempDir();
    const files = await decisionFiles(dir);
    await Promise.all(["a", "b", "c"].map((m) => files.saveCalibration(book(m))));
    expect(files.calibration.entries[0]!.member).toBe("c");
    expect((await decisionFiles(dir)).calibration.entries[0]!.member).toBe("c");
  });

  it("DHK7.11 a save that fails rejects and leaves the book as it was, and later saves go through", async () => {
    const dir = await tempDir();
    const files = await decisionFiles(dir);
    await files.saveCalibration(book("first"));
    rmSync(dir, { recursive: true });
    await expect(files.saveCalibration(book("lost"))).rejects.toBeDefined();
    expect(files.calibration.entries[0]!.member).toBe("first");
    mkdirSync(dir);
    await files.saveCalibration(book("again"));
    expect(files.calibration.entries[0]!.member).toBe("again");
  });
});

describe("decisionFiles: who can read it", () => {
  it("DHK11.4 the calibration book is the owner's alone, whatever the umask", async () => {
    const before = process.umask(0o022);
    try {
      const dir = await tempDir();
      const files = await decisionFiles(dir);
      await files.saveCalibration(book("saved"));
      expect(statSync(join(dir, "calibration.json")).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(before);
    }
  });
});
