import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { wilsonInterval } from "@harness/cognitive";
import { Lifecycle, parseLifecycleSettings } from "../src/lifecycle.ts";
import type { LifecycleState } from "../src/lifecycle.ts";

type Command =
  | { readonly op: "add"; readonly key: string; readonly builtFrom: readonly string[] }
  | { readonly op: "observe"; readonly key: string; readonly fit: boolean; readonly session: string | undefined }
  | { readonly op: "use"; readonly key: string }
  | { readonly op: "revive"; readonly key: string };

const keys = fc.constantFrom("a", "b", "c");
const sessions = fc.constantFrom("s1", "s2", "s3", "s4");
const commands = fc.array(
  fc.oneof(
    fc.record({ op: fc.constant("add" as const), key: keys, builtFrom: fc.subarray(["s1", "s2", "s3", "s4"]) }),
    { arbitrary: fc.record({ op: fc.constant("observe" as const), key: keys, fit: fc.boolean(), session: fc.option(sessions, { nil: undefined }) }), weight: 6 },
    { arbitrary: fc.record({ op: fc.constant("use" as const), key: keys }), weight: 3 },
    fc.record({ op: fc.constant("revive" as const), key: keys }),
  ) as fc.Arbitrary<Command>,
  { maxLength: 80 },
);

const settingsArb = fc.record({
  promote: fc.record({ fits: fc.integer({ min: 1, max: 4 }), sessions: fc.integer({ min: 0, max: 3 }), lowerBound: fc.constantFrom(0, 0.3, 0.5) }),
  retire: fc.record({ margin: fc.integer({ min: 1, max: 3 }) }),
  audit: fc.record({ every: fc.integer({ min: 1, max: 4 }) }),
});

/** The specification, written independently of the class: plain records and the rules in the settings. */
interface Model {
  state: LifecycleState;
  builtFrom: readonly string[];
  fits: number;
  misses: number;
  seen: Set<string>;
  activeFits: number;
  activeMisses: number;
  uses: number;
}

const LEGAL: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  candidate: ["candidate", "shadow", "active", "retired"],
  shadow: ["shadow", "active", "retired"],
  active: ["active", "retired"],
  retired: ["retired"],
};

describe("lifecycle properties", () => {
  test.prop([settingsArb, commands])("LCY5.1 the lifecycle agrees with a plain model of its rules, and never takes an illegal step", (raw, script) => {
    const settings = parseLifecycleSettings(raw);
    const real = new Lifecycle<string>(settings);
    const model = new Map<string, Model>();
    for (const c of script) {
      const m = model.get(c.key);
      if (c.op === "add") {
        real.add(c.key, { origin: "x", builtFrom: c.builtFrom });
        if (m === undefined) model.set(c.key, { state: "candidate", builtFrom: c.builtFrom, fits: 0, misses: 0, seen: new Set(), activeFits: 0, activeMisses: 0, uses: 0 });
      } else if (m === undefined) {
        expect(() => (c.op === "observe" ? real.observe(c.key, { fit: c.fit }) : c.op === "use" ? real.use(c.key) : real.revive(c.key))).toThrow();
      } else if (c.op === "revive") {
        if (m.state !== "retired") expect(() => real.revive(c.key)).toThrow();
        else {
          real.revive(c.key);
          Object.assign(m, { state: "candidate", fits: 0, misses: 0, seen: new Set(), activeFits: 0, activeMisses: 0, uses: 0 });
        }
      } else if (c.op === "use") {
        const before = real.state(c.key);
        const got = real.use(c.key);
        if (m.state !== "active") expect(got).toEqual({ answer: false, audit: false });
        else {
          m.uses += 1;
          const audit = m.uses % settings.audit.every === 0;
          expect(got).toEqual({ answer: !audit, audit });
        }
        expect(real.state(c.key)).toBe(before);
      } else {
        const before = m.state;
        const got = real.observe(c.key, c.session === undefined ? { fit: c.fit } : { fit: c.fit, session: c.session });
        const ignored = m.state === "retired" || (c.session !== undefined && m.builtFrom.includes(c.session));
        expect(got.counted).toBe(!ignored);
        if (!ignored) {
          if (c.fit) m.fits += 1;
          else m.misses += 1;
          if (c.session !== undefined) m.seen.add(c.session);
          if (m.state === "active") {
            if (c.fit) m.activeFits += 1;
            else m.activeMisses += 1;
            if (m.activeMisses - m.activeFits >= settings.retire.margin) m.state = "retired";
          } else {
            m.state = "shadow";
            const promotable = m.fits >= settings.promote.fits && m.seen.size >= settings.promote.sessions && wilsonInterval(m.fits, m.fits + m.misses)[0] >= settings.promote.lowerBound;
            if (m.misses - m.fits >= settings.retire.margin) m.state = "retired";
            else if (promotable) m.state = "active";
          }
        }
        expect(got.from).toBe(before);
        expect(got.to).toBe(m.state);
        expect(LEGAL[got.from]).toContain(got.to);
      }
      for (const [key, expected] of model) expect(real.state(key)).toBe(expected.state);
    }
    expect(real.list().map((a) => a.key)).toEqual([...model.keys()]);
  });

  test.prop([settingsArb, commands])("LCY5.2 a snapshot restores to an identical lifecycle at any point", (raw, script) => {
    const settings = parseLifecycleSettings(raw);
    const real = new Lifecycle<string>(settings);
    for (const c of script) {
      try {
        if (c.op === "add") real.add(c.key, { origin: "x", builtFrom: c.builtFrom });
        else if (c.op === "observe") real.observe(c.key, c.session === undefined ? { fit: c.fit } : { fit: c.fit, session: c.session });
        else if (c.op === "use") real.use(c.key);
        else real.revive(c.key);
      } catch {
        // an unknown key or a revive of what is not retired is refused; that is tested elsewhere
      }
    }
    const copy = new Lifecycle<string>(settings);
    copy.restore(JSON.parse(JSON.stringify(real.snapshot())) as unknown);
    expect(copy.list()).toEqual(real.list());
    for (const a of real.list()) {
      expect(copy.shouldAudit(a.key)).toBe(real.shouldAudit(a.key));
      expect(copy.use(a.key)).toEqual(real.use(a.key));
    }
  });

  test.prop([settingsArb, commands])("LCY5.3 a retired key stays retired until it is revived, and only an active artefact ever answers", (raw, script) => {
    const real = new Lifecycle<string>(parseLifecycleSettings(raw));
    const revived = new Set<string>();
    for (const c of script) {
      const before = real.state(c.key);
      let answered = false;
      try {
        if (c.op === "add") real.add(c.key, { origin: "x", builtFrom: c.builtFrom });
        else if (c.op === "observe") real.observe(c.key, c.session === undefined ? { fit: c.fit } : { fit: c.fit, session: c.session });
        else if (c.op === "use") answered = real.use(c.key).answer;
        else {
          real.revive(c.key);
          revived.add(c.key);
        }
      } catch {
        // refused calls change nothing
      }
      if (before === "retired" && !(c.op === "revive" && revived.has(c.key))) expect(real.state(c.key)).toBe("retired");
      if (answered) expect(before).toBe("active");
      revived.delete(c.key);
    }
  });
});
