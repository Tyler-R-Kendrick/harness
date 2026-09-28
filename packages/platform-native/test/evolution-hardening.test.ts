import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandEvaluator, parseEvolutionConfig, textCheck } from "../src/evolution-config.ts";
import { evolutionCommand } from "../src/evolution-command.ts";
import { SeededEntropy } from "@harness/testkit";
import { fileText, gone, groupMembers, onLinux, sleep, stopped } from "./evolution-process.ts";
import { scenario } from "./evolution-world.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "evo-h-"));
  dirs.push(d);
  return d;
};
const tasks = [{ id: "t1", text: "x" }];

/** The evaluate port on a command with the given evaluator settings. */
const evaluator = (command: string[], options: Record<string, unknown> = {}) => {
  const dir = tmp();
  const config = parseEvolutionConfig({ documents: { a: { path: "a.json" } }, components: ["prompt", "config"], tasks: { evolve: tasks }, evaluator: { command, ...options } });
  return commandEvaluator({ config, dir });
};
const node = (script: string, options: Record<string, unknown> = {}) => evaluator([process.execPath, "-e", script], options);

/** Starts a command that records its pid, waits until it is running, and shows its process group is the one it leads (so the group checks after it are not vacuous). */
async function leading(pidfile: string, start: () => Promise<unknown>) {
  const settled = outcome(start());
  const pid = Number(await fileText(pidfile));
  await sleep(150);
  expect(groupMembers(pid).length).toBeGreaterThan(0);
  return { pid, result: await settled };
}

const outcome = async (promise: Promise<unknown>) => {
  const started = Date.now();
  const result = await Promise.race([promise.then((v) => ({ resolved: v }), (e: Error) => ({ rejected: e.message })), new Promise<{ pending: true }>((r) => setTimeout(() => r({ pending: true }), 6000))]);
  return { ...result, ms: Date.now() - started };
};

describe.skipIf(!onLinux)("the evaluator's process group is stopped with it (EH13.1 to EH13.6)", () => {
  it("EH13.1 a child that ignores SIGTERM is killed at the time limit: the evaluation fails with the timeout error, promptly, and nothing of it survives", async () => {
    const pidfile = join(tmp(), "pid");
    const { pid, result: r } = await leading(pidfile, () => node(`require("fs").writeFileSync(${JSON.stringify(pidfile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`, { timeoutMs: 700 })({}, tasks, 1));
    expect(r).toMatchObject({ rejected: "the evaluator took longer than 700 ms and was stopped" });
    expect(r.ms).toBeLessThan(3000);
    expect(await gone(pid)).toEqual([]);
  });

  it("EH13.2 a shell pipeline whose grandchildren hold the pipe is stopped at the time limit too: the promise settles with the timeout error and no process of the group survives", async () => {
    const pidfile = join(tmp(), "pid");
    const { pid, result: r } = await leading(pidfile, () => evaluator(["sh", "-c", `echo $$ > ${pidfile}; sleep 30 | cat; echo '[]'`], { timeoutMs: 700 })({}, tasks, 1));
    expect(r).toMatchObject({ rejected: "the evaluator took longer than 700 ms and was stopped" });
    expect(r.ms).toBeLessThan(3000);
    expect(await gone(pid)).toEqual([]);
  });

  it("EH13.3 a finished evaluator leaves nothing behind: a background process it started is killed with its group", async () => {
    const dir = tmp();
    const pidfile = join(dir, "pid");
    const bg = join(dir, "bg");
    const r = await outcome(evaluator(["sh", "-c", `echo $$ > ${pidfile}; sleep 30 >/dev/null 2>&1 & echo $! > ${bg}; sleep 0.3; echo '[]'`])({}, tasks, 1));
    expect(r).toMatchObject({ resolved: [] });
    const pid = Number(await fileText(pidfile));
    const background = Number(await fileText(bg));
    expect(background).toBeGreaterThan(pid);
    expect(await stopped(background)).toBe(true);
    expect(await gone(pid)).toEqual([]);
  });
});

