import { base64 } from "@scure/base";
import { z } from "zod";

/** Float vectors travel as base64 of little-endian float32s. */
export const toBase64 = (v: Float32Array): string => base64.encode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));

export const floats = z.string().transform((text, ctx) => {
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(text);
  } catch {
    ctx.addIssue({ code: "custom", message: "not valid base64" });
    return z.NEVER;
  }
  if (bytes.length % 4 !== 0) {
    ctx.addIssue({ code: "custom", message: "not a whole number of float32 values" });
    return z.NEVER;
  }
  const v = new Float32Array(bytes.slice().buffer);
  if (!v.every(Number.isFinite)) {
    ctx.addIssue({ code: "custom", message: "has non-finite values" });
    return z.NEVER;
  }
  return v;
});
