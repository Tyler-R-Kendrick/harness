import { describe, expect, it } from "vitest";
import {
  anchoredNonInferiority,
  approvalGate,
  atLeastRetained,
  emptyOverlay,
  evidenceGate,
  foldAll,
  graphSize,
  normalQuantile,
  pairedDifference,
  parseGraph,
  poorStatistics,
  powerMargin,
  revisionId,
  routesIntoSideEffects,
  structureGate,
} from "@harness/procedural";
import type { CandidateDocument, OverlayEvent, ProceduralGraph, TaskScore } from "@harness/procedural";
import { edge, hotpot } from "./fixtures.ts";
import type { DocInput } from "./fixtures.ts";
import { cautionOnCore, idOf, noteOnCore, observed, proposed, status } from "./overlay-fixtures.ts";

const graphOf = (doc: DocInput): ProceduralGraph => {
  const parsed = parseGraph(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.graph;
};
const base = graphOf(hotpot());
const baseId = revisionId(base);
const overlayOf = (...events: OverlayEvent[]) => foldAll(baseId, events);
const scores = (values: readonly number[], prefix = "t"): TaskScore[] => values.map((score, i) => ({ task: `${prefix}${i}`, score }));
const ni = { totalLoss: 0.05, confidence: 0.95, power: 0.8 };
const live = { minSupport: 3, confidence: 0.9 };

/** The hotpot graph with one change. */
const edited = (change: (doc: DocInput) => void): CandidateDocument => {
  const doc = hotpot();
  change(doc);
  return graphOf(doc);
};

describe("structure and the paper's gate", () => {
  it("PD1.1 structureGate passes a candidate with no diagnostics and names every diagnostic otherwise", () => {
    expect(structureGate({ diagnostics: [] })).toEqual({ pass: true, reason: "the candidate passes the structural checks" });
    const failed = structureGate({
      diagnostics: [
        { code: "missing-endpoint", message: "edge names Ghost", at: "edges[3]" },
        { code: "filtered", message: "url: a URL" },
      ],
    });
    expect(failed).toEqual({ pass: false, reason: "missing-endpoint at edges[3]: edge names Ghost; filtered: url: a URL" });
  });

  it("PD1.2 atLeastRetained accepts a validation mean at least the retained cached score, ties included (App. B.6 line 16)", () => {
    expect(atLeastRetained({ candidate: 0.5, retained: 0.5 })).toEqual({ pass: true, reason: "validation 0.5000 ≥ retained 0.5000" });
    expect(atLeastRetained({ candidate: 0.61, retained: 0.6 }).pass).toBe(true);
    expect(atLeastRetained({ candidate: 0.59, retained: 0.6 })).toEqual({ pass: false, reason: "validation 0.5900 < retained 0.6000" });
  });
});

describe("statistics", () => {
  it("PD1.3 normalQuantile inverts the standard normal distribution in the tails and the center", () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416212335729143, 8);
    expect(normalQuantile(0.95)).toBeCloseTo(1.6448536269514722, 8);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 8);
    expect(normalQuantile(0.2)).toBeCloseTo(-0.8416212335729143, 8);
    expect(normalQuantile(0.01)).toBeCloseTo(-2.3263478740408408, 8);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232306167813, 8);
    expect(normalQuantile(0.999)).toBeCloseTo(3.090232306167813, 8);
    expect(normalQuantile(0.99)).toBeCloseTo(2.3263478740408408, 8);
    expect(normalQuantile(0.02425)).toBeCloseTo(-1.9729610, 6);
    expect(normalQuantile(0.97575)).toBeCloseTo(1.9729610, 6);
    for (const p of [0, 1, -0.1, 1.5, Number.NaN]) expect(() => normalQuantile(p)).toThrow(RangeError);
  });

  it("PD1.4 powerMargin is (z_confidence + z_power) · sqrt(discordance / n)", () => {
    const z = normalQuantile(0.95) + normalQuantile(0.8);
    expect(powerMargin(100, 0.2, 0.95, 0.8)).toBeCloseTo(z * Math.sqrt(0.2 / 100), 12);
    expect(powerMargin(400, 0.2, 0.95, 0.8)).toBeCloseTo(powerMargin(100, 0.2, 0.95, 0.8) / 2, 12);
    expect(powerMargin(50, 0, 0.9, 0.5)).toBe(0);
    expect(() => powerMargin(0, 0.2, 0.95, 0.8)).toThrow(RangeError);
    expect(() => powerMargin(10, -0.1, 0.95, 0.8)).toThrow(RangeError);
  });

  it("PD1.5 binary paired scores use a Newcombe-style interval: Wilson margins joined through the pairs' correlation", () => {
    // a = both pass, b = only the candidate, c = only the retained, d = neither.
    const [a, b, c, d] = [12, 9, 2, 21];
    const cand = [...Array(a).fill(1), ...Array(b).fill(1), ...Array(c).fill(0), ...Array(d).fill(0)];
    const ret = [...Array(a).fill(1), ...Array(b).fill(0), ...Array(c).fill(1), ...Array(d).fill(0)];
    const n = a + b + c + d;
    const z = normalQuantile(0.95);
    const wilson = (x: number): [number, number] => {
      const p = x / n;
      const center = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
      const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
      return [center - half, center + half];
    };
    const p1 = (a + b) / n;
    const p2 = (a + c) / n;
    const [l1] = wilson(a + b);
    const [, u2] = wilson(a + c);
    const phi = (a * d - b * c) / Math.sqrt((a + b) * (c + d) * (a + c) * (b + d));
    const lower = p1 - p2 - Math.sqrt((p1 - l1) ** 2 - 2 * phi * (p1 - l1) * (u2 - p2) + (u2 - p2) ** 2);
    const out = pairedDifference(scores(cand), scores(ret), 0.95, "seed");
    expect(out.method).toBe("newcombe");
    expect(out.n).toBe(n);
    expect(out.difference).toBeCloseTo((b - c) / n, 12);
    expect(out.lower).toBeCloseTo(lower, 12);
    // No correlation term when a margin is degenerate: all candidate scores pass.
    const allPass = pairedDifference(scores([1, 1, 1, 1]), scores([1, 0, 1, 0]), 0.9, "seed");
    const zz = normalQuantile(0.9);
    const lo = (x: number, m: number) => ((x / m + (zz * zz) / (2 * m)) - zz * Math.sqrt(((x / m) * (1 - x / m)) / m + (zz * zz) / (4 * m * m))) / (1 + (zz * zz) / m);
    const hi2 = (x: number, m: number) => ((x / m + (zz * zz) / (2 * m)) + zz * Math.sqrt(((x / m) * (1 - x / m)) / m + (zz * zz) / (4 * m * m))) / (1 + (zz * zz) / m);
    expect(allPass.lower).toBeCloseTo(0.5 - Math.sqrt((1 - lo(4, 4)) ** 2 + (hi2(2, 4) - 0.5) ** 2), 12);
  });

  it("PD1.6 continuous paired scores use a paired bootstrap whose resampler is deterministic in its seed", () => {
    const cand = scores([0.9, 0.4, 0.7, 0.65, 0.3, 0.8, 0.55, 0.95]);
    const ret = scores([0.8, 0.5, 0.6, 0.6, 0.35, 0.7, 0.5, 0.9]);
    const first = pairedDifference(cand, ret, 0.9, "seed-a");
    expect(first.method).toBe("bootstrap");
    expect(first.n).toBe(8);
    expect(first.difference).toBeCloseTo(0.0375, 12);
    expect(pairedDifference(cand, ret, 0.9, "seed-a")).toEqual(first);
    // The resampler is a fixed stream: this bound is a golden value of seed-a's draws.
    expect(first.lower).toBeCloseTo(0.00625, 12);
    expect(first.lower).toBeLessThan(first.difference);
    expect(first.lower).toBeGreaterThan(-0.05);
    expect(pairedDifference(cand, ret, 0.9, "seed-b").lower).not.toBe(first.lower);
    // A wider confidence gives a lower bound further down; the bound is an order statistic of resampled means.
    expect(pairedDifference(cand, ret, 0.99, "seed-a").lower).toBeLessThan(first.lower);
    const diffs = cand.map((c, i) => c.score - ret[i]!.score);
    const possible = pairedDifference(cand, ret, 0.9, "seed-a", 5).lower * 8;
    expect(Math.min(...diffs) * 8).toBeLessThanOrEqual(possible + 1e-9);
    // Identical differences leave nothing to resample: the bound is the difference.
    expect(pairedDifference(scores([0.5, 0.7]), scores([0.4, 0.6]), 0.95, "s")).toEqual({ n: 2, difference: expect.closeTo(0.1, 12), lower: expect.closeTo(0.1, 12), method: "bootstrap" });
  });

  it("PD1.7 the bootstrap takes its bound at the (1 − confidence) quantile of the resampled means", () => {
    // Two tasks: resampled means are 0 (both draws the low task), 0.5 or 1; with confidence 0.5 the bound is the median.
    const out = pairedDifference(scores([0.5, 1]), scores([0.5, 0]), 0.5, "median", 400);
    expect(out.lower).toBe(0.5);
    expect(pairedDifference(scores([0.5, 1]), scores([0.5, 0]), 0.999, "median", 400).lower).toBe(0);
    expect(pairedDifference(scores([0.5, 1]), scores([0.5, 0]), 0.001, "median", 400).lower).toBe(1);
  });

  it("PD1.8 scores pair by task; unpaired tasks are left out and no pairs is an empty comparison", () => {
    const out = pairedDifference([{ task: "x", score: 1 }, { task: "y", score: 0 }, { task: "only-candidate", score: 1 }], [{ task: "y", score: 1 }, { task: "x", score: 1 }, { task: "only-retained", score: 0 }], 0.9, "s");
    expect(out.n).toBe(2);
    expect(out.difference).toBeCloseTo(-0.5, 12);
    expect(pairedDifference([{ task: "a", score: 1 }], [{ task: "b", score: 1 }], 0.9, "s")).toEqual({ n: 0, difference: 0, lower: Number.NEGATIVE_INFINITY, method: "newcombe" });
  });
});

