import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Dialogue, parseBook } from "@harness/dialogue";
import { routerModel, settings } from "./helpers.ts";

const book = JSON.parse(readFileSync(new URL("../data/builtin.json", import.meta.url), "utf8"));
const reply = parseBook(book).scripts.find((script) => script.id === "capabilities")!.reply[0] as string;

describe("builtin capability script", () => {
  it("BK1.1 what can you do is the capability template, by pattern, with no model", async () => {
    const router = routerModel(() => ({ tool: "capabilities", confidence: 0.99 }));
    const dialogue = new Dialogue({ settings: settings(), book, router });
    expect(await dialogue.respond({ sessionId: "s", utterance: "what can you do?" })).toEqual({ kind: "reply", script: "capabilities", text: reply, match: { by: "pattern" } });
    expect(router.offered).toEqual([]);
    expect(reply).not.toMatch(/claude|anthropic/i);
  });

  it("BK1.2 the router reuses that template for which skills and tools are registered", async () => {
    const router = routerModel((input) => (input.includes("skills") ? { tool: "capabilities", confidence: 0.95 } : undefined));
    const dialogue = new Dialogue({ settings: settings(), book, router });
    expect(await dialogue.respond({ sessionId: "s", utterance: "what skills/tools do you have registered" })).toEqual({
      kind: "reply",
      script: "capabilities",
      text: reply,
      match: { by: "router", confidence: 0.95 },
    });
    expect(router.offered[0]).toEqual(["capabilities", "research", "calculation", "instructions", "manual", "harness-menu"]);
  });

  it("BK1.3 a different question the router declines goes to the model", async () => {
    const router = routerModel(() => undefined);
    const dialogue = new Dialogue({ settings: settings(), book, router });
    expect(await dialogue.respond({ sessionId: "s", utterance: "what is the capital of France?" })).toEqual({ kind: "pass", reason: "no script matches" });
  });

  it("RC1.3 accepted intents are stitched in book order, whichever order the router listed them", async () => {
    const router = routerModel(() => [
      { tool: "calculation", confidence: 0.95 },
      { tool: "research", confidence: 0.95 },
    ]);
    const dialogue = new Dialogue({ settings: settings(), book, router });
    const decision = await dialogue.respond({ sessionId: "s", utterance: "research the boiling point and calculate 2+2" });
    expect(decision.kind).toBe("generate");
    if (decision.kind !== "generate") return;
    expect(decision.scripts).toEqual(["research", "calculation"]);
    expect(decision.template.parts.map((part) => (typeof part === "string" ? part : part.hole))).toEqual(["abstract", "\n\n", "work"]);
    expect(decision.instruction.endsWith("____\n\n____")).toBe(true);
    expect(decision.instruction.includes("{work}")).toBe(false);
  });

  it("RC1.4 two fixed replies are copied into one reply and nothing is left for a model", async () => {
    const router = routerModel(() => [
      { tool: "two", confidence: 0.95 },
      { tool: "one", confidence: 0.95 },
    ]);
    const dialogue = new Dialogue({
      settings: settings(),
      book: {
        scripts: [
          { id: "one", intent: "The first part", reply: ["Alpha."] },
          { id: "two", intent: "The second part", reply: ["Beta."] },
          { id: "three", intent: "Left out", reply: ["No."] },
        ],
      },
      router,
    });
    expect(await dialogue.respond({ sessionId: "s", utterance: "both parts please" })).toEqual({
      kind: "reply",
      script: "one",
      scripts: ["one", "two"],
      text: "Alpha.\n\nBeta.",
      match: { by: "router", confidence: 0.95 },
    });
  });
});

const hole = (parts: readonly (string | { hole: string; constraint?: { type: string; ebnf?: string } })[], name: string) => {
  const part = parts.find((item) => typeof item === "object" && item.hole === name);
  if (part === undefined || typeof part === "string" || part.constraint?.type !== "grammar" || part.constraint.ebnf === undefined) throw new Error(name);
  return part.constraint.ebnf;
};

