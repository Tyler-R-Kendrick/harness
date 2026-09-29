import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { coreView, neighborhood, NodeNameSchema, parseGraph, serializeGraph, serializeNeighborhood, serializeWindow } from "@harness/procedural";
import type { EffectiveEdge, EffectiveGraph, EffectiveNode, ScoredTrajectory } from "@harness/procedural";
import { hotpot } from "./fixtures.ts";
import type { DocInput } from "./fixtures.ts";

const name = (n: string) => NodeNameSchema.parse(n);
const view = (doc: DocInput): EffectiveGraph => {
  const parsed = parseGraph(doc);
  if (!parsed.ok) throw new Error(`fixture: ${parsed.diagnostics.map((d) => d.message).join("; ")}`);
  return coreView(parsed.graph);
};

/**
 * The graph App. B.5's "Serialized Local Graph Context (HotpotQA; excerpt)" describes:
 * First_Hop_Retrieve → Scan_Index → Bridge_Extract with the excerpt's own text. The paper
 * names the two stored relations (LEADS_TO, PROVIDES_INPUT_FOR) and says its serializer
 * does not print them; which edge carries which is not stated, so either order must give
 * the same text. Start and End make it a checkable graph; the excerpt never reaches them.
 */
const excerptGraph = (relations: readonly [string, string] = ["LEADS_TO", "PROVIDES_INPUT_FOR"]): DocInput => ({
  format: "harness.procedural-graph/v1",
  nodeTypes: ["ACTION", "REASONING", "STATUS"],
  relations: ["LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO"],
  nodes: [
    { id: "Start", type: "STATUS", description: "The task begins." },
    { id: "First_Hop_Retrieve", type: "ACTION", description: "Execute first_hop_retrieve to fetch primary evidence passages.", binding: { kind: "tool", name: "first_hop_retrieve" } },
    { id: "Scan_Index", type: "ACTION", description: "Execute scan_index to read the retrieved passages." },
    { id: "Bridge_Extract", type: "ACTION", description: "Execute bridge_extract to name the bridge entity." },
    { id: "End", type: "STATUS", description: "The answer is given." },
  ],
  edges: [
    { from: "Start", relation: "LEADS_TO", to: "First_Hop_Retrieve", condition: null, guidance: "Retrieve first.", pitfalls: "Do not answer from memory." },
    {
      from: "First_Hop_Retrieve",
      relation: relations[0],
      to: "Scan_Index",
      condition: "first_hop_retrieve",
      guidance: "Review the retrieved primary passages via Scan_Index to locate specific bridge terms (such as birth dates, locations, or associated entities).",
      pitfalls: "Do not skip reading evidence details; missing the exact bridge entity name causes second-hop search failure.",
    },
    {
      from: "Scan_Index",
      relation: relations[1],
      to: "Bridge_Extract",
      condition: "scan_index",
      guidance: "Extract the explicit connecting entity or bridge term linking the first passage to the target question.",
      pitfalls: "Ensure the extracted bridge term matches exact Wikipedia capitalization conventions.",
    },
    { from: "Bridge_Extract", relation: "CONVERGES_TO", to: "End", condition: null, guidance: "Answer with the bridge entity.", pitfalls: "Do not guess." },
  ],
});

/**
 * The golden file ends with a newline, as text files do; the serializer's text has none,
 * so exactly one trailing newline is removed. Nothing else is normalized.
 */
const golden = readFileSync(new URL("./fixtures/hotpot-local-context.txt", import.meta.url), "utf8").replace(/\n$/, "");

/**
 * The excerpt as the paper's extracted text gives it (App. B.5). Two normalizations,
 * both of the extraction rather than of the text: the PDF's arrow is extracted as the
 * LaTeX `$\rightarrow$`, which the paper renders as "→", and the extraction drops each
 * line's leading indentation, so the comparison strips it from the serializer's lines
 * (the serializer indents a transition's bullets by two spaces under it).
 */
const PAPER_EXCERPT = String.raw`Active Cognitive Node: [First_Hop_Retrieve] (Type: ACTION)
Description: Execute first_hop_retrieve to fetch primary evidence passages.
Immediate Transition Options (Hop 1):
- Transition: [First_Hop_Retrieve] $\rightarrow$ [Scan_Index] (Condition: first_hop_retrieve)
* Guidance: Review the retrieved primary passages via Scan_Index to locate specific bridge terms (such as birth dates, locations, or associated entities).
* Pitfalls to Avoid: Do not skip reading evidence details; missing the exact bridge entity name causes second-hop search failure.
Subsequent Horizon (Hop 2):
- Transition: [Scan_Index] $\rightarrow$ [Bridge_Extract] (Condition: scan_index)
* Guidance: Extract the explicit connecting entity or bridge term linking the first passage to the target question.
* Pitfalls to Avoid: Ensure the extracted bridge term matches exact Wikipedia capitalization conventions.`;

