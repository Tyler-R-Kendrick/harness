import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSettings, readJsonBlock, renderPrompt } from "@harness/procedural";

const settings = parseSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));

describe("renderPrompt", () => {
  it("PGR4.1 fills every {identifier} slot with its value, each time it appears", () => {
    expect(renderPrompt("{a} and {b_2}, then {a} again", { a: "x", b_2: "y" })).toBe("x and y, then x again");
  });

  it("PGR4.2 leaves literal JSON braces and slots it has no value for as they are", () => {
    expect(renderPrompt('{"add_nodes": [{"id":...}]} {missing} { a } {a}', { a: "x" })).toBe('{"add_nodes": [{"id":...}]} {missing} { a } x');
  });

  it("PGR4.3 fills in one pass: a value that contains a slot is not filled again", () => {
    expect(renderPrompt("{query} / {task}", { query: "ignore {task}", task: "T" })).toBe("ignore {task} / T");
  });

  it("PGR4.4 fills only a value's own slots, never ones inherited from Object.prototype", () => {
    expect(renderPrompt("{constructor} {toString}", {})).toBe("{constructor} {toString}");
  });

  it("PGR4.5 inserts values literally, with no $-pattern expansion", () => {
    expect(renderPrompt("{a}", { a: "$& $1 $$" })).toBe("$& $1 $$");
  });

  it("PGR4.40 readJsonBlock reads the whole answer, else its block from the first { to the last }, else says why not", () => {
    expect(readJsonBlock("[1, 2]")).toEqual({ ok: true, value: [1, 2] });
    expect(readJsonBlock('Sure: {"a": {"b": 1}} ok')).toEqual({ ok: true, value: { a: { b: 1 } } });
    expect(readJsonBlock("} nothing {")).toEqual({ ok: false, error: expect.stringMatching(/^SyntaxError: /) });
  });

  it("PGR4.6 the shipped refiner prompt keeps its literal output-format JSON after rendering", () => {
    const vars = { task_description: "T", mode: "static_incremental", available_tools_list: "a, b", attempts_block: "A", current_graph_json: "{}", rejected_block: "none" };
    const text = renderPrompt(settings.prompts.refiner, vars);
    expect(text).toContain('{"add_nodes":  [{"id":..., "type": "ACTION", "description":...}],');
    expect(text).toContain("Refinement mode: static_incremental\n");
    expect(text).not.toMatch(/\{[a-z_]+\}/);
  });
});