describe("the evaluator's environment (EH13.7 to EH13.9)", () => {
  const seen = (name: string) => `process.stdout.write(JSON.stringify([{ task: process.env[${JSON.stringify(name)}] ?? "unset", trials: [] }]))`;

  it("EH13.7 by default a child sees only PATH, HOME, LANG, LC_ALL, TMPDIR and TERM of the parent's environment: a secret is not visible", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "hunter2");
    vi.stubEnv("LANG", "C.UTF-8");
    const all = await node(`process.stdout.write(JSON.stringify([{ task: JSON.stringify(Object.keys(process.env).filter((k) => !k.startsWith("__") && k !== "PWD" && k !== "SHLVL" && k !== "_" && k !== "OLDPWD").sort()), trials: [] }]))`)({}, tasks, 1);
    const keys = JSON.parse(all[0]!.task) as string[];
    expect(keys).not.toContain("AI_GATEWAY_API_KEY");
    expect(keys.every((k) => ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM"].includes(k))).toBe(true);
    expect(keys).toContain("PATH");
    expect(keys).toContain("LANG");
    expect((await node(seen("AI_GATEWAY_API_KEY"))({}, tasks, 1))[0]!.task).toBe("unset");
  });

  it("EH13.8 a variable named in env.allow is copied from the parent, env.set gives literal values (and wins), and a named variable the parent lacks stays unset", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "hunter2");
    vi.stubEnv("OTHER_SECRET", "s3");
    const options = { env: { allow: ["AI_GATEWAY_API_KEY", "ABSENT_ONE"], set: { LITERAL: "fixed", OTHER_SECRET: "set-wins" } } };
    expect((await node(seen("AI_GATEWAY_API_KEY"), options)({}, tasks, 1))[0]!.task).toBe("hunter2");
    expect((await node(seen("LITERAL"), options)({}, tasks, 1))[0]!.task).toBe("fixed");
    expect((await node(seen("OTHER_SECRET"), options)({}, tasks, 1))[0]!.task).toBe("set-wins");
    expect((await node(seen("ABSENT_ONE"), options)({}, tasks, 1))[0]!.task).toBe("unset");
    expect((await node(seen("OTHER_SECRET"), { env: { allow: ["AI_GATEWAY_API_KEY"] } })({}, tasks, 1))[0]!.task).toBe("unset");
    // The default variables stay when allow adds to them.
    expect((await node(`process.stdout.write(JSON.stringify([{ task: process.env.PATH ? "path" : "no path", trials: [] }]))`, options)({}, tasks, 1))[0]!.task).toBe("path");
  });

  it("EH13.9 a check command gets the same environment rules: a secret is invisible by default and visible only when its check names it", () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "hunter2");
    const script = `console.error("key=" + (process.env.AI_GATEWAY_API_KEY ?? "unset")); process.exit(1)`;
    const dir = tmp();
    expect(textCheck({ command: [process.execPath, "-e", script], timeoutMs: 10_000 }, dir)("x")).toBe("key=unset");
    expect(textCheck({ command: [process.execPath, "-e", script], timeoutMs: 10_000, env: { allow: ["AI_GATEWAY_API_KEY"] } }, dir)("x")).toBe("key=hunter2");
    expect(textCheck({ command: [process.execPath, "-e", script], timeoutMs: 10_000, env: { set: { AI_GATEWAY_API_KEY: "given" } } }, dir)("x")).toBe("key=given");
  });

  it("EH13.10 env is validated: names are identifiers, values strings, unknown keys refused; it applies to the evaluator and a text document's check, and is optional", () => {
    const base = { documents: { a: { kind: "text", path: "a.txt", check: { command: ["x"] } } }, components: ["prompt"], tasks: { evolve: tasks }, evaluator: { command: ["x"] } };
    const parse = (evaluatorEnv: unknown, checkEnv: unknown = undefined) =>
      parseEvolutionConfig({ ...base, documents: { a: { ...base.documents.a, check: { command: ["x"], ...(checkEnv === undefined ? {} : { env: checkEnv }) } } }, evaluator: { command: ["x"], ...(evaluatorEnv === undefined ? {} : { env: evaluatorEnv }) } });
    expect(parse({ allow: ["A_B", "_c1"], set: { X: "" } }, { allow: ["K"] }).evaluator.env).toEqual({ allow: ["A_B", "_c1"], set: { X: "" } });
    expect(parse(undefined).evaluator.env).toBeUndefined();
    expect(() => parse({ allow: ["1BAD"] })).toThrow(/allow/);
    expect(() => parse({ allow: ["A=B"] })).toThrow(/allow/);
    expect(() => parse({ set: { "A B": "x" } })).toThrow(/set/);
    expect(() => parse({ set: { A: 1 } })).toThrow(/set/);
    expect(() => parse({ extra: true })).toThrow(/extra/);
    expect(() => parse(undefined, { allow: [""] })).toThrow(/allow/);
  });
});

