import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConstraintEngine } from "@harness/constrained";
import { Dialogue } from "@harness/dialogue";
import { loadXGrammar } from "../../constrained/test/xgrammar.ts";
import { routerModel, settings } from "./helpers.ts";

const book = JSON.parse(readFileSync(new URL("../data/builtin.json", import.meta.url), "utf8"));

/** Longer than the old 80-character prose cap, in several words. */
const SENTENCE = "consequently i cannot browse external websites or modify files without explicit permission";
/** Past a 512-token generation budget: one token per word, with no upper bound in the grammar. */
const LONG = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ");

const ALPHA = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n()[]-+*/=.,;:!?'\"`-"];
const EOS = ALPHA.length;
const TOKENS = [...ALPHA, "<eos>"];

const EQUATION = "x + y = z\n";
const BLANK = "____";

describe("stitched replies", () => {
  it("ST2.1 a stitch is one answer per intent, a prose hole has no word cap, and the instruction shows blanks", async () => {
    expect(SENTENCE.length).toBeGreaterThan(80);
    expect(SENTENCE.split(" ").length).toBeGreaterThan(8);
    const router = routerModel(() => [
      { tool: "manual", confidence: 0.95 },
      { tool: "calculation", confidence: 0.95 },
      { tool: "research", confidence: 0.95 },
      { tool: "instructions", confidence: 0.95 },
    ]);
    const dialogue = new Dialogue({ settings: settings(), book, router });
    const decision = await dialogue.respond({ sessionId: "s", utterance: "what can you not do" });
    expect(decision.kind).toBe("generate");
    if (decision.kind !== "generate") return;
    expect(decision.scripts).toEqual(["research", "calculation", "instructions", "manual"]);

    const engine = await ConstraintEngine.create(() => loadXGrammar(), { tokens: TOKENS, stopTokens: [EOS] });
    const holes = decision.template.parts.flatMap((part) => (typeof part === "string" || part.constraint?.type !== "grammar" ? [] : [part]));
    expect(holes.map((part) => part.hole)).toEqual(["abstract", "work", "answer", "synopsis"]);
    expect(decision.template.parts.filter((part): part is string => typeof part === "string").join("")).toBe("\n\n\n\n\n\n");
    for (const part of holes) {
      const fill = part.hole === "work" ? EQUATION : SENTENCE;
      if (part.constraint?.type !== "grammar") throw new Error(part.hole);
      const matcher = await engine.matcher({ type: "grammar", ebnf: part.constraint.ebnf });
      let accepted = true;
      for (const ch of fill) accepted = accepted && matcher.accept(TOKENS.indexOf(ch));
      accepted = accepted && matcher.accept(EOS);
      matcher.dispose();
      expect(accepted, part.hole).toBe(true);
      if (part.hole === "work") continue;
      const smashed = await engine.matcher({ type: "grammar", ebnf: part.constraint.ebnf });
      let identifier = true;
      for (const ch of "WhatIcannotdoisnO") identifier = identifier && smashed.accept(TOKENS.indexOf(ch));
      identifier = identifier && smashed.accept(EOS);
      smashed.dispose();
      expect(identifier, part.hole).toBe(false);
    }
    const math = holes.find((part) => part.hole === "work");
    if (math?.constraint?.type !== "grammar") throw new Error("work");
    const refused = await engine.matcher({ type: "grammar", ebnf: math.constraint.ebnf });
    let prose = true;
    for (const ch of SENTENCE) prose = prose && refused.accept(TOKENS.indexOf(ch));
    prose = prose && refused.accept(EOS);
    refused.dispose();
    expect(prose).toBe(false);
    const synopsis = holes.find((part) => part.hole === "synopsis");
    if (synopsis?.constraint?.type !== "grammar") throw new Error("synopsis");
    const overrun = await engine.matcher({ type: "grammar", ebnf: synopsis.constraint.ebnf });
    let fits = true;
    for (const ch of LONG) fits = fits && overrun.accept(TOKENS.indexOf(ch));
    fits = fits && overrun.accept(EOS);
    overrun.dispose();
    expect(fits, "a prose hole may run past the model's output budget").toBe(true);
    const loop = await engine.matcher({ type: "grammar", ebnf: synopsis.constraint.ebnf });
    let dashed = true;
    for (const ch of "a - or 3- or 4- or 5-") dashed = dashed && loop.accept(TOKENS.indexOf(ch));
    dashed = dashed && loop.accept(EOS);
    loop.dispose();
    expect(dashed).toBe(false);
    const answer = holes.find((part) => part.hole === "answer");
    if (answer?.constraint?.type !== "grammar") throw new Error("answer");
    const labels = await engine.matcher({ type: "grammar", ebnf: answer.constraint.ebnf });
    let salad = true;
    for (const ch of "Step 1\nStep 2\nVerify: Step 3\n") salad = salad && labels.accept(TOKENS.indexOf(ch));
    salad = salad && labels.accept(EOS);
    labels.dispose();
    expect(salad).toBe(false);
    expect(decision.instruction.includes("one sentence")).toBe(false);
    expect(decision.instruction.includes("a few words")).toBe(false);
    expect(decision.instruction).toContain("words that answer the user");
    expect(decision.instruction).toContain("spaces between them");
    expect(decision.instruction.endsWith(`${BLANK}\n\n${BLANK}\n\n${BLANK}\n\n${BLANK}`)).toBe(true);
    expect(decision.instruction.includes("{abstract}")).toBe(false);
    expect(decision.instruction.includes("{name}")).toBe(false);
    expect(decision.instruction.includes("{synopsis}")).toBe(false);
  });

  it("ST2.2 a stitch keeps the fixed text around one hole and reduces a document to its sentence", async () => {
    const prose = "root ::= prose\nprose ::= word (spaces word){2,12}\nspaces ::= \" \" \" \"*\nword ::= [A-Za-z0-9] [A-Za-z0-9',.]{0,40}";
    const router = routerModel(() => [
      { tool: "page", confidence: 0.95 },
      { tool: "note", confidence: 0.95 },
    ]);
    const dialogue = new Dialogue({
      settings: settings(),
      book: {
        scripts: [
          { id: "note", intent: "A short note", reply: ["Result: ", { generate: "note", constraint: { type: "regex", pattern: "a+" } }] },
          {
            id: "page",
            intent: "A page",
            reply: [
              "NAME\n",
              { generate: "title", constraint: { type: "grammar", ebnf: "root ::= title \" - \" prose\nprose ::= word\nword ::= [A-Za-z]+" } },
              "\nBODY\n",
              { generate: "body", constraint: { type: "grammar", ebnf: prose } },
            ],
          },
        ],
      },
      router,
    });
    const decision = await dialogue.respond({ sessionId: "s", utterance: "both" });
    expect(decision.kind).toBe("generate");
    if (decision.kind !== "generate") return;
    expect(decision.scripts).toEqual(["note", "page"]);
    expect(decision.template.parts).toEqual([
      "Result: ",
      { hole: "note", constraint: { type: "regex", pattern: "a+" } },
      "\n\n",
      { hole: "body", constraint: { type: "grammar", ebnf: prose } },
    ]);
    expect(decision.instruction.endsWith(`Result: ${BLANK}\n\n${BLANK}`)).toBe(true);
    expect(decision.instruction.includes("{title}")).toBe(false);
    expect(decision.instruction.includes("{body}")).toBe(false);
  });
});
