import { describe, expect, it } from "vitest";
import type { Experimental_EvaluationModelV4 as EvaluationModelV4, Experimental_EvaluationModelV4Answer as ModelAnswer, Experimental_EvaluationModelV4Question as ModelQuestion } from "@ai-sdk/provider";

/**
 * The System One wire contract: the requirements of the `jevcompat` specification 0.1
 * (github.com/mandu5/jevcompat, SPEC.md) that a server must meet to be a drop-in
 * replacement for TypeSafe's `POST /v1/systemone`, written as a suite that runs against
 * any implementation: the handler on its own (`handleSystemOne`) and a real HTTP server.
 *
 * Each test is named by the rule it checks (`request.state`, `choice.argmax`, ...). MUSTs
 * are tests of their own; SHOULDs are tests whose names say SHOULD. Comparisons allow for
 * the rounding a response shows (spec section 5). Semantic comparisons (section 7) send
 * each request three times and compare means, and a difference counts only when a second
 * round shows it again in the same direction.
 */

/** What a server answered: the status, the JSON body, and the media type when the transport has one. */
export interface SystemOneWireReply {
  readonly status: number;
  readonly body: unknown;
  readonly contentType?: string;
}

export interface SystemOneFixture {
  /** POSTs `body` as JSON to `path` (e.g. `/v1/systemone`). */
  post(path: string, body: unknown, headers?: Readonly<Record<string, string>>): Promise<SystemOneWireReply>;
  /** POSTs `text` as it is, declared as JSON: for bodies that are not JSON. Without it those rules are not tested. */
  postRaw?(path: string, text: string, headers?: Readonly<Record<string, string>>): Promise<SystemOneWireReply>;
  /** GETs `path`. Without it `GET /v1/models` is not tested. */
  get?(path: string, headers?: Readonly<Record<string, string>>): Promise<SystemOneWireReply>;
  /** The model ids the server serves (besides the alias `jev-latest`). */
  readonly models: readonly string[];
  /** The bearer token the server requires; without it the server runs without authentication. */
  readonly token?: string;
}

type Json = Record<string, unknown>;
const PATH = "/v1/systemone";
const ALIAS = "jev-latest";
const SLACK = 1e-9;

const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const obj = (x: unknown): Json => {
  expect(isObject(x), `expected a JSON object, got ${JSON.stringify(x)}`).toBe(true);
  return x as Json;
};
const nums = (x: unknown): number[] => Object.values(obj(x)).map((v) => v as number);
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

// ---- numeric tolerances (spec section 5) ---------------------------------------------------

/** r: the largest rounding error per value, from the fewest decimals (2 to 6) at which every probability is exact. */
function roundingError(p: readonly number[]): number {
  for (let d = 2; d <= 6; d++) {
    const scale = 10 ** d;
    if (p.every((x) => Math.abs(x * scale - Math.round(x * scale)) < 1e-7)) return 0.5 / scale;
  }
  return 0;
}

function sumBound(p: readonly number[]): { readonly above: number; readonly below: number } {
  const r = roundingError(p);
  return { above: Math.max(0.05, p.filter((x) => x > 0).length * r), below: Math.max(0.05, p.length * r) };
}

// ---- reference confidence (spec 4.5) ---------------------------------------------------------

const choiceReference = (p: readonly number[]): number => (p.length * Math.max(...p) - 1) / (p.length - 1);

/** The adapter formula, for each level that could be the mode (levels tied within epsilon-round). */
function scoreReferences(p: readonly number[]): number[] {
  const n = p.length;
  const middle = (n - 1) / 2;
  const uniform = sum(p.map((_, i) => Math.abs(i - middle))) / n;
  const top = Math.max(...p);
  return p.flatMap((x, k) => (top - x <= 0.005 + SLACK ? [Math.max(0, 1 - sum(p.map((pi, i) => pi * Math.abs(i - k))) / uniform)] : []));
}

// ---- response checks -------------------------------------------------------------------------

function everyNumberFinite(x: unknown, where: string): void {
  if (typeof x === "number") expect(Number.isFinite(x), `${where} is not finite`).toBe(true);
  else if (Array.isArray(x)) x.forEach((v, i) => everyNumberFinite(v, `${where}[${i}]`));
  else if (isObject(x)) for (const [k, v] of Object.entries(x)) everyNumberFinite(v, `${where}.${k}`);
}

