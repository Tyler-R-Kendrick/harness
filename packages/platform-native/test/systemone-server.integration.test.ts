import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import type { Experimental_EvaluationModelV4 as EvaluationModelV4 } from "@ai-sdk/provider";
import { experimental_evaluate } from "ai";
import { bytes, Ensemble } from "@harness/cognitive";
import { ensembleSystemOneModels, systemOneModels } from "@harness/decision";
import type { SystemOneModels } from "@harness/decision";
import { typesafeApiEvaluationModel } from "@harness/models";
import { hashedEvaluationModel, scriptedJudge, systemOneContract } from "@harness/testkit";
import type { SystemOneWireReply } from "@harness/testkit";
import { serveSystemOne } from "../src/systemone-server.ts";
import type { SystemOneServer, SystemOneServerOptions } from "../src/systemone-server.ts";

const TOKEN = "correct horse battery staple";

/** A model with fixed answers, so that what a client parses can be asserted. */
const fixed: EvaluationModelV4 = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "fixed",
  supportedQuestionTypes: ["boolean", "choice", "score"],
  async doEvaluate({ questions }) {
    const answers = Object.fromEntries(
      Object.entries(questions).map(([id, q]) => [
        id,
        q.type === "boolean"
          ? { type: "boolean" as const, probability: 0.9 }
          : q.type === "choice"
            ? { type: "choice" as const, choice: "billing", probabilities: { billing: 0.7, sales: 0.2, support: 0.1 } }
            : { type: "score" as const, score: 1.2, probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 } },
      ]),
    );
    return { answers, warnings: [], usage: { inputTokens: 40, outputTokens: 6 } };
  },
};

const served = (model: EvaluationModelV4 = fixed): SystemOneModels => systemOneModels([{ id: "test-1", model, releaseDate: "2026-09-28" }]);

const running: SystemOneServer[] = [];
async function start(options: Partial<SystemOneServerOptions> = {}): Promise<SystemOneServer> {
  const server = await serveSystemOne({ models: served(), port: 0, ...options });
  running.push(server);
  return server;
}
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

const questions = {
  urgent: { type: "noul", instructions: "Urgent?" },
  team: { type: "choice", instructions: "Which team?", criteria: { billing: "Charges", sales: null, support: "Help" } },
  anger: { type: "score", instructions: "How angry?", criteria: ["Calm", "Frustrated", "Very angry"] },
};
const valid = { model: "jev-latest", state: "I was charged twice", questions };
const json = { "content-type": "application/json" };

// ---- the wire contract, over fetch --------------------------------------------------------------

function fetchFixture(serverOf: () => SystemOneServer, token?: string) {
  const reply = async (res: Response): Promise<SystemOneWireReply> => {
    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? undefined;
    return { status: res.status, body: text === "" ? undefined : JSON.parse(text), ...(contentType === undefined ? {} : { contentType }) };
  };
  return {
    models: ["test-1"],
    ...(token === undefined ? {} : { token }),
    post: async (path: string, body: unknown, headers: Readonly<Record<string, string>> = {}) => reply(await fetch(`${serverOf().url}${path}`, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body) })),
    postRaw: async (path: string, text: string, headers: Readonly<Record<string, string>> = {}) => reply(await fetch(`${serverOf().url}${path}`, { method: "POST", headers: { ...json, ...headers }, body: text })),
    get: async (path: string, headers: Readonly<Record<string, string>> = {}) => reply(await fetch(`${serverOf().url}${path}`, { headers })),
  };
}

describe("the System One HTTP server", () => {
  let open: SystemOneServer;
  let guarded: SystemOneServer;
  beforeAll(async () => {
    open = await serveSystemOne({ models: systemOneModels([{ id: "test-1", model: hashedEvaluationModel(), releaseDate: "2026-09-28" }]), port: 0 });
    guarded = await serveSystemOne({ models: systemOneModels([{ id: "test-1", model: hashedEvaluationModel() }]), port: 0, token: TOKEN });
  });
  afterAll(async () => {
    await Promise.all([open.close(), guarded.close()]);
  });

  systemOneContract("over HTTP without authentication", fetchFixture(() => open));
  systemOneContract("over HTTP with a bearer token", fetchFixture(() => guarded, TOKEN));
});

