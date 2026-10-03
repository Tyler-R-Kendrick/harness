import { describe, expect, it } from "vitest";
import { scrubJson, scrubText, secretName } from "../src/scrub.ts";
import type { Json } from "../src/types.ts";

const text = (value: string, chars = 4096) => scrubText(value, chars);

/** How long a call takes, in milliseconds. */
function timed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

/** The characters of every string (keys included) in a value. */
function weight(value: Json): number {
  if (typeof value === "string") return value.length;
  if (typeof value !== "object" || value === null) return 0;
  if (Array.isArray(value)) return (value as Json[]).reduce<number>((sum, item) => sum + weight(item), 0);
  return Object.entries(value).reduce((sum, [key, item]) => sum + key.length + weight(item), 0);
}

describe("secret names", () => {
  it("SCR1.1 a name is secret when it holds token, key, secret, password, credential, cookie or auth, in any case", () => {
    for (const name of ["token", "API_KEY", "x-Secret-y", "passwd", "Password", "credentials", "Set-Cookie", "X-Auth", "authorization", "Authorize"]) expect(secretName(name), name).toBe(true);
  });

  it("SCR1.2 a name is secret when a part of it is session, sessionid, sid, sig or signature, and not when those are only inside a word", () => {
    for (const name of ["session", "sessionId", "x-amz-signature", "sig", "a.sid", "user_session_x"]) expect(secretName(name), name).toBe(true);
    for (const name of ["design", "assign", "significant", "sessions", "inside", "resign"]) expect(secretName(name), name).toBe(false);
  });

  it("SCR1.3 an author is not an authorization", () => {
    for (const name of ["author", "authority", "authors", "name", "title", "path"]) expect(secretName(name), name).toBe(false);
  });
});

describe("what scrubText removes", () => {
  it("SCR1.4 secrets in a JSON body are removed, with the quotes of the name between it and the colon", () => {
    expect(text(`curl -d '{"password":"hunter2","api_key": "abc123"}' https://x`)).toBe(`curl -d '{"password":[redacted],"api_key": [redacted]}' https://x`);
    expect(text(`{"token" : 'a b', "n": 1}`)).toBe(`{"token" : [redacted], "n": 1}`);
    expect(text(`{'secret':'x'}`)).toBe(`{'secret':[redacted]}`);
  });

  it("SCR1.5 secrets in an escaped JSON string are removed too", () => {
    expect(text(String.raw`echo "{\"token\":\"sk-123\"}"`)).toBe(String.raw`echo "{\"token\":[redacted]}"`);
    expect(text(String.raw`{\"password\": \"a b\", \"n\": 1}`)).toBe(String.raw`{\"password\": [redacted], \"n\": 1}`);
  });

  it("SCR1.6 a quoted value with an escaped quote in it goes whole", () => {
    expect(text(String.raw`{"password":"ab\"cd","n":1}`)).toBe(`{"password":[redacted],"n":1}`);
  });

  it("SCR1.7 a quoted value that is never closed goes to the end of the text", () => {
    expect(text(`tool --token "abc def`)).toBe("tool --token [redacted]");
    expect(text(`password='abc def ghi`)).toBe("password=[redacted]");
  });

  it("SCR1.8 the value of a secret flag goes when it is quoted, in either quote", () => {
    expect(text(`tool --token "s3cret-value"`)).toBe("tool --token [redacted]");
    expect(text(`tool --password 's3cret value' --name x`)).toBe("tool --password [redacted] --name x");
  });

  it("SCR1.9 a user and password given with -u, -U, --user or --proxy-user lose the password, and keep the user", () => {
    expect(text("curl -u bob:pw123 https://x")).toBe("curl -u bob:[redacted] https://x");
    expect(text("curl -U bob:pw123 https://x")).toBe("curl -U bob:[redacted] https://x");
    expect(text("curl --user bob:pw123 https://x")).toBe("curl --user bob:[redacted] https://x");
    expect(text("curl --user=bob:pw123 https://x")).toBe("curl --user=bob:[redacted] https://x");
    expect(text("curl --proxy-user bob:pw123 https://x")).toBe("curl --proxy-user bob:[redacted] https://x");
    expect(text(`curl -u 'bob:pw 123' https://x`)).not.toContain("pw");
    expect(text("curl -u bob https://x")).toBe("curl -u bob https://x");
    expect(text("ssh -u")).toBe("ssh -u");
  });

  it("SCR1.10 a password given as -p glued to a quote goes, and a port given with -p does not", () => {
    expect(text(`mysql -u root -p'hunter2' db`)).toBe("mysql -u root -p[redacted] db");
    expect(text(`mysql -p"hunter2"`)).toBe("mysql -p[redacted]");
    expect(text("ssh -p 22 host")).toBe("ssh -p 22 host");
  });

  it("SCR1.11 a cookie header goes to the end of its line, and a header with an auth name loses its value", () => {
    expect(text("Cookie: sessionid=ZZZ; theme=dark")).toBe("Cookie: [redacted]");
    expect(text("Set-Cookie: a=1; b=2\nHost: x")).toBe("Set-Cookie: [redacted]\nHost: x");
    expect(text("X-Auth: tok777")).toBe("X-Auth: [redacted]");
    expect(text(`curl -H 'Cookie: a=1; b=2' https://x`)).toBe(`curl -H 'Cookie: [redacted]' https://x`);
    expect(text("curl --cookie 'sid=abc' https://x")).toBe("curl --cookie [redacted] https://x");
  });

  it("SCR1.12 a session id and a signature in an assignment go, and words that only contain sig or session do not", () => {
    expect(text("sessionid=abc sig=def X-Amz-Signature=ghi")).toBe("sessionid=[redacted] sig=[redacted] X-Amz-Signature=[redacted]");
    expect(text("design=abc assign=x significant: 3 author: bob")).toBe("design=abc assign=x significant: 3 author: bob");
  });

  it("SCR1.13 an authorization header, a bearer token and the secrets of a url go as they always did", () => {
    expect(text("curl Authorization: Bearer   tok -v")).toBe("curl Authorization: [redacted] -v");
    expect(text("echo bearer abc")).toBe("echo bearer [redacted]");
    expect(text("https://user:pw@host/p?token=a;b&page=1&Api_Key=z#f")).toBe("https://[redacted]@host/p?token=[redacted]&page=1&Api_Key=[redacted]#f");
    expect(text("a=1 token=abc&b=2")).toBe("a=1 token=[redacted]&b=2");
  });

  it("SCR1.14 an assignment with nothing after it, or only an operator, hides nothing", () => {
    expect(text("token=")).toBe("token=");
    expect(text("token=; echo")).toBe("token=; echo");
    expect(text("key: ")).toBe("key: ");
    expect(text("the key")).toBe("the key");
  });

  it("SCR1.15 the text is cut to the characters given before anything is searched", () => {
    expect(text("abcdef", 3)).toBe("abc");
    expect(text("token=abcdef", 8)).toBe("token=[redacted]");
  });
});