function distributionOk(p: unknown, keys: readonly string[], where: string): number[] {
  const record = obj(p);
  expect(Object.keys(record).sort(), `${where}: probabilities are keyed by the options, byte for byte`).toEqual([...keys].sort());
  const values = keys.map((k) => record[k] as number);
  for (const v of values) {
    expect(typeof v, `${where}: a probability is a number`).toBe("number");
    expect(v >= -SLACK && v <= 1 + SLACK, `${where}: probability ${v} is in [0, 1]`).toBe(true);
  }
  const total = sum(values);
  const bound = sumBound(values);
  expect(total <= 1 + bound.above + SLACK && total >= 1 - bound.below - SLACK, `${where}: probabilities sum to ${total}`).toBe(true);
  return values;
}

type Question = { readonly type: string; readonly instructions?: unknown; readonly criteria?: unknown };

/** The answer's fields against its question: types, keys, distribution, argmax, expectation, legend, confidence range. */
function answerOk(id: string, q: Question, a: unknown, confidenceFormula: boolean): void {
  const answer = obj(a);
  expect(answer["type"], `${id}: the answer's type is the question's`).toBe(q.type);
  if (q.type === "noul") {
    expect(typeof answer["noul"], `${id}: noul.answer is a number`).toBe("number");
    expect((answer["noul"] as number) >= 0 && (answer["noul"] as number) <= 1, `${id}: noul is a probability`).toBe(true);
    return;
  }
  expect(typeof answer["confidence"], `${id}: confidence is a number`).toBe("number");
  const confidence = answer["confidence"] as number;
  expect(confidence >= -SLACK && confidence <= 1 + SLACK, `${id}: confidence.range ${confidence}`).toBe(true);
  if (q.type === "choice") {
    const options = Object.keys(obj(q.criteria));
    expect(typeof answer["choice"], `${id}: choice.answer has a choice`).toBe("string");
    const p = distributionOk(answer["probabilities"], options, id);
    const chosen = options.indexOf(answer["choice"] as string);
    expect(chosen, `${id}: the choice is one of the options`).toBeGreaterThanOrEqual(0);
    expect(p[chosen]! >= Math.max(...p) - 0.005 - SLACK, `${id}: choice.argmax`).toBe(true);
    if (confidenceFormula) expect(Math.abs(confidence - choiceReference(p)), `${id}: confidence.formula`).toBeLessThanOrEqual(0.02 + (p.length * roundingError(p)) / Math.max(1, p.length - 1) + SLACK);
    return;
  }
  const levels = q.criteria as unknown[];
  const keys = levels.map((_, i) => String(i));
  expect(typeof answer["score"], `${id}: score.answer has a score`).toBe("number");
  const p = distributionOk(answer["probabilities"], keys, id);
  const r = roundingError(p);
  const n = p.length;
  expect(Math.abs((answer["score"] as number) - sum(p.map((x, i) => i * x))), `${id}: score.expectation`).toBeLessThanOrEqual(0.02 + r * (1 + (n * (n - 1)) / 2) + SLACK);
  const legend = obj(answer["legend"]);
  expect(Object.keys(legend).sort(), `${id}: score.legend has a key per level`).toEqual([...keys].sort());
  levels.forEach((level, i) => {
    const shown = legend[String(i)];
    expect(shown, `${id}: a legend value is never null`).not.toBeNull();
    if (typeof level === "string") expect(shown, `${id}: a level sent as a string comes back unchanged`).toBe(level);
    else if (level !== null) expect(typeof shown === "string" || JSON.stringify(shown) === JSON.stringify(level), `${id}: a structured level comes back unchanged or as a string`).toBe(true);
  });
  if (confidenceFormula) {
    // Rounding each probability by r moves the distance-based formula by at most 2 * r * n * (n - 1) (its divisor is at least 1/2).
    const slack = 0.02 + 2 * r * n * (n - 1);
    const references = [...scoreReferences(p), choiceReference(p)];
    expect(references.some((ref) => Math.abs(confidence - ref) <= slack + SLACK), `${id}: confidence.formula, ${confidence} is none of ${references.join(", ")}`).toBe(true);
  }
}

function envelopeOk(body: unknown, questions: Readonly<Record<string, Question>>): Json {
  const b = obj(body);
  expect(typeof b["model"], "response.envelope: model is a string").toBe("string");
  obj(b["answers"]);
  const usage = obj(b["usage"]);
  for (const key of ["input_tokens", "output_tokens"]) {
    expect(Number.isInteger(usage[key]) && (usage[key] as number) >= 0, `response.usage: ${key} is a non-negative integer`).toBe(true);
  }
  expect(Object.keys(obj(b["answers"])).sort(), "response.answer-ids: one answer per question, none added").toEqual(Object.keys(questions).sort());
  everyNumberFinite(b, "response");
  return b;
}