// ---- TypeSafe's own AI SDK provider as the client ----------------------------------------------------

describe("the System One server with TypeSafe's client (@ai-sdk/typesafe-ai through typesafeApiEvaluationModel)", () => {
  const ask = (server: SystemOneServer, apiKey?: string, model = "jev-latest") =>
    experimental_evaluate({
      model: typesafeApiEvaluationModel({ baseUrl: server.url, model, ...(apiKey === undefined ? {} : { apiKey }) }),
      state: "I was charged twice",
      maxRetries: 0,
      questions: {
        refund: { type: "boolean", instructions: "Does the customer want money back?" },
        team: { type: "choice", instructions: "Which team?", criteria: { billing: "Charges", sales: null, support: "Help" } },
        anger: { type: "score", instructions: "How angry?", criteria: ["Calm", "Frustrated", "Very angry"] },
      },
    });

  it("S1H3.1 boolean, choice and score answers parse: the client sees P(true), the choice, the level probabilities and the score", async () => {
    const result = await ask(await start());
    expect(result.answers.refund.probability).toBe(0.9);
    expect(result.answers.team.choice).toBe("billing");
    expect(result.answers.team.probabilities).toEqual({ billing: 0.7, sales: 0.2, support: 0.1 });
    expect(result.answers.anger.score).toBeCloseTo(1.2, 12);
    expect(result.answers.anger.probabilities).toEqual({ "0": 0.1, "1": 0.6, "2": 0.3 });
  });

  it("S1H3.2 the confidence the client reads is derived from the probabilities", async () => {
    const result = await ask(await start());
    const confidence = (result.providerMetadata as { typesafe: { confidence: Record<string, number> } }).typesafe.confidence;
    expect(confidence["team"]).toBeCloseTo((3 * 0.7 - 1) / 2, 12);
    expect(confidence["anger"]).toBeCloseTo(1 - 0.4 / (2 / 3), 12);
    expect(confidence).not.toHaveProperty("refund");
  });

  it("S1H3.3 the alias jev-latest resolves to the served model, which the client reports, with integer usage", async () => {
    const result = await ask(await start());
    expect(result.response.modelId).toBe("test-1");
    expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 18 });
  });

  it("S1H3.4 the served model can be asked for by its id", async () => {
    expect((await ask(await start(), undefined, "test-1")).response.modelId).toBe("test-1");
  });

  it("S1H3.5 with a token the client's API key is the bearer token; a wrong key is an API error with status 401", async () => {
    const server = await start({ token: TOKEN });
    expect((await ask(server, TOKEN)).answers.team.choice).toBe("billing");
    const wrong = await ask(server, "wrong").catch((e: unknown) => e);
    expect(APICallError.isInstance(wrong)).toBe(true);
    expect((wrong as APICallError).statusCode).toBe(401);
    expect((wrong as APICallError).message).toContain("authentication_error");
  });

  it("S1H3.6 a model that fails is an API error with status 502 and the reason", async () => {
    const failing: EvaluationModelV4 = { ...fixed, doEvaluate: async () => Promise.reject(new Error("weights offline")) };
    const error = await ask(await start({ models: served(failing) })).catch((e: unknown) => e);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).statusCode).toBe(502);
    expect((error as APICallError).message).toContain("weights offline");
  });

  it("S1H3.8 the harness's own ensemble is a System One provider: the client is told which member answered", async () => {
    const ensemble = new Ensemble({ platform: "native" });
    ensemble.register(
      { id: "judge-x", name: "judge-x", publisher: "t", tasks: ["judgment"], ports: ["judge"], locality: "local", runtime: "transformers.js", run: { dtype: "q4" }, platforms: ["native"], license: "MIT", downloadBytes: bytes(1), benchmarks: [] },
      async () => ({ judge: scriptedJudge((_, q) => (q.type === "boolean" ? { type: "boolean", probability: 0.75 } : undefined)) }),
    );
    const server = await start({ models: ensembleSystemOneModels(ensemble) });
    const result = await ask(server, undefined, "jev-latest");
    expect(result.response.modelId).toBe("judge-x");
    expect(result.answers.refund.probability).toBe(0.75);
    expect(result.answers.team.choice).toBe("billing");
    expect((await fetch(`${server.url}/v1/models`).then((r) => r.json())) as unknown).toMatchObject({ models: [{ name: "harness-ensemble" }] });
  });

  it("S1H3.7 an unknown model is an API error with status 404", async () => {
    const error = await ask(await start(), undefined, "other-9").catch((e: unknown) => e);
    expect((error as APICallError).statusCode).toBe(404);
  });
});

