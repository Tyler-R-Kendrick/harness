export type DecodeResult =
  | { readonly kind: "message"; readonly value: unknown }
  | { readonly kind: "error"; readonly code: "parse_error" | "too_large" | "truncated"; readonly detail: string };

/**
 * Newline-delimited JSON framing over text. Hosts turn bytes into text (streaming
 * UTF-8 decoding is a host concern) and push it here. Lines longer than `maxChars`
 * are rejected once and skipped up to the next newline, so a hostile or broken peer
 * cannot make the daemon buffer without bound.
 */
export class NdjsonDecoder {
  readonly #maxChars: number;
  #buffer = "";
  #discarding = false;

  constructor(options: { maxChars?: number } = {}) {
    const maxChars = options.maxChars ?? 16 * 1024 * 1024;
    if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("maxChars must be a positive integer");
    this.#maxChars = maxChars;
  }

  push(chunk: string): DecodeResult[] {
    const out: DecodeResult[] = [];
    let rest = chunk;
    for (;;) {
      const nl = rest.indexOf("\n");
      const piece = nl === -1 ? rest : rest.slice(0, nl);
      if (!this.#discarding) {
        this.#buffer += piece;
        if (this.#lineLength() > this.#maxChars) {
          out.push({ kind: "error", code: "too_large", detail: `line exceeds ${this.#maxChars} characters` });
          this.#buffer = "";
          this.#discarding = true;
        }
      }
      if (nl === -1) break;
      if (!this.#discarding) out.push(...decodeLine(this.#buffer));
      this.#buffer = "";
      this.#discarding = false;
      rest = rest.slice(nl + 1);
    }
    return out;
  }

  /** Signal end of input; a non-empty partial line is decoded or reported as truncated. */
  end(): DecodeResult[] {
    const line = this.#buffer;
    this.#buffer = "";
    this.#discarding = false;
    if (line.trim() === "") return [];
    const decoded = decodeLine(line);
    return decoded[0]?.kind === "message" ? decoded : [{ kind: "error", code: "truncated", detail: "input ended mid-message" }];
  }

  #lineLength(): number {
    return this.#buffer.endsWith("\r") ? this.#buffer.length - 1 : this.#buffer.length;
  }
}

function decodeLine(raw: string): DecodeResult[] {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  if (line.trim() === "") return [];
  try {
    return [{ kind: "message", value: JSON.parse(line) as unknown }];
  } catch (e) {
    return [{ kind: "error", code: "parse_error", detail: e instanceof Error ? e.message : String(e) }];
  }
}

export function encodeFrame(message: unknown): string {
  const text = JSON.stringify(message) as string | undefined;
  if (text === undefined) throw new Error("message is not JSON-serializable");
  return `${text}\n`;
}
