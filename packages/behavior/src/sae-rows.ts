/**
 * SAE rows files: just the encoder and decoder rows a graph uses, cut from a full SAE
 * by tools/model-lab/sae_rows.py. A 65k-wide SAE is a gigabyte; the rows a behavior
 * graph needs are kilobytes, so that is what ships.
 */
import { fromBase64 } from "./pack.ts";
import type { SaeRows } from "./pack.ts";

const FORMAT = "harness.sae-rows/v1";

interface Row {
  readonly weights: Float32Array;
  readonly bias: number;
  readonly threshold: number;
  readonly decoder: Float32Array;
}

const positiveInt = (v: unknown, what: string): number => {
  if (!Number.isInteger(v) || (v as number) < 1) throw new Error(`SAE rows ${what} must be a positive integer`);
  return v as number;
};

const finite = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what} must be a finite number`);
  return v;
};

/** Parse and check a rows file completely; asking for a feature it does not carry throws. */
export function parseSaeRows(text: string): SaeRows {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("SAE rows file is not valid JSON");
  }
  if (raw["format"] !== FORMAT) throw new Error(`SAE rows format must be ${FORMAT}`);
  const dims = positiveInt(raw["dims"], "dims");
  const width = positiveInt(raw["width"], "width");
  const features = raw["features"];
  if (typeof features !== "object" || features === null) throw new Error("SAE rows features must be an object");
  const rows = new Map<number, Row>();
  for (const [key, value] of Object.entries(features as Record<string, Record<string, unknown>>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= width) throw new Error(`SAE rows feature ${key} is not an index below the width ${width}`);
    rows.set(index, {
      weights: fromBase64(String(value["encoder"]), dims, `feature ${index} encoder`),
      bias: finite(value["bias"], `feature ${index} bias`),
      threshold: finite(value["threshold"], `feature ${index} threshold`),
      decoder: fromBase64(String(value["decoder"]), dims, `feature ${index} decoder`),
    });
  }
  const get = (index: number): Row => {
    const row = rows.get(index);
    if (!row) throw new Error(`feature ${index} is not in the rows file`);
    return row;
  };
  return {
    dims,
    width,
    encoder: (index) => {
      const { weights, bias, threshold } = get(index);
      return { weights, bias, threshold };
    },
    decoder: (index) => get(index).decoder,
  };
}