describe.skipIf(!onLinux)("the evaluator's output is bounded (EH13.11 to EH13.13)", () => {
  it("EH13.11 an evaluator that writes more than maxOutputBytes to stdout is killed with its group and fails with a clear error", async () => {
    const pidfile = join(tmp(), "pid");
    const { pid, result: r } = await leading(pidfile, () => node(`require("fs").writeFileSync(${JSON.stringify(pidfile)}, String(process.pid)); setInterval(() => process.stdout.write("x".repeat(20000)), 20)`, { maxOutputBytes: 500_000, timeoutMs: 20_000 })({}, tasks, 1));
    expect(r).toMatchObject({ rejected: "the evaluator wrote more than 500000 bytes on stdout and was stopped" });
    expect(r.ms).toBeLessThan(5000);
    expect(await gone(pid)).toEqual([]);
  });

  it("EH13.12 output exactly at the limit is accepted; one byte more is not", async () => {
    // "[]" is two bytes.
    expect(await node(`process.stdout.write("[]")`, { maxOutputBytes: 2 })({}, tasks, 1)).toEqual([]);
    await expect(node(`process.stdout.write("[] ")`, { maxOutputBytes: 2 })({}, tasks, 1)).rejects.toThrow("the evaluator wrote more than 2 bytes on stdout and was stopped");
  });

  it("EH13.13 maxOutputBytes is a positive whole number of at most 256 MiB, 64 MiB by default", () => {
    const parse = (maxOutputBytes: unknown) => parseEvolutionConfig({ documents: { a: { path: "a.json" } }, components: ["prompt"], tasks: { evolve: tasks }, evaluator: { command: ["x"], maxOutputBytes } });
    expect(parse(268_435_456).evaluator.maxOutputBytes).toBe(268_435_456);
    expect(() => parse(268_435_457)).toThrow(/maxOutputBytes/);
    expect(() => parse(0)).toThrow(/maxOutputBytes/);
    expect(() => parse(1.5)).toThrow(/maxOutputBytes/);
    expect(parseEvolutionConfig({ documents: { a: { path: "a.json" } }, components: ["prompt"], tasks: { evolve: tasks }, evaluator: { command: ["x"] } }).evaluator.maxOutputBytes).toBeUndefined();
  });
});

describe.skipIf(!onLinux)("a text document's check stops with its group (EH13.14 to EH13.16)", () => {
  /** A check command that records the pid of a background sleeper it starts, then runs `rest`. */
  const sleeper = (bg: string, rest: string) => ["sh", "-c", `sleep 30 >/dev/null 2>&1 & echo $! > ${bg}; ${rest}`];
  const survivors = async (bg: string) => (await stopped(Number(await fileText(bg)))) ? [] : ["the background process is alive"];

  it("EH13.14 a check that outlives its time limit is killed with SIGKILL (it ignores SIGTERM), and so are the processes it started", async () => {
    const bg = join(tmp(), "bg");
    const check = textCheck({ command: sleeper(bg, "trap '' TERM; sleep 30"), timeoutMs: 700 }, tmp());
    const started = Date.now();
    expect(check("x")).toBe("the check took longer than 700 ms and was stopped");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await survivors(bg)).toEqual([]);
  });

  it("EH13.15 a check that exits leaving a background process behind does not leave it running", async () => {
    const bg = join(tmp(), "bg");
    const check = textCheck({ command: sleeper(bg, "sleep 0.2; exit 0"), timeoutMs: 10_000 }, tmp());
    expect(check("x")).toBeUndefined();
    expect(await survivors(bg)).toEqual([]);
  });

  it("EH13.16 a check that floods its output is stopped at the bound, and its group with it", async () => {
    const bg = join(tmp(), "bg");
    const check = textCheck({ command: sleeper(bg, "yes"), timeoutMs: 10_000 }, tmp());
    expect(check("x")).toBe("the check wrote more than 65536 bytes and was stopped");
    expect(await survivors(bg)).toEqual([]);
  });

  it("EH13.17 a check that fails is judged by its stderr and its group is cleaned up as well", async () => {
    const bg = join(tmp(), "bg");
    const check = textCheck({ command: sleeper(bg, "echo 'the problem' >&2; exit 4"), timeoutMs: 10_000 }, tmp());
    expect(check("x")).toBe("the problem");
    expect(await survivors(bg)).toEqual([]);
  });
});

