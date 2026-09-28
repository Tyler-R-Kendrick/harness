import type { Experimental_EvaluationModelV4, Experimental_EvaluationModelV4Answer, Experimental_EvaluationModelV4Input, Experimental_EvaluationModelV4Question } from "@ai-sdk/provider";
import type { ModelDescriptor } from "@harness/cognitive";
import { Mutex } from "async-mutex";
import type { OrtLike, OrtTensorLike } from "./onnx-session.ts";
import { decisionTokenizer } from "./tokenizers.ts";
import type { DecisionTokenizer } from "./tokenizers.ts";

/**
 * Decision models: typed questions over a state (choice, ordered score, boolean), each
 * encoded as one sequence whose options the model scores at marker tokens. What is
 * particular to a model (its question head, type ids, limits, how it writes JSON) is its
 * catalog entry's `run`.
 */
export type DecisionFormat = Extract<ModelDescriptor, { runtime: "onnxruntime-decision" }>["run"];
type Input = Experimental_EvaluationModelV4Input;
type QuestionType = keyof DecisionFormat["types"];

/** A request is refused when it breaks the model's contract (option counts, strict limits). */
export class DecisionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionRequestError";
  }
}

/** JSON written with the model's separators (Python's json.dumps writes ", " and ": "). */
export function writeJson(value: unknown, separators: DecisionFormat["json"]): string {
  if (Array.isArray(value)) return `[${value.map((v) => writeJson(v, separators)).join(separators.item)}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}${separators.key}${writeJson(v, separators)}`).join(separators.item)}}`;
  }
  return JSON.stringify(value);
}

export interface DecisionRequest {
  readonly type: QuestionType;
  readonly question: string;
  /** The options in order; a boolean question's are false then true. */
  readonly options: readonly string[];
  readonly state: Input;
}

export interface EncodedDecision {
  readonly ids: readonly number[];
  /** Where each option's marker is. */
  readonly markers: readonly number[];
  readonly qtype: number;
  /** Whether the state was cut to fit (never when strict). */
  readonly truncated: boolean;
}

const fill = (template: string, values: Readonly<Record<string, string>>) => template.replace(/\{(\w+)\}/g, (all, name: string) => values[name] ?? all);
const total = (xs: readonly (readonly number[])[]) => xs.reduce((sum, x) => sum + x.length, 0);

/**
 * One request as the model reads it: the start token, the question head, a separator,
 * each option behind the marker token, a separator, the state and a separator. When a
 * request does not fit, strict encoding refuses it; otherwise options are cut to the
 * option limit, then evenly when they leave the question too little room, the question
 * keeps what room is left (at least `cut.head`), and the state is cut to fit.
 */
export function encodeDecision(tokenizer: DecisionTokenizer, format: DecisionFormat, request: DecisionRequest): EncodedDecision {
  const { limits, strict } = format;
  const n = request.options.length;
  if (n < limits.options.min || n > limits.options.max) throw new DecisionRequestError(`a question takes ${limits.options.min} to ${limits.options.max} options, not ${n}`);
  if (request.type === "boolean" && n !== 2) throw new DecisionRequestError("a boolean question has two options, false then true");
  request.options.forEach((o, i) => {
    if (o === "") throw new DecisionRequestError(`option ${i + 1} is empty`);
  });
  const { marker } = tokenizer;
  const state = typeof request.state === "string" ? request.state : writeJson(request.state, format.json);
  if (strict && [state, request.question, ...request.options].some((t) => t.includes(marker))) throw new DecisionRequestError(`the request contains the reserved marker ${marker}`);
  const clean = (text: string) => text.replaceAll(marker, " ");
  const type = format.types[request.type];
  const head = tokenizer.encode(fill(format.head, { type: type.name, question: clean(request.question) }));
  const written = request.options.map((o) => tokenizer.encode(fill(format.option, { option: clean(o) })));
  if (strict) {
    written.forEach((x, i) => {
      if (x.length > limits.option) throw new DecisionRequestError(`option ${i + 1} is ${x.length} tokens; at most ${limits.option}`);
    });
  }
  let options = written.map((x) => [tokenizer.ids.marker, ...x.slice(0, limits.option)]);
  let budget = limits.head - total(options);
  if (budget < limits.cut.budget) {
    const each = Math.max(limits.cut.option, Math.floor((limits.head - limits.cut.budget) / n));
    options = options.map((x) => x.slice(0, each));
    budget = limits.head - total(options);
  }
  if (strict && (head.length > budget || options.some((x, i) => x.length !== written[i]!.length + 1))) {
    throw new DecisionRequestError(`the question and options are more than ${limits.head} tokens`);
  }
  const ids = [tokenizer.ids.start, ...head.slice(0, Math.max(limits.cut.head, budget)), tokenizer.ids.separator];
  const markers: number[] = [];
  for (const option of options) {
    markers.push(ids.length);
    ids.push(...option);
  }
  ids.push(tokenizer.ids.separator);
  const stateIds = tokenizer.encode(clean(state));
  const room = limits.tokens - ids.length - 1;
  if (room < 1) throw new DecisionRequestError(`the question and options leave no room for the state in ${limits.tokens} tokens`);
  if (strict && stateIds.length > room) throw new DecisionRequestError(`the state is ${stateIds.length} tokens; ${room} fit`);
  return { ids: [...ids, ...stateIds.slice(0, room), tokenizer.ids.separator], markers, qtype: type.id, truncated: stateIds.length > room };
}

/** Encoded requests as the model's inputs: row-major, padded to the longest (rounded up to `padTo`, within `tokens`). */
export interface DecisionBatch {
  readonly size: number;
  readonly length: number;
  /** The most options any row has. */
  readonly options: number;
  readonly inputIds: BigInt64Array;
  readonly attentionMask: BigInt64Array;
  readonly markerPos: BigInt64Array;
  readonly markerMask: Uint8Array;
  readonly qtype: BigInt64Array;
}

export function collateDecisions(rows: readonly EncodedDecision[], options: { readonly pad: number; readonly padTo: number; readonly tokens: number }): DecisionBatch {
  const longest = Math.max(...rows.map((r) => r.ids.length));
  const length = Math.min(options.tokens, Math.ceil(longest / options.padTo) * options.padTo);
  const width = Math.max(...rows.map((r) => r.markers.length));
  const inputIds = new BigInt64Array(rows.length * length).fill(BigInt(options.pad));
  const attentionMask = new BigInt64Array(rows.length * length);
  const markerPos = new BigInt64Array(rows.length * width);
  const markerMask = new Uint8Array(rows.length * width);
  rows.forEach((r, i) => {
    r.ids.forEach((id, t) => {
      inputIds[i * length + t] = BigInt(id);
      attentionMask[i * length + t] = 1n;
    });
    r.markers.forEach((m, k) => {
      markerPos[i * width + k] = BigInt(m);
      markerMask[i * width + k] = 1;
    });
  });
  return { size: rows.length, length, options: width, inputIds, attentionMask, markerPos, markerMask, qtype: BigInt64Array.from(rows, (r) => BigInt(r.qtype)) };
}

/** Split rows into runs whose padded size (rows times their padded length) is within the model's `batchTokens`; a longer row runs alone. */
function batches(rows: readonly EncodedDecision[], format: DecisionFormat): EncodedDecision[][] {
  const padded = (n: number) => Math.min(format.limits.tokens, Math.ceil(n / format.padTo) * format.padTo);
  const out: EncodedDecision[][] = [];
  let current: EncodedDecision[] = [];
  let longest = 0;
  for (const row of rows) {
    const length = padded(row.ids.length);
    if (current.length > 0 && (current.length + 1) * Math.max(longest, length) > format.batchTokens) {
      out.push(current);
      current = [];
      longest = 0;
    }
    current.push(row);
    longest = Math.max(longest, length);
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Runs a batch: one score per row and option, row-major (`size` x `options`). */
export interface DecisionSession {
  run(batch: DecisionBatch): Promise<Float32Array>;
}

const INPUTS = ["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"];

/** A decision model on onnxruntime (node or web; the same class runs on either). */
export class OnnxDecisionSession implements DecisionSession {
  readonly #rt: OrtLike;
  readonly #session: Awaited<ReturnType<OrtLike["InferenceSession"]["create"]>>;

  private constructor(rt: OrtLike, session: Awaited<ReturnType<OrtLike["InferenceSession"]["create"]>>) {
    this.#rt = rt;
    this.#session = session;
  }

  static async create(options: { readonly runtime: OrtLike; readonly model: Uint8Array | string; readonly sessionOptions?: object }): Promise<OnnxDecisionSession> {
    const session = await options.runtime.InferenceSession.create(options.model, options.sessionOptions);
    const missing = INPUTS.filter((name) => !session.inputNames.includes(name));
    if (missing.length > 0) throw new Error(`not a decision model: it has no ${missing.join(", ")} input`);
    return new OnnxDecisionSession(options.runtime, session);
  }

  async run(batch: DecisionBatch): Promise<Float32Array> {
    const T = this.#rt.Tensor;
    const out = await this.#session.run({
      input_ids: new T("int64", batch.inputIds, [batch.size, batch.length]),
      attention_mask: new T("int64", batch.attentionMask, [batch.size, batch.length]),
      marker_pos: new T("int64", batch.markerPos, [batch.size, batch.options]),
      marker_mask: new T("bool", batch.markerMask, [batch.size, batch.options]),
      qtype: new T("int64", batch.qtype, [batch.size]),
    });
    const logits = out["logits"] as OrtTensorLike;
    const expected = [batch.size, batch.options];
    if (logits.type !== "float32" || logits.dims.length !== 2 || logits.dims.some((d, i) => d !== expected[i])) {
      throw new Error(`logits are ${logits.type} [${logits.dims.join(",")}]; expected float32 [${expected.join(",")}]`);
    }
    return Float32Array.from(logits.data as Float32Array);
  }
}

/** A question's options in order, as text, with the answer key each stands for. */
function optionsOf(q: Experimental_EvaluationModelV4Question, text: (input: Input) => string): { readonly keys: string[]; readonly options: string[] } {
  const described = (description: Input | null | undefined, otherwise: string) => (description === null || description === undefined ? otherwise : text(description)) || otherwise;
  if (q.type === "boolean") return { keys: ["false", "true"], options: [described(q.criteria?.false, "false"), described(q.criteria?.true, "true")] };
  if (q.type === "choice") {
    const keys = Object.keys(q.criteria);
    return { keys, options: keys.map((k) => described(q.criteria[k], k)) };
  }
  return { keys: q.criteria.map((_, level) => String(level)), options: q.criteria.map((d, level) => described(d, String(level))) };
}

/**
 * A decision model as an AI SDK evaluation model. A call's questions go to the model in
 * one batch; each answer is the softmax over its options' scores: the most probable
 * choice with the whole distribution, the expected score level, or P(true). Calls run
 * one at a time on the session.
 */
export function decisionModel(options: { readonly modelId: string; readonly session: DecisionSession; readonly tokenizer: DecisionTokenizer; readonly format: DecisionFormat }): Experimental_EvaluationModelV4 {
  const { modelId, session, tokenizer, format } = options;
  const mutex = new Mutex();
  const text = (input: Input) => (typeof input === "string" ? input : writeJson(input, format.json));
  return {
    specificationVersion: "v4",
    provider: "harness.decision",
    modelId,
    supportedQuestionTypes: ["boolean", "choice", "score"],
    async doEvaluate({ state, questions, abortSignal }) {
      abortSignal?.throwIfAborted();
      const asked = Object.entries(questions).map(([id, q]) => ({ id, q, ...optionsOf(q, text) }));
      const encoded = asked.map(({ q, options }) => encodeDecision(tokenizer, format, { type: q.type, question: text(q.instructions), options, state }));
      const scores = await mutex.runExclusive(async () => {
        const rows: number[][] = [];
        for (const part of batches(encoded, format)) {
          abortSignal?.throwIfAborted();
          const batch = collateDecisions(part, { pad: tokenizer.ids.pad, padTo: format.padTo, tokens: format.limits.tokens });
          const out = await session.run(batch);
          part.forEach((_, r) => rows.push(Array.from(out.subarray(r * batch.options, (r + 1) * batch.options))));
        }
        return rows;
      });
      const answers: Record<string, Experimental_EvaluationModelV4Answer> = {};
      asked.forEach(({ id, q, keys }, row) => {
        const z = scores[row]!.slice(0, keys.length);
        if (!z.every(Number.isFinite)) throw new Error(`${modelId} returned non-finite scores for ${id}`);
        const top = Math.max(...z);
        const e = z.map((x) => Math.exp(x - top));
        const sum = e.reduce((a, b) => a + b, 0);
        const p = e.map((x) => x / sum);
        const probabilities = Object.fromEntries(keys.map((k, i) => [k, p[i]!]));
        if (q.type === "boolean") answers[id] = { type: "boolean", probability: p[1]! };
        else if (q.type === "choice") answers[id] = { type: "choice", choice: keys[p.indexOf(Math.max(...p))]!, probabilities };
        else answers[id] = { type: "score", score: p.reduce((s, x, level) => s + x * level, 0), probabilities };
      });
      return { answers, usage: { inputTokens: encoded.reduce((s, e) => s + e.ids.length, 0), outputTokens: 0 }, warnings: [], response: { modelId } };
    },
  };
}

/**
 * A catalog decision model from its files: the model (bytes, or a path where its weights
 * file sits beside it), its tokenizer.json and tokenizer config, on the host's
 * onnxruntime with the host's session options (execution providers, external data).
 */
export async function loadDecisionModel(
  m: Extract<ModelDescriptor, { runtime: "onnxruntime-decision" }>,
  files: { readonly model: Uint8Array | string; readonly tokenizer: Uint8Array; readonly tokenizerConfig: Uint8Array },
  host: { readonly runtime: OrtLike; readonly sessionOptions?: object },
): Promise<Experimental_EvaluationModelV4> {
  const json = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  const tokenizer = decisionTokenizer(json(files.tokenizer), json(files.tokenizerConfig));
  const session = await OnnxDecisionSession.create({ runtime: host.runtime, model: files.model, ...(host.sessionOptions ? { sessionOptions: host.sessionOptions } : {}) });
  return decisionModel({ modelId: m.id, session, tokenizer, format: m.run });
}
