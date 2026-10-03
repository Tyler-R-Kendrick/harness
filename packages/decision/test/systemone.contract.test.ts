import { describe, expect, it } from "vitest";
import { confirmedDifference, hashedEvaluationModel, sampleDifference, systemOneContract } from "@harness/testkit";
import type { SystemOneFixture } from "@harness/testkit";
import { handleModels, handleSystemOne, systemOneError, systemOneInvalidJson, systemOneModels } from "../src/index.ts";

/** The handler on its own, with the routing a host would add. */
export function handlerFixture(): SystemOneFixture {
  const models = systemOneModels([{ id: "hashed-1", model: hashedEvaluationModel("hashed-model"), releaseDate: "2026-09-28" }]);
  return {
    models: ["hashed-1"],
    post: async (path, body) => (path === "/v1/systemone" ? handleSystemOne({ body, models }) : { status: 404, body: { detail: { error_type: "not_found", message: path } } }),
    postRaw: async (path, text) => {
      try {
        return await handleSystemOne({ body: JSON.parse(text) as unknown, models });
      } catch (e) {
        return path === "/v1/systemone" && e instanceof SyntaxError ? systemOneInvalidJson(e.message) : { status: 404, body: {} };
      }
    },
    get: async (path) => (path === "/v1/models" ? handleModels(models) : { status: 404, body: { detail: { error_type: "not_found", message: path } } }),
  };
}

systemOneContract("handleSystemOne over a scripted evaluation model", handlerFixture());

/** A server with only the required part of a fixture: POST, no raw bodies, no model list. */
const { post: minimalPost, models: minimalModels } = handlerFixture();
systemOneContract("a fixture that can only post JSON", { post: minimalPost, models: minimalModels });

/** A server that adds fields of its own, prefixed x_ as the specification asks. */
const plain = handlerFixture();
systemOneContract("handleSystemOne with x_ extensions", {
  ...plain,
  post: async (path, body, headers) => {
    const reply = await plain.post(path, body, headers);
    if (reply.status !== 200) return reply;
    const ok = reply.body as { answers: Record<string, object> };
    return { ...reply, body: { ...ok, x_latency_ms: 3, answers: Object.fromEntries(Object.entries(ok.answers).map(([id, a]) => [id, { ...a, x_note: "extra" }])) } };
  },
});

/** The same handler behind a bearer token and with media types, as a host would serve it. */
function hostedFixture(token: string): SystemOneFixture {
  const inner = handlerFixture();
  const headersOk = (headers?: Readonly<Record<string, string>>): "missing" | "invalid" | "ok" => (headers?.["authorization"] === undefined ? "missing" : headers["authorization"] === `Bearer ${token}` ? "ok" : "invalid");
  const guarded = async (headers: Readonly<Record<string, string>> | undefined, run: () => Promise<{ status: number; body: unknown }>) => {
    const state = headersOk(headers);
    const reply = state === "ok" ? await run() : { ...systemOneError(state === "missing" ? 403 : 401, "authentication_error", "a bearer token is required") };
    return { ...reply, contentType: "application/json; charset=utf-8" };
  };
  return {
    models: inner.models,
    token,
    post: (path, body, headers) => guarded(headers, () => inner.post(path, body, headers)),
    postRaw: (path, text, headers) => guarded(headers, () => inner.postRaw!(path, text, headers)),
    get: (path, headers) => guarded(headers, () => inner.get!(path, headers)),
  };
}

systemOneContract("handleSystemOne behind a bearer token, with media types", hostedFixture("s3cret"));

describe("the contract's sampling rules (jevcompat 7)", () => {
  it("S1C53 a difference within the noise floor of 0.05 is no difference, beyond it the direction is reported", () => {
    expect(sampleDifference([0.5, 0.5, 0.5], [0.54, 0.54, 0.54])).toBe(0);
    expect(sampleDifference([0.5, 0.5, 0.5], [0.6, 0.6, 0.6])).toBe(-1);
    expect(sampleDifference([0.7, 0.7, 0.7], [0.6, 0.6, 0.6])).toBe(1);
  });

  it("S1C54 noisy sends widen the limit to four standard errors", () => {
    expect(sampleDifference([0.1, 0.5, 0.9], [0.3, 0.7, 1])).toBe(0);
    expect(sampleDifference([0.5, 0.5, 0.5], [0.9, 0.9, 0.9])).toBe(-1);
  });

  it("S1C55 a difference counts only when the second round shows it again in the same direction", () => {
    expect(confirmedDifference([1, 0], [1, 0])).toBe(true);
    expect(confirmedDifference([1, 0], [-1, 0])).toBe(false);
    expect(confirmedDifference([1, 0], [0, 1])).toBe(false);
    expect(confirmedDifference([0, 0], [0, 0])).toBe(false);
    expect(confirmedDifference([0, -1], [1, -1])).toBe(true);
  });
});
