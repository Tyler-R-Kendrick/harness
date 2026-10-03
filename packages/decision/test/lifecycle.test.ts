import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { wilsonInterval } from "@harness/cognitive";
import { Lifecycle, lifecycleSettingsJsonSchema, parseLifecycleSettings } from "../src/lifecycle.ts";
import type { LifecycleSettings } from "../src/lifecycle.ts";

const file = JSON.parse(readFileSync(new URL("../data/lifecycle.json", import.meta.url), "utf8")) as Record<string, unknown>;

/** Settings that promote after two fits in two sessions and retire two misses ahead. */
const settings = (patch: { promote?: { fits?: number; sessions?: number; lowerBound?: number }; retire?: { margin?: number }; audit?: { every?: number } } = {}): LifecycleSettings =>
  parseLifecycleSettings({
    promote: { fits: 2, sessions: 2, lowerBound: 0, ...patch.promote },
    retire: { margin: 2, ...patch.retire },
    audit: { every: 3, ...patch.audit },
  });

const fit = (session?: string) => ({ fit: true, ...(session === undefined ? {} : { session }) });
const miss = (session?: string) => ({ fit: false, ...(session === undefined ? {} : { session }) });

describe("lifecycle settings (data/lifecycle.json)", () => {
  it("LCY1.1 the shipped settings parse, and name their JSON Schema, which is generated from the parser", async () => {
    expect(parseLifecycleSettings(file).promote.fits).toBeGreaterThan(0);
    expect(file["$schema"]).toBe("./lifecycle.schema.json");
    await expect(`${JSON.stringify(lifecycleSettingsJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/lifecycle.schema.json");
  });

  it("LCY1.2 settings that cannot be right are refused, naming where", () => {
    const edit = (path: readonly string[], value: unknown) => {
      const s = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
      let o: Record<string, unknown> = s;
      for (const key of path.slice(0, -1)) o = o[key] as Record<string, unknown>;
      o[path.at(-1)!] = value;
      return () => parseLifecycleSettings(s);
    };
    expect(edit(["promote", "lowerBound"], 1.5)).toThrow(/invalid lifecycle settings[\s\S]*promote\.lowerBound/);
    expect(edit(["promote", "fits"], 0)).toThrow(/promote\.fits/);
    expect(edit(["promote", "sessions"], -1)).toThrow(/promote\.sessions/);
    expect(edit(["retire", "margin"], 0)).toThrow(/retire\.margin/);
    expect(edit(["audit", "every"], 0)).toThrow(/audit\.every/);
    expect(edit(["audit", "extra"], 1)).toThrow(/extra/);
  });
});

describe("lifecycle: states", () => {
  it("LCY2.1 an artefact starts as a candidate, and an unknown key has no state", () => {
    const l = new Lifecycle<string>(settings());
    expect(l.state("r1")).toBeUndefined();
    expect(l.add("r1", { origin: "induced" })).toBe("candidate");
    expect(l.state("r1")).toBe("candidate");
  });

  it("LCY2.2 adding a key that is known changes nothing and reports its state", () => {
    const l = new Lifecycle<string>(settings());
    l.add("r1", { origin: "induced" });
    l.observe("r1", fit("s1"));
    expect(l.add("r1", { origin: "authored" })).toBe("shadow");
    expect(l.list()).toEqual([expect.objectContaining({ key: "r1", origin: "induced", fits: 1 })]);
  });

  it("LCY2.3 the first evidence moves a candidate into shadow", () => {
    const l = new Lifecycle<string>(settings({ promote: { fits: 5 } }));
    l.add("r1", { origin: "induced" });
    expect(l.observe("r1", fit("s1"))).toEqual({ counted: true, from: "candidate", to: "shadow" });
    expect(l.state("r1")).toBe("shadow");
  });

  it("LCY2.4 an artefact is promoted only when fits, sessions and the lower bound are all reached", () => {
    const enough = () => {
      const l = new Lifecycle<string>(settings({ promote: { fits: 3, sessions: 2, lowerBound: 0.3 } }));
      l.add("r", { origin: "induced" });
      return l;
    };
    const few = enough();
    few.observe("r", fit("s1"));
    few.observe("r", fit("s2"));
    expect(few.state("r")).toBe("shadow"); // 2 fits < 3
    expect(few.observe("r", fit("s2"))).toEqual({ counted: true, from: "shadow", to: "active" });

    const oneSession = enough();
    for (let i = 0; i < 5; i++) oneSession.observe("r", fit("s1"));
    expect(oneSession.state("r")).toBe("shadow"); // one session only
    oneSession.observe("r", fit("s2"));
    expect(oneSession.state("r")).toBe("active");

    const lowBound = new Lifecycle<string>(settings({ promote: { fits: 3, sessions: 1, lowerBound: 0.6 }, retire: { margin: 50 } }));
    lowBound.add("r", { origin: "induced" });
    lowBound.observe("r", fit("s1"));
    lowBound.observe("r", miss("s1"));
    lowBound.observe("r", fit("s1"));
    lowBound.observe("r", fit("s1"));
    expect(lowBound.state("r")).toBe("shadow"); // 3 fits, but the fit rate's lower bound is under 0.6
    for (let i = 0; i < 30; i++) lowBound.observe("r", fit("s1"));
    expect(lowBound.state("r")).toBe("active");
  });

  it("LCY2.5 the promotion bound is the Wilson lower bound of the fit rate, at its exact value", () => {
    // wilson(4, 4) lower is about 0.5101
    const at = (lowerBound: number) => {
      const l = new Lifecycle<string>(settings({ promote: { fits: 4, sessions: 0, lowerBound } }));
      l.add("r", { origin: "induced" });
      for (let i = 0; i < 4; i++) l.observe("r", fit());
      return l.state("r");
    };
    expect(at(0.51)).toBe("active");
    expect(at(0.52)).toBe("shadow");
    expect(at(wilsonInterval(4, 4)[0])).toBe("active"); // a bound met exactly is met
  });

  it("LCY2.6 evidence from the sessions an artefact was built from does not count", () => {
    const l = new Lifecycle<string>(settings({ promote: { fits: 1, sessions: 1 } }));
    l.add("r", { origin: "induced", builtFrom: ["s0", "s1"] });
    expect(l.observe("r", fit("s0"))).toEqual({ counted: false, from: "candidate", to: "candidate" });
    expect(l.observe("r", miss("s1"))).toEqual({ counted: false, from: "candidate", to: "candidate" });
    expect(l.list()[0]).toMatchObject({ fits: 0, misses: 0, sessions: [] });
    expect(l.observe("r", fit("s2"))).toEqual({ counted: true, from: "candidate", to: "active" });
  });

  it("LCY2.7 evidence with no session counts as a fit or miss but not towards distinct sessions", () => {
    const l = new Lifecycle<string>(settings({ promote: { fits: 2, sessions: 1 } }));
    l.add("r", { origin: "induced" });
    l.observe("r", fit());
    l.observe("r", fit());
    expect(l.list()[0]).toMatchObject({ fits: 2, sessions: [], state: "shadow" });
    l.observe("r", fit("s1"));
    expect(l.state("r")).toBe("active");
  });

  it("LCY2.8 a session is counted once, whatever it says and however often", () => {
    const l = new Lifecycle<string>(settings({ promote: { fits: 9, sessions: 3 } }));
    l.add("r", { origin: "induced" });
    for (const s of ["a", "b", "a", "b", "a"]) l.observe("r", fit(s));
    expect(l.list()[0]?.sessions).toEqual(["a", "b"]);
  });

  it("LCY2.17 the sessions kept are only as many as promotion needs", () => {
    const l = new Lifecycle<string>(settings({ promote: { fits: 9, sessions: 2 } }));
    l.add("r", { origin: "induced" });
    for (const s of ["s1", "s2", "s3"]) l.observe("r", fit(s));
    expect(l.list()[0]).toMatchObject({ fits: 3, sessions: ["s1", "s2"] });
  });

  it("LCY2.18 when the evidence would both promote and retire an artefact, it is retired", () => {
    const l = new Lifecycle<string>(settings({ promote: { fits: 2, sessions: 2, lowerBound: 0 }, retire: { margin: 2 } }));
    l.add("r", { origin: "induced" });
    l.observe("r", fit());
    l.observe("r", fit());
    l.observe("r", miss("s1"));
    l.observe("r", miss());
    l.observe("r", miss());
    expect(l.state("r")).toBe("shadow"); // 3 misses - 2 fits = 1, and only one session
    expect(l.observe("r", miss("s2"))).toEqual({ counted: true, from: "shadow", to: "retired" }); // 4 - 2 = 2 with two sessions and two fits
  });

  it("LCY2.9 a shadowed artefact that misleads by the margin is retired", () => {
    const l = new Lifecycle<string>(settings({ promote: { fits: 9 } }));
    l.add("r", { origin: "induced" });
    l.observe("r", fit("s1"));
    l.observe("r", miss("s1"));
    l.observe("r", miss("s2"));
    expect(l.state("r")).toBe("shadow"); // 2 misses - 1 fit is under the margin
    expect(l.observe("r", miss("s3"))).toEqual({ counted: true, from: "shadow", to: "retired" });
  });

  it("LCY2.10 a candidate whose first evidence is a miss that meets the margin is retired outright", () => {
    const l = new Lifecycle<string>(settings({ retire: { margin: 1 } }));
    l.add("r", { origin: "induced" });
    expect(l.observe("r", miss("s1"))).toEqual({ counted: true, from: "candidate", to: "retired" });
  });

  it("LCY2.11 an active artefact is retired when its misses since promotion lead its fits since promotion by the margin", () => {
    const l = new Lifecycle<string>(settings());
    l.add("r", { origin: "induced" });
    l.observe("r", fit("s1"));
    l.observe("r", fit("s2"));
    expect(l.state("r")).toBe("active");
    l.observe("r", miss("s3"));
    l.observe("r", fit("s3")); // back to even
    l.observe("r", miss("s4"));
    expect(l.state("r")).toBe("active"); // 2 misses - 1 fit = 1
    expect(l.observe("r", miss("s4"))).toEqual({ counted: true, from: "active", to: "retired" });
  });

  it("LCY2.12 evidence gathered in shadow does not offset misses after promotion", () => {
    const l = new Lifecycle<string>(settings({ promote: { fits: 4, sessions: 1 } }));
    l.add("r", { origin: "induced" });
    for (let i = 0; i < 4; i++) l.observe("r", fit("s1"));
    expect(l.state("r")).toBe("active");
    l.observe("r", miss("s2"));
    expect(l.observe("r", miss("s3"))).toMatchObject({ to: "retired" });
  });

  it("LCY2.13 a retired artefact is never added again under its key, and gathers no evidence", () => {
    const l = new Lifecycle<string>(settings({ retire: { margin: 1 } }));
    l.add("r", { origin: "induced" });
    l.observe("r", miss("s1"));
    expect(l.add("r", { origin: "induced" })).toBe("retired");
    expect(l.observe("r", fit("s2"))).toEqual({ counted: false, from: "retired", to: "retired" });
    expect(l.list()[0]).toMatchObject({ state: "retired", fits: 0, misses: 1 });
  });

  it("LCY2.14 reviving a retired artefact starts it over as a candidate with no evidence", () => {
    const l = new Lifecycle<string>(settings({ retire: { margin: 1 } }));
    l.add("r", { origin: "induced", builtFrom: ["s0"] });
    l.observe("r", miss("s1"));
    expect(l.revive("r")).toBe("candidate");
    expect(l.list()[0]).toEqual({ key: "r", state: "candidate", origin: "induced", builtFrom: ["s0"], fits: 0, misses: 0, sessions: [], activeFits: 0, activeMisses: 0, uses: 0 });
  });

  it("LCY2.15 only a retired artefact can be revived", () => {
    const l = new Lifecycle<string>(settings());
    expect(() => l.revive("nope")).toThrow('no artefact "nope"');
    l.add("r", { origin: "induced" });
    expect(() => l.revive("r")).toThrow('artefact "r" is candidate, only a retired one is revived');
  });

  it("LCY2.16 evidence for an unknown key is refused", () => {
    const l = new Lifecycle<string>(settings());
    expect(() => l.observe("nope", fit())).toThrow('no artefact "nope"');
    expect(() => l.use("nope")).toThrow('no artefact "nope"');
    expect(() => l.shouldAudit("nope")).toThrow('no artefact "nope"');
  });
});

describe("lifecycle: use and audit", () => {
  const active = (every = 3) => {
    const l = new Lifecycle<string>(settings({ promote: { fits: 1, sessions: 0 }, audit: { every } }));
    l.add("r", { origin: "induced" });
    l.observe("r", fit());
    return l;
  };

  it("LCY3.1 only an active artefact answers", () => {
    const l = new Lifecycle<string>(settings({ promote: { fits: 9 }, retire: { margin: 1 } }));
    l.add("c", { origin: "induced" });
    l.add("s", { origin: "induced" });
    l.observe("s", fit("s1"));
    l.add("x", { origin: "induced" });
    l.observe("x", miss("s1"));
    for (const key of ["c", "s", "x"]) expect(l.use(key)).toEqual({ answer: false, audit: false });
    expect(l.list().map((a) => a.uses)).toEqual([0, 0, 0]);
    expect(active().use("r")).toEqual({ answer: true, audit: false });
  });

  it("LCY3.2 every n-th use of an active artefact is an audit, in which it does not answer", () => {
    const l = active(3);
    const seen = Array.from({ length: 7 }, () => l.use("r"));
    expect(seen.map((u) => u.audit)).toEqual([false, false, true, false, false, true, false]);
    expect(seen.map((u) => u.answer)).toEqual([true, true, false, true, true, false, true]);
  });

  it("LCY3.3 shouldAudit says whether the next use is an audit, without counting it", () => {
    const l = active(2);
    expect(l.shouldAudit("r")).toBe(false);
    expect(l.shouldAudit("r")).toBe(false);
    l.use("r");
    expect(l.shouldAudit("r")).toBe(true);
    expect(l.use("r").audit).toBe(true);
    expect(l.shouldAudit("r")).toBe(false);
  });

  it("LCY3.4 an artefact that is not active is never audited", () => {
    const l = new Lifecycle<string>(settings({ promote: { fits: 9 }, audit: { every: 1 } }));
    l.add("r", { origin: "induced" });
    expect(l.shouldAudit("r")).toBe(false);
    l.observe("r", fit("s1"));
    expect(l.shouldAudit("r")).toBe(false);
  });

  it("LCY3.7 with an audit every third use, it is the third use that shouldAudit announces, not the first or the second", () => {
    const l = active(3);
    expect([l.shouldAudit("r"), l.use("r").audit, l.shouldAudit("r"), l.use("r").audit, l.shouldAudit("r"), l.use("r").audit]).toEqual([false, false, false, false, true, true]);
  });

  it("LCY3.5 with an audit every use, an active artefact never answers alone", () => {
    const l = active(1);
    expect(l.shouldAudit("r")).toBe(true);
    expect(l.use("r")).toEqual({ answer: false, audit: true });
  });

  it("LCY3.6 the audit is checked like any evidence: a miss found in an audit can retire the artefact", () => {
    const l = active(1);
    l.use("r");
    l.observe("r", miss("s1"));
    l.observe("r", miss("s2"));
    expect(l.state("r")).toBe("retired");
    expect(l.use("r")).toEqual({ answer: false, audit: false });
  });
});

describe("lifecycle: snapshot and restore", () => {
  const busy = () => {
    const l = new Lifecycle<string>(settings({ promote: { fits: 2, sessions: 1 } }));
    l.add("rule-a", { origin: "induced", builtFrom: ["s0"] });
    l.observe("rule-a", fit("s1"));
    l.observe("rule-a", fit("s2"));
    l.use("rule-a");
    l.add("rule-b", { origin: "fitted" });
    l.observe("rule-b", miss("s1"));
    l.add("rule-c", { origin: "authored" });
    return l;
  };

  it("LCY4.1 a snapshot is plain JSON that restores every artefact and its counters", () => {
    const l = busy();
    const snapshot = JSON.parse(JSON.stringify(l.snapshot())) as unknown;
    const restored = new Lifecycle<string>(settings());
    restored.restore(snapshot);
    expect(restored.list()).toEqual(l.list());
    expect(restored.state("rule-a")).toBe("active");
    expect(l.snapshot().format).toBe("harness.decision.lifecycle/v1");
    expect(restored.snapshot()).toEqual(l.snapshot());
  });

  it("LCY4.2 a restored lifecycle carries on where the saved one left off", () => {
    const l = new Lifecycle<string>(settings({ audit: { every: 2 } }));
    l.add("a", { origin: "induced" });
    l.observe("a", fit("s1"));
    l.observe("a", fit("s2"));
    l.use("a");
    const restored = new Lifecycle<string>(settings({ audit: { every: 2 } }));
    restored.restore(l.snapshot());
    expect(restored.use("a")).toEqual({ answer: false, audit: true });
  });

  it("LCY4.3 restoring replaces what was there", () => {
    const l = new Lifecycle<string>(settings());
    l.add("old", { origin: "induced" });
    l.restore(busy().snapshot());
    expect(l.state("old")).toBeUndefined();
    expect(l.list().map((a) => a.key)).toEqual(["rule-a", "rule-b", "rule-c"]);
  });

  it("LCY4.4 a snapshot that is not valid is refused, naming where, and leaves the lifecycle as it was", () => {
    const l = new Lifecycle<string>(settings());
    l.add("keep", { origin: "induced" });
    const good = JSON.parse(JSON.stringify(busy().snapshot())) as { artefacts: Record<string, unknown>[] };
    const bad = (mutate: (s: typeof good) => void) => {
      const copy = JSON.parse(JSON.stringify(good)) as typeof good;
      mutate(copy);
      return () => l.restore(copy);
    };
    expect(() => l.restore(null)).toThrow(/invalid lifecycle snapshot/);
    expect(bad((s) => { s.artefacts[0]!["state"] = "done"; })).toThrow(/artefacts\[0\]\.state/);
    expect(bad((s) => { s.artefacts[0]!["fits"] = -1; })).toThrow(/artefacts\[0\]\.fits/);
    expect(bad((s) => { s.artefacts[0]!["fits"] = 1.5; })).toThrow(/artefacts\[0\]\.fits/);
    expect(bad((s) => { s.artefacts[1]!["extra"] = 1; })).toThrow(/extra/);
    expect(bad((s) => { (s as Record<string, unknown>)["format"] = "other"; })).toThrow(/format/);
    expect(bad((s) => { s.artefacts[1]!["key"] = "rule-a"; })).toThrow(/keys are unique/);
    expect(bad((s) => { s.artefacts[1]!["key"] = ""; })).toThrow(/artefacts\[1\]\.key/);
    expect(bad((s) => { s.artefacts[1]!["origin"] = ""; })).toThrow(/artefacts\[1\]\.origin/);
    expect(bad((s) => { s.artefacts[0]!["sessions"] = ["x", "x"]; })).toThrow(/sessions are unique/);
    expect(l.list().map((a) => a.key)).toEqual(["keep"]);
  });

  it("LCY4.5 list gives every artefact in the order it was added, tombstones included, as copies", () => {
    const l = new Lifecycle<string>(settings({ retire: { margin: 1 } }));
    l.add("z", { origin: "induced" });
    l.add("a", { origin: "induced" });
    l.observe("z", miss("s1"));
    const listed = l.list();
    expect(listed.map((a) => [a.key, a.state])).toEqual([["z", "retired"], ["a", "candidate"]]);
    (listed[1]!.sessions as string[]).push("tamper");
    (listed[1]!.builtFrom as string[]).push("tamper");
    expect(l.list()[1]).toMatchObject({ sessions: [], builtFrom: [] });
  });
});
