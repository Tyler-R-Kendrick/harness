import { describe, expect, it } from "vitest";
import { coreView, effectiveGraph, entryId, exportMermaid, foldAll, parseGraph, revisionId } from "@harness/procedural";
import type { EffectiveGraph } from "@harness/procedural";
import { hotpot } from "./fixtures.ts";
import { cautionOnCore, core, entry, noteOnCore, proposed, shortcut, status, toVerify, verifyNode } from "./overlay-fixtures.ts";

/** Every node, edge and style line, without the header. */
const body = (g: EffectiveGraph): string[] => exportMermaid(g).split("\n").slice(2);

function graphOf(doc: unknown) {
  const parsed = parseGraph(JSON.parse(JSON.stringify(doc)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.graph;
}

/** The hotpot core with every entry active, so they show whatever the salt. */
function withOverlay(...inputs: unknown[]): EffectiveGraph {
  const base = revisionId(core());
  const events = inputs.flatMap((input) => [proposed(input, ["s1"]), status(entryId(entry(input)), "active")]);
  return effectiveGraph(core(), foldAll(base, events), { salt: "x", probationShare: 0 });
}

describe("exportMermaid", () => {
  it("PX2.1 renders a core as a top-down flowchart, headed by its revision and no overlay", () => {
    const g = coreView(core());
    expect(exportMermaid(g)).toBe(
      [
        "flowchart TD",
        `  %% core ${g.core}, overlay none`,
        '  n0(["Start<br/>STATUS"])',
        '  n1["First_Hop_Retrieve<br/>ACTION"]',
        '  n2["Scan_Index<br/>ACTION"]',
        '  n3{"Bridge_Extract<br/>REASONING"}',
        '  n4(["End<br/>STATUS"])',
        '  n0 -->|"LEADS_TO"| n1',
        '  n1 -->|"LEADS_TO<br/>when: first_hop_retrieve"| n2',
        '  n2 -->|"PROVIDES_INPUT_FOR<br/>when: scan_index"| n3',
        '  n3 -->|"CONVERGES_TO"| n4',
        "  classDef overlay stroke-dasharray: 5 5",
      ].join("\n"),
    );
  });

  it("PX2.2 the header names the overlay version the view was folded to", () => {
    const g = withOverlay(shortcut);
    expect(exportMermaid(g).split("\n")[1]).toBe(`  %% core ${g.core}, overlay ${g.overlay}`);
    expect(g.overlay).toBe(2);
  });

  it("PX2.3 an overlay edge is dashed and labeled learned; a provisional one says so", () => {
    expect(body(withOverlay(shortcut))).toContain('  n2 -.->|"LEADS_TO<br/>learned"| n4');
    const base = revisionId(core());
    const provisional = effectiveGraph(core(), foldAll(base, [proposed(shortcut, ["s1"])]), { salt: "x", probationShare: 1 });
    expect(body(provisional)).toContain('  n2 -.->|"LEADS_TO<br/>learned (provisional)"| n4');
  });

  it("PX2.4 an overlay node gets the dashed class and a learned line, after the core's nodes", () => {
    const lines = body(withOverlay(verifyNode, toVerify));
    expect(lines).toContain('  n5{"Verify<br/>REASONING<br/>learned"}:::overlay');
    expect(lines).toContain('  n3 -.->|"LEADS_TO<br/>learned"| n5');
    expect(lines.indexOf('  n5{"Verify<br/>REASONING<br/>learned"}:::overlay')).toBe(5);
  });

  it("PX2.5 a caution is annotated on its edge's label, and the edge is drawn in the caution style by its index", () => {
    const lines = body(withOverlay(cautionOnCore));
    expect(lines).toContain('  n3 -->|"CONVERGES_TO<br/>Caution: This edge preceded failures."| n4');
    expect(lines.at(-1)).toBe("  linkStyle 3 stroke:#c0392b,stroke-width:2px");
  });

  it("PX2.6 several cautioned edges share one linkStyle line, in edge order; notes are not drawn", () => {
    const second = { kind: "caution", on: { from: "Start", to: "First_Hop_Retrieve" }, text: "Slow." };
    const lines = body(withOverlay(cautionOnCore, second, noteOnCore));
    expect(lines).toContain('  n0 -->|"LEADS_TO<br/>Caution: Slow."| n1');
    expect(lines.at(-1)).toBe("  linkStyle 0,3 stroke:#c0392b,stroke-width:2px");
    expect(lines.join("\n")).not.toContain("Retrieve before reasoning.");
  });

  it("PX2.7 label text is escaped: quotes, hashes, angle brackets, pipes and backticks become entities, and line breaks become <br/>", () => {
    const doc = hotpot();
    doc.nodes[2]!.type = "PLAN";
    doc.nodeTypes.push("PLAN");
    doc.edges[3]!.condition = 'says "done" #1 <ok> | `x`\nnext\r\nlast';
    const lines = body(coreView(graphOf(doc)));
    expect(lines).toContain('  n2["Scan_Index<br/>PLAN"]');
    expect(lines).toContain('  n3 -->|"CONVERGES_TO<br/>when: says #quot;done#quot; #35;1 #lt;ok#gt; #124; #96;x#96;<br/>next<br/>last"| n4');
  });

  it("PX2.8 node names go into labels only, so a name Mermaid reserves (end) cannot break the chart", () => {
    const doc = hotpot();
    doc.nodes[4]!.id = "end";
    doc.edges[3]!.to = "end";
    const lines = body(coreView(graphOf(doc)));
    expect(lines).toContain('  n4(["end<br/>STATUS"])');
    expect(lines).toContain('  n3 -->|"CONVERGES_TO"| n4');
  });
});