// ---- raw HTTP ------------------------------------------------------------------------------------------

interface Raw {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
}
function raw(server: SystemOneServer, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${server.url}${options.path ?? "/v1/systemone"}`, { method: options.method ?? "POST", headers: options.headers ?? json, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    // A string body would be joined to the headers and encoded with them as UTF-8; bytes keep the headers as written.
    req.end(typeof options.body === "string" ? Buffer.from(options.body) : options.body);
  });
}
const detail = (r: Raw) => (JSON.parse(r.text) as { detail: Record<string, unknown> | { loc: unknown[]; msg: string; type: string }[] }).detail;

describe("the System One server: authentication", () => {
  it("S1H4.1 with a token a request without one is a 401 with a JSON authentication_error and a challenge", async () => {
    const server = await start({ token: TOKEN });
    const r = await raw(server, { body: JSON.stringify(valid) });
    expect(r.status).toBe(401);
    expect(r.headers["www-authenticate"]).toBe("Bearer");
    expect(r.headers["content-type"]).toMatch(/^application\/json/);
    expect(detail(r)).toEqual({ error_type: "authentication_error", message: expect.any(String) });
  });

  it("S1H4.2 a wrong token, a wrong scheme, a token with the wrong length and an empty bearer are all 401", async () => {
    const server = await start({ token: TOKEN });
    for (const authorization of ["Bearer nope", `Basic ${TOKEN}`, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, "Bearer ", "Bearer", TOKEN, `Bearer ${TOKEN.toUpperCase()}`]) {
      expect((await raw(server, { headers: { ...json, authorization }, body: JSON.stringify(valid) })).status, authorization).toBe(401);
    }
  });

  it("S1H4.3 the right token is accepted, and the scheme is not case sensitive", async () => {
    const server = await start({ token: TOKEN });
    for (const authorization of [`Bearer ${TOKEN}`, `bearer ${TOKEN}`, `BEARER   ${TOKEN}`]) {
      expect((await raw(server, { headers: { ...json, authorization }, body: JSON.stringify(valid) })).status, authorization).toBe(200);
    }
  });

  it("S1H4.4 a token with non-ASCII characters works, and one that differs only in bytes does not", async () => {
    const server = await start({ token: "pässwörd-🙂" });
    const post = (authorization: string) => raw(server, { headers: { ...json, authorization: Buffer.from(authorization, "utf8").toString("latin1") }, body: JSON.stringify(valid) });
    expect((await post("Bearer pässwörd-🙂")).status).toBe(200);
    expect((await post("Bearer passwörd-🙂")).status).toBe(401);
  });

  it("S1H4.5 every path needs the token, so an unknown one does not show that it is unknown", async () => {
    const server = await start({ token: TOKEN });
    expect((await raw(server, { method: "GET", path: "/nope", headers: {} })).status).toBe(401);
    expect((await raw(server, { method: "GET", path: "/v1/models", headers: {} })).status).toBe(401);
    expect((await raw(server, { method: "GET", path: "/v1/models", headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  it("S1H4.6 a non-loopback address is served with a token", async () => {
    const server = await start({ host: "0.0.0.0", token: TOKEN });
    const url = server.url.replace("0.0.0.0", "127.0.0.1");
    const res = await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
  });

  it("S1H4.7 without a token only a loopback Host is answered, so DNS rebinding cannot reach it", async () => {
    const server = await start();
    for (const host of ["evil.example", "evil.example:80", "127.0.0.1.evil.example", "10.0.0.5"]) {
      const r = await raw(server, { headers: { ...json, host }, body: JSON.stringify(valid) });
      expect(r.status, host).toBe(403);
      expect(detail(r)).toEqual({ error_type: "forbidden_host", message: expect.any(String) });
    }
    const port = new URL(server.url).port;
    for (const host of ["localhost", `localhost:${port}`, `127.0.0.1:${port}`, `127.9.9.9`, `[::1]:${port}`]) {
      expect((await raw(server, { headers: { ...json, host }, body: JSON.stringify(valid) })).status, host).toBe(200);
    }
  });

  it("S1H4.8 with a token the Host does not matter", async () => {
    const server = await start({ token: TOKEN });
    expect((await raw(server, { headers: { ...json, host: "proxy.internal", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(valid) })).status).toBe(200);
  });
});

describe("the System One server: routes", () => {
  it("S1H5.1 GET /v1/models lists the served models", async () => {
    const server = await start();
    const r = await raw(server, { method: "GET", path: "/v1/models", headers: {} });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ models: [{ name: "test-1", description: "test-1", release_date: "2026-09-28" }] });
  });

  it("S1H5.2 an unknown path is a 404, and a trailing slash is another path", async () => {
    const server = await start();
    for (const path of ["/", "/v1", "/v1/systemone/", "/v2/systemone", "/v1/models/x", "/V1/systemone"]) {
      const r = await raw(server, { path, body: "{}" });
      expect(r.status, path).toBe(404);
      expect(detail(r)).toEqual({ error_type: "not_found", message: expect.stringContaining(path) });
    }
  });

  it("S1H5.3 the wrong method is a 405 with Allow", async () => {
    const server = await start();
    for (const method of ["GET", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const r = await raw(server, { method, headers: json });
      expect(r.status, method).toBe(405);
      expect(r.headers["allow"]).toBe("POST");
    }
    for (const method of ["POST", "PUT", "DELETE"]) {
      const r = await raw(server, { method, path: "/v1/models", headers: json, body: "{}" });
      expect(r.status, method).toBe(405);
      expect(r.headers["allow"]).toBe("GET");
    }
  });

  it("S1H5.4 a query string is ignored", async () => {
    const server = await start();
    expect((await raw(server, { path: "/v1/systemone?trace=1", body: JSON.stringify(valid) })).status).toBe(200);
    expect((await raw(server, { method: "GET", path: "/v1/models?x=y", headers: {} })).status).toBe(200);
  });

  it("S1H5.5 there are no CORS headers: a web page on another origin cannot read an answer", async () => {
    const server = await start();
    const r = await raw(server, { headers: { ...json, origin: "https://evil.example" }, body: JSON.stringify(valid) });
    expect(Object.keys(r.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    const preflight = await raw(server, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(preflight.status).toBe(405);
  });

  it("S1H5.6 every answer is JSON, not cached, and not sniffable", async () => {
    const server = await start();
    for (const r of [await raw(server, { body: JSON.stringify(valid) }), await raw(server, { path: "/nope" }), await raw(server, { body: "{" })]) {
      expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(Number(r.headers["content-length"])).toBe(Buffer.byteLength(r.text));
    }
  });

  it("S1H5.7 many requests at once are all answered", async () => {
    const server = await start({ maxInFlight: 24 });
    const replies = await Promise.all(Array.from({ length: 24 }, () => raw(server, { body: JSON.stringify(valid) })));
    expect(replies.map((r) => r.status)).toEqual(Array.from({ length: 24 }, () => 200));
  });

  it("S1H5.8 the limits on questions and concurrency are passed to the handler", async () => {
    const server = await start({ maxQuestions: 2 });
    const r = await raw(server, { body: JSON.stringify(valid) });
    expect(r.status).toBe(422);
    expect(r.text).toContain("at most 2 questions");
  });
});

describe("the System One server: request bodies", () => {
  it("S1H6.1 a body over the limit is a 413 by its declared length, answered without reading it", async () => {
    const server = await start({ maxBodyBytes: 1024 });
    const socket = connect({ host: "127.0.0.1", port: Number(new URL(server.url).port) });
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.write(`POST /v1/systemone HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: 10000000000\r\n\r\n`);
    await closed;
    const text = Buffer.concat(chunks).toString("utf8");
    expect(text).toMatch(/^HTTP\/1\.1 413 /);
    expect(text.toLowerCase()).toContain("connection: close");
    expect(text).toContain("payload_too_large");
  });

  it("S1H6.2 a body that grows past the limit while it is being read is a 413 too, whatever it declared", async () => {
    const server = await start({ maxBodyBytes: 1024 });
    const big = JSON.stringify({ ...valid, state: "x".repeat(4096) });
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < big.length; i += 500) controller.enqueue(new TextEncoder().encode(big.slice(i, i + 500)));
        controller.close();
      },
    });
    const res = await fetch(`${server.url}/v1/systemone`, { method: "POST", headers: json, body: chunked, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { detail: { error_type: string } }).detail.error_type).toBe("payload_too_large");
  });

  it("S1H6.3 a body over the limit sent whole is a 413 and the server goes on serving", async () => {
    const server = await start({ maxBodyBytes: 2048 });
    const big = await fetch(`${server.url}/v1/systemone`, { method: "POST", headers: json, body: JSON.stringify({ ...valid, state: "y".repeat(100_000) }) });
    expect(big.status).toBe(413);
    expect((await raw(server, { body: JSON.stringify(valid) })).status).toBe(200);
  });

  it("S1H6.6 a body many times the limit is still answered with the 413, and the server is not stopped by it", async () => {
    const server = await start({ maxBodyBytes: 1024 });
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${server.url}/v1/systemone`, { method: "POST", headers: json, body: Buffer.alloc(16 * 1024 * 1024, 0x61) });
      expect(res.status).toBe(413);
    }
    expect((await raw(server, { body: JSON.stringify(valid) })).status).toBe(200);
  });

  it("S1H6.4 a body of exactly the limit is accepted and one byte more is not", async () => {
    const server = await start({ maxBodyBytes: 600 });
    const base = JSON.stringify({ model: "jev-latest", state: "", questions: { u: { type: "noul" } } });
    const fill = 600 - Buffer.byteLength(base);
    const exact = JSON.stringify({ model: "jev-latest", state: "s".repeat(fill), questions: { u: { type: "noul" } } });
    expect(Buffer.byteLength(exact)).toBe(600);
    expect((await raw(server, { body: exact, headers: { ...json, "content-length": "600" } })).status).toBe(200);
    expect((await raw(server, { body: `${exact} ` })).status).toBe(413);
  });

  it("S1H6.5 the default limit is 1 MiB", async () => {
    const server = await start();
    const state = "z".repeat(1024 * 1024 - 200);
    expect((await raw(server, { body: JSON.stringify({ model: "jev-latest", state, questions: { u: { type: "noul" } } }) })).status).toBe(200);
    expect((await raw(server, { body: JSON.stringify({ model: "jev-latest", state: state + "z".repeat(400), questions: { u: { type: "noul" } } }) })).status).toBe(413);
  });

  it("S1H7.1 a body that is not JSON is a 415 when it says so and a 422 in the validation shape when it says JSON", async () => {
    const server = await start();
    for (const headers of [{ "content-type": "text/plain" }, { "content-type": "application/x-www-form-urlencoded" }, { "content-type": "multipart/form-data; boundary=x" }, {}, { "content-type": "application/jsonx" }, { "content-type": "text/json" }]) {
      const r = await raw(server, { headers, body: JSON.stringify(valid) });
      expect(r.status, JSON.stringify(headers)).toBe(415);
      expect(detail(r)).toEqual({ error_type: "unsupported_media_type", message: expect.any(String) });
    }
  });

  it("S1H7.2 application/json with parameters, other cases, and +json types are accepted", async () => {
    const server = await start();
    for (const type of ["application/json; charset=utf-8", "APPLICATION/JSON", "application/json;charset=UTF-8", "application/vnd.api+json", "application/problem+json ; x=y"]) {
      expect((await raw(server, { headers: { "content-type": type }, body: JSON.stringify(valid) })).status, type).toBe(200);
    }
  });

  it("S1H7.3 text that is not JSON, and an empty body, are 422 with detail located at the body", async () => {
    const server = await start();
    for (const body of ["{ not json", "", "undefined", "{\"a\":1}}", "[1,"]) {
      const r = await raw(server, { body });
      expect(r.status, body).toBe(422);
      expect(detail(r)).toEqual([{ loc: ["body"], msg: expect.any(String), type: "json_invalid" }]);
    }
  });

  it("S1H7.4 bytes that are not UTF-8 are a 422, not a mangled request", async () => {
    const server = await start();
    const bad = Buffer.concat([Buffer.from('{"model":"jev-latest","state":"'), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from('","questions":{"u":{"type":"noul"}}}')]);
    const r = await raw(server, { body: bad });
    expect(r.status).toBe(422);
    expect(detail(r)).toEqual([{ loc: ["body"], msg: expect.stringContaining("UTF-8"), type: "json_invalid" }]);
  });

  it("S1H7.5 JSON that is not a valid request is the handler's 422 with located problems", async () => {
    const server = await start();
    const r = await raw(server, { body: JSON.stringify({ model: "jev-latest", state: "s", questions: { q: { type: "boolean" } } }) });
    expect(r.status).toBe(422);
    expect((detail(r) as { loc: unknown[] }[])[0]!.loc).toEqual(["body", "questions", "q", "type"]);
  });

  it("S1H7.6 non-ASCII text round-trips through the wire byte for byte", async () => {
    const server = await start({ models: served(hashedEvaluationModel()) });
    const body = JSON.stringify({ model: "jev-latest", state: "요금 🙂", questions: { 팀: { type: "choice", instructions: "어느 팀?", criteria: { 청구: null, "판매 🙂": null } } } });
    const r = await raw(server, { body });
    expect(r.status).toBe(200);
    expect(Object.keys((JSON.parse(r.text) as { answers: Record<string, { probabilities: object }> }).answers["팀"]!.probabilities)).toEqual(["청구", "판매 🙂"]);
  });
});

