import { z } from "zod";

/**
 * Values with invariants, as refined types. Each is a number or string branded with
 * what it is (and its unit), made only by parsing: a Probability is in [0, 1] because
 * nothing else can be one, and bytes, dimensions and tokens cannot stand in for one
 * another. Lint forbids forging them with `as`; construct them here, or parse them with
 * these schemas at a boundary.
 */
export const ProbabilitySchema = z.number().min(0).max(1).brand<"Probability">();
/** A probability or calibrated confidence, in [0, 1]. */
export type Probability = z.output<typeof ProbabilitySchema>;

export const SimilaritySchema = z.number().min(-1).max(1).brand<"Similarity">();
/** A cosine similarity, in [-1, 1]. */
export type Similarity = z.output<typeof SimilaritySchema>;

export const BytesSchema = z.int().min(0).brand<"Bytes">();
/** A size in bytes. */
export type Bytes = z.output<typeof BytesSchema>;
/** Bytes of something that is never empty (a file of weights). */
export const PositiveBytesSchema = z.int().positive().brand<"Bytes">();

export const DimensionsSchema = z.int().positive().brand<"Dimensions">();
/** An embedding's number of dimensions. */
export type Dimensions = z.output<typeof DimensionsSchema>;

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "a lowercase hex sha256").brand<"Sha256">();
export type Sha256 = z.output<typeof Sha256Schema>;

export const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, "a pinned commit, never a branch").brand<"CommitSha">();
export type CommitSha = z.output<typeof CommitShaSchema>;

function refine<S extends z.ZodType>(schema: S, what: string): (value: unknown) => z.output<S> {
  return (value) => {
    const result = schema.safeParse(value);
    if (!result.success) throw new RangeError(`not ${what}: ${JSON.stringify(value)}\n${z.prettifyError(result.error)}`);
    return result.data;
  };
}

export const probability = refine(ProbabilitySchema, "a probability");
export const similarity = refine(SimilaritySchema, "a similarity");
export const bytes = refine(BytesSchema, "a number of bytes");
export const dimensions = refine(DimensionsSchema, "a number of dimensions");
export const sha256 = refine(Sha256Schema, "a sha256");
export const commitSha = refine(CommitShaSchema, "a commit sha");

/** Bytes add to bytes. */
export const sumBytes = (sizes: readonly Bytes[]): Bytes => bytes(sizes.reduce<number>((total, b) => total + b, 0));
