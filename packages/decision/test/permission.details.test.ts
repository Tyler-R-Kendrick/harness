import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describePermission, parsePermissionAuthority, parsePermissionRiskSettings, permissionAuthorityFacts, permissionRiskFork } from "../src/permission.ts";
import type { PermissionFacts } from "../src/permission.ts";
import type { Answers, Json } from "../src/types.ts";
import { answer, lazy, levels, yes } from "./loops-fixtures.ts";

const read = (name: string) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
const questionsFile = read("permission-questions.json");
const authority = lazy(() => parsePermissionAuthority(read("permission.json")));

const facts = (patch: Partial<PermissionFacts> = {}): PermissionFacts => ({ tool: "bash", ...patch });
const outside = (path: string, cwd: string) => (permissionAuthorityFacts(facts({ path, cwd })) as { outsideCwd: boolean }).outsideCwd;
const scrub = (patch: Partial<PermissionFacts>, field: "command" | "url") => (describePermission(facts(patch)) as Record<string, string>)[field]!;

describe("the fork with no settings", () => {
  const bare = lazy(() => permissionRiskFork());
  const answers = (risk: readonly number[], yes3 = 0): Answers => ({ irreversible: yes(yes3), costs: yes(yes3), visible: yes(yes3), risk: levels(risk) });

  it("PRM6.1 asks the bare questions, with no criteria, and is named for them and for having no authority", () => {
    expect(bare.version).toBe("minimal+none");
    expect(bare.ask(facts({ command: "ls" }))).toStrictEqual({
      state: { tool: "bash", command: "ls" },
      questions: {
        irreversible: { type: "boolean", instructions: "Would carrying out this request be hard to undo?" },
        costs: { type: "boolean", instructions: "Would carrying out this request spend money or other limited resources?" },
        visible: { type: "boolean", instructions: "Would carrying out this request be visible or have effects outside this machine?" },
        risk: { type: "score", instructions: "How risky is it to let this request run without a person checking it first?", criteria: ["none", "low", "high", "severe"] },
      },
    });
  });

  it("PRM6.2 with no authority every request is at least careful, and nothing is decided by rule", () => {
    for (const patch of [{}, { kind: "read" }, { command: "ls" }, { kind: "edit", path: "/etc/passwd", cwd: "/work" }]) {
      expect(bare.floor?.(facts(patch))).toBe("careful");
      expect(bare.fallback(facts(patch))).toBe("careful");
      expect(bare.rule?.(facts(patch))).toBeUndefined();
    }
  });

  it("PRM6.3 a risk score is careful from an expected level of 1.5 and critical from 2.5", () => {
    const at = (risk: readonly number[]) => bare.interpret(answers(risk), facts())?.action;
    expect(at([0, 0.6, 0.4, 0])).toBe("routine"); // 1.4
    expect(at([0, 0.5, 0.5, 0])).toBe("careful"); // 1.5
    expect(at([0, 0, 0.6, 0.4])).toBe("careful"); // 2.4
    expect(at([0, 0, 0.5, 0.5])).toBe("critical"); // 2.5
  });

  it("PRM6.4 a yes answer counts from a probability of one half", () => {
    const at = (p: number) => bare.interpret({ ...answers([1, 0, 0, 0]), irreversible: yes(p) }, facts())?.action;
    expect(at(0.49)).toBe("routine");
    expect(at(0.5)).toBe("careful");
  });
});

describe("answers the fork cannot use", () => {
  const fork = lazy(() => permissionRiskFork(authority, parsePermissionRiskSettings(questionsFile)));
  const base = (): Answers => ({ irreversible: yes(0.9), costs: yes(0.9), visible: yes(0.9), risk: levels([1, 1, 1, 1]) });

  it("PRM6.5 a risk score with more levels than four, fewer, or other names, is no answer", () => {
    expect(fork.interpret({ ...base(), risk: levels([1, 1, 1, 1, 1]) }, facts())).toBeUndefined();
    expect(fork.interpret({ ...base(), risk: levels([1, 1, 1]) }, facts())).toBeUndefined();
    expect(fork.interpret({ ...base(), risk: answer("score", { a: 1, b: 1, c: 1, d: 1 }) }, facts())).toBeUndefined();
    expect(fork.interpret({ ...base(), risk: answer("score", { "0": 1, "1": 1, "2": 1, "9": 1 }) }, facts())).toBeUndefined();
    expect(fork.interpret(base(), facts())).toBeDefined();
  });

  it("PRM6.6 a question answered with the wrong kind of answer, or not answered, is no answer", () => {
    expect(fork.interpret({ ...base(), costs: levels([1, 1]) }, facts())).toBeUndefined();
    expect(fork.interpret({ ...base(), risk: yes(0.5) }, facts())).toBeUndefined();
    const { visible: _visible, ...without } = base();
    expect(fork.interpret(without, facts())).toBeUndefined();
  });

  it("PRM6.7 when nothing could answer, a request the authority forbids is critical and any other is careful, never routine", () => {
    expect(fork.fallback(facts({ kind: "execute", command: "rm -rf /" }))).toBe("critical");
    expect(fork.fallback(facts({ kind: "read", path: "a.txt" }))).toBe("careful");
    expect(fork.fallback(facts({ kind: "execute", command: "ls" }))).toBe("careful");
  });
});

