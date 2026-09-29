/** Graph documents as untrusted JSON (what a file or a refiner gives), for parsing tests. */

export interface DocInput {
  $schema?: string;
  format: string;
  nodeTypes: string[];
  relations: string[];
  nodes: { id: string; type: string; description: string; binding?: unknown }[];
  edges: { from: string; relation: string; to: string; condition: string | null; guidance: string; pitfalls: string }[];
}

const edge = (from: string, to: string, relation = "LEADS_TO", condition: string | null = null): DocInput["edges"][number] => ({
  from,
  relation,
  to,
  condition,
  guidance: `After ${from}, go to ${to}.`,
  pitfalls: `Do not skip ${to}.`,
});

/** A small retrieval procedure (after App. B.5's HotpotQA excerpt): Start → retrieve → scan → extract → answer → End. */
export function hotpot(): DocInput {
  return {
    format: "harness.procedural-graph/v1",
    nodeTypes: ["ACTION", "REASONING", "STATUS"],
    relations: ["LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO"],
    nodes: [
      { id: "Start", type: "STATUS", description: "The task begins." },
      { id: "First_Hop_Retrieve", type: "ACTION", description: "Execute first_hop_retrieve to fetch primary evidence passages.", binding: { kind: "tool", name: "first_hop_retrieve" } },
      { id: "Scan_Index", type: "ACTION", description: "Scan the retrieved passages." },
      { id: "Bridge_Extract", type: "REASONING", description: "Extract the bridge entity." },
      { id: "End", type: "STATUS", description: "The answer is given." },
    ],
    edges: [
      edge("Start", "First_Hop_Retrieve"),
      edge("First_Hop_Retrieve", "Scan_Index", "LEADS_TO", "first_hop_retrieve"),
      edge("Scan_Index", "Bridge_Extract", "PROVIDES_INPUT_FOR", "scan_index"),
      edge("Bridge_Extract", "End", "CONVERGES_TO"),
    ],
  };
}

export { edge };
