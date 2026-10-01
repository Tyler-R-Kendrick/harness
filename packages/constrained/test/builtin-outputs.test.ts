import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Constraint, TemplateConstraint } from "@harness/cognitive";
import { ConstraintEngine } from "@harness/constrained";
import { loadXGrammar } from "./xgrammar.ts";

const VOCAB = [...new Set([..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789{}[]():;,.\"' \n=+-*/<>_^!?-", "<eos>"])];
const EOS = VOCAB.indexOf("<eos>");
const id = (token: string) => {
  const at = VOCAB.indexOf(token);
  if (at < 0) throw new Error(`no token ${JSON.stringify(token)}`);
  return at;
};

type Part = string | { readonly generate: string; readonly constraint?: { readonly type: string; readonly ebnf: string } };
const book = JSON.parse(readFileSync(new URL("../../dialogue/data/builtin.json", import.meta.url), "utf8")) as { scripts: { id: string; reply: Part[] }[] };

function template(scriptId: string): TemplateConstraint {
  const script = book.scripts.find((item) => item.id === scriptId);
  if (!script) throw new Error(scriptId);
  return {
    type: "template",
    parts: script.reply.map((part) => (typeof part === "string" ? part : { hole: part.generate, ...(part.constraint ? { constraint: { type: "grammar" as const, ebnf: part.constraint.ebnf } } : {}) })),
  };
}

/** Whether the constraint accepts `text` and then the end, or refuses it at some token. */
async function accepts(engine: ConstraintEngine, constraint: Constraint, text: string): Promise<boolean> {
  const matcher = await engine.matcher(constraint);
  for (const token of [...text, "<eos>"]) if (!matcher.accept(id(token))) return false;
  return matcher.done;
}

describe("builtin output grammars", () => {
  it("SO4.1 research, calculation and instructions decode only in their structured languages", async () => {
    const engine = await ConstraintEngine.create(() => loadXGrammar(), { tokens: VOCAB, stopTokens: [EOS] });
    const report = ["Abstract\n", "Paper was first made from pulp.", "\n", "Pulp was pressed in China [Smith-Jones]", "\nReferences\n", "[Smith-Jones] Smith, J. 1954", "\nTLDR\n", "Paper started in China.", "\nELI5\n", "People mashed plants into sheets."].join("");
    const uncited = report.replace(" [Smith-Jones]", "");
    expect(await accepts(engine, template("research"), report)).toBe(true);
    expect(await accepts(engine, template("research"), uncited)).toBe(false);
    const work = template("calculation");
    expect(await accepts(engine, work, "2 + 2 = 4\n12 * (3 + 1) = 48\n")).toBe(true);
    expect(await accepts(engine, work, "I think it is four.\n")).toBe(false);
    const steps = template("instructions");
    expect(await accepts(engine, steps, "Step 1\nBoil the water\nVerify: The water bubbles\nStep 2\nAdd the tea\nVerify: The water turns brown\n")).toBe(true);
    expect(await accepts(engine, steps, "Boil water, then add tea.\n")).toBe(false);
    const page = template("manual");
    const manual = ["NAME\n", "daemon - session daemon process", "\nSYNOPSIS\n", "start the daemon", "\nDESCRIPTION\n", "The daemon keeps sessions.", "\nOPTIONS\n", "socket keeps the session", "\nEXAMPLES\n", "run the daemon now", "\nSEE ALSO\n", "session(1)"].join("");
    expect(await accepts(engine, page, manual)).toBe(true);
    expect(await accepts(engine, page, "Here is some help.\n")).toBe(false);
  });
});