describe("paths", () => {
  it("PRM6.8 a rooted working directory gives a definite answer, and a relative path is resolved against it", () => {
    expect(outside("a.ts", "/proj")).toBe(false);
    expect(outside("../other", "/proj")).toBe(true);
    expect(outside("sub/../a.ts", "/proj")).toBe(false);
    expect(outside("/proj/sub/../a.ts", "/proj")).toBe(false);
    expect(outside("../../etc/passwd", "/proj")).toBe(true);
  });

  it("PRM6.9 a . in the middle of a path is nothing", () => {
    expect(outside("/work/./app/x", "/work/app")).toBe(false);
    expect(outside("/work/app/./x/./y", "/work/./app")).toBe(false);
    expect(outside("/work/./other", "/work/app")).toBe(true);
  });

  it("PRM6.10 only a segment that is a drive letter and a colon stops .. from going further up", () => {
    expect(outside("C:x\\..\\..\\w\\a", "/w")).toBe(false);
    expect(outside("/aC:/../w/a", "/w")).toBe(false);
    expect(outside("/C:/../w/a", "/w")).toBe(true);
    expect(outside("C:\\..\\..\\proj\\a", "C:\\proj")).toBe(false);
  });
});

describe("what is shown", () => {
  it("PRM6.11 an authorization header is removed with or without spaces, with any scheme or none", () => {
    expect(scrub({ command: "curl -H Authorization:Bearer abc" }, "command")).toBe("curl -H Authorization:[redacted]");
    expect(scrub({ command: "curl authorization = tok" }, "command")).toBe("curl authorization = [redacted]");
    expect(scrub({ command: "curl Authorization : Basic  zzz" }, "command")).toBe("curl Authorization : [redacted]");
    expect(scrub({ command: "curl Authorization: abc" }, "command")).toBe("curl Authorization: [redacted]");
    expect(scrub({ command: "curl Authorization: Bearer   tok -v" }, "command")).toBe("curl Authorization: [redacted] -v");
    expect(scrub({ command: "curl Authorization: Token tok" }, "command")).toBe("curl Authorization: [redacted]");
    expect(scrub({ command: "curl Authorization: Digest tok" }, "command")).toBe("curl Authorization: [redacted]");
  });

  it("PRM6.12 a bearer token is removed whatever the spacing", () => {
    expect(scrub({ command: "echo Bearer   abc123" }, "command")).toBe("echo Bearer   [redacted]");
    expect(scrub({ command: "echo bearer abc" }, "command")).toBe("echo bearer [redacted]");
    expect(scrub({ command: "echo BEARER a.b-c~d+e/f=" }, "command")).toBe("echo BEARER [redacted]");
  });

  it("PRM6.13 every secret flag in a command goes, in any case", () => {
    expect(scrub({ command: "tool --token a --password b --name c" }, "command")).toBe("tool --token [redacted] --password [redacted] --name c");
    expect(scrub({ command: "tool --API-KEY abc" }, "command")).toBe("tool --API-KEY [redacted]");
    expect(scrub({ command: "tool --token --verbose" }, "command")).toBe("tool --token --verbose");
  });

  it("PRM6.14 every secret parameter in a url goes, in any case", () => {
    expect(scrub({ url: "https://x.example/a?token=a&secret=b&page=1" }, "url")).toBe("https://x.example/a?token=[redacted]&secret=[redacted]&page=1");
    expect(scrub({ url: "https://x.example/a?Api_Key=a" }, "url")).toBe("https://x.example/a?Api_Key=[redacted]");
    expect(scrub({ url: "https://x.example/a?token=a;b&secret=c|d#frag" }, "url")).toBe("https://x.example/a?token=[redacted]&secret=[redacted]#frag");
    expect(scrub({ url: "https://x.example/a?TOKEN=a;b" }, "url")).toBe("https://x.example/a?TOKEN=[redacted]");
  });

  it("PRM6.15 what the tool was given is followed sixteen levels down, and what is below is cut, in objects and in arrays", () => {
    const nest = (wrap: (inner: unknown) => unknown, levelsDeep: number) => {
      let value: unknown = "bottom";
      for (let i = 0; i < levelsDeep; i++) value = wrap(value);
      return value;
    };
    const walk = (value: unknown, step: (v: unknown) => unknown): unknown[] => {
      const seen: unknown[] = [];
      let current = value;
      while (typeof current === "object" && current !== null) {
        seen.push(current);
        current = step(current);
      }
      seen.push(current);
      return seen;
    };
    const objects = describePermission(facts({ input: nest((inner) => ({ k: inner }), 20) as NonNullable<PermissionFacts["input"]> })) as { input: unknown };
    const objectChain = walk(objects.input, (v) => (v as { k: unknown }).k);
    expect(objectChain.at(-1)).toBe("[truncated]");
    expect(objectChain).toHaveLength(17); // sixteen objects (the input is the first) and the cut
    const arrays = describePermission(facts({ input: { list: nest((inner) => [inner], 20) as Json } })) as { input: { list: unknown } };
    const arrayChain = walk(arrays.input.list, (v) => (v as unknown[])[0]);
    expect(arrayChain.at(-1)).toBe("[truncated]");
    expect(arrayChain).toHaveLength(16); // fifteen arrays (the input uses the first level) and the cut
  });
});