describe("the edges of what scrubText removes", () => {
  it("SCR2.1 a name is a run of letters, digits, _ . and -: the first and last of each kind belong to it", () => {
    for (const name of ["tokenz", "TOKENZ", "tokena", "TOKENA", "token9", "token0", "token_", "token.", "token-", "tokenA", "tokenZ"]) expect(text(`${name}=abc`), name).toBe(`${name}=[redacted]`);
    for (const name of ["token`", "token{", "token@", "token[", "token/", "token:x"]) expect(text(`${name}=abc`), name).not.toBe(`${name}=[redacted]`);
  });

  it("SCR2.2 the credentials of a url go for any scheme that has a letter in it, in either case, and for no other", () => {
    expect(text("a://user:pw@host")).toBe("a://[redacted]@host");
    expect(text("Z://user:pw@host")).toBe("Z://[redacted]@host");
    expect(text("A://user:pw@host")).toBe("A://[redacted]@host");
    expect(text("z://user:pw@host")).toBe("z://[redacted]@host");
    expect(text("git+ssh://user:pw@host")).toBe("git+ssh://[redacted]@host");
    expect(text("a+://user@host")).toBe("a+://[redacted]@host");
    expect(text("1.0://user@host")).toBe("1.0://user@host");
    expect(text("x ://user:pw@host")).toBe("x ://user:pw@host");
    expect(text("1://user@host")).toBe("1://user@host");
    expect(text("-://user@host")).toBe("-://user@host");
    expect(text("_://user@host")).toBe("_://user@host");
    expect(text("[://user@host")).toBe("[://user@host");
    expect(text("https://host/a@b")).toBe("https://host/a@b");
    expect(text("https://@host")).toBe("https://@host");
    expect(text("https://a:b@h1 and http://c:d@h2")).toBe("https://[redacted]@h1 and http://[redacted]@h2");
  });

  it("SCR2.3 a query parameter named like a secret goes only when it has a value; without one it is a word", () => {
    expect(text("/p?token&x=1")).toBe("/p?token&x=1");
    expect(text("/p?token=")).toBe("/p?token=");
    expect(text("/p?a=1&session=abc")).toBe("/p?a=1&session=[redacted]");
  });

  it("SCR2.4 a flag takes the next argument only when it is a flag for a secret and the argument is not another flag", () => {
    expect(text("my token abc")).toBe("my token abc");
    expect(text("(--token)")).toBe("(--token)");
    expect(text("tool --token -v")).toBe("tool --token -v");
    expect(text("tool --token\tabc")).toBe("tool --token\t[redacted]");
    expect(text("tool --token\nabc")).toBe("tool --token\n[redacted]");
  });

  it("SCR2.4b a quote that does not start the value ends it: an unquoted value runs up to a quote", () => {
    expect(text("key=a'b c")).toBe("key=[redacted]'b c");
    expect(text('key=a"b c')).toBe('key=[redacted]"b c');
    expect(text(String.raw`key=a\b c`)).toBe("key=[redacted] c");
  });

  it("SCR2.5 -u takes an argument after spaces of any number, and --username is not --user", () => {
    expect(text("curl -u   bob:pw")).toBe("curl -u   bob:[redacted]");
    expect(text("curl --username bob:pw")).toBe("curl --username bob:pw");
    expect(text("curl --user='bob:pw 1' x")).toBe("curl --user='bob:[redacted] x");
    expect(text(`curl --user="bob:pw" x`)).toBe('curl --user="bob:[redacted] x');
    expect(text("curl -uroot:pw")).toBe("curl -uroot:pw");
    expect(text("curl git-u bob:pw x--user a:b")).toBe("curl git-u bob:pw x--user a:b");
  });

  it("SCR2.6 an authorization header loses its scheme and its token, with any scheme, spacing or name around it", () => {
    expect(text("Authorization: Bearer")).toBe("Authorization: [redacted]");
    expect(text("authorization=Token abc rest")).toBe("authorization=[redacted] rest");
    expect(text("Proxy-Authorization: Basic zzz")).toBe("Proxy-Authorization: [redacted]");
    expect(text("Authorization: Negotiate YII")).toBe("Authorization: [redacted]");
    expect(text("Authorization: Bearer 'abc def'")).toBe("Authorization: [redacted]");
    expect(text("Authorization: Bearer;x")).toBe("Authorization: [redacted];x");
    expect(text("token: basic")).toBe("token: [redacted]");
    expect(text("token: basicx abc")).toBe("token: [redacted] abc");
    expect(text("token: xbasic abc")).toBe("token: [redacted] abc");
  });

  it("SCR2.7 a bearer token goes after any spaces; a bearer word with none after it, or in a longer word, hides nothing", () => {
    expect(text("echo Bearer abc.def-ghi_jkl~+/=")).toBe("echo Bearer [redacted]");
    expect(text("echo bearer")).toBe("echo bearer");
    expect(text("echo bearer;")).toBe("echo bearer;");
    expect(text("echo bearers abc")).toBe("echo bearers abc");
    expect(text("echo xbearer abc")).toBe("echo xbearer abc");
    expect(text("echo bearer \n")).toBe("echo bearer \n");
  });
});