describe("harness-evolution command line arguments (EH13.20 to EH13.24)", () => {
  async function misuse(args: readonly string[], message: string) {
    let out = "";
    let err = "";
    const code = await evolutionCommand(args, { stdout: (s) => void (out += s), stderr: (s) => void (err += s) }, { evaluate: async () => Promise.reject(new Error("must not run")), entropy: new SeededEntropy(1) });
    expect({ code, out }).toEqual({ code: 2, out: "" });
    expect(err.split("\n")[0]).toBe(message);
    expect(err).toContain("usage: harness-evolution <command>");
  }

  it("EH13.20 --force is for start and documents --write; it is refused elsewhere, not ignored", async () => {
    const s = scenario(tmp());
    await misuse(["status", "--config", s.config, "--force"], "--force is for start and documents --write");
    await misuse(["round", "--config", s.config, "--model", "m", "--force"], "--force is for start and documents --write");
    await misuse(["run", "--config", s.config, "--model", "m", "--force"], "--force is for start and documents --write");
    await misuse(["documents", "--config", s.config, "--force"], "--force is for start and documents --write");
  });

  it("EH13.21 --last is for status and --max-rounds for run; they are refused on the other commands", async () => {
    const s = scenario(tmp());
    await misuse(["start", "--config", s.config, "--last", "3"], "--last is for status");
    await misuse(["run", "--config", s.config, "--model", "m", "--last", "3"], "--last is for status");
    await misuse(["documents", "--config", s.config, "--last", "3"], "--last is for status");
    await misuse(["round", "--config", s.config, "--model", "m", "--max-rounds", "2"], "--max-rounds is for run");
    await misuse(["status", "--config", s.config, "--max-rounds", "2"], "--max-rounds is for run");
    await misuse(["start", "--config", s.config, "--max-rounds", "2"], "--max-rounds is for run");
  });

  it("EH13.22 an option given an empty value is a usage error naming it, for every option that takes a value", async () => {
    const s = scenario(tmp());
    await misuse(["round", "--config", s.config, "--model", ""], "--model needs a value, not an empty string");
    await misuse(["start", "--config", ""], "--config needs a value, not an empty string");
    await misuse(["start", "--config", s.config, "--state", ""], "--state needs a value, not an empty string");
    await misuse(["start", "--config", s.config, "--settings", ""], "--settings needs a value, not an empty string");
    await misuse(["round", "--config", s.config, "--model", "m", "--critic-model", ""], "--critic-model needs a value, not an empty string");
    await misuse(["round", "--config", s.config, "--model", "m", "--critic", ""], "--critic needs a value, not an empty string");
    await misuse(["round", "--config", s.config, "--model", "m", "--critic", "ensemble", "--model-cache", ""], "--model-cache needs a value, not an empty string");
    await misuse(["round", "--config", s.config, "--model", "m", "--critic", "ensemble", "--llama-server", ""], "--llama-server needs a value, not an empty string");
    await misuse(["status", "--config", s.config, "--last", ""], "--last needs a value, not an empty string");
    await misuse(["run", "--config", s.config, "--model", "m", "--max-rounds", ""], "--max-rounds needs a value, not an empty string");
  });

  it("EH13.23 classify.rules[].document names an own document: an inherited property name such as toString is not a document", () => {
    const parse = (document: string) => parseEvolutionConfig({ documents: { a: { path: "a.json" } }, components: ["prompt"], tasks: { evolve: tasks }, evaluator: { command: ["x"] }, classify: { rules: [{ document, prefix: "", component: "prompt" }] } });
    expect(parse("a").classify.rules[0]!.document).toBe("a");
    for (const name of ["toString", "constructor", "hasOwnProperty", "__proto__"]) expect(() => parse(name), name).toThrow(`not a document: ${name}`);
  });
});

describe("a config file with an env is a config like any other (EH13.24)", () => {
  it("EH13.24 the evaluator env of a config file reaches the evaluator command the CLI runs", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "hunter2");
    const dir = tmp();
    const probe = join(dir, "probe.js");
    writeFileSync(probe, `require("fs").writeFileSync(${JSON.stringify(join(dir, "seen"))}, process.env.AI_GATEWAY_API_KEY ?? "unset"); process.exit(3)`);
    const s = scenario(dir, { evaluator: [process.execPath, probe] });
    let err = "";
    const code = await evolutionCommand(["start", "--config", s.config], { stdout: () => {}, stderr: (t) => void (err += t) }, { entropy: new SeededEntropy(1) });
    expect(code).toBe(1);
    expect(err).toContain("the evaluator exited with code 3");
    expect(await fileText(join(dir, "seen"))).toBe("unset");
  });
});