describe("settings", () => {
  const edit = (path: readonly string[], value: unknown) => {
    const s = JSON.parse(JSON.stringify(questionsFile)) as Record<string, unknown>;
    let o: Record<string, unknown> = s;
    for (const key of path.slice(0, -1)) o = o[key] as Record<string, unknown>;
    o[path.at(-1)!] = value;
    return () => parsePermissionRiskSettings(s);
  };

  it("PRM6.16 the thresholds are levels from 0 to 3, careful no later than critical", () => {
    const both = (careful: number, critical: number) => {
      const s = JSON.parse(JSON.stringify(questionsFile)) as { combine: { carefulAt: number; criticalAt: number } };
      s.combine.carefulAt = careful;
      s.combine.criticalAt = critical;
      return () => parsePermissionRiskSettings(s);
    };
    expect(both(3, 3)).not.toThrow();
    expect(both(0, 0)).not.toThrow();
    expect(edit(["combine", "carefulAt"], -0.1)).toThrow(/combine\.carefulAt/);
    expect(edit(["combine", "carefulAt"], 3.1)).toThrow(/combine\.carefulAt/);
    expect(edit(["combine", "criticalAt"], 3.1)).toThrow(/combine\.criticalAt/);
    expect(edit(["combine", "criticalAt"], 3)).not.toThrow();
    expect(edit(["combine", "yesAt"], -0.1)).toThrow(/combine\.yesAt/);
  });

  it("PRM6.17 critical may be reached at the same level as careful, not before", () => {
    const equal = JSON.parse(JSON.stringify(questionsFile)) as { combine: { carefulAt: number; criticalAt: number } };
    equal.combine.carefulAt = 2;
    equal.combine.criticalAt = 2;
    expect(() => parsePermissionRiskSettings(equal)).not.toThrow();
    equal.combine.criticalAt = 1.9;
    expect(() => parsePermissionRiskSettings(equal)).toThrow(/combine\.criticalAt[\s\S]*critical must not be reached before careful|critical must not be reached before careful[\s\S]*combine\.criticalAt/);
  });

  it("PRM6.18 a text that is empty is refused wherever the settings have one", () => {
    expect(edit(["questions", "costs", "instructions"], "")).toThrow(/questions\.costs\.instructions/);
    expect(edit(["questions", "visible", "instructions"], "")).toThrow(/questions\.visible\.instructions/);
    expect(edit(["questions", "risk", "instructions"], "")).toThrow(/questions\.risk\.instructions/);
    expect(edit(["questions", "risk", "levels"], ["a", "", "c", "d"])).toThrow(/questions\.risk\.levels/);
    expect(edit(["questions", "irreversible", "criteria", "true"], "")).toThrow(/criteria\.true/);
    expect(edit(["questions", "irreversible", "criteria", "false"], "")).toThrow(/criteria\.false/);
    expect(edit(["questions", "irreversible", "extra"], 1)).toThrow(/extra/);
    expect(edit(["questions", "risk", "extra"], 1)).toThrow(/extra/);
    expect(edit(["combine", "extra"], 1)).toThrow(/extra/);
    expect(edit(["questions", "extra"], 1)).toThrow(/extra/);
  });

  it("PRM6.19 an authority and settings that are not valid say which they are", () => {
    expect(() => parsePermissionAuthority({})).toThrow(/^invalid permission authority\n/);
    expect(() => parsePermissionRiskSettings({})).toThrow(/^invalid permission risk settings\n/);
  });
});

