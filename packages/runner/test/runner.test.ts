import { describe, expect, it } from "vitest";
import { OpenInferenceSpanKind, SemanticConventions } from "@arizeai/openinference-semantic-conventions";
import { createEvalSdk, executeCase, harnessTracer, InProcessEnvironment, traceAgent, traceTool } from "@harness/runner";
import type { Agent, TracerPort } from "@harness/runner";
import type { Case } from "@harness/ir";

const specCase: Case = { id: "c1", source: "local", instruction: "do the thing" };

function recording(): TracerPort & { spans: { name: string; attributes: Record<string, string> }[] } {
  const spans: { name: string; attributes: Record<string, string> }[] = [];
  return {
    spans,
    startSpan(name: string) {
      const attributes: Record<string, string> = {};
      return {
        setAttribute(key: string, value: string) {
          attributes[key] = value;
        },
        end() {
          spans.push({ name, attributes });
        },
      };
    },
  };
}

describe("eval runner", () => {
  it("RN1.1 an in-process agent writes the trial and a harbor handle does not call the agent", async () => {
    const env = new InProcessEnvironment();
    const agent: Agent = {
      async run(instruction, target, ctx) {
        if (target.kind !== "process") throw new Error("harbor");
        target.say(instruction);
        target.callTool("read", { path: "a.txt" });
        target.callTool("ping");
        target.write("a.txt");
        expect(ctx.trial).toBe(0);
      },
    };
    const trial = await executeCase(agent, env, specCase, { caseId: "c1", trial: 0 }, "train");
    expect(trial.output).toBe("do the thing");
    expect(trial.tools).toEqual([{ name: "read", args: { path: "a.txt" } }, { name: "ping" }]);
    expect(trial.files).toEqual(["a.txt"]);
    expect(trial.passed).toBe(true);
    const refusing = new InProcessEnvironment();
    const quiet: Agent = { async run(_instruction, target) { if (target.kind === "process") target.refuse(); } };
    const refused = await executeCase(quiet, refusing, specCase, { caseId: "c1", trial: 1 }, "test");
    expect(refused.behavior).toBe("refused");
    expect(refused.failureClass).toBe("refusal");
    expect(refused.passed).toBe(false);
    const boom = new Error("nope");
    const broken: Agent = { async run() { throw boom; } };
    expect((await executeCase(broken, new InProcessEnvironment(), specCase, { caseId: "c1", trial: 0 }, "train")).failureClass).toBe("harness");
    const timeout = new Error("slow");
    timeout.name = "TimeoutError";
    const slow: Agent = { async run() { throw timeout; } };
    expect((await executeCase(slow, new InProcessEnvironment(), specCase, { caseId: "c1", trial: 0 }, "train")).failureClass).toBe("timeout");
    const stringError: Agent = { async run() { throw "nope"; } };
    expect((await executeCase(stringError, new InProcessEnvironment(), specCase, { caseId: "c1", trial: 0 }, "train")).failureClass).toBe("harness");
    let called = false;
    const harbor = await executeCase(
      { async run() { called = true; } },
      { kind: "harbor", handle: "job-1", view: { output: "reward 1", tools: [], files: [], behavior: "complied", failureClass: "genuine", passed: true } },
      specCase,
      { caseId: "c1", trial: 0 },
      "test",
    );
    expect(called).toBe(false);
    expect(harbor.output).toBe("reward 1");
    expect(harbor.passed).toBe(true);
    expect(harbor.failureClass).toBe("genuine");
  });

  it("RN1.2 spans use OpenInference names", () => {
    const tracer = recording();
    traceAgent(tracer, "agent", "in", "out");
    traceTool(tracer, "read", { path: "a.txt" });
    expect(harnessTracer("eval").startSpan).toBeTypeOf("function");
    const agent = tracer.spans[0];
    const tool = tracer.spans[1];
    expect(agent?.attributes[SemanticConventions.OPENINFERENCE_SPAN_KIND]).toBe(OpenInferenceSpanKind.AGENT);
    expect(agent?.attributes[SemanticConventions.INPUT_VALUE]).toBe("in");
    expect(agent?.attributes[SemanticConventions.OUTPUT_VALUE]).toBe("out");
    expect(tool?.attributes[SemanticConventions.OPENINFERENCE_SPAN_KIND]).toBe(OpenInferenceSpanKind.TOOL);
    expect(tool?.attributes[SemanticConventions.TOOL_NAME]).toBe("read");
    expect(tool?.attributes[SemanticConventions.INPUT_VALUE]).toContain("a.txt");
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => traceTool(tracer, "read", cycle)).toThrow(/serialize/);
  });

  it("RN1.3 an OpenInference processor wraps the OTLP exporter", async () => {
    const sdk = createEvalSdk("http://127.0.0.1:9/v1/traces");
    await sdk.shutdown();
  });
});
