import { describe, expect, it } from "vitest";
import { embeddingPrompt, truncateEmbedding } from "@harness/cognitive";

const norm = (v: Float32Array) => Math.hypot(...v);

/** An embedding model's prompts from its catalog entry. */
const config = { query: "task: {task} | query: {text}", document: "title: {title} | text: {text}", defaults: { task: "search result", title: "none" } };

describe("embedding prompts", () => {
  it("EG1.1 a query fills the model's query template, with the catalog's default task", () => {
    expect(embeddingPrompt(config, { kind: "query", text: "which planet is red?" })).toBe("task: search result | query: which planet is red?");
  });

  it("EG1.2 a query's own task replaces the default", () => {
    expect(embeddingPrompt(config, { kind: "query", text: "x", task: "code retrieval" })).toBe("task: code retrieval | query: x");
  });

  it("EG1.3 a document fills the document template, with its title or the default", () => {
    expect(embeddingPrompt(config, { kind: "document", text: "Mars is red." })).toBe("title: none | text: Mars is red.");
    expect(embeddingPrompt(config, { kind: "document", text: "Mars is red.", title: "Planets" })).toBe("title: Planets | text: Mars is red.");
  });

  it("EG1.4 a model without templates beyond {text} sees the bare text; unknown placeholders are empty", () => {
    expect(embeddingPrompt({ query: "{text}", document: "{text}" }, { kind: "query", text: "hi", task: "ignored" })).toBe("hi");
    expect(embeddingPrompt({ query: "[{missing}]{text}", document: "{text}" }, { kind: "query", text: "hi" })).toBe("[]hi");
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

});