describe("a working directory that is not rooted", () => {
  const forbid = (patch: Partial<PermissionFacts>) => permissionRiskFork(authority).floor?.(facts({ kind: "edit", ...patch }));

  it("PRM7.1 is unknown, so every path is outside it: an empty, ., ./ or relative working directory makes no path inside", () => {
    for (const cwd of ["", ".", "./", "proj", "../proj", "proj/sub"]) {
      expect(outside("/etc/passwd", cwd), cwd).toBe(true);
      expect(outside("../../etc/passwd", cwd), cwd).toBe(true);
      expect(outside("a.ts", cwd), cwd).toBe(true);
    }
  });

  it("PRM7.2 only a rooted working directory gives a definite answer: / holds everything, ~ and a drive are rooted", () => {
    expect(outside("/etc/passwd", "/")).toBe(false);
    expect(outside("a.ts", "/")).toBe(false);
    expect(outside("~/proj/x", "~/proj")).toBe(false);
    expect(outside("~/other", "~/proj")).toBe(true);
    expect(outside("/etc/x", "~/proj")).toBe(true);
    expect(outside("C:\\proj\\a", "C:\\proj")).toBe(false);
    expect(outside("\\work\\app\\a", "\\work\\app")).toBe(false); // a backslash is a separator, so this is rooted
    expect(outside("\\elsewhere", "\\work\\app")).toBe(true);
  });

  it("PRM7.3 the shipped authority forbids a write to /etc/passwd whatever the session's working directory is", () => {
    for (const cwd of ["", ".", "./", "/work"]) expect(forbid({ path: "/etc/passwd", cwd }), cwd).toBe("critical");
    expect(forbid({ path: "/work/a.ts", cwd: "/work" })).toBe("careful");
  });

  it("PRM7.4 without a working directory nothing is said of what is outside it", () => {
    expect(permissionAuthorityFacts(facts({ path: "/etc/passwd" }))).not.toHaveProperty("outsideCwd");
  });
});

describe("what is shown of every field", () => {
  const described = (patch: Partial<PermissionFacts>, chars?: number) => describePermission(facts(patch), chars) as Record<string, Json>;
  const title = "curl -H 'Authorization: Bearer sk-live-12345' https://api.x --password hunter2";

  it("PRM7.5 the tool, the kind, the working directory and the session lose their secrets like the command does", () => {
    const out = described({ tool: title, kind: "execute token=k1", cwd: "/w/password=c1", session: "s key=s1", command: title });
    const text = JSON.stringify(out);
    for (const secret of ["sk-live-12345", "hunter2", "k1", "c1", "s1"]) expect(text, secret).not.toContain(secret);
    expect(out["tool"]).toBe("curl -H 'Authorization: [redacted]' https://api.x --password [redacted]");
    expect(out["kind"]).toBe("execute token=[redacted]");
    expect(out["cwd"]).toBe("/w/password=[redacted]");
    expect(out["session"]).toBe("s key=[redacted]");
  });

  it("PRM7.6 the tool, the kind, the working directory and the session are cut to the length given", () => {
    const out = described({ tool: "t".repeat(50), kind: "k".repeat(50), cwd: "/".repeat(50), session: "s".repeat(50) }, 10);
    expect(out).toStrictEqual({ tool: "t".repeat(10), kind: "k".repeat(10), cwd: "/".repeat(10), session: "s".repeat(10) });
  });

  it("PRM7.7 a JSON body in a command or in an input string is scrubbed, escaped or not", () => {
    const out = described({ command: `curl -d '{"password":"hunter2","api_key": "abc123"}' https://x`, input: { body: `echo "{\\"token\\":\\"sk-123\\"}"` } });
    const text = JSON.stringify(out);
    for (const secret of ["hunter2", "abc123", "sk-123"]) expect(text, secret).not.toContain(secret);
  });

  it("PRM7.8 a quoted value after a secret flag is scrubbed, and so are -u user:password and header lists", () => {
    const out = described({
      command: `tool --token "s3cret-value" --password 's3cret value' && curl -u bob:pw123 x`,
      input: { headers: [{ name: "Authorization", value: "sk-live-999" }], cookie: "sid=abc", args: ["-u", "bob:pw456"], opts: "Cookie: sessionid=ZZZ; X-Auth: tok777" },
    });
    const text = JSON.stringify(out);
    for (const secret of ["s3cret", "pw123", "sk-live-999", "sid=abc", "pw456", "ZZZ", "tok777"]) expect(text, secret).not.toContain(secret);
  });

  it("PRM7.9 a hostile tool input is scrubbed in well under a second, and what it costs is bounded as a whole", () => {
    const input = { command: "key-".repeat(1024), files: Array.from({ length: 2000 }, () => "key.".repeat(125)) };
    const start = performance.now();
    const out = described({ command: "a-key".repeat(819), tool: "key.".repeat(1000), input }, 500);
    expect(performance.now() - start).toBeLessThan(500);
    expect(JSON.stringify(out).length).toBeLessThan(500 * 70);
  });
});