// ---- requests --------------------------------------------------------------------------------

const noul = { type: "noul", instructions: "Does the customer ask for money back?" };
const choice = { type: "choice", instructions: "Which team should handle this?", criteria: { billing: "Charges, invoices and refunds", sales: null, technical: ["Bugs", "Outages"] } };
const score = { type: "score", instructions: "How angry is the customer?", criteria: ["Calm", "Frustrated", "Very angry"] };
const STATE = "I was charged twice for the same order. Please refund the duplicate.";
const request = (questions: Record<string, unknown> = { urgent: noul, team: choice, anger: score }, more: Record<string, unknown> = {}) => ({ model: ALIAS, state: STATE, questions, ...more });

/** Numbers an answer commits to, keyed for comparison. */
function committed(answers: Json): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, a] of Object.entries(answers)) {
    const answer = obj(a);
    if (answer["type"] === "noul") out.set(`${id}/noul`, answer["noul"] as number);
    else for (const [k, v] of Object.entries(obj(answer["probabilities"]))) out.set(`${id}/${k}`, v as number);
  }
  return out;
}

const mean = (xs: readonly number[]) => sum(xs) / xs.length;
const sd = (xs: readonly number[], m: number) => Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / Math.max(1, xs.length - 1));

/**
 * Whether two sets of sends of one number differ by more than sampling noise explains
 * (spec section 7): 1 when the first is larger, -1 when smaller, 0 when they do not differ.
 * The limit is max(0.05, 4 * pooled deviation * sqrt(2 / k)).
 */
export function sampleDifference(a: readonly number[], b: readonly number[]): -1 | 0 | 1 {
  const [ma, mb] = [mean(a), mean(b)];
  const pooled = Math.sqrt((sd(a, ma) ** 2 + sd(b, mb) ** 2) / 2);
  const limit = Math.max(0.05, 4 * pooled * Math.sqrt(2 / a.length));
  return Math.abs(ma - mb) > limit ? (ma > mb ? 1 : -1) : 0;
}

/** A difference fails a requirement only when a fresh round shows it again for the same number in the same direction. */
export function confirmedDifference(first: readonly number[], second: readonly number[]): boolean {
  return first.some((d, i) => d !== 0 && d === second[i]);
}

/**
 * The System One wire contract over one implementation. `name` labels the run (the
 * handler, an HTTP server).
 */
