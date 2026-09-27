import { describe, expect } from "vitest";
import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { SubagentTree } from "@harness/core";
import type { Grant } from "@harness/core";

const GRANTS: Grant[] = ["observe", "control", "approve", "spawn", "cancel", "cap:fs", "cap:net"];
const grantSet = fc.subarray(GRANTS);
const op = fc.oneof(
  fc.record({ t: fc.constant("spawn" as const), parent: fc.nat(20), grants: grantSet }),
  fc.record({ t: fc.constant("revoke" as const), node: fc.nat(20), grants: grantSet }),
  fc.record({ t: fc.constant("grant" as const), node: fc.nat(20), grants: grantSet }),
  fc.record({ t: fc.constant("detach" as const), node: fc.nat(20) }),
  fc.record({ t: fc.constant("reattach" as const), node: fc.nat(20) }),
  fc.record({ t: fc.constant("close" as const), node: fc.nat(20) }),
);

describe("SubagentTree properties", () => {
  test.prop([fc.array(op, { maxLength: 80 })])(
    "ST5.1 every node's grants stay a subset of its parent's under any operation sequence",
    (ops) => {
      const t = new SubagentTree();
      t.createRoot("n0", "agent", GRANTS);
      const ids = ["n0"];
      for (const o of ops) {
        if (o.t === "spawn") {
          const r = t.spawn(ids[o.parent % ids.length]!, `n${ids.length}`, "agent", o.grants);
          if (r.ok) ids.push(`n${ids.length}`);
        } else if (o.t === "revoke") t.revoke(ids[o.node % ids.length]!, o.grants);
        else if (o.t === "grant") t.grant(ids[o.node % ids.length]!, o.grants);
        else if (o.t === "detach") t.detach(ids[o.node % ids.length]!);
        else if (o.t === "reattach") t.reattach(ids[o.node % ids.length]!);
        else t.close(ids[o.node % ids.length]!);
      }
      for (const id of ids) {
        const parent = t.get(id)?.parent;
        if (parent === undefined) continue;
        const parentGrants = t.grants(parent);
        for (const g of t.grants(id)) expect(parentGrants.has(g)).toBe(true);
      }
      for (const g of GRANTS) for (const h of t.holders(g)) expect(t.get(h)?.state).toBe("active");
    },
  );
});