describe("adversarial text takes linear time", () => {
  const big = 50_000;
  const shapes: readonly (readonly [string, string])[] = [
    ["key. repeated", "key.".repeat(big / 4)],
    ["a-key repeated", "a-key".repeat(big / 5)],
    ["key- repeated", "key-".repeat(big / 4)],
    ["a.key repeated", "a.key".repeat(big / 5)],
    ["a. repeated before ://", `${"a.".repeat(big / 2)}://`],
    ["unterminated quotes after names", 'key="'.repeat(big / 5)],
    ["escaped quotes after names", 'key=\\"'.repeat(big / 6)],
    ["flags with no value", "--token ".repeat(big / 8)],
    ["user flags with no colon", "-u x ".repeat(big / 5)],
    ["://@ repeated", "a://b@".repeat(big / 6)],
    ["://x repeated", "a://bcd".repeat(big / 7)],
    ["bearer and spaces", `Bearer${" ".repeat(big)}`],
    ["authorization and spaces", `Authorization:${" ".repeat(big)}'`],
    ["many assignments", "token=a ".repeat(big / 8)],
    ["cookies", "Cookie: a=1; ".repeat(big / 13)],
    ["spaces", " ".repeat(big)],
  ];

  for (const [index, [name, input]] of shapes.entries()) {
    it(`SCR1.${16 + index} ${name}: ${input.length} characters are scrubbed in well under a second`, () => {
      expect(timed(() => scrubText(input, big))).toBeLessThan(500);
    });
  }
});