export function systemOneContract(name: string, fixture: SystemOneFixture): void {
  const auth: Record<string, string> = fixture.token === undefined ? {} : { authorization: `Bearer ${fixture.token}` };
  const send = (body: unknown) => fixture.post(PATH, body, auth);
  const ok = async (body: unknown) => {
    const reply = await send(body);
    expect(reply.status, `expected 200, got ${reply.status}: ${JSON.stringify(reply.body)}`).toBe(200);
    return reply;
  };
  const answersOf = async (questions: Record<string, unknown>, more: Record<string, unknown> = {}) => obj(envelopeOk((await ok(request(questions, more))).body, questions as Record<string, Question>)["answers"]);

  let nonces = 0;
  /** Whether the server takes unknown fields, found out once: sends carry a distinct nonce so that a cache cannot make repeats look alike. */
  let nonceAccepted: boolean | undefined;

  /** The numbers of every answer over k sends. */
  async function sample(body: unknown, k: number): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    for (let i = 0; i < k; i++) {
      const withNonce = { ...(body as Json), x_nonce: `nonce-${nonces++}` };
      nonceAccepted ??= (await send(withNonce)).status === 200;
      const reply = await ok(nonceAccepted ? withNonce : body);
      for (const [key, v] of committed(obj(obj(reply.body)["answers"]))) out.set(key, [...(out.get(key) ?? []), v]);
    }
    return out;
  }

  /** Whether the two requests give a different answer to a pair of numbers, in two rounds that agree. */
  async function answersDiffer(base: unknown, variant: unknown, pairs: readonly [string, string][]): Promise<boolean> {
    const round = async () => {
      const [a, b] = [await sample(base, 3), await sample(variant, 3)];
      return pairs.map(([x, y]) => sampleDifference(a.get(x)!, b.get(y)!));
    };
    const first = await round();
    return first.some((d) => d !== 0) && confirmedDifference(first, await round());
  }

  describe(`System One wire contract (jevcompat 0.1): ${name}`, () => {
    // ---- 1. transport -------------------------------------------------------------------
    describe("transport", () => {
      it("S1C1 http.endpoint: a valid request is answered with 200", async () => {
        expect((await send(request())).status).toBe(200);
      });

      it("S1C2 http.json: the body of a 200 is JSON", async () => {
        obj((await ok(request())).body);
      });

      it("S1C3 http.content-type SHOULD: every response declares a JSON media type", async () => {
        for (const reply of [await ok(request()), await send({})]) {
          if (reply.contentType !== undefined) expect(reply.contentType).toMatch(/^application\/(?:[\w.+-]+\+)?json/);
        }
      });

      it("S1C4 http.models SHOULD: GET /v1/models lists name, description and release_date", async () => {
        if (fixture.get === undefined) return;
        const reply = await fixture.get("/v1/models", auth);
        expect(reply.status).toBe(200);
        const models = obj(reply.body)["models"] as unknown[];
        expect(models.length).toBeGreaterThanOrEqual(1);
        for (const m of models) {
          const model = obj(m);
          expect(typeof model["name"]).toBe("string");
          expect(typeof model["description"]).toBe("string");
          expect(model["release_date"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
        const names = models.map((m) => obj(m)["name"]);
        for (const id of fixture.models) expect(names).toContain(id);
      });

      it("S1C5 every model the server serves can be asked for by its id", async () => {
        for (const model of fixture.models) {
          const reply = await ok(request({ urgent: noul }, { model }));
          expect(obj(reply.body)["model"]).toBe(model);
        }
      });
    });

    // ---- 2. authentication ----------------------------------------------------------------
    describe("authentication", () => {
      if (fixture.token === undefined) {
        it("S1C6 auth.ignored-when-off: a server without authentication accepts an Authorization header", async () => {
          const reply = await fixture.post(PATH, request(), { authorization: "Bearer any-key-at-all" });
          expect(reply.status).toBe(200);
        });
      } else {
        it("S1C7 auth.bearer: the key is read from Authorization: Bearer", async () => {
          expect((await fixture.post(PATH, request(), { authorization: `Bearer ${fixture.token}` })).status).toBe(200);
        });

        it("S1C8 auth.missing SHOULD: a request without a key is 401 or 403 with an authentication_error", async () => {
          const reply = await fixture.post(PATH, request(), {});
          expect([401, 403]).toContain(reply.status);
          expect(obj(obj(reply.body)["detail"])).toMatchObject({ error_type: "authentication_error", message: expect.any(String) });
        });

        it("S1C9 auth.invalid SHOULD: a wrong key is 401 with an authentication_error", async () => {
          const reply = await fixture.post(PATH, request(), { authorization: "Bearer not-the-key" });
          expect(reply.status).toBe(401);
          expect(obj(obj(reply.body)["detail"])).toMatchObject({ error_type: "authentication_error", message: expect.any(String) });
        });
      }
    });

    // ---- 3. request -----------------------------------------------------------------------
    describe("request", () => {
      it("S1C10 request.state: state may be a string, an object or an array", async () => {
        for (const state of [STATE, { message: STATE, order: { id: 7, lines: [1, 2] } }, ["first message", { role: "user", text: STATE }]]) {
          await answersOf({ urgent: noul }, { state });
        }
      });

      it("S1C11 request.model-alias: the model jev-latest is accepted, and the response names a model", async () => {
        const body = envelopeOk((await ok(request({ urgent: noul }, { model: ALIAS }))).body, { urgent: noul });
        expect(body["model"]).not.toBe("");
      });

      it("S1C12 request.multi: several questions of different types are each answered in one request", async () => {
        const questions = { urgent: noul, team: choice, anger: score };
        const answers = await answersOf(questions);
        for (const [id, q] of Object.entries(questions)) answerOk(id, q, answers[id], false);
      });

      it("S1C13 request.question-ids: ids with -, ., spaces and non-ASCII characters come back unchanged", async () => {
        const ids = ["kebab-case", "dotted.id", "with space", "팀-1", "emoji 🙂", "3", "a/b"];
        const answers = await answersOf(Object.fromEntries(ids.map((id) => [id, noul])));
        expect(Object.keys(answers).sort()).toEqual([...ids].sort());
      });

      it("S1C14 request.unicode: non-ASCII text is accepted everywhere and option names come back byte for byte", async () => {
        const q = {
          팀: { type: "choice", instructions: "어느 팀이 처리해야 합니까? 🙂", criteria: { 청구: "요금과 환불", "판매 🙂": null, "é": "combining" } },
          점수: { type: "score", instructions: "고객이 얼마나 화가 났습니까?", criteria: ["침착", "🙂 화남"] },
        };
        const answers = await answersOf(q, { state: "주문에 대해 두 번 청구되었습니다. 🙂" });
        answerOk("팀", q["팀"], answers["팀"], false);
        answerOk("점수", q["점수"], answers["점수"], false);
      });

      it("S1C15 request.unknown-fields SHOULD: unknown top-level fields are ignored", async () => {
        await answersOf({ urgent: noul }, { x_nonce: "abc", extra_body: { anything: [1, 2] } });
      });

      it("S1C16 request.structured-text: instructions and descriptions may be a string, an object or an array", async () => {
        const q = {
          a: { type: "choice", instructions: { ask: "which", among: ["a", "b"] }, criteria: { a: { includes: ["x", "y"] }, b: ["p", "q"], c: "text" } },
          b: { type: "score", instructions: ["how", "high"], criteria: [{ level: "low" }, ["medium"], "high"] },
          c: { type: "noul", instructions: { question: "yes?" }, criteria: { true: ["a"], false: { b: 1 } } },
        };
        const answers = await answersOf(q);
        for (const [id, question] of Object.entries(q)) answerOk(id, question, answers[id], false);
      });

      it("S1C17 noul.criteria: criteria may be omitted, null, both sides, or one side", async () => {
        const criteria = [undefined, null, { true: "yes", false: "no" }, { true: "yes" }, { false: "no" }];
        const q = Object.fromEntries(criteria.map((c, i) => [`n${i}`, { type: "noul", instructions: "Is it so?", ...(c === undefined ? {} : { criteria: c }) }]));
        const answers = await answersOf(q);
        for (const id of Object.keys(q)) answerOk(id, q[id]!, answers[id], false);
      });

      it("S1C18 noul.no-instructions SHOULD: a noul question without instructions is accepted", async () => {
        await answersOf({ n: { type: "noul" } });
      });

      it("S1C19 choice.null-description: an option's description may be null", async () => {
        const q = { c: { type: "choice", instructions: "Which?", criteria: { alpha: null, beta: null } } };
        answerOk("c", q.c, (await answersOf(q))["c"], false);
      });

      it("S1C20 choice.options: 2 to 255 options are accepted", async () => {
        for (const n of [2, 3, 50, 255]) {
          const q = { c: { type: "choice", instructions: "Which?", criteria: Object.fromEntries(Array.from({ length: n }, (_, i) => [`option ${i}`, i % 3 ? null : `about ${i}`])) } };
          answerOk(`c(${n})`, q.c, (await answersOf(q))["c"], false);
        }
      });

      it("S1C21 score.levels: 2 to 10 levels are accepted, described low to high", async () => {
        for (const n of [2, 3, 5, 10]) {
          const q = { s: { type: "score", instructions: "How much?", criteria: Array.from({ length: n }, (_, i) => `level number ${i}`) } };
          answerOk(`s(${n})`, q.s, (await answersOf(q))["s"], false);
        }
      });

      it("S1C22 score.map-rejected SHOULD: score criteria given as an object are rejected with a 4xx", async () => {
        const reply = await send(request({ s: { type: "score", instructions: "?", criteria: { "0": "low", "1": "high" } } }));
        expect(reply.status).toBeGreaterThanOrEqual(400);
        expect(reply.status).toBeLessThan(500);
      });

      it("S1C23 limits: a choice with 1 or 256 options and a score with 1 or 11 levels are accepted or refused with a 4xx, never a 5xx", async () => {
        const options = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, null]));
        const levels = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);
        for (const q of [
          { type: "choice", instructions: "?", criteria: options(1) },
          { type: "choice", instructions: "?", criteria: options(256) },
          { type: "score", instructions: "?", criteria: levels(1) },
          { type: "score", instructions: "?", criteria: levels(11) },
        ]) {
          const reply = await send(request({ q }));
          expect(reply.status === 200 || (reply.status >= 400 && reply.status < 500), `status ${reply.status}`).toBe(true);
        }
      });
    });

    // ---- 4. response ------------------------------------------------------------------------
    describe("response", () => {
      const questions = { urgent: noul, team: choice, anger: score };

      it("S1C24 response.envelope: model, answers and usage, with one answer per question", async () => {
        envelopeOk((await ok(request(questions))).body, questions);
      });

      it("S1C25 response.usage: token counts are non-negative integers", async () => {
        const usage = obj(obj((await ok(request(questions))).body)["usage"]);
        expect(Number.isInteger(usage["input_tokens"])).toBe(true);
        expect(Number.isInteger(usage["output_tokens"])).toBe(true);
      });

      it("S1C26 response.answer-type: each answer's type is its question's", async () => {
        const answers = await answersOf(questions);
        for (const [id, q] of Object.entries(questions)) expect(obj(answers[id])["type"]).toBe(q.type);
      });

      it("S1C27 response.finite: every number is finite", async () => {
        everyNumberFinite((await ok(request(questions))).body, "response");
      });

      it("S1C28 response.extensions SHOULD: fields the specification does not define start with x_", async () => {
        const body = obj((await ok(request(questions))).body);
        expect(Object.keys(body).filter((k) => !["model", "answers", "usage"].includes(k) && !k.startsWith("x_"))).toEqual([]);
        const defined: Record<string, string[]> = { noul: ["type", "noul"], choice: ["type", "choice", "probabilities", "confidence"], score: ["type", "score", "legend", "probabilities", "confidence"] };
        for (const [id, a] of Object.entries(obj(body["answers"]))) {
          const answer = obj(a);
          const allowed = defined[answer["type"] as string]!;
          expect(Object.keys(answer).filter((k) => !allowed.includes(k) && !k.startsWith("x_")), id).toEqual([]);
        }
      });

      it("S1C29 noul.answer: {type: noul, noul: p} with p in [0, 1]", async () => {
        const a = obj((await answersOf({ n: noul }))["n"]);
        expect(a["type"]).toBe("noul");
        expect(a["noul"] as number).toBeGreaterThanOrEqual(0);
        expect(a["noul"] as number).toBeLessThanOrEqual(1);
      });

      it("S1C30 noul.answer SHOULD: a noul answer has no confidence", async () => {
        expect(obj((await answersOf({ n: noul }))["n"])).not.toHaveProperty("confidence");
      });

      it("S1C31 choice.answer: choice, probabilities and confidence", async () => {
        const a = obj((await answersOf({ c: choice }))["c"]);
        expect(typeof a["choice"]).toBe("string");
        expect(isObject(a["probabilities"])).toBe(true);
        expect(typeof a["confidence"]).toBe("number");
      });

      it("S1C32 choice.probability-keys: the keys are exactly the option names", async () => {
        const q = { c: { type: "choice", instructions: "?", criteria: { "α β": null, "a.b": null, "🙂": "x" } } };
        const a = obj((await answersOf(q))["c"]);
        expect(Object.keys(obj(a["probabilities"])).sort()).toEqual(Object.keys(q.c.criteria).sort());
      });

      it("S1C33 choice.distribution: probabilities are in [0, 1] and sum to 1 within the rounding they show", async () => {
        const a = (await answersOf({ c: choice }))["c"];
        distributionOk(obj(a)["probabilities"], Object.keys(choice.criteria), "c");
      });

      it("S1C34 choice.argmax: the choice has the largest probability", async () => {
        answerOk("c", choice, (await answersOf({ c: choice }))["c"], false);
      });

      it("S1C35 score.answer: score, legend, probabilities and confidence", async () => {
        const a = obj((await answersOf({ s: score }))["s"]);
        expect(typeof a["score"]).toBe("number");
        expect(isObject(a["legend"])).toBe(true);
        expect(isObject(a["probabilities"])).toBe(true);
        expect(typeof a["confidence"]).toBe("number");
      });

      it("S1C36 score.legend: the levels by index, a string level unchanged, never null", async () => {
        const q = { s: { type: "score", instructions: "?", criteria: ["low 🙂", "mid", "hi"] } };
        expect(obj(obj((await answersOf(q))["s"])["legend"])).toEqual({ "0": "low 🙂", "1": "mid", "2": "hi" });
        const structured = { s: { type: "score", instructions: "?", criteria: [{ a: 1 }, ["b"], "c"] } };
        answerOk("s", structured.s, (await answersOf(structured))["s"], false);
      });

      it("S1C37 score.probability-keys and score.distribution: level indexes as strings, summing to 1", async () => {
        const a = (await answersOf({ s: score }))["s"];
        distributionOk(obj(a)["probabilities"], ["0", "1", "2"], "s");
      });

      it("S1C38 score.expectation: the score is the sum of level times probability", async () => {
        answerOk("s", score, (await answersOf({ s: score }))["s"], false);
      });

      it("S1C39 confidence.range: confidence is in [0, 1]", async () => {
        const answers = await answersOf({ c: choice, s: score });
        for (const id of ["c", "s"]) {
          const confidence = obj(answers[id])["confidence"] as number;
          expect(confidence >= 0 && confidence <= 1).toBe(true);
        }
      });

      it("S1C40 confidence.formula SHOULD: confidence is the reference formula over the probabilities", async () => {
        const answers = await answersOf({ c: choice, s: score });
        answerOk("c", choice, answers["c"], true);
        answerOk("s", score, answers["s"], true);
      });

      it("S1C41 dropin: the response has no null anywhere, which the strictest client (the Python SDK's strict model) rejects", async () => {
        const body = obj((await ok(request(questions))).body);
        const nullFree = (x: unknown): boolean => x !== null && (Array.isArray(x) ? x.every(nullFree) : isObject(x) ? Object.values(x).every(nullFree) : true);
        expect(nullFree(body)).toBe(true);
        expect(typeof body["model"]).toBe("string");
        expect(nums(obj(obj(body["answers"])["team"])["probabilities"]).every((v) => typeof v === "number")).toBe(true);
      });
    });

    // ---- 6. errors --------------------------------------------------------------------------
    describe("errors", () => {
      const valid = request();
      const invalid: [string, unknown][] = [
        ["a body that is an array", []],
        ["a body that is null", null],
        ["a missing state", { model: ALIAS, questions: { q: noul } }],
        ["missing questions", { model: ALIAS, state: STATE }],
        ["questions equal to {}", { ...valid, questions: {} }],
        ["a question without a type", request({ q: { instructions: "?" } })],
        ["an unknown type (boolean)", request({ q: { type: "boolean", instructions: "?" } })],
        ["a choice with empty criteria", request({ q: { type: "choice", instructions: "?", criteria: {} } })],
        ["a score whose criteria is not an array", request({ q: { type: "score", instructions: "?", criteria: "low, high" } })],
        ["questions that is not an object", { ...valid, questions: [noul] }],
        ["a question that is a string", request({ q: "Is it?" })],
        ["a state that is a number", { ...valid, state: 42 }],
        ["a model that is not a string", { ...valid, model: 7 }],
      ];

      it("S1C42 errors.no-5xx: a request that is malformed or out of range never produces a 5xx", async () => {
        for (const [what, body] of invalid) {
          const reply = await send(body);
          expect(reply.status, what).toBeLessThan(500);
        }
        if (fixture.postRaw) for (const text of ["", "{", "not json", "[1,", "{\"state\":", "\u0000", "{\"a\":1}}"]) expect((await fixture.postRaw(PATH, text, auth)).status, JSON.stringify(text)).toBeLessThan(500);
      });

      it("S1C43 errors.reject-invalid SHOULD: an invalid request gets a 4xx, not a 200", async () => {
        for (const [what, body] of invalid) {
          const { status } = await send(body);
          expect(status >= 400 && status < 500, `${what} got ${status}`).toBe(true);
        }
        if (fixture.postRaw) expect((await fixture.postRaw(PATH, "this is not JSON", auth)).status).toBeGreaterThanOrEqual(400);
      });

      it("S1C44 errors.json SHOULD: error responses have JSON bodies", async () => {
        for (const [, body] of invalid) obj((await send(body)).body);
        for (const [, body] of invalid.slice(0, 3)) {
          const reply = await send(body);
          if (reply.contentType !== undefined) expect(reply.contentType).toMatch(/json/);
        }
      });

      it("S1C45 errors.validation-shape SHOULD: a validation failure is a 422 with detail[{loc, msg, type}] located from body", async () => {
        for (const [what, body] of invalid) {
          const reply = await send(body);
          expect(reply.status, what).toBe(422);
          const detail = obj(reply.body)["detail"] as unknown[];
          expect(Array.isArray(detail) && detail.length > 0, what).toBe(true);
          for (const d of detail) {
            const item = obj(d);
            expect((item["loc"] as unknown[])[0], what).toBe("body");
            expect(typeof item["msg"], what).toBe("string");
            expect(typeof item["type"], what).toBe("string");
          }
        }
      });

      it("S1C46 errors.validation-shape SHOULD: text that is not JSON is a 422 in the same shape", async () => {
        if (fixture.postRaw === undefined) return;
        const reply = await fixture.postRaw(PATH, "{ this is not json", auth);
        expect(reply.status).toBe(422);
        const first = obj((obj(reply.body)["detail"] as unknown[])[0]);
        expect((first["loc"] as unknown[])[0]).toBe("body");
      });

      it("S1C47 errors.shape SHOULD: an unknown model is a 4xx with detail {error_type, message}", async () => {
        const reply = await send(request({ q: noul }, { model: "no-such-model-1.0" }));
        expect(reply.status).toBeGreaterThanOrEqual(400);
        expect(reply.status).toBeLessThan(500);
        expect(obj(obj(reply.body)["detail"])).toMatchObject({ error_type: expect.any(String), message: expect.any(String) });
      });

      it("S1C48 errors.no-5xx: a request with absurd but legal values is answered, not crashed on", async () => {
        const long = "x".repeat(50_000);
        const reply = await send(request({ [long.slice(0, 500)]: { type: "choice", instructions: long, criteria: { [long.slice(0, 1000)]: long, b: null } } }, { state: { deep: [[[[[[[[["🙂"]]]]]]]]] } }));
        expect(reply.status).toBeLessThan(500);
      });
    });

    // ---- 7. semantics -----------------------------------------------------------------------
    describe("semantics", () => {
      /** The numbers to compare: the base request's, and the variant's under the ids it renamed. */
      const pairsOf = (renames: Record<string, string> = {}): [string, string][] => {
        const at = (id: string, key: string): string => `${renames[id] ?? id}/${key}`;
        return [
          [`urgent/noul`, at("urgent", "noul")],
          ...["billing", "sales", "technical"].map((o): [string, string] => [`team/${o}`, at("team", o)]),
          ...["0", "1", "2"].map((l): [string, string] => [`anger/${l}`, at("anger", l)]),
        ];
      };

      it("S1C49 semantics.question-id: renaming a question id does not change its answer", async () => {
        const renames = { urgent: "is-this-urgent", team: "which team?", anger: "팀" };
        const base = request({ urgent: noul, team: choice, anger: score });
        const variant = request({ [renames.urgent]: noul, [renames.team]: choice, [renames.anger]: score });
        expect(await answersDiffer(base, variant, pairsOf(renames))).toBe(false);
      });

      it("S1C50 semantics.batching SHOULD: adding other questions does not change an answer", async () => {
        const base = request({ urgent: noul, team: choice, anger: score });
        const variant = request({ extra1: { type: "choice", instructions: "Unrelated?", criteria: { a: null, b: null } }, urgent: noul, team: choice, extra2: noul, anger: score });
        expect(await answersDiffer(base, variant, pairsOf())).toBe(false);
      });

      it("S1C51 semantics.question-order SHOULD: the order of the questions does not change an answer", async () => {
        const base = request({ urgent: noul, team: choice, anger: score });
        const variant = request({ anger: score, team: choice, urgent: noul });
        expect(await answersDiffer(base, variant, pairsOf())).toBe(false);
      });
    });
  });
}

