import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import type { Instructions, ModelMessage } from "ai";
import { HARNESS } from "@harness/cognitive";
import { ManualClock, SeededEntropy } from "@harness/testkit";
import { ADVISORY, GUIDANCE_LABEL, parseGraph, proceduralStep } from "@harness/procedural";
import type { ProceduralGraph, StepRecord } from "@harness/procedural";
import { hotpot } from "./fixtures.ts";
import { answering } from "./models.ts";
import { fakePin, fakeStore, GRAPH, hotpotGraph, seed, settingsFile } from "./step-fakes.ts";

/** What happens between two steps of a session. */
type Move =
  | { kind: "call"; tools: string[] } // the model called tools and they returned
  | { kind: "approval" } // the worker restarts the stream after an approval round: same turn, step 0
  | { kind: "turn"; text: string } // the next turn begins
  | { kind: "dream" }; // the head moves, from outside

const TOOLS = ["first_hop_retrieve", "Scan_Index", "Bridge_Extract", "grep", "End"];
const move: fc.Arbitrary<Move> = fc.oneof(
  fc.record({ kind: fc.constant("call" as const), tools: fc.array(fc.constantFrom(...TOOLS), { minLength: 1, maxLength: 3 }) }),
  fc.constant({ kind: "approval" as const }),
  fc.record({ kind: fc.constant("turn" as const), text: fc.string({ minLength: 1, maxLength: 8 }) }),
  fc.constant({ kind: "dream" as const }),
);

function variant(n: number): ProceduralGraph {
  const parsed = parseGraph({ ...hotpot(), nodes: hotpot().nodes.map((node) => ({ ...node, description: `${node.description} (${n})` })) });
  if (!parsed.ok) throw new Error("fixture");
  return parsed.graph;
}

const isAdvisory = (m: ModelMessage) => m.role === "user" && m.providerOptions?.[HARNESS]?.["advisory"] === ADVISORY.advisory;
const count = (text: string, part: string) => text.split(part).length - 1;
const instructionText = (i: Instructions): string => (typeof i === "string" ? i : (Array.isArray(i) ? i : [i]).map((m) => m.content).join("\n"));

/**
 * Drives the hook as sessionAgent and AgentWorker would: a step's message override
 * carries forward to the next step of the same stream, the worker's own history holds
 * only what the model and tools said, and an approval round restarts the stream.
 */
async function drive(preset: "paper" | "harness", moves: readonly Move[]) {
  const store = fakeStore();
  await seed(store, hotpotGraph());
  const hook = proceduralStep({ store, resolve: () => GRAPH, pin: fakePin, settings: settingsFile, preset, model: answering((n) => `advice ${n}`), clock: new ManualClock(), entropy: new SeededEntropy(1) });
  const records: { turn: number; record: StepRecord }[] = [];
  const results: Awaited<ReturnType<typeof hook.prepare>>[] = [];
  let history: ModelMessage[] = [{ role: "user", content: "start" }];
  let carried: ModelMessage[] | undefined;
  let turn = 0;
  let step = 0;
  let dreams = 0;
  const prepare = async () => {
    const messages = carried ?? history;
    const result = await hook.prepare({
      sessionId: "s",
      turnId: `t${turn}`,
      messages,
      initialInstructions: "Be brief.",
      stepNumber: step,
      model: answering("unused"),
      report: (n) => records.push({ turn, record: n._meta.harness.procedural.step }),
    });
    results.push(result);
    carried = result?.messages ?? carried;
  };
  await prepare();
  for (const m of moves) {
    if (m.kind === "dream") {
      await seed(store, variant(++dreams), GRAPH, "dream");
      continue;
    }
    if (m.kind === "call") {
      const said: ModelMessage[] = [
        { role: "assistant", content: m.tools.map((t, i) => ({ type: "tool-call" as const, toolCallId: `c${i}`, toolName: t, input: {} })) },
        { role: "tool", content: m.tools.map((t, i) => ({ type: "tool-result" as const, toolCallId: `c${i}`, toolName: t, output: { type: "text" as const, value: "ok" } })) },
      ];
      history = [...history, ...said];
      carried = carried ? [...carried, ...said] : undefined;
      step++;
    } else if (m.kind === "approval") {
      carried = undefined;
      step = 0;
    } else {
      history = [...history, { role: "user", content: m.text }];
      carried = undefined;
      step = 0;
      turn++;
    }
    await prepare();
  }
  return { records, results };
}

describe("proceduralStep (properties)", () => {
  test.prop([fc.array(move, { maxLength: 12 })])("PW1.P1 guidance never stacks: trailing-message delivery leaves exactly one advisory, last", async (moves) => {
    const { results } = await drive("harness", moves);
    for (const r of results) {
      const advisories = r!.messages!.filter(isAdvisory);
      expect(advisories).toHaveLength(1);
      expect(r!.messages!.at(-1)).toBe(advisories[0]);
      expect(r).not.toHaveProperty("instructions");
    }
  });

  test.prop([fc.array(move, { maxLength: 12 })])("PW1.P2 guidance never stacks: system delivery holds the guidance slot exactly once, after the turn's own instructions", async (moves) => {
    const { results } = await drive("paper", moves);
    for (const r of results) {
      const text = instructionText(r!.instructions!);
      expect(count(text, GUIDANCE_LABEL)).toBe(1);
      expect(text.startsWith("Be brief.\n\n")).toBe(true);
      expect(r).not.toHaveProperty("messages");
    }
  });

  test.prop([fc.array(move, { maxLength: 12 }), fc.constantFrom("paper" as const, "harness" as const)])("PW1.P3 every step of a turn reads one version pair, whatever moves the head meanwhile", async (moves, preset) => {
    const { records } = await drive(preset, moves);
    const pairs = new Map<number, string>();
    for (const { turn, record } of records) {
      const pair = `${record.core}@${record.overlay}`;
      expect(pairs.get(turn) ?? pair).toBe(pair);
      pairs.set(turn, pair);
    }
  });

  test.prop([fc.array(move, { maxLength: 12 })])("PW1.P4 an approval round never resets the node: the step after it is at the same node as the step before it", async (moves) => {
    const { records } = await drive("paper", moves);
    let i = 1;
    for (const m of moves) {
      if (m.kind === "dream") continue;
      if (m.kind === "approval") expect(records[i]!.record.node).toBe(records[i - 1]!.record.node);
      i++;
    }
  });
});