describe("the anchored non-inferiority gate", () => {
  const big = { items: 20, chars: 900 };
  const small = { items: 18, chars: 900 };
  const binary = (passes: number, n = 200, prefix = "t") => scores(Array.from({ length: n }, (_, i) => (i < passes ? 1 : 0)), prefix);

  it("PD1.9 graphSize counts nodes plus edges, then the characters of every attribute", () => {
    expect(graphSize(base)).toEqual({
      items: 9,
      chars: base.nodes.reduce((s, n) => s + n.description.length, 0) + base.edges.reduce((s, e) => s + (e.condition ?? "").length + e.guidance.length + e.pitfalls.length, 0),
    });
  });

  it("PD1.10 a confidently superior candidate passes whatever its size", () => {
    const out = anchoredNonInferiority({ candidate: binary(150), retained: binary(100), anchor: binary(100), sizes: { candidate: big, retained: small }, ...ni, seed: "s" });
    expect(out.pass).toBe(true);
    expect(out.reason).toMatch(/^superior: /);
  });

  it("PD1.11 an equal candidate passes only when it is smaller, first by items then by characters", () => {
    const same = { candidate: binary(120), retained: binary(120), anchor: binary(120), ...ni, seed: "s" };
    expect(anchoredNonInferiority({ ...same, sizes: { candidate: small, retained: big } })).toMatchObject({ pass: true, reason: expect.stringMatching(/^non-inferior and smaller: /) });
    expect(anchoredNonInferiority({ ...same, sizes: { candidate: big, retained: small } })).toMatchObject({ pass: false, reason: expect.stringMatching(/^neither superior nor non-inferior and smaller: /) });
    expect(anchoredNonInferiority({ ...same, sizes: { candidate: { items: 20, chars: 800 }, retained: big } }).pass).toBe(true);
    expect(anchoredNonInferiority({ ...same, sizes: { candidate: big, retained: big } }).pass).toBe(false);
    expect(anchoredNonInferiority({ ...same, sizes: { candidate: { items: 19, chars: 2000 }, retained: big } }).pass).toBe(true);
    expect(anchoredNonInferiority({ ...same, sizes: { candidate: { items: 21, chars: 10 }, retained: big } }).pass).toBe(false);
  });

  it("PD1.12 identical continuous scores pass as non-inferior when smaller", () => {
    const vals = scores([0.2, 0.4, 0.9, 0.7]);
    expect(anchoredNonInferiority({ candidate: vals, retained: vals, anchor: vals, sizes: { candidate: small, retained: big }, totalLoss: 0.05, confidence: 0.9, power: 0.8, seed: "s" }).pass).toBe(true);
  });

  it("PD1.13 a clearly worse candidate fails even when smaller", () => {
    const out = anchoredNonInferiority({ candidate: binary(80), retained: binary(120), anchor: binary(80), sizes: { candidate: small, retained: big }, ...ni, seed: "s" });
    expect(out.pass).toBe(false);
  });

  it("PD1.14 the candidate stays within totalLoss of G₀, so losses cannot compound across rounds", () => {
    // Non-inferior to the retained head, but the retained head already lost ground against G₀.
    const out = anchoredNonInferiority({ candidate: binary(120), retained: binary(120), anchor: binary(150), sizes: { candidate: small, retained: big }, ...ni, seed: "s" });
    expect(out).toMatchObject({ pass: false, reason: expect.stringMatching(/^beyond the total loss against G₀: /) });
    // Superiority to the retained head does not excuse it either.
    expect(anchoredNonInferiority({ candidate: binary(125), retained: binary(80), anchor: binary(170), sizes: { candidate: small, retained: big }, ...ni, seed: "s" }).pass).toBe(false);
  });

  it("PD1.15 when the power-sized margin exceeds totalLoss only superiority is accepted", () => {
    // Twenty tasks with many discordant pairs: δ is far above a total loss of 0.01.
    const cand = scores([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    const ret = scores([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
    const out = anchoredNonInferiority({ candidate: cand, retained: ret, anchor: cand, sizes: { candidate: small, retained: big }, totalLoss: 0.9, confidence: 0.95, power: 0.8, seed: "s" });
    expect(out.pass).toBe(true);
    const tight = anchoredNonInferiority({ candidate: cand, retained: ret, anchor: cand, sizes: { candidate: small, retained: big }, totalLoss: 0.01, confidence: 0.95, power: 0.8, seed: "s" });
    expect(tight).toMatchObject({ pass: false, reason: expect.stringMatching(/^the margin δ [0-9.]+ exceeds the total loss 0.0100, so only superiority passes: /) });
  });

  it("PD1.27 the gate needs a confidence above one half", () => {
    const vals = scores([1, 0]);
    for (const confidence of [0.5, 0.2, 1]) expect(() => anchoredNonInferiority({ candidate: vals, retained: vals, anchor: vals, sizes: { candidate: small, retained: big }, totalLoss: 0.05, confidence, power: 0.8, seed: "s" })).toThrow(RangeError);
  });

  it("PD1.16 with no paired validation tasks the gate fails", () => {
    expect(anchoredNonInferiority({ candidate: scores([1], "a"), retained: scores([1], "b"), anchor: scores([1], "a"), sizes: { candidate: small, retained: big }, ...ni, seed: "s" })).toEqual({ pass: false, reason: "no validation task was scored for both graphs" });
    expect(anchoredNonInferiority({ candidate: scores([1], "a"), retained: scores([1], "a"), anchor: scores([1], "b"), sizes: { candidate: small, retained: big }, ...ni, seed: "s" })).toEqual({ pass: false, reason: "no validation task was scored for both graphs" });
  });
});

describe("the evidence gate", () => {
  const withBase = (candidate: CandidateDocument, events: OverlayEvent[] = []) => evidenceGate({ base, candidate, overlay: overlayOf(...events), ...live });
  const sessions = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
  const turns = (path: string[], n: number, score: number | null, prefix = "s") => Array.from({ length: n }, (_, i) => observed(`${prefix}${i}/t`, path, score));

  it("PD1.17 an unchanged candidate passes", () => {
    expect(withBase(base)).toEqual({ pass: true, reason: "every change has evidence (0 changes)" });
  });

  it("PD1.18 removing a core edge needs a caution with minSupport sessions", () => {
    const pruned = edited((d) => {
      d.edges = d.edges.filter((e) => e.from !== "Bridge_Extract");
      d.edges.push(edge("Scan_Index", "End"));
    });
    const supported = transitionsTo("Scan_Index", "End");
    expect(withBase(pruned, supported)).toMatchObject({ pass: false, reason: "no evidence for: removed edge Bridge_Extract → End (CONVERGES_TO)" });
    expect(withBase(pruned, [...supported, proposed(cautionOnCore, sessions(2))]).pass).toBe(false);
    expect(withBase(pruned, [...supported, proposed(cautionOnCore, sessions(3))])).toEqual({ pass: true, reason: "every change has evidence (2 changes)" });
    expect(withBase(pruned, [...supported, proposed(cautionOnCore, sessions(3)), status(idOf(cautionOnCore), "retired")]).pass).toBe(false);
  });

  /** minSupport sessions traversing a transition the core lacks. */
  function transitionsTo(from: string, to: string): OverlayEvent[] {
    return turns([from, to], 3, null, `${from}-${to}-`);
  }

  it("PD1.19 removing a core edge also passes on poor statistics: confidently below the rest of the graph with minSupport sessions", () => {
    const events = [...turns(["Bridge_Extract", "End"], 40, 0, "bad"), ...turns(["Start", "First_Hop_Retrieve"], 40, 1, "good")];
    const o = overlayOf(...events);
    expect(poorStatistics(o, "Bridge_Extract", "End", live)).toBe(true);
    expect(poorStatistics(o, "Start", "First_Hop_Retrieve", live)).toBe(false);
    expect(poorStatistics(o, "Scan_Index", "End", live)).toBe(false);
    // Too few sessions, or too few scored traversals elsewhere, are not evidence.
    expect(poorStatistics(overlayOf(...turns(["Bridge_Extract", "End"], 2, 0), ...turns(["Start", "First_Hop_Retrieve"], 40, 1, "g")), "Bridge_Extract", "End", live)).toBe(false);
    expect(poorStatistics(overlayOf(...turns(["Bridge_Extract", "End"], 40, 0), ...turns(["Start", "First_Hop_Retrieve"], 2, 1, "g")), "Bridge_Extract", "End", live)).toBe(false);
    expect(poorStatistics(overlayOf(...turns(["Bridge_Extract", "End"], 40, null), ...turns(["Start", "First_Hop_Retrieve"], 40, 1, "g")), "Bridge_Extract", "End", live)).toBe(false);
    expect(poorStatistics(overlayOf(...turns(["Bridge_Extract", "End"], 40, 1), ...turns(["Start", "First_Hop_Retrieve"], 40, 1, "g")), "Bridge_Extract", "End", live)).toBe(false);
    // Too few scored traversals on the edge, however many sessions saw it.
    expect(poorStatistics(overlayOf(...turns(["Bridge_Extract", "End"], 40, null), ...turns(["Bridge_Extract", "End"], 2, 0, "scored"), ...turns(["Start", "First_Hop_Retrieve"], 40, 1, "g")), "Bridge_Extract", "End", live)).toBe(false);
    // Poor statistics from few distinct sessions do not count.
    const oneSession = [...Array.from({ length: 40 }, (_, i) => observed(`solo/t${i}`, ["Bridge_Extract", "End"], 0)), ...turns(["Start", "First_Hop_Retrieve"], 40, 1, "g")];
    expect(poorStatistics(overlayOf(...oneSession), "Bridge_Extract", "End", live)).toBe(false);
    const pruned = edited((d) => {
      d.edges = d.edges.filter((e) => e.from !== "Bridge_Extract");
      d.edges.push(edge("Scan_Index", "End"));
    });
    expect(withBase(pruned, [...events, ...transitionsTo("Scan_Index", "End")]).pass).toBe(true);
  });

  it("PD1.20 an added edge needs an active overlay edge between its endpoints or minSupport sessions on the transition", () => {
    const shortcutDoc = edited((d) => d.edges.push(edge("Scan_Index", "End")));
    expect(withBase(shortcutDoc)).toEqual({ pass: false, reason: "no evidence for: added edge Scan_Index → End (LEADS_TO)" });
    expect(withBase(shortcutDoc, turns(["Scan_Index", "End"], 2, null)).pass).toBe(false);
    expect(withBase(shortcutDoc, turns(["Scan_Index", "End"], 3, null)).pass).toBe(true);
    const entry = { kind: "edge", from: "Scan_Index", relation: "TRIGGERS", to: "End", condition: null, guidance: "g", pitfalls: "" };
    expect(withBase(shortcutDoc, [proposed(entry, ["x"])]).pass).toBe(false);
    expect(withBase(shortcutDoc, [proposed(entry, ["x"]), status(idOf(entry), "active")]).pass).toBe(true);
  });

  it("PD1.21 an added node needs an active node entry or a supported transition through it", () => {
    const verify = edited((d) => {
      d.nodes.push({ id: "Verify", type: "REASONING", description: "Check." });
      d.edges.push(edge("Bridge_Extract", "Verify"));
    });
    const nodeEntry = { kind: "node", id: "Verify", type: "REASONING", description: "Check." };
    const edgeEvidence = turns(["Bridge_Extract", "Verify"], 3, null);
    expect(withBase(verify, [proposed(nodeEntry, ["x"]), status(idOf(nodeEntry), "active")]).reason).toBe("no evidence for: added edge Bridge_Extract → Verify (LEADS_TO)");
    expect(withBase(verify, edgeEvidence).pass).toBe(true);
    const into = edited((d) => {
      d.nodes.push({ id: "Verify", type: "REASONING", description: "Check." });
      d.edges.push(edge("Verify", "End"));
      d.edges.push({ ...edge("Bridge_Extract", "Verify") });
    });
    expect(withBase(into, [...turns(["Verify", "End"], 3, null, "v"), ...edgeEvidence]).pass).toBe(true);
    const lonely = edited((d) => d.nodes.push({ id: "Lonely", type: "STATUS", description: "Isolated." }));
    expect(withBase(lonely)).toEqual({ pass: false, reason: "no evidence for: added node Lonely" });
    expect(withBase(lonely, [proposed({ ...nodeEntry, id: "Lonely" }, ["x"])]).pass).toBe(false);
    expect(withBase(lonely, [proposed({ ...nodeEntry, id: "Lonely" }, ["x"]), status(idOf({ ...nodeEntry, id: "Lonely" }), "active")]).pass).toBe(true);
  });

  it("PD1.22 a rewritten edge passes when its text is shorter or it absorbs an active note on the edge", () => {
    const rewrite = (guidance: string) =>
      edited((d) => {
        d.edges[0] = { ...d.edges[0]!, guidance };
      });
    expect(withBase(rewrite("Go on.")).pass).toBe(true);
    const longer = rewrite(`${base.edges[0]!.guidance} Retrieve before reasoning. Always.`);
    expect(withBase(longer)).toEqual({ pass: false, reason: "no evidence for: rewritten edge Start → First_Hop_Retrieve (LEADS_TO)" });
    expect(withBase(longer, [proposed(noteOnCore, ["x"])]).pass).toBe(false);
    expect(withBase(longer, [proposed(noteOnCore, ["x"]), status(idOf(noteOnCore), "active")]).pass).toBe(true);
    const inPitfalls = edited((d) => {
      d.edges[0] = { ...d.edges[0]!, pitfalls: `${d.edges[0]!.pitfalls} Retrieve before reasoning.` };
    });
    expect(withBase(inPitfalls, [proposed(noteOnCore, ["x"]), status(idOf(noteOnCore), "active")]).pass).toBe(true);
    const inCondition = edited((d) => {
      d.edges[0] = { ...d.edges[0]!, condition: "Retrieve before reasoning." };
    });
    expect(withBase(inCondition, [proposed(noteOnCore, ["x"]), status(idOf(noteOnCore), "active")]).pass).toBe(true);
    const sameLength = rewrite(base.edges[0]!.guidance.replace("go", "GO"));
    expect(withBase(sameLength).pass).toBe(false);
  });

  it("PD1.23 a rewritten node passes only with the same type and binding and a shorter description", () => {
    const node = (change: Partial<DocInput["nodes"][number]>) =>
      edited((d) => {
        d.nodes[1] = { ...d.nodes[1]!, ...change };
      });
    expect(withBase(node({ description: "Retrieve." })).pass).toBe(true);
    expect(withBase(node({ description: `${base.nodes[1]!.description} More.` }))).toEqual({ pass: false, reason: "no evidence for: rewritten node First_Hop_Retrieve" });
    expect(withBase(node({ description: "Retrieve.", type: "REASONING" })).pass).toBe(false);
    expect(withBase(node({ description: "Retrieve.", binding: { kind: "tool", name: "other" } })).pass).toBe(false);
    const unbound = edited((d) => {
      const { binding: _binding, ...rest } = d.nodes[1]!;
      d.nodes[1] = { ...rest, description: "Retrieve." };
    });
    expect(withBase(unbound).pass).toBe(false);
  });

  it("PD1.24 the gate names every change without evidence", () => {
    const two = edited((d) => {
      d.edges.push(edge("Scan_Index", "End"));
      d.nodes.push({ id: "Lonely", type: "STATUS", description: "Isolated." });
    });
    expect(withBase(two).reason).toBe("no evidence for: added node Lonely; added edge Scan_Index → End (LEADS_TO)");
    expect(evidenceGate({ base, candidate: two, overlay: emptyOverlay(baseId), minSupport: 1, confidence: 0.9 }).pass).toBe(false);
  });
});

describe("approval", () => {
  it("PD1.25 routesIntoSideEffects names the tools that added edges route into, unless declared free of side effects", () => {
    const doc = hotpot();
    doc.nodes.push({ id: "send_email", type: "ACTION", description: "Send." });
    doc.nodes.push({ id: "Lookup", type: "ACTION", description: "Look up.", binding: { kind: "tool", name: "lookup_tool" } });
    doc.nodes.push({ id: "Think", type: "REASONING", description: "Think." });
    doc.edges.push(edge("Scan_Index", "send_email"), edge("send_email", "End"), edge("Scan_Index", "Lookup"), edge("Lookup", "End"), edge("Scan_Index", "Think"), edge("Think", "End"));
    const candidate = graphOf(doc);
    expect(routesIntoSideEffects(base, candidate, [])).toEqual(["send_email", "lookup_tool"]);
    expect(routesIntoSideEffects(base, candidate, ["lookup_tool"])).toEqual(["send_email"]);
    expect(routesIntoSideEffects(base, candidate, ["lookup_tool", "send_email"])).toEqual([]);
    // Existing edges into existing tools need nothing.
    expect(routesIntoSideEffects(base, base, [])).toEqual([]);
    // An edge re-added with new text routes into its tool again.
    const rewritten = edited((d) => {
      d.edges[0] = { ...d.edges[0]!, guidance: "New." };
    });
    expect(routesIntoSideEffects(base, rewritten, [])).toEqual(["first_hop_retrieve"]);
  });

  it("PD1.26 approvalGate passes when not required or approved, and fails when declined or no approver answered", () => {
    expect(approvalGate({ required: false })).toEqual({ pass: true, reason: "no approval needed" });
    expect(approvalGate({ required: true, approved: true })).toEqual({ pass: true, reason: "approved" });
    expect(approvalGate({ required: true, approved: false })).toEqual({ pass: false, reason: "declined by the approver" });
    expect(approvalGate({ required: true })).toEqual({ pass: false, reason: "approval needed, and no approver is configured" });
  });
});

describe("gates: boundaries and distractors", () => {
  const f4 = (x: number) => x.toFixed(4);
  const vals = scores([0.2, 0.4, 0.9, 0.7, 0.35]);
  const small = { items: 1, chars: 0 };
  const big = { items: 2, chars: 0 };

  it("PD1.28 the checks name what is out of range", () => {
    expect(() => normalQuantile(1)).toThrow("a normal quantile needs a probability strictly between 0 and 1, not 1");
    expect(() => powerMargin(0, 0.2, 0.95, 0.8)).toThrow("a margin needs at least one paired task, not 0");
    expect(powerMargin(1, 0.25, 0.95, 0.8)).toBeCloseTo((normalQuantile(0.95) + normalQuantile(0.8)) * 0.5, 12);
    expect(() => powerMargin(3, -1, 0.95, 0.8)).toThrow("discordance is a variance, not -1");
    for (const confidence of [0.5, 1]) expect(() => anchoredNonInferiority({ candidate: vals, retained: vals, anchor: vals, sizes: { candidate: small, retained: big }, totalLoss: 0.05, confidence, power: 0.8, seed: "s" })).toThrow(`the confidence must be above 0.5 and below 1, not ${confidence}`);
  });

  it("PD1.29 a pair is binary only when both of its scores are 0 or 1", () => {
    expect(pairedDifference(scores([1, 0, 1]), scores([0.5, 0.5, 0.5]), 0.9, "s").method).toBe("bootstrap");
    expect(pairedDifference(scores([0.5, 0.5, 0.5]), scores([1, 0, 1]), 0.9, "s").method).toBe("bootstrap");
    expect(pairedDifference(scores([1, 0, 1]), scores([0, 0, 1]), 0.9, "s").method).toBe("newcombe");
  });

  it("PD1.60 the bootstrap stream is fixed by its seed (golden values)", () => {
    const cand = scores([0.91, 0.12, 0.55, 0.73, 0.38, 0.64, 0.27, 0.8]);
    const ret = scores([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(f4(pairedDifference(cand, ret, 0.9, "golden-1").lower)).toBe("-0.0612");
    expect(f4(pairedDifference(cand, ret, 0.75, "golden-2").lower)).toBe("-0.0125");
  });

  it("PD1.61 the gate's reason reports both comparisons, each with its own seed, and δ from the interval", () => {
    const cand = scores([0.3, 0.5, 0.8, 0.6, 0.4, 0.95, 0.15, 0.7]);
    const anchor = scores([0.1, 0.9, 0.5, 0.5, 0.2, 0.33, 0.61, 0.05]);
    const vals = scores([0.2, 0.4, 0.9, 0.7, 0.35, 0.5, 0.45, 0.2]);
    const out = anchoredNonInferiority({ candidate: cand, retained: vals, anchor, sizes: { candidate: small, retained: big }, totalLoss: 0.5, confidence: 0.9, power: 0.8, seed: "k" });
    const r = pairedDifference(cand, vals, 0.9, "k/retained");
    const a = pairedDifference(cand, anchor, 0.9, "k/anchor");
    const delta = ((r.difference - r.lower) * (normalQuantile(0.9) + normalQuantile(0.8))) / normalQuantile(0.9);
    expect(out.reason).toContain(`candidate − retained ${f4(r.difference)} (lower ${f4(r.lower)}, δ ${f4(delta)}); candidate − G₀ ${f4(a.difference)} (lower ${f4(a.lower)}, total loss 0.5000)`);
    expect(r.lower).not.toBe(pairedDifference(cand, vals, 0.9, "").lower);
    expect(a.lower).not.toBe(pairedDifference(cand, anchor, 0.9, "").lower);
  });

  it("PD1.62 boundaries: exactly at the total loss passes, a zero lower bound is not superiority, a zero margin still allows non-inferiority", () => {
    // Identical continuous scores: every bound is 0 and δ is 0.
    const same = { candidate: vals, retained: vals, anchor: vals, confidence: 0.9, power: 0.8, seed: "s" };
    expect(anchoredNonInferiority({ ...same, sizes: { candidate: small, retained: big }, totalLoss: 0 }).pass).toBe(true);
    expect(anchoredNonInferiority({ ...same, sizes: { candidate: big, retained: big }, totalLoss: 0.05 }).pass).toBe(false);
    // Uniformly a little worse: the lower bound is below −δ = 0, so smaller does not help.
    const worse = scores([0.18, 0.38, 0.88, 0.68, 0.33]);
    expect(anchoredNonInferiority({ ...same, candidate: worse, anchor: worse, sizes: { candidate: small, retained: big }, totalLoss: 0.05 }).pass).toBe(false);
  });

  it("PD1.63 poor statistics count exactly minSupport sessions and scored traversals on each side", () => {
    const o = foldAll(baseId, [...[0, 1, 2].map((i) => observed(`b${i}/t`, ["Bridge_Extract", "End"], 0)), ...[0, 1, 2].map((i) => observed(`g${i}/t`, ["Start", "First_Hop_Retrieve"], 1))]);
    expect(poorStatistics(o, "Bridge_Extract", "End", live)).toBe(true);
  });

  it("PD1.64 evidence ignores entries of other kinds, on other edges, or with other ids", () => {
    const sessions3 = ["a", "b", "c"];
    const pruned = edited((d) => {
      d.edges = d.edges.filter((e) => e.from !== "Bridge_Extract");
    });
    const on = (from: string, to: string, kind = "caution") => ({ kind, on: { from, to }, text: `${kind} ${from} ${to}` });
    const activate = (e: unknown) => [proposed(e, sessions3), status(idOf(e), "active")];
    expect(evidenceGate({ base, candidate: pruned, overlay: overlayOf(...activate(on("Bridge_Extract", "Scan_Index")), ...activate(on("Scan_Index", "End")), ...activate(on("Bridge_Extract", "End", "note"))), ...live }).pass).toBe(false);
    const verify = edited((d) => {
      d.nodes.push({ id: "Verify", type: "REASONING", description: "Check." });
      d.edges.push(edge("Bridge_Extract", "Verify"));
    });
    const node = (id: string) => ({ kind: "node", id, type: "REASONING", description: "Check." });
    const edgeEntry = (from: string, to: string) => ({ kind: "edge", from, relation: "LEADS_TO", to, condition: null, guidance: "x", pitfalls: "" });
    const distractors = [...activate(node("Other")), ...activate(on("Start", "First_Hop_Retrieve", "note")), ...activate(edgeEntry("Bridge_Extract", "End")), ...activate(edgeEntry("Scan_Index", "Verify")), ...activate(on("Bridge_Extract", "Verify", "note"))];
    // Supported transitions elsewhere, and too few sessions through Verify, do not justify it.
    const elsewhere = [0, 1, 2].map((i) => observed(`x${i}/t`, ["Scan_Index", "End"], null));
    const few = [0, 1].map((i) => observed(`y${i}/t`, ["Bridge_Extract", "Verify"], null));
    expect(evidenceGate({ base, candidate: verify, overlay: overlayOf(...distractors, ...elsewhere, ...few), ...live }).reason).toBe("no evidence for: added node Verify; added edge Bridge_Extract → Verify (LEADS_TO)");
    const longer = edited((d) => {
      d.edges[0] = { ...d.edges[0]!, guidance: `${d.edges[0]!.guidance} Retrieve before reasoning.` };
    });
    const elsewhereNote = { kind: "note", on: { from: "Scan_Index", to: "Bridge_Extract" }, text: "Retrieve before reasoning." };
    const sameFromNote = { kind: "note", on: { from: "Start", to: "Scan_Index" }, text: "Retrieve before reasoning." };
    const sameToNote = { kind: "note", on: { from: "Scan_Index", to: "First_Hop_Retrieve" }, text: "Retrieve before reasoning." };
    const caution = { kind: "caution", on: { from: "Start", to: "First_Hop_Retrieve" }, text: "Retrieve before reasoning." };
    const unrelated = { kind: "note", on: { from: "Start", to: "First_Hop_Retrieve" }, text: "Something else." };
    expect(evidenceGate({ base, candidate: longer, overlay: overlayOf(...activate(elsewhereNote), ...activate(sameFromNote), ...activate(sameToNote), ...activate(caution), ...activate(unrelated)), ...live }).pass).toBe(false);
    const sameLength = edited((d) => {
      d.nodes[1] = { ...d.nodes[1]!, description: d.nodes[1]!.description.replace("E", "e") };
    });
    expect(evidenceGate({ base, candidate: sameLength, overlay: overlayOf(), ...live }).pass).toBe(false);
  });

  it("PD1.65 the gate counts every justified change", () => {
    const many = edited((d) => {
      d.nodes[2] = { ...d.nodes[2]!, description: "Scan." };
      d.edges[0] = { ...d.edges[0]!, guidance: "Go." };
      d.edges.push(edge("Scan_Index", "End"));
    });
    expect(evidenceGate({ base, candidate: many, overlay: overlayOf(...[0, 1, 2].map((i) => observed(`s${i}/t`, ["Scan_Index", "End"], null))), ...live }).reason).toBe("every change has evidence (3 changes)");
    const removal = edited((d) => {
      d.edges = d.edges.filter((e) => e.from !== "Bridge_Extract");
    });
    expect(evidenceGate({ base, candidate: removal, overlay: overlayOf(proposed(cautionOnCore, ["a", "b", "c"])), ...live }).reason).toBe("every change has evidence (1 changes)");
  });
});