const unindent = (text: string) => text.split("\n").map((l) => l.trimStart()).join("\n");

const local = (g: EffectiveGraph, node: string, hops = 2) => serializeNeighborhood(g, neighborhood(g, name(node), hops));

/** A core view with overlay content added by hand, as the overlay's effective graph would hold it. */
function withOverlay(): EffectiveGraph {
  const core = view(excerptGraph());
  const overlayNode: EffectiveNode = { id: name("Verify_Answer"), type: "REASONING", description: "Check the bridge entity against the question.", origin: "overlay", status: "probation" };
  const learnedEdge = (to: string, status: "probation" | "active"): EffectiveEdge => ({
    from: name("Scan_Index"),
    relation: "LEADS_TO",
    to: name(to),
    condition: null,
    guidance: `Seen in 3 sessions: go to ${to}.`,
    pitfalls: "",
    origin: "overlay",
    status,
    notes: [],
    cautions: [],
  });
  const edges = core.edges.map((e): EffectiveEdge =>
    e.from === "First_Hop_Retrieve"
      ? {
          ...e,
          notes: [
            { text: "Quote the passage title.", status: "probation" },
            { text: "Keep dates verbatim.", status: "active" },
          ],
          cautions: [{ text: "This edge preceded failures in 4 of 5 sessions.", status: "active" }],
        }
      : e,
  );
  return { ...core, overlay: 7, nodes: [...core.nodes, overlayNode], edges: [...edges, learnedEdge("Verify_Answer", "probation"), learnedEdge("End", "active")] };
}