describe("what scrubJson removes", () => {
  const json = (value: Json, chars = 4096) => scrubJson(value, chars);

  it("SCR1.32 the value of a key named like a secret is removed at any depth, and its value may be anything", () => {
    expect(json({ a: { Password: "x", list: [{ token: { deep: 1 } }] }, ok: "fine" })).toStrictEqual({ a: { Password: "[redacted]", list: [{ token: "[redacted]" }] }, ok: "fine" });
  });

  it("SCR1.33 cookie, auth, session and signature keys are secret, an author or a design is not", () => {
    expect(json({ cookie: "sid=abc", sessionId: "z", signature: "q", "X-Auth": "t", author: "bob", design: "d" })).toStrictEqual({ cookie: "[redacted]", sessionId: "[redacted]", signature: "[redacted]", "X-Auth": "[redacted]", author: "bob", design: "d" });
  });

  it("SCR1.34 the value of a header given as a name and a value is removed when its name is secret", () => {
    expect(json({ headers: [{ name: "Authorization", value: "sk-live-999" }, { name: "Accept", value: "json" }, { header: "Cookie", value: "sid=abc" }] })).toStrictEqual({
      headers: [{ name: "Authorization", value: "[redacted]" }, { name: "Accept", value: "json" }, { header: "Cookie", value: "[redacted]" }],
    });
    expect(json({ name: 5, value: "x" })).toStrictEqual({ name: 5, value: "x" });
    expect(json({ name: ["token"], value: "x" })).toStrictEqual({ name: ["token"], value: "x" });
  });

  it("SCR1.35 the argument after a secret flag, or after -u, in a list of arguments is removed", () => {
    expect(json({ args: ["curl", "-u", "bob:pw123", "--password", "x", "--name", "y", "--token", "--verbose", "--token"] })).toStrictEqual({
      args: ["curl", "-u", "bob:[redacted]", "--password", "[redacted]", "--name", "y", "--token", "--verbose", "--token"],
    });
    expect(json({ args: ["--api-key", 5, "x"] })).toStrictEqual({ args: ["--api-key", 5, "x"] });
    expect(json({ args: ["-u", 5, "a:b", "-u", "bob", "-u", "x:y"] })).toStrictEqual({ args: ["-u", 5, "a:b", "-u", "bob", "-u", "x:[redacted]"] });
    expect(json({ args: ["git-u", "a:b", "x--user", "c:d"] })).toStrictEqual({ args: ["git-u", "a:b", "x--user", "c:d"] });
    expect(json({ args: ["a:b", "c:d", "--user", "e:f"] })).toStrictEqual({ args: ["a:b", "c:d", "--user", "e:[redacted]"] });
  });

  it("SCR1.36 strings are scrubbed as text, numbers and the rest go through", () => {
    expect(json({ command: "echo token=abc", n: 1, b: true, z: null })).toStrictEqual({ command: "echo token=[redacted]", n: 1, b: true, z: null });
  });

  it("SCR1.37 what lies below sixteen levels is cut, in objects and in arrays", () => {
    let value: Json = "bottom";
    for (let i = 0; i < 20; i++) value = { k: value };
    let walked: Json = json(value);
    let depth = 0;
    while (typeof walked === "object" && walked !== null) {
      walked = (walked as { k: Json }).k;
      depth += 1;
    }
    expect(walked).toBe("[truncated]");
    expect(depth).toBe(16);
  });

  it("SCR1.38 the characters scrubbed across a value are shared: a list of long strings is cut when the share is spent", () => {
    const strings = Array.from({ length: 2000 }, () => "key.".repeat(125));
    const out = json({ files: strings }, 500);
    expect(weight(out)).toBeLessThan(500 * 64 + 1000);
    const files = (out as { files: Json[] }).files;
    expect(files.at(-1)).toBe("[truncated]");
    expect(files[0]).toBe("key.".repeat(125));
  });

  it("SCR1.39 the entries and the items scrubbed are bounded, and the cut is said", () => {
    const list = json({ list: Array.from({ length: 10_000 }, () => 1) }) as { list: Json[] };
    expect(list.list.length).toBeLessThan(4000);
    expect(list.list.at(-1)).toBe("[truncated]");
    const entries = json(Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, i]))) as Record<string, Json>;
    expect(Object.keys(entries).length).toBeLessThan(4000);
    expect(entries["[truncated]"]).toBeGreaterThan(7000);
  });

  it("SCR1.40 a hostile input of 2000 strings of 500 characters is scrubbed in well under a second", () => {
    const hostile = { command: "key-".repeat(1024), files: Array.from({ length: 2000 }, () => "key.".repeat(125)), more: Array.from({ length: 1000 }, () => "a-key".repeat(100)) };
    expect(timed(() => json(hostile, 500))).toBeLessThan(500);
  });

  it("SCR1.41 a key longer than the text limit is cut to it, and is still judged whole", () => {
    const out = json({ [`${"a".repeat(600)}token`]: "x", [`${"b".repeat(600)}`]: "y" }, 500);
    const [first, second] = Object.entries(out as Record<string, Json>);
    expect(first![0]).toHaveLength(500);
    expect(first![1]).toBe("[redacted]");
    expect(second![1]).toBe("y");
  });
});

