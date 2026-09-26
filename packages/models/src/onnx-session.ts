import type { SteerableSession } from "./steerable.ts";

/** The parts of onnxruntime (node or web) the session uses. */
export interface OrtTensorLike {
  readonly type: string;
  readonly data: ArrayLike<number | bigint>;
  readonly dims: readonly number[];
}
export interface OrtLike {
  Tensor: new (type: string, data: ArrayLike<number | bigint>, dims: readonly number[]) => OrtTensorLike;
  InferenceSession: {
    create(model: Uint8Array | string, options?: object): Promise<{ readonly inputNames: readonly string[]; run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>> }>;
  };
}

type OrtSession = Awaited<ReturnType<OrtLike["InferenceSession"]["create"]>>;

export interface DecoderConfig {
  readonly layers: number;
  readonly kvHeads: number;
  readonly headSize: number;
  readonly hidden: number;
}

/**
 * A steerable decoder (see onnx-steer.ts) on onnxruntime, with its KV cache: inputs
 * input_ids, attention_mask, past_key_values.i.{key,value}, steer.L; outputs logits,
 * present.i.{key,value}, resid.L. The same class runs on onnxruntime-node and
 * onnxruntime-web.
 */
export class OnnxSteerableSession implements SteerableSession {
  readonly dims: number;
  readonly layer: number;
  readonly #rt: OrtLike;
  readonly #session: OrtSession;
  readonly #config: DecoderConfig;
  #past: Record<string, OrtTensorLike> = {};
  #length = 0;

  private constructor(rt: OrtLike, session: OrtSession, layer: number, config: DecoderConfig) {
    this.#rt = rt;
    this.#session = session;
    this.layer = layer;
    this.dims = config.hidden;
    this.#config = config;
    this.reset();
  }

  static async create(options: { model: Uint8Array | string; layer: number; config: DecoderConfig; runtime?: OrtLike; sessionOptions?: object }): Promise<OnnxSteerableSession> {
    const rt = options.runtime ?? ((await import("onnxruntime-node")) as unknown as OrtLike);
    const session = await rt.InferenceSession.create(options.model, options.sessionOptions);
    if (!session.inputNames.includes(`steer.${options.layer}`)) throw new Error(`the model has no steer.${options.layer} input: patch it with makeSteerable first`);
    return new OnnxSteerableSession(rt, session, options.layer, options.config);
  }

  reset(): void {
    const { layers, kvHeads, headSize } = this.#config;
    this.#past = {};
    for (let l = 0; l < layers; l++) {
      for (const kind of ["key", "value"]) this.#past[`past_key_values.${l}.${kind}`] = new this.#rt.Tensor("float32", new Float32Array(0), [1, kvHeads, 0, headSize]);
    }
    this.#length = 0;
  }

  async forward(ids: readonly number[], steer: Float32Array | undefined): Promise<{ logits: Float32Array; residuals: Float32Array[] }> {
    const n = ids.length;
    const total = this.#length + n;
    const out = await this.#session.run({
      input_ids: new this.#rt.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, n]),
      attention_mask: new this.#rt.Tensor("int64", new BigInt64Array(total).fill(1n), [1, total]),
      ...this.#past,
      [`steer.${this.layer}`]: new this.#rt.Tensor("float32", steer ?? new Float32Array(this.dims), [this.dims]),
    });
    for (const name of Object.keys(this.#past)) this.#past[name] = out[name.replace("past_key_values.", "present.")]!;
    this.#length = total;
    const logits = out["logits"]!;
    const vocab = logits.dims.at(-1)!;
    const resid = out[`resid.${this.layer}`]!.data as Float32Array;
    return {
      logits: Float32Array.from((logits.data as Float32Array).subarray((n - 1) * vocab, n * vocab)),
      residuals: ids.map((_, t) => Float32Array.from(resid.subarray(t * this.dims, (t + 1) * this.dims))),
    };
  }
}