describe("the System One server: bad clients", () => {
  it("S1H8.1 bytes that are not HTTP are refused and the server goes on serving", async () => {
    const server = await start();
    const port = Number(new URL(server.url).port);
    for (const junk of [Buffer.from("this is not http\r\n\r\n"), Buffer.from([0, 1, 2, 3, 255, 254, 253, 10, 13, 10, 13, 10]), Buffer.from("POST /v1/systemone HTTP/1.1\r\ncontent-length: -5\r\n\r\n")]) {
      const socket = connect({ host: "127.0.0.1", port });
      const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
      socket.on("error", () => {});
      socket.resume();
      socket.write(junk);
      await closed;
    }
    expect((await raw(server, { body: JSON.stringify(valid) })).status).toBe(200);
  });

  it("S1H8.2 a client that hangs up in the middle of its body does not disturb the server", async () => {
    const server = await start();
    const port = Number(new URL(server.url).port);
    const socket = connect({ host: "127.0.0.1", port });
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.write(`POST /v1/systemone HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: 500\r\n\r\n{"model":`);
    await new Promise((r) => setTimeout(r, 30));
    socket.destroy();
    await closed;
    expect((await raw(server, { body: JSON.stringify(valid) })).status).toBe(200);
  });

  it("S1H8.3 a model that fails is a 502 and the next request is answered", async () => {
    let calls = 0;
    const flaky: EvaluationModelV4 = { ...fixed, doEvaluate: async (o) => (++calls === 1 ? Promise.reject(new Error("first call fails")) : fixed.doEvaluate(o)) };
    const server = await start({ models: served(flaky) });
    const first = await raw(server, { body: JSON.stringify(valid) });
    expect(first.status).toBe(502);
    expect(detail(first)).toEqual({ error_type: "upstream_error", message: "first call fails" });
    expect((await raw(server, { body: JSON.stringify(valid) })).status).toBe(200);
  });

  it("S1H8.4 a failure of the server's own is a 500 that says nothing of it, is logged, and does not stop the server", async () => {
    const lines: string[] = [];
    const broken: SystemOneModels = {
      resolve: served().resolve,
      list: () => {
        throw new Error("secret internal detail");
      },
    };
    const server = await start({ models: broken, log: (m) => lines.push(m) });
    const r = await raw(server, { method: "GET", path: "/v1/models", headers: {} });
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("secret");
    expect(detail(r)).toEqual({ error_type: "internal_error", message: expect.any(String) });
    expect(lines.some((l) => l.includes("GET /v1/models failed: secret internal detail"))).toBe(true);
    expect((await raw(server, { body: JSON.stringify(valid) })).status).toBe(200);
  });
});