// ---- a deterministic evaluation model to serve ---------------------------------------------

/** A deterministic hash (FNV-1a) of what a model is shown. */
function fnv(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/**
 * An evaluation model whose answers depend on the state, the question's kind, instructions
 * and criteria and nothing else (not the question ids, not the other questions): the same
 * input gives the same answer, the way a real model's does. Probabilities are rounded to
 * two decimals, as TypeSafe's are, and the model says so.
 */
export function hashedEvaluationModel(modelId = "hashed"): EvaluationModelV4 {
  const weights = (state: unknown, q: ModelQuestion, n: number) => Array.from({ length: n }, (_, i) => 1 + (fnv(JSON.stringify([state, q.type, q.instructions, q.criteria, i])) % 9) ** 2);
  return {
    specificationVersion: "v4",
    provider: "testkit.hashed",
    modelId,
    supportedQuestionTypes: ["boolean", "choice", "score"],
    async doEvaluate({ state, questions }) {
      const answers: Record<string, ModelAnswer> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (q.type === "boolean") {
          answers[id] = { type: "boolean", probability: Math.round((fnv(JSON.stringify([state, q])) % 101)) / 100 };
          continue;
        }
        const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
        const w = weights(state, q, keys.length);
        const total = w.reduce((a, b) => a + b, 0);
        const p = w.map((x) => Math.round((x / total) * 100) / 100);
        const probabilities = Object.fromEntries(keys.map((k, i) => [k, p[i]!]));
        answers[id] = q.type === "choice" ? { type: "choice", choice: keys[p.indexOf(Math.max(...p))]!, probabilities } : { type: "score", score: p.reduce((sum, x, i) => sum + x * i, 0), probabilities };
      }
      return { answers, warnings: [], usage: { inputTokens: 12, outputTokens: 3 }, rounding: { probabilityDecimals: 2, scoreDecimals: 15 } };
    },
  };
}
