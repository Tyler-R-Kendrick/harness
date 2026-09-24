import { describe, expect, it } from "vitest";
import { cosine, EMBEDDING_GEMMA_DIMENSIONS, embeddingGemmaPrompt, truncateEmbedding } from "@harness/cognitive";

const norm = (v: Float32Array) => Math.hypot(...v);

describe("EmbeddingGemma prompts", () => {
  it("EG1.1 a query defaults to the search-result task prefix", () => {
    expect(embeddingGemmaPrompt({ kind: "query", text: "which planet is red?" })).toBe("task: search result | query: which planet is red?");
  });

  it("EG1.2 a query carries its task name", () => {
    expect(embeddingGemmaPrompt({ kind: "query", text: "x", task: "code retrieval" })).toBe("task: code retrieval | query: x");
    expect(embeddingGemmaPrompt({ kind: "query", text: "x", task: "sentence similarity" })).toBe("task: sentence similarity | query: x");
  });

  it("EG1.3 a document carries its title, or none", () => {
    expect(embeddingGemmaPrompt({ kind: "document", text: "Mars is red." })).toBe("title: none | text: Mars is red.");
    expect(embeddingGemmaPrompt({ kind: "document", text: "Mars is red.", title: "Planets" })).toBe("title: Planets | text: Mars is red.");
  });

  it("EG1.4 the Matryoshka sizes are 768, 512, 256 and 128", () => {
    expect([...EMBEDDING_GEMMA_DIMENSIONS]).toEqual([768, 512, 256, 128]);
  });
});

describe("embedding vectors", () => {
  it("EG2.1 truncation keeps the leading components and renormalizes to unit length", () => {
    const v = new Float32Array([3, 4, 12, 0]);
    const t = truncateEmbedding(v, 2);
    expect(Array.from(t)).toEqual([expect.closeTo(0.6, 6), expect.closeTo(0.8, 6)]);
    expect(norm(t)).toBeCloseTo(1, 6);
    expect(truncateEmbedding(v, 4)).not.toBe(v);
  });

  it("EG2.2 truncation rejects sizes that are not a positive integer within the vector", () => {
    const v = new Float32Array([1, 0]);
    expect(() => truncateEmbedding(v, 3)).toThrow(/dimensions/);
    expect(() => truncateEmbedding(v, 0)).toThrow(/dimensions/);
    expect(() => truncateEmbedding(v, 1.5)).toThrow(/dimensions/);
    expect(() => truncateEmbedding(new Float32Array([0, 0, 1]), 2)).toThrow(/zero/);
  });

  it("EG2.3 cosine similarity of identical, opposite and orthogonal vectors", () => {
    expect(cosine(new Float32Array([1, 2]), new Float32Array([2, 4]))).toBeCloseTo(1, 9);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([-3, 0]))).toBeCloseTo(-1, 9);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 5]))).toBeCloseTo(0, 9);
  });

  it("EG2.4 cosine rejects mismatched lengths and zero vectors", () => {
    expect(() => cosine(new Float32Array([1]), new Float32Array([1, 0]))).toThrow(/length/);
    expect(() => cosine(new Float32Array([0, 0]), new Float32Array([1, 0]))).toThrow(/zero/);
  });
});