describe("the System One server: logging", () => {
  it("S1H9.1 one line per request with the method, path, status and time, and never a token or a body", async () => {
    const lines: string[] = [];
    const server = await start({ token: TOKEN, log: (m) => lines.push(m) });
    await raw(server, { path: "/v1/systemone?secret=1", headers: { ...json, authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ ...valid, state: "PRIVATE-STATE" }) });
    await raw(server, { path: "/v1/systemone", body: "{}" });
    await new Promise((r) => setTimeout(r, 20));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^POST \/v1\/systemone 200 \d+ms$/);
    expect(lines[1]).toMatch(/^POST \/v1\/systemone 401 \d+ms$/);
    expect(lines.join("\n")).not.toMatch(/PRIVATE|secret|correct horse/);
  });

  it("S1H9.3 a failure that is not an Error is logged by its text", async () => {
    const lines: string[] = [];
    const broken: SystemOneModels = {
      resolve: served().resolve,
      list: () => {
        throw "plain text failure"; // a library that throws a string
      },
    };
    const server = await start({ models: broken, log: (m) => lines.push(m) });
    expect((await raw(server, { method: "GET", path: "/v1/models", headers: {} })).status).toBe(500);
    expect(lines.some((l) => l.endsWith("failed: plain text failure"))).toBe(true);
  });

  it("S1H9.2 without a log function nothing is written and nothing fails", async () => {
    expect((await raw(await start(), { body: JSON.stringify(valid) })).status).toBe(200);
  });
});

