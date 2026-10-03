import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { DecisionPlugin } from "../src/plugin.ts";
import type { PermissionFacts } from "../src/permission.ts";
import { FakeBus, FakeFacts, OPTIONS } from "./plugin-fixtures.ts";
import { rig, saying, shippedAuthority } from "./compose-fixtures.ts";

const CRITICAL = { boolean: 0.95, score: [0, 0, 0.1, 0.9] };
const FACTS: PermissionFacts = { tool: "Bash", kind: "execute", command: "make" };

type Op =
  | { readonly kind: "request"; readonly session: string; readonly id: string }
  | { readonly kind: "resolve"; readonly session: string; readonly id: string; readonly choice: "allow" | "deny" | null }
  | { readonly kind: "call"; readonly session: string; readonly title: string }
  | { readonly kind: "ended" | "started"; readonly session: string };

const session = fc.constantFrom("s1", "s2");
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("request" as const), session, id: fc.constantFrom("a", "b", "c") }),
  fc.record({ kind: fc.constant("resolve" as const), session, id: fc.constantFrom("a", "b", "c"), choice: fc.constantFrom("allow" as const, "deny" as const, null) }),
  fc.record({ kind: fc.constant("call" as const), session, title: fc.constantFrom("ls", "cat", "make") }),
  fc.record({ kind: fc.constantFrom("ended" as const, "started" as const), session }),
);

/** Play operations against a fresh world; with `duplicates`, the bus delivers earlier events again after some steps. */
async function play(ops: readonly Op[], duplicates: readonly boolean[]) {
  const bus = new FakeBus();
  const facts = new FakeFacts();
  const errors: unknown[] = [];
  const r = rig({ members: [saying("m", CRITICAL)], authority: shippedAuthority() });
  const plugin = new DecisionPlugin({ layer: r.layer, source: bus, facts, onError: (e) => void errors.push(e) });
  await plugin.start();
  const open = new Set<string>();
  const done = new Set<string>();
  let calls = 0;
  let handled = 0;
  for (const [i, o] of ops.entries()) {
    const key = o.kind === "request" || o.kind === "resolve" ? `${o.session}/${o.id}` : "";
    if (o.kind === "request" && !open.has(key) && !done.has(key)) {
      open.add(key);
      facts.openRequest(o.session, o.id, FACTS, OPTIONS);
      facts.append(o.session, "event", { event: "permission.requested", data: { requestId: o.id } });
      bus.publish("permission.requested", o.session, { requestId: o.id });
    } else if (o.kind === "resolve" && open.has(key)) {
      open.delete(key);
      done.add(key);
      facts.closeRequest(o.session, o.id);
      facts.append(o.session, "event", { event: "permission.resolved", data: { requestId: o.id, outcome: o.choice === null ? { outcome: "cancelled" } : { outcome: "selected", optionId: o.choice }, by: o.choice === null ? "system" : "alice" } });
      bus.publish("permission.resolved", o.session, { requestId: o.id, by: "alice" });
    } else if (o.kind === "call") {
      facts.toolCall(o.session, `c${calls++}`, o.title, { n: calls % 2 });
    } else if (o.kind === "ended") {
      bus.publish("turn.ended", o.session, { stopReason: "end_turn" });
    } else if (o.kind === "started") {
      bus.publish("turn.started", o.session, {});
    }
    handled += await plugin.step();
    if (duplicates[i % Math.max(1, duplicates.length)] === true) {
      bus.redeliver = bus.events.map((e) => e.eventId);
      handled += await plugin.step();
    }
  }
  const records = (await r.layer.records()).map(({ id, ...rest }) => ({ id, ...rest }));
  return { open: [...open], inbox: r.layer.inbox.list(), records, published: r.published.length, errors: errors.length, handled, unique: bus.events.length };
}

describe("plugin properties", () => {
  test.prop([fc.array(op, { maxLength: 30 }), fc.array(fc.boolean(), { minLength: 1, maxLength: 30 })], { numRuns: 60 })("DPL12.1 handling is idempotent: events delivered again change nothing", async (ops, duplicates) => {
    const once = await play(ops, []);
    const twice = await play(ops, duplicates);
    expect(twice.inbox).toEqual(once.inbox);
    expect(twice.records).toEqual(once.records);
    expect(twice.published).toBe(once.published);
    expect(twice.handled).toBe(once.handled);
    expect(twice.errors).toBe(once.errors);
  });

  test.prop([fc.array(op, { maxLength: 30 })], { numRuns: 60 })("DPL12.2 a plugin never loses a request: every open request is in the inbox, and every resolved one is not", async (ops) => {
    const result = await play(ops, []);
    expect(result.errors).toBe(0);
    const permissions = result.inbox.filter((i) => i.kind === "permission").map((i) => i.id).sort();
    expect(permissions).toEqual(result.open.map((key) => `permission:${key.replace("/", ":")}`).sort());
    expect(result.inbox.every((i) => i.kind !== "permission" || i.blocked)).toBe(true);
  });
});