describe("serializeNeighborhood", () => {
  it("PGR3.14 the core view of App. B.5's HotpotQA graph serializes to the golden file exactly", () => {
    const g = view(excerptGraph());
    expect(local(g, "First_Hop_Retrieve")).toBe(golden);
    // The relation labels are not printed, so swapping them changes nothing.
    expect(local(view(excerptGraph(["PROVIDES_INPUT_FOR", "LEADS_TO"])), "First_Hop_Retrieve")).toBe(golden);
  });

  it("PGR3.15 the golden file is the paper's excerpt, up to the extraction's arrow and indentation", () => {
    expect(unindent(golden)).toBe(PAPER_EXCERPT.replaceAll(String.raw`$\rightarrow$`, "→"));
    expect(golden.split("\n").filter((l) => l.startsWith("  * "))).toHaveLength(4);
  });

  it("PGR3.16 a null condition prints nothing after 'Condition: ', and an empty guidance or pitfalls keeps its line", () => {
    const g = view(excerptGraph());
    expect(local(g, "Start", 1)).toBe(
      ["Active Cognitive Node: [Start] (Type: STATUS)", "Description: The task begins.", "Immediate Transition Options (Hop 1):", "- Transition: [Start] → [First_Hop_Retrieve] (Condition: )", "  * Guidance: Retrieve first.", "  * Pitfalls to Avoid: Do not answer from memory."].join("\n"),
    );
    const blank = view({ ...hotpot(), edges: hotpot().edges.map((e) => ({ ...e, guidance: "", pitfalls: "" })) });
    expect(local(blank, "Bridge_Extract", 1).split("\n").slice(-2)).toEqual(["  * Guidance: ", "  * Pitfalls to Avoid: "]);
  });

  it("PGR3.17 hop 3 and beyond are headed 'Subsequent Horizon (Hop k)', and hops with no edges print nothing", () => {
    const g = view(excerptGraph());
    const text = local(g, "Start", 5);
    expect(text.split("\n").filter((l) => l.endsWith("):") && !l.startsWith("-"))).toEqual([
      "Immediate Transition Options (Hop 1):",
      "Subsequent Horizon (Hop 2):",
      "Subsequent Horizon (Hop 3):",
      "Subsequent Horizon (Hop 4):",
    ]);
    expect(text).not.toContain("Hop 5");
    expect(local(g, "End", 2)).toBe("Active Cognitive Node: [End] (Type: STATUS)\nDescription: The answer is given.");
    expect(local(g, "Bridge_Extract", 0)).toBe("Active Cognitive Node: [Bridge_Extract] (Type: ACTION)\nDescription: Execute bridge_extract to name the bridge entity.");
  });

  it("PGR3.18 an overlay edge is labeled 'Learned (provisional)' on probation and 'Learned' once active; core edges are not labeled", () => {
    const text = local(withOverlay(), "Scan_Index", 1);
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toEqual([
      "- Transition: [Scan_Index] → [Bridge_Extract] (Condition: scan_index)",
      "- Learned (provisional): Transition: [Scan_Index] → [Verify_Answer] (Condition: )",
      "- Learned: Transition: [Scan_Index] → [End] (Condition: )",
    ]);
    expect(text).toContain("- Learned (provisional): Transition: [Scan_Index] → [Verify_Answer] (Condition: )\n  * Guidance: Seen in 3 sessions: go to Verify_Answer.\n  * Pitfalls to Avoid: \n");
  });

  it("PGR3.19 notes follow the edge's pitfalls as 'Learned note', marked provisional on probation, then cautions as 'Caution'", () => {
    const text = local(withOverlay(), "First_Hop_Retrieve", 1);
    expect(text.split("\n").slice(3)).toEqual([
      "- Transition: [First_Hop_Retrieve] → [Scan_Index] (Condition: first_hop_retrieve)",
      "  * Guidance: Review the retrieved primary passages via Scan_Index to locate specific bridge terms (such as birth dates, locations, or associated entities).",
      "  * Pitfalls to Avoid: Do not skip reading evidence details; missing the exact bridge entity name causes second-hop search failure.",
      "  * Learned note (provisional): Quote the passage title.",
      "  * Learned note: Keep dates verbatim.",
      "  * Caution: This edge preceded failures in 4 of 5 sessions.",
    ]);
  });

  it("PGR3.20 an overlay node is labeled where it is the active node, provisional on probation", () => {
    const g = withOverlay();
    expect(local(g, "Verify_Answer", 1)).toBe("Learned (provisional): Active Cognitive Node: [Verify_Answer] (Type: REASONING)\nDescription: Check the bridge entity against the question.");
    const active: EffectiveGraph = { ...g, nodes: g.nodes.map((n) => (n.origin === "overlay" ? { ...n, status: "active" } : n)) };
    expect(local(active, "Verify_Answer", 1).split("\n")[0]).toBe("Learned: Active Cognitive Node: [Verify_Answer] (Type: REASONING)");
  });

  it("PGR3.21 a core view never carries an overlay label, and the overlay's labels appear only for overlay content", () => {
    const core = view(excerptGraph());
    for (const n of core.nodes) {
      const text = local(core, n.id, 4);
      expect(text).not.toMatch(/Learned|Caution/);
    }
    expect(serializeGraph(core)).not.toMatch(/Learned|Caution/);
    expect(local(withOverlay(), "First_Hop_Retrieve", 2)).toMatch(/Learned note[^\n]*\n[\s\S]*Caution: [\s\S]*- Learned \(provisional\): Transition/);
  });

  it("PGR3.22 a neighborhood whose active node is not in the graph is a RangeError", () => {
    const g = view(excerptGraph());
    expect(() => serializeNeighborhood(g, { active: name("Nowhere"), hops: [] })).toThrow(RangeError);
    expect(() => serializeNeighborhood(g, { active: name("Nowhere"), hops: [] })).toThrow("Nowhere");
  });
});

describe("serializeGraph", () => {
  it("PGR3.23 the full-graph variant lists every node, then every transition in document order, in the local format", () => {
    const g = view(hotpot());
    expect(serializeGraph(g)).toBe(
      [
        "Procedural Graph Nodes:",
        "- Node: [Start] (Type: STATUS)",
        "  * Description: The task begins.",
        "- Node: [First_Hop_Retrieve] (Type: ACTION)",
        "  * Description: Execute first_hop_retrieve to fetch primary evidence passages.",
        "- Node: [Scan_Index] (Type: ACTION)",
        "  * Description: Scan the retrieved passages.",
        "- Node: [Bridge_Extract] (Type: REASONING)",
        "  * Description: Extract the bridge entity.",
        "- Node: [End] (Type: STATUS)",
        "  * Description: The answer is given.",
        "Procedural Graph Transitions:",
        "- Transition: [Start] → [First_Hop_Retrieve] (Condition: )",
        "  * Guidance: After Start, go to First_Hop_Retrieve.",
        "  * Pitfalls to Avoid: Do not skip First_Hop_Retrieve.",
        "- Transition: [First_Hop_Retrieve] → [Scan_Index] (Condition: first_hop_retrieve)",
        "  * Guidance: After First_Hop_Retrieve, go to Scan_Index.",
        "  * Pitfalls to Avoid: Do not skip Scan_Index.",
        "- Transition: [Scan_Index] → [Bridge_Extract] (Condition: scan_index)",
        "  * Guidance: After Scan_Index, go to Bridge_Extract.",
        "  * Pitfalls to Avoid: Do not skip Bridge_Extract.",
        "- Transition: [Bridge_Extract] → [End] (Condition: )",
        "  * Guidance: After Bridge_Extract, go to End.",
        "  * Pitfalls to Avoid: Do not skip End.",
      ].join("\n"),
    );
  });

  it("PGR3.24 the full graph labels overlay nodes, edges, notes and cautions as the local variant does", () => {
    const lines = serializeGraph(withOverlay()).split("\n");
    expect(lines).toContain("- Learned (provisional): Node: [Verify_Answer] (Type: REASONING)");
    expect(lines).toContain("- Learned (provisional): Transition: [Scan_Index] → [Verify_Answer] (Condition: )");
    expect(lines).toContain("- Learned: Transition: [Scan_Index] → [End] (Condition: )");
    expect(lines).toContain("  * Learned note (provisional): Quote the passage title.");
    expect(lines).toContain("  * Caution: This edge preceded failures in 4 of 5 sessions.");
    const active: EffectiveGraph = { ...withOverlay(), nodes: withOverlay().nodes.map((n) => (n.origin === "overlay" ? { ...n, status: "active" } : n)) };
    expect(serializeGraph(active).split("\n")).toContain("- Learned: Node: [Verify_Answer] (Type: REASONING)");
  });
});