describe("the System One server: starting and closing", () => {
  it("S1H10.1 port 0 takes a free port on loopback, and each server gets its own", async () => {
    const [a, b] = [await start(), await start()];
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(a.url).not.toBe(b.url);
  });

  it("S1H10.2 a port that is taken is an error at start", async () => {
    const first = await start();
    await expect(serveSystemOne({ models: served(), port: Number(new URL(first.url).port) })).rejects.toThrow(/EADDRINUSE/);
  });

  it("S1H10.3 close stops listening: the port refuses connections afterwards", async () => {
    const server = await serveSystemOne({ models: served(), port: 0 });
    const port = Number(new URL(server.url).port);
    expect((await raw(server, { body: JSON.stringify(valid) })).status).toBe(200);
    await server.close();
    await expect(new Promise((resolve, reject) => connect({ host: "127.0.0.1", port }).on("connect", resolve).on("error", reject))).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("S1H10.4 close ends connections that are open, and closing twice is fine", async () => {
    const server = await serveSystemOne({ models: served(), port: 0 });
    const socket = connect({ host: "127.0.0.1", port: Number(new URL(server.url).port) });
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    await server.close();
    await closed;
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("S1H10.5 close ends a request that is still being answered, and does not wait for the model", async () => {
    let started!: () => void;
    const begun = new Promise<void>((resolve) => (started = resolve));
    const slow: EvaluationModelV4 = {
      ...fixed,
      doEvaluate: async () => {
        started();
        return new Promise(() => {});
      },
    };
    const server = await serveSystemOne({ models: served(slow), port: 0 });
    const pending = fetch(`${server.url}/v1/systemone`, { method: "POST", headers: json, body: JSON.stringify(valid) }).then(
      () => "answered",
      () => "ended",
    );
    await begun;
    await server.close();
    expect(await pending).toBe("ended");
  });

  it("S1H10.6 a keep-alive connection serves several requests", async () => {
    const server = await start();
    for (let i = 0; i < 3; i++) expect((await fetch(`${server.url}/v1/models`)).status).toBe(200);
  });
});

describe("the System One server: load", () => {
  /** A model that holds every call until `release`, and records the signal each call was given. */
  function held() {
    const signals: (AbortSignal | undefined)[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let began!: () => void;
    let begun = new Promise<void>((resolve) => (began = resolve));
    const model: EvaluationModelV4 = {
      ...fixed,
      doEvaluate: async (options) => {
        signals.push(options.abortSignal);
        began();
        await new Promise<void>((resolve) => {
          gate.then(resolve);
          options.abortSignal?.addEventListener("abort", () => resolve());
        });
        return fixed.doEvaluate(options);
      },
    };
    return { model, signals, release, begun: () => begun, rearm: () => (begun = new Promise<void>((resolve) => (began = resolve))) };
  }
  const post = (server: SystemOneServer) => raw(server, { body: JSON.stringify(valid) });

  it("S1H11.1 a client that hangs up aborts the model call that is running for it", async () => {
    const h = held();
    const server = await start({ models: served(h.model) });
    const socket = connect({ host: "127.0.0.1", port: Number(new URL(server.url).port) });
    socket.on("error", () => {});
    const body = JSON.stringify(valid);
    socket.write(`POST /v1/systemone HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await h.begun();
    expect(h.signals[0]?.aborted).toBe(false);
    socket.destroy();
    await vi.waitFor(() => expect(h.signals[0]?.aborted).toBe(true));
  });

  it("S1H11.2 a request that was answered does not abort anything afterwards", async () => {
    const h = held();
    const server = await start({ models: served(h.model) });
    const pending = post(server);
    await h.begun();
    h.release();
    expect((await pending).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.signals.map((s) => s?.aborted)).toEqual([false, false, false]);
  });

  it("S1H11.3 with the requests in flight at the cap, the next is a 503 with Retry-After, and a slot freed is taken again", async () => {
    const h = held();
    const server = await start({ models: served(h.model), maxInFlight: 2 });
    const first = [post(server), post(server)];
    await h.begun();
    await vi.waitFor(() => expect(h.signals.length).toBeGreaterThanOrEqual(2));
    const refused = await post(server);
    expect(refused.status).toBe(503);
    expect(refused.headers["retry-after"]).toBe("1");
    expect(detail(refused)).toEqual({ error_type: "overloaded", message: expect.any(String) });
    h.release();
    expect((await Promise.all(first)).map((r) => r.status)).toEqual([200, 200]);
    expect((await post(server)).status).toBe(200);
  });

  it("S1H11.4 a request that fails or is cut short gives its slot back", async () => {
    const failing: EvaluationModelV4 = {
      ...fixed,
      doEvaluate: async () => {
        throw new Error("model down");
      },
    };
    const server = await start({ models: served(failing), maxInFlight: 1 });
    for (let i = 0; i < 3; i++) expect((await post(server)).status).toBe(502);
  });

  it("S1H11.5 requests that are not model calls are not counted against the cap", async () => {
    const h = held();
    const server = await start({ models: served(h.model), maxInFlight: 1 });
    const first = post(server);
    await h.begun();
    expect((await raw(server, { method: "GET", path: "/v1/models" })).status).toBe(200);
    expect((await raw(server, { body: "{" })).status).toBe(422);
    h.release();
    expect((await first).status).toBe(200);
  });

  it("S1H11.6 the cap and the connection limit must be positive whole numbers", async () => {
    for (const maxInFlight of [0, -1, 1.5, Number.NaN]) await expect(serveSystemOne({ models: served(), port: 0, maxInFlight })).rejects.toThrow(/maxInFlight must be a positive whole number/);
    for (const maxConnections of [0, -1, 1.5, Number.NaN]) await expect(serveSystemOne({ models: served(), port: 0, maxConnections })).rejects.toThrow(/maxConnections must be a positive whole number/);
  });

  it("S1H11.7 connections past the limit are closed, and one that ends makes room", async () => {
    const server = await start({ maxConnections: 1 });
    const port = Number(new URL(server.url).port);
    const open = connect({ host: "127.0.0.1", port });
    open.on("error", () => {});
    await new Promise<void>((resolve) => open.on("connect", () => resolve()));
    const extra = connect({ host: "127.0.0.1", port });
    extra.on("error", () => {});
    extra.resume();
    await new Promise<void>((resolve) => extra.on("close", () => resolve()));
    const gone = new Promise<void>((resolve) => open.on("close", () => resolve()));
    open.destroy();
    await gone;
    await vi.waitFor(async () => expect((await raw(server, { body: JSON.stringify(valid) })).status).toBe(200));
  });
});
