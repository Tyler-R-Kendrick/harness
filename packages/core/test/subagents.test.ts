import { describe, expect, it } from "vitest";
import { SubagentTree } from "@harness/core";

function tree(): SubagentTree {
  const t = new SubagentTree();
  t.createRoot("root", "agent", ["observe", "control", "approve", "spawn", "cap:fs"]);
  return t;
}

describe("SubagentTree", () => {
  it("ST1.1 the root holds exactly the grants it was created with", () => {
    const t = tree();
    expect(t.get("root")).toMatchObject({ id: "root", kind: "agent", state: "active" });
    expect([...t.grants("root")].sort()).toEqual(["approve", "cap:fs", "control", "observe", "spawn"]);
  });

  it("ST1.2 a child may be spawned with a subset of its parent's grants", () => {
    const t = tree();
    const r = t.spawn("root", "human-1", "human", ["observe", "approve"]);
    expect(r.ok).toBe(true);
    expect(t.get("human-1")).toMatchObject({ parent: "root", kind: "human", state: "active" });
    expect([...t.grants("human-1")].sort()).toEqual(["approve", "observe"]);
  });

  it("ST1.3 a child cannot receive a grant its parent lacks", () => {
    const t = tree();
    t.spawn("root", "obs", "client", ["observe", "spawn"]);
    expect(t.spawn("obs", "x", "client", ["approve"])).toMatchObject({ ok: false, error: { code: "grant_not_held" } });
    expect(t.get("x")).toBeUndefined();
  });

  it("ST1.4 spawning requires the spawn grant", () => {
    const t = tree();
    t.spawn("root", "obs", "client", ["observe"]);
    expect(t.spawn("obs", "x", "client", [])).toMatchObject({ ok: false, error: { code: "not_permitted" } });
  });

  it("ST1.5 unknown parents and duplicate ids are rejected", () => {
    const t = tree();
    expect(t.spawn("nope", "x", "agent", [])).toMatchObject({ ok: false, error: { code: "unknown_node" } });
    t.spawn("root", "x", "agent", []);
    expect(t.spawn("root", "x", "agent", [])).toMatchObject({ ok: false, error: { code: "duplicate_node" } });
    expect(t.spawn("root", "root", "agent", [])).toMatchObject({ ok: false, error: { code: "duplicate_node" } });
  });

  it("ST1.6 inactive parents cannot spawn", () => {
    const t = tree();
    t.spawn("root", "c", "client", ["spawn"]);
    t.detach("c");
    expect(t.spawn("c", "x", "agent", [])).toMatchObject({ ok: false, error: { code: "inactive_parent" } });
  });

  it("ST1.7 a second root is rejected", () => {
    const t = tree();
    expect(() => t.createRoot("other", "agent", [])).toThrow(/root/);
  });

  it("ST2.1 revoking a grant removes it from the node and every descendant", () => {
    const t = tree();
    t.spawn("root", "a", "agent", ["approve", "spawn", "observe"]);
    t.spawn("a", "b", "agent", ["approve", "observe"]);
    t.spawn("root", "sibling", "agent", ["approve"]);
    expect(t.revoke("a", ["approve"]).ok).toBe(true);
    expect(t.grants("a").has("approve")).toBe(false);
    expect(t.grants("b").has("approve")).toBe(false);
    expect(t.grants("b").has("observe")).toBe(true);
    expect(t.grants("sibling").has("approve")).toBe(true);
  });

  it("ST2.2 operations on unknown nodes report unknown_node", () => {
    const t = tree();
    expect(t.revoke("nope", ["approve"])).toMatchObject({ ok: false, error: { code: "unknown_node" } });
    expect(t.grant("nope", ["approve"])).toMatchObject({ ok: false, error: { code: "unknown_node" } });
    expect(t.detach("nope")).toMatchObject({ ok: false, error: { code: "unknown_node" } });
    expect(t.reattach("nope")).toMatchObject({ ok: false, error: { code: "unknown_node" } });
    expect(t.close("nope")).toMatchObject({ ok: false, error: { code: "unknown_node" } });
    expect(t.grants("nope").size).toBe(0);
  });

  it("ST2.3 grant adds only what the parent holds", () => {
    const t = tree();
    t.spawn("root", "a", "agent", ["observe", "spawn"]);
    t.spawn("a", "b", "agent", []);
    expect(t.grant("b", ["observe"]).ok).toBe(true);
    expect(t.grants("b").has("observe")).toBe(true);
    expect(t.grant("b", ["approve"])).toMatchObject({ ok: false, error: { code: "grant_not_held" } });
    expect(t.grants("b").has("approve")).toBe(false);
  });

  it("ST2.4 the root can be granted new authority from outside the tree", () => {
    const t = tree();
    expect(t.grant("root", ["cap:net"]).ok).toBe(true);
    expect(t.grants("root").has("cap:net")).toBe(true);
  });

  it("ST3.1 holders lists active nodes with the grant, in creation order", () => {
    const t = tree();
    t.spawn("root", "h1", "human", ["approve"]);
    t.spawn("root", "o", "client", ["observe"]);
    t.spawn("root", "h2", "human", ["approve"]);
    expect(t.holders("approve")).toEqual(["root", "h1", "h2"]);
  });

  it("ST3.2 detached nodes hold nothing until reattached", () => {
    const t = tree();
    t.spawn("root", "h1", "human", ["approve"]);
    expect(t.detach("h1").ok).toBe(true);
    expect(t.holders("approve")).toEqual(["root"]);
    expect(t.hasGrant("h1", "approve")).toBe(false);
    expect(t.reattach("h1").ok).toBe(true);
    expect(t.holders("approve")).toEqual(["root", "h1"]);
    expect(t.hasGrant("h1", "approve")).toBe(true);
  });

  it("ST3.3 closing a node closes its whole subtree permanently", () => {
    const t = tree();
    t.spawn("root", "a", "agent", ["spawn", "approve"]);
    t.spawn("a", "b", "agent", ["approve"]);
    expect(t.close("a").ok).toBe(true);
    expect(t.get("a")?.state).toBe("closed");
    expect(t.get("b")?.state).toBe("closed");
    expect(t.reattach("b")).toMatchObject({ ok: false, error: { code: "closed" } });
    expect(t.detach("b")).toMatchObject({ ok: false, error: { code: "closed" } });
    expect(t.holders("approve")).toEqual(["root"]);
  });

  it("ST3.4 children and ancestry are navigable", () => {
    const t = tree();
    t.spawn("root", "a", "agent", ["spawn"]);
    t.spawn("a", "b", "agent", []);
    t.spawn("root", "c", "agent", []);
    expect(t.children("root")).toEqual(["a", "c"]);
    expect(t.children("b")).toEqual([]);
    expect(t.ancestors("b")).toEqual(["a", "root"]);
    expect(t.ancestors("root")).toEqual([]);
  });

  it("ST4.1 the tree round-trips through plain data", () => {
    const t = tree();
    t.spawn("root", "a", "human", ["approve", "spawn"]);
    t.spawn("a", "b", "client", ["approve"]);
    t.detach("b");
    const copy = SubagentTree.fromJSON(JSON.parse(JSON.stringify(t.toJSON())));
    expect(copy.holders("approve")).toEqual(["root", "a"]);
    expect(copy.get("b")).toEqual(t.get("b"));
    expect(copy.children("a")).toEqual(["b"]);
    expect(copy.spawn("a", "c", "agent", ["approve"]).ok).toBe(true);
  });

  it("ST4.2 fromJSON rejects data that violates the grant-subset invariant", () => {
    const data = tree().toJSON();
    const bad = { nodes: [...data.nodes, { id: "x", parent: "root", kind: "agent", state: "active", grants: ["cap:other"] }] };
    expect(() => SubagentTree.fromJSON(bad)).toThrow(/subset/);
  });

  it("ST4.3 fromJSON rejects malformed data", () => {
    expect(() => SubagentTree.fromJSON(null)).toThrow(/invalid/);
    expect(() => SubagentTree.fromJSON({ nodes: "x" })).toThrow(/invalid/);
    expect(() => SubagentTree.fromJSON({ nodes: [{ id: "a", parent: "missing", kind: "agent", state: "active", grants: [] }] })).toThrow(/parent/);
  });
});