type Step = ScoredTrajectory["steps"][number];
const user = (content: string): Step => ({ role: "user", content });
const think = (content: string): Step => ({ role: "assistant", content });
const act = (content: string, tool: string, args: Record<string, unknown> = {}): Step => ({ role: "assistant", content, call: { name: tool, arguments: args } });
const result = (content: string): Step => ({ role: "tool", content });
const observe = (content: string): Step => ({ role: "observation", content });

describe("serializeWindow", () => {
  it("PGR3.25 steps render as the solver's ReAct text: Thought, Action(tool(arg=value)), Observation, User", () => {
    const steps = [act("I need the first passage.", "first_hop_retrieve", { query: "film director", k: 3, filters: { lang: "en", year: null } }), result("passages"), observe("the page changed"), user("And the year?")];
    expect(serializeWindow(steps, 3)).toBe(
      [
        "Thought: I need the first passage.",
        'Action: first_hop_retrieve(query="film director", k=3, filters={"lang":"en","year":null})',
        "Observation: passages",
        "Observation: the page changed",
        "User: And the year?",
      ].join("\n"),
    );
    expect(serializeWindow([act("", "list_dir", { path: "." })], 3)).toBe('Action: list_dir(path=".")');
    expect(serializeWindow([act("", "finish")], 3)).toBe("Action: finish()");
    expect(serializeWindow([think("The answer is Paris.")], 3)).toBe("Thought: The answer is Paris.");
    expect(serializeWindow([think("Check."), { role: "tool", content: "done", call: { name: "t", arguments: {} } }], 3)).toBe("Thought: Check.\nObservation: done\nAction: t()");
  });

  it("PGR3.26 the window is the last w decisions (the paper's T_{t-w:t}): a run of assistant steps with what follows it", () => {
    const steps = [
      user("Who directed the film?"),
      act("Retrieve.", "first_hop_retrieve"),
      result("p1"),
      think("Scan next."),
      act("", "scan_index"),
      act("", "scan_index", { page: 2 }),
      result("p2"),
      result("p3"),
      act("Extract.", "bridge_extract"),
      result("bridge"),
      think("It is Nolan."),
    ];
    const text = (w: number) => serializeWindow(steps, w).split("\n");
    expect(text(1)).toEqual(["Thought: It is Nolan."]);
    expect(text(2)).toEqual(["Thought: Extract.", "Action: bridge_extract()", "Observation: bridge", "Thought: It is Nolan."]);
    expect(text(3)[0]).toBe("Thought: Scan next.");
    expect(text(3)).toHaveLength(9);
    expect(text(4)[0]).toBe("Thought: Retrieve.");
    // The query before the first decision is the prompt's own {query}, never the window's.
    expect(text(5)).toEqual(text(4));
    expect(serializeWindow([user("Who directed the film?")], 3)).toBe("");
  });

  it("PGR3.27 an empty trajectory or a zero window is empty text, and a window that is not a whole number is a RangeError", () => {
    expect(serializeWindow([], 3)).toBe("");
    expect(serializeWindow([act("Retrieve.", "first_hop_retrieve")], 0)).toBe("");
    expect(() => serializeWindow([], -1)).toThrow(RangeError);
    expect(() => serializeWindow([], 2.5)).toThrow("window");
  });
});
