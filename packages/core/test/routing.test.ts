import { describe, expect, it } from "vitest";
import { CallbackRouter, SubagentTree } from "@harness/core";

const OPTIONS = [
  { optionId: "allow", kind: "allow_once" },
  { optionId: "deny", kind: "reject_once" },
] as const;

function setup() {
  const tree = new SubagentTree();
  tree.createRoot("root", "agent", ["observe", "control", "approve", "spawn"]);
  tree.spawn("root", "worker", "agent", ["observe"]);
  tree.spawn("root", "alice", "human", ["observe", "approve"]);
  tree.spawn("root", "bob", "human", ["observe", "approve"]);
  tree.spawn("root", "viewer", "client", ["observe"]);
  tree.revoke("root", []);
  const router = new CallbackRouter(tree, { exclude: ["root"] });
  return { tree, router };
}

describe("CallbackRouter", () => {
  it("MX3.1 a request is routed only to active approvers", () => {
    const { router } = setup();
    const r = router.open({ requestId: "r1", from: "worker", options: [...OPTIONS], at: 0 });
    expect(r).toEqual({ ok: true, value: { targets: ["alice", "bob"] } });
  });

  it("MX3.2 the first valid answer wins and a late second answer is rejected", () => {
    const { router } = setup();
    router.open({ requestId: "r1", from: "worker", options: [...OPTIONS], at: 0 });
    expect(router.answer("r1", "alice", { outcome: "selected", optionId: "allow" }, 1)).toEqual({
      ok: true,
      value: { requestId: "r1", by: "alice", outcome: { outcome: "selected", optionId: "allow" }, at: 1 },
    });
    expect(router.answer("r1", "bob", { outcome: "selected", optionId: "deny" }, 2)).toMatchObject({ ok: false, error: { code: "already_resolved" } });
    expect(router.resolution("r1")?.by).toBe("alice");
  });

  it("MX3.3 observers cannot answer", () => {
    const { router } = setup();
    router.open({ requestId: "r1", from: "worker", options: [...OPTIONS], at: 0 });
    expect(router.answer("r1", "viewer", { outcome: "selected", optionId: "allow" }, 1)).toMatchObject({ ok: false, error: { code: "not_authorized" } });
    expect(router.resolution("r1")).toBeUndefined();
  });

  it("MX3.4 the requesting worker cannot approve its own request even with the grant", () => {
    const { tree, router } = setup();
    tree.grant("worker", ["approve"]);
    router.open({ requestId: "r1", from: "worker", options: [...OPTIONS], at: 0 });
    expect(router.pending("r1")?.targets).toEqual(["alice", "bob"]);
    expect(router.answer("r1", "worker", { outcome: "selected", optionId: "allow" }, 1)).toMatchObject({ ok: false, error: { code: "not_authorized" } });
  });

  it("MX3.5 an answer naming an option that was not offered is rejected", () => {
    const { router } = setup();
    router.open({ requestId: "r1", from: "worker", options: [...OPTIONS], at: 0 });
    expect(router.answer("r1", "alice", { outcome: "selected", optionId: "yolo" }, 1)).toMatchObject({ ok: false, error: { code: "invalid_option" } });
  });

  it("MX3.6 answers to unknown requests are rejected", () => {
    const { router } = setup();
    expect(router.answer("nope", "alice", { outcome: "cancelled" }, 1)).toMatchObject({ ok: false, error: { code: "unknown_request" } });
  });

  it("MX3.7 with no approvers attached the request stays pending and is never auto-approved", () => {
    const { tree, router } = setup();
    tree.detach("alice");
    tree.detach("bob");
    expect(router.open({ requestId: "r1", from: "worker", options: [...OPTIONS], at: 0 })).toEqual({ ok: true, value: { targets: [] } });
    expect(router.expire(1_000_000)).toEqual([]);
    expect(router.resolution("r1")).toBeUndefined();
    expect(router.pending("r1")).toBeDefined();
  });

  it("MX3.8 an approver that attaches later sees pending requests", () => {
    const { tree, router } = setup();
    tree.detach("alice");
    tree.detach("bob");
    router.open({ requestId: "r1", from: "worker", options: [...OPTIONS], at: 0 });
    tree.reattach("bob");
    expect(router.pendingFor("bob")).toEqual(["r1"]);
    expect(router.pendingFor("viewer")).toEqual([]);
    expect(router.answer("r1", "bob", { outcome: "selected", optionId: "deny" }, 5).ok).toBe(true);
    expect(router.pendingFor("bob")).toEqual([]);
  });

  it("MX3.9 a detached approver cannot answer", () => {
    const { tree, router } = setup();
    router.open({ requestId: "r1", from: "worker", options: [...OPTIONS], at: 0 });
    tree.detach("alice");
    expect(router.answer("r1", "alice", { outcome: "selected", optionId: "allow" }, 1)).toMatchObject({ ok: false, error: { code: "not_authorized" } });
  });

  it("MX3.10 cancelling resolves the request as cancelled and blocks later answers", () => {
    const { router } = setup();
    router.open({ requestId: "r1", from: "worker", options: [...OPTIONS], at: 0 });
    expect(router.cancel("r1", 3)).toMatchObject({ ok: true, value: { by: "system", outcome: { outcome: "cancelled" } } });
    expect(router.answer("r1", "alice", { outcome: "selected", optionId: "allow" }, 4)).toMatchObject({ ok: false, error: { code: "already_resolved" } });
    expect(router.cancel("r1", 5)).toMatchObject({ ok: false, error: { code: "already_resolved" } });
    expect(router.cancel("nope", 5)).toMatchObject({ ok: false, error: { code: "unknown_request" } });
  });

  it("MX3.11 requests past their deadline resolve as cancelled", () => {
    const { router } = setup();
    router.open({ requestId: "r1", from: "worker", options: [...OPTIONS], at: 0, deadline: 100 });
    router.open({ requestId: "r2", from: "worker", options: [...OPTIONS], at: 0, deadline: 200 });
    expect(router.expire(99)).toEqual([]);
    const expired = router.expire(100);
    expect(expired.map((r) => r.requestId)).toEqual(["r1"]);
    expect(expired[0]).toMatchObject({ by: "system", outcome: { outcome: "cancelled" }, at: 100 });
    expect(router.pending("r2")).toBeDefined();
  });

  it("MX3.12 duplicate request ids are rejected", () => {
    const { router } = setup();
    router.open({ requestId: "r1", from: "worker", options: [...OPTIONS], at: 0 });
    expect(router.open({ requestId: "r1", from: "worker", options: [...OPTIONS], at: 1 })).toMatchObject({ ok: false, error: { code: "duplicate_request" } });
  });

  it("MX3.13 an explicit cancelled answer from an approver resolves the request", () => {
    const { router } = setup();
    router.open({ requestId: "r1", from: "worker", options: [...OPTIONS], at: 0 });
    expect(router.answer("r1", "bob", { outcome: "cancelled" }, 2)).toMatchObject({ ok: true, value: { by: "bob" } });
  });
});