describe("the budget of scrubJson", () => {
  const json = (value: Json, chars = 4096) => scrubJson(value, chars);

  it("SCR3.1 a list of 2047 items is scrubbed whole, and one more is cut: the list itself is a value", () => {
    expect((json(Array.from({ length: 2047 }, () => 1)) as Json[]).length).toBe(2047);
    const cut = json(Array.from({ length: 2048 }, () => 1)) as Json[];
    expect(cut.length).toBe(2048);
    expect(cut.at(-1)).toBe("[truncated]");
    expect(cut.at(-2)).toBe(1);
  });

  it("SCR3.2 entries removed count as values: so many secret keys are cut, and the cut says how many", () => {
    const secrets = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`token${i}`, "x"]));
    const out = json(secrets) as Record<string, Json>;
    expect(Object.keys(out)).toHaveLength(2048);
    expect(out["[truncated]"]).toBe(5000 - 2047);
    expect(out["token0"]).toBe("[redacted]");
  });

  it("SCR3.3 arguments removed after a flag count as values too", () => {
    const flags = Array.from({ length: 3000 }, (_, i) => (i % 2 === 0 ? "--password" : "x"));
    const out = json(flags) as Json[];
    expect(out).toHaveLength(2048);
    expect(out.at(-1)).toBe("[truncated]");
    const users = Array.from({ length: 3000 }, (_, i) => (i % 2 === 0 ? "-u" : "a:b"));
    expect(json(users) as Json[]).toHaveLength(2048);
  });

  it("SCR3.4 the keys use up the characters too: entries whose keys are long are cut when the share is spent", () => {
    const keys = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [String(i).padEnd(500, "k"), 1]));
    const out = json(keys, 500) as Record<string, Json>;
    expect(Object.keys(out).length).toBeGreaterThan(60);
    expect(Object.keys(out).length).toBeLessThan(70);
    expect(out["[truncated]"]).toBeGreaterThan(130);
  });

  it("SCR3.5 a string met when the characters are spent is cut whole, and one met with only some left is cut to them", () => {
    // chars 10: a share of 640; the 64th key of 10 characters uses the last of it, and its value finds nothing left
    const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i).padStart(10, "k"), ""]));
    const spentAtValue = Object.values(json(keys(64), 10) as Record<string, Json>);
    expect(spentAtValue.slice(0, 63).every((v) => v === "")).toBe(true);
    expect(spentAtValue.at(-1)).toBe("[truncated]");
    // chars 20: a share of 1280; 67 keys of 19 characters use 1273, leaving 7 for the value of the last
    const partial = json(Object.fromEntries(Array.from({ length: 67 }, (_, i) => [String(i).padStart(19, "k"), i < 66 ? "" : "v".repeat(20)])), 20) as Record<string, Json>;
    expect(Object.values(partial).at(-1)).toBe("v".repeat(7));
    expect(Object.values(partial)[0]).toBe("");
  });

  it("SCR3.6 what lies below sixteen levels of lists is cut", () => {
    let value: Json = "bottom";
    for (let i = 0; i < 20; i++) value = [value];
    let walked: Json = json({ list: value });
    let depth = 0;
    while (typeof walked === "object" && walked !== null) {
      walked = Array.isArray(walked) ? (walked as Json[])[0]! : (walked as { list: Json }).list;
      depth += 1;
    }
    expect(walked).toBe("[truncated]");
    expect(depth).toBe(16);
  });

  it("SCR3.7 the name of a header is judged whole, however long", () => {
    expect(json({ name: `${"a".repeat(600)}token`, value: "x" }, 500)).toStrictEqual({ name: "a".repeat(500), value: "[redacted]" });
  });
});
