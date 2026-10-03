import { describe, expect, it } from "vitest";
import { authorityJsonSchema, AuthoritySchema, evaluateAuthority, EFFECTS, tighten } from "@harness/decision";
import type { Authority } from "@harness/decision";
import { readFileSync } from "node:fs";

const authority = (rules: Authority["rules"], def: Authority["default"] = "escalate"): Authority => AuthoritySchema.parse({ version: "a1", default: def, rules });
const facts = { tool: "bash", command: "rm -rf /", cost: 0 };

describe("authority", () => {
  it("AUT1.1 with no rule matching, the stated default applies", () => {
    for (const d of EFFECTS) expect(evaluateAuthority(authority([], d), facts)).toEqual({ effect: d, matched: [], reasons: [] });
  });

  it("AUT1.2 a permit rule allows what the default would escalate", () => {
    const a = authority([{ id: "reads", effect: "permit", when: { eq: ["tool", "read"] } }]);
    expect(evaluateAuthority(a, { tool: "read" })).toMatchObject({ effect: "allow", matched: ["reads"] });
    expect(evaluateAuthority(a, { tool: "bash" })).toMatchObject({ effect: "escalate", matched: [] });
  });

  it("AUT1.3 forbid wins over escalate, and escalate over permit, whatever the order", () => {
    const rules: Authority["rules"] = [
      { id: "p", effect: "permit", when: { exists: "tool" } },
      { id: "e", effect: "escalate", when: { exists: "tool" }, reason: "look" },
      { id: "f", effect: "forbid", when: { prefix: ["command", "rm"] }, reason: "destructive" },
    ];
    for (const order of [rules, [...rules].reverse(), [rules[1]!, rules[2]!, rules[0]!]]) {
      const r = evaluateAuthority(authority(order, "allow"), facts);
      expect(r.effect).toBe("deny");
      expect([...r.matched].sort()).toEqual(["e", "f", "p"]);
      expect([...r.reasons].sort()).toEqual(["destructive", "look"]);
    }
    expect(evaluateAuthority(authority(rules, "allow"), { tool: "bash", command: "ls" }).effect).toBe("escalate");
  });

  it("AUT1.4 evaluation is order independent for the matched set as well as the effect", () => {
    const rules = ["a", "b", "c"].map((id) => ({ id, effect: "permit" as const, when: { exists: "tool" } }));
    const one = evaluateAuthority(authority(rules), facts);
    const other = evaluateAuthority(authority([...rules].reverse()), facts);
    expect(one.effect).toBe(other.effect);
    expect([...one.matched].sort()).toEqual([...other.matched].sort());
  });

  it("AUT2.1 tightening takes the more restrictive effect and never relaxes", () => {
    expect(EFFECTS).toEqual(["allow", "escalate", "deny"]);
    for (const [a, b, out] of [
      ["allow", "allow", "allow"],
      ["allow", "escalate", "escalate"],
      ["escalate", "allow", "escalate"],
      ["escalate", "deny", "deny"],
      ["deny", "allow", "deny"],
      ["deny", "escalate", "deny"],
    ] as const) expect(tighten(a, b)).toBe(out);
  });

  it("AUT3.1 rule ids are unique, non-empty, and effects and defaults are the known words", () => {
    const dup = { version: "a", default: "deny", rules: [{ id: "x", effect: "permit", when: { exists: "a" } }, { id: "x", effect: "forbid", when: { exists: "a" } }] };
    expect(AuthoritySchema.safeParse(dup).success).toBe(false);
    expect(AuthoritySchema.safeParse({ version: "a", default: "deny", rules: [{ id: "", effect: "permit", when: { exists: "a" } }] }).success).toBe(false);
    expect(AuthoritySchema.safeParse({ version: "a", default: "maybe", rules: [] }).success).toBe(false);
    expect(AuthoritySchema.safeParse({ version: "a", default: "deny", rules: [{ id: "x", effect: "allow", when: { exists: "a" } }] }).success).toBe(false);
    expect(AuthoritySchema.safeParse({ version: "", default: "deny", rules: [] }).success).toBe(false);
    expect(AuthoritySchema.safeParse({ version: "a", default: "deny", rules: [], extra: 1 }).success).toBe(false);
  });

  it("AUT3.2 the JSON Schema for authority files is generated from the parser", async () => {
    await expect(`${JSON.stringify(authorityJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/authority.schema.json");
    expect(JSON.parse(readFileSync(new URL("../data/authority.schema.json", import.meta.url), "utf8")).type).toBe("object");
  });

  it("AUT3.3 a duplicate rule id is refused with a message that says so", () => {
    const r = AuthoritySchema.safeParse({ version: "a", default: "deny", rules: [{ id: "x", effect: "permit", when: { exists: "a" } }, { id: "x", effect: "permit", when: { exists: "a" } }] });
    expect(r.success || r.error.issues.map((i) => i.message)).toEqual(["rule ids are unique"]);
  });

  it("AUT1.5 a single matched rule decides, whatever its effect, and its reason is kept", () => {
    for (const [effect, expected] of [["permit", "allow"], ["escalate", "escalate"], ["forbid", "deny"]] as const) {
      const a = authority([{ id: "r", effect, when: { exists: "tool" }, reason: "because" }], expected === "allow" ? "deny" : "allow");
      expect(evaluateAuthority(a, facts)).toEqual({ effect: expected, matched: ["r"], reasons: ["because"] });
    }
  });
});