describe("builtin structured output scripts", () => {
  it("SO1.1 a research question is a report template with an abstract, cited findings, a citation footer, a TLDR and an ELI5", async () => {
    const router = routerModel((input) => (input.includes("research") ? { tool: "research", confidence: 0.95 } : undefined));
    const dialogue = new Dialogue({ settings: settings(), book, router });
    const decision = await dialogue.respond({ sessionId: "s", utterance: "research the history of paper" });
    expect(decision).toMatchObject({
      kind: "generate",
      script: "research",
      match: { by: "router", confidence: 0.95 },
      template: {
        type: "template",
        parts: [
          "Abstract\n",
          { hole: "abstract", constraint: { type: "grammar" } },
          "\n",
          { hole: "findings", constraint: { type: "grammar" } },
          "\nReferences\n",
          { hole: "references", constraint: { type: "grammar" } },
          "\nTLDR\n",
          { hole: "tldr", constraint: { type: "grammar" } },
          "\nELI5\n",
          { hole: "eli5", constraint: { type: "grammar" } },
        ],
      },
    });
    if (decision.kind !== "generate") return;
    expect(hole(decision.template.parts, "findings")).toContain(" [");
    expect(hole(decision.template.parts, "references")).toContain("[");
    const labels = decision.template.parts.filter((part) => typeof part === "string").join("");
    expect(labels.indexOf("Abstract\n")).toBe(0);
    expect(labels.indexOf("References\n")).toBeGreaterThan(0);
    expect(labels.indexOf("TLDR\n")).toBeGreaterThan(labels.indexOf("References\n"));
    expect(labels.indexOf("ELI5\n")).toBeGreaterThan(labels.indexOf("TLDR\n"));
  });

  it("SO1.2 a calculation is a math grammar whose steps show the work", async () => {
    const router = routerModel((input) => (input.includes("calculate") ? { tool: "calculation", confidence: 0.95 } : undefined));
    const dialogue = new Dialogue({ settings: settings(), book, router });
    const decision = await dialogue.respond({ sessionId: "s", utterance: "calculate 12 times 3 plus 1" });
    expect(decision).toMatchObject({
      kind: "generate",
      script: "calculation",
      match: { by: "router" },
      template: { type: "template", parts: [{ hole: "work", constraint: { type: "grammar" } }] },
    });
    if (decision.kind !== "generate") return;
    const work = hole(decision.template.parts, "work");
    expect(work).toContain("step");
    expect(work).toContain(" = ");
  });

  it("SO1.3 instructions are steps, and each step says how to verify it", async () => {
    const router = routerModel((input) => (input.includes("how do") ? { tool: "instructions", confidence: 0.95 } : undefined));
    const dialogue = new Dialogue({ settings: settings(), book, router });
    const decision = await dialogue.respond({ sessionId: "s", utterance: "how do I brew tea" });
    expect(decision).toMatchObject({
      kind: "generate",
      script: "instructions",
      match: { by: "router" },
      template: { type: "template", parts: [{ hole: "steps", constraint: { type: "grammar" } }] },
    });
    if (decision.kind !== "generate") return;
    const steps = hole(decision.template.parts, "steps");
    expect(steps).toContain("Step ");
    expect(steps).toContain("Verify: ");
  });

  it("SO1.4 research, calculation and instructions are not a second pattern matcher", () => {
    const scripts = parseBook(book).scripts;
    for (const id of ["research", "calculation", "instructions", "manual"]) expect(scripts.find((script) => script.id === id)?.patterns).toEqual([]);
  });

  it("SO1.5 a technical documentation question is a man page, with the manual's sections in order", async () => {
    const router = routerModel((input) => (input.includes("doc") ? { tool: "manual", confidence: 0.95 } : undefined));
    const dialogue = new Dialogue({ settings: settings(), book, router });
    const decision = await dialogue.respond({ sessionId: "s", utterance: "show me the technical docs for the daemon socket" });
    expect(decision).toMatchObject({
      kind: "generate",
      script: "manual",
      match: { by: "router", confidence: 0.95 },
      template: {
        type: "template",
        parts: [
          "NAME\n",
          { hole: "name", constraint: { type: "grammar" } },
          "\nSYNOPSIS\n",
          { hole: "synopsis", constraint: { type: "grammar" } },
          "\nDESCRIPTION\n",
          { hole: "description", constraint: { type: "grammar" } },
          "\nOPTIONS\n",
          { hole: "options", constraint: { type: "grammar" } },
          "\nEXAMPLES\n",
          { hole: "examples", constraint: { type: "grammar" } },
          "\nSEE ALSO\n",
          { hole: "see", constraint: { type: "grammar" } },
        ],
      },
    });
    if (decision.kind !== "generate") return;
    expect(hole(decision.template.parts, "name")).toContain(" - ");
    expect(hole(decision.template.parts, "see")).toContain("(");
    const labels = decision.template.parts.filter((part) => typeof part === "string").join("");
    for (const heading of ["NAME\n", "SYNOPSIS\n", "DESCRIPTION\n", "OPTIONS\n", "EXAMPLES\n", "SEE ALSO\n"]) expect(labels).toContain(heading);
    expect(labels.indexOf("NAME\n")).toBeLessThan(labels.indexOf("SYNOPSIS\n"));
    expect(labels.indexOf("SYNOPSIS\n")).toBeLessThan(labels.indexOf("DESCRIPTION\n"));
    expect(labels.indexOf("DESCRIPTION\n")).toBeLessThan(labels.indexOf("OPTIONS\n"));
    expect(labels.indexOf("OPTIONS\n")).toBeLessThan(labels.indexOf("EXAMPLES\n"));
    expect(labels.indexOf("EXAMPLES\n")).toBeLessThan(labels.indexOf("SEE ALSO\n"));
  });
});
