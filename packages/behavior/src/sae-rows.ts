/**
 * SAE rows files: just the encoder and decoder rows a graph uses, cut from a full SAE
 * by tools/model-lab/sae_rows.py. A 65k-wide SAE is a gigabyte; the rows a behavior
 * graph needs are kilobytes, so that is what ships.
 */
import { z } from "zod";
import { floats } from "./floats.ts";
import type { SaeRows } from "./pack.ts";

const Row = z.strictObject({ encoder: floats, bias: z.number(), threshold: z.number(), decoder: floats });

const RowsFile = z
  .object({
    format: z.literal("harness.sae-rows/v1"),
    dims: z.int().positive(),
    width: z.int().positive(),
    features: z.record(z.string().regex(/^\d+$/), Row),
  })
  .superRefine((f, ctx) => {
    for (const [key, row] of Object.entries(f.features)) {
      if (Number(key) >= f.width) ctx.addIssue({ code: "custom", message: `feature ${key} is not below the width ${f.width}`, path: ["features", key] });
      for (const part of ["encoder", "decoder"] as const) {
        if (row[part].length !== f.dims) ctx.addIssue({ code: "custom", message: `has ${row[part].length} values, expected ${f.dims}`, path: ["features", key, part] });
      }
    }
  });

/** Parse a rows file completely; asking the result for a feature it does not carry throws. */
export function parseSaeRows(text: string): SaeRows {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("SAE rows file is not valid JSON");
  }
  const result = RowsFile.safeParse(raw);
  if (!result.success) throw new Error(`invalid SAE rows file\n${z.prettifyError(result.error)}`);
  const { dims, width, features } = result.data;
  const row = (index: number) => {
    const r = features[index];
    if (!r) throw new Error(`feature ${index} is not in the rows file`);
    return r;
  };
  return {
    dims,
    width,
    encoder: (index) => {
      const { encoder, bias, threshold } = row(index);
      return { weights: encoder, bias, threshold };
    },
    decoder: (index) => row(index).decoder,
  };
}
