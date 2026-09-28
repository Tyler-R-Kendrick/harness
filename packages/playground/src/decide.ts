/**
 * Deciding without generating: which template answers a request, and the values of its
 * holes that need no generator. Every decision is a choice question to a decision model
 * (an AI SDK evaluation model: a local one such as Julia 1 where it runs, else the
 * lexical one here), so a better decision model drops in without changing the engine.
 */
import { experimental_evaluate } from "ai";
import type { Experimental_EvaluationModelV4 as EvaluationModelV4, Experimental_EvaluationModelV4Input as EvaluationInput } from "@ai-sdk/provider";
import type { EngineSettings } from "./engine-settings.ts";
import type { Hole, Template } from "./templates.ts";

type LexicalSettings = EngineSettings["lexical"];

/** The option a decision model is given for "none of these". */
export const NONE = "none";

const asText = (input: EvaluationInput | null | undefined): string => (input == null ? "" : typeof input === "string" ? input : JSON.stringify(input));

/** Words for matching: lower case, stopwords and single letters dropped, a plural's s taken off. */
function words(text: string, stopwords: ReadonlySet<string>): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !stopwords.has(w)).map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** How much each document shares with the query: cosine similarity of TF-IDF vectors, the IDF taken over the documents. */
export function lexicalScores(query: string, documents: readonly string[], stopwords: readonly string[] = []): number[] {
  const stop = new Set(stopwords);
  const docs = documents.map((d) => words(d, stop));
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => Math.log((docs.length + 1) / ((df.get(w) ?? 0) + 1)) + 1;
  const vector = (ws: readonly string[]) => {
    const v = new Map<string, number>();
    for (const w of ws) v.set(w, (v.get(w) ?? 0) + idf(w));
    return v;
  };
  const norm = (v: Map<string, number>) => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0));
  const q = vector(words(query, stop));
  return docs.map((d) => {
    const v = vector(d);
    const dot = [...q].reduce((s, [w, x]) => s + x * (v.get(w) ?? 0), 0);
    return dot === 0 ? 0 : dot / (norm(q) * norm(v));
  });
}

/**
 * The lexical decision model: a choice goes to the option (its name and description)
 * that shares the most words with the state, the option named `none` scoring a fixed
 * floor, with a softmax over the similarities as the probabilities. No model, no
 * inference: the decision model of last resort.
 */
export function lexicalJudge(settings: LexicalSettings): EvaluationModelV4 {
  return {
    specificationVersion: "v4",
    provider: "harness.lexical",
    modelId: "tf-idf",
    supportedQuestionTypes: ["choice"],
    doEvaluate: async ({ state, questions }) => ({
      answers: Object.fromEntries(
        Object.entries(questions).map(([id, question]) => {
          const options = Object.entries(question.type === "choice" ? question.criteria : {});
          const scores = lexicalScores(asText(state), options.map(([name, text]) => `${name} ${asText(text)}`), settings.stopwords).map((s, i) => (options[i]![0] === NONE ? settings.none : s));
          const peak = Math.max(...scores);
          const weights = scores.map((s) => Math.exp((s - peak) / settings.temperature));
          const total = weights.reduce((a, b) => a + b, 0);
          const probabilities = Object.fromEntries(options.map(([name], i) => [name, weights[i]! / total]));
          return [id, { type: "choice" as const, choice: options[scores.indexOf(peak)]![0], probabilities }];
        }),
      ),
      warnings: [],
    }),
  };
}

/**
 * A decision model, and how it is asked. A model reads each template's description alone
 * (written as what a user asks for) and needs `decision.accept` to take one; the lexical
 * one reads names, descriptions and examples, and needs `lexical.accept`.
 */
export interface Decider {
  readonly judge: EvaluationModelV4;
  readonly lexical: boolean;
}
export const modelDecider = (judge: EvaluationModelV4): Decider => ({ judge, lexical: false });
export const lexicalDecider = (settings: LexicalSettings): Decider => ({ judge: lexicalJudge(settings), lexical: true });

const nameOf = (judge: EvaluationModelV4) => `${judge.provider}/${judge.modelId}`;

/**
 * A choice put to a decider. A model is given every rotation of the options at once (one
 * batch) and its answers are averaged, so where an option sits does not decide it (a
 * decision model can favour a position); the lexical judge, which has no order, is asked once.
 */
async function choose(decider: Decider, state: string, instructions: string, entries: readonly (readonly [string, string | null])[], rotate: boolean): Promise<{ choice: string; probabilities: Record<string, number> }> {
  const probabilities: Record<string, number> = Object.fromEntries(entries.map(([k]) => [k, 0]));
  if (decider.lexical || !rotate) {
    const { answers } = await experimental_evaluate({ model: decider.judge, maxRetries: 0, state, questions: { q0: { type: "choice", instructions, criteria: Object.fromEntries(entries) } } });
    Object.assign(probabilities, answers["q0"]!.probabilities ?? { [answers["q0"]!.choice]: 1 });
  } else {
    // Options go under stand-in names (o0, o1, …) that keep each rotation's order: an object puts integer-like keys first.
    const described = entries.map(([name, text]) => [name, text ?? name] as const);
    const orders = described.map((_, i) => [...described.slice(i), ...described.slice(0, i)]);
    const questions = Object.fromEntries(orders.map((order, i) => [`q${i}`, { type: "choice" as const, instructions, criteria: Object.fromEntries(order.map(([, text], k) => [`o${k}`, text])) }]));
    const { answers } = await experimental_evaluate({ model: decider.judge, maxRetries: 0, state, questions });
    orders.forEach((order, i) => {
      const answer = answers[`q${i}`]!;
      const p = answer.probabilities ?? { [answer.choice]: 1 };
      order.forEach(([name], k) => (probabilities[name] = probabilities[name]! + (p[`o${k}`] ?? 0) / orders.length));
    });
  }
  const choice = entries.map(([k]) => k).reduce((best, k) => (probabilities[k]! > probabilities[best]! ? k : best));
  return { choice, probabilities };
}

/** Ask each decider in turn until one answers: its answer, who it was, and why the ones before it did not. */
async function firstAnswer<T>(deciders: readonly Decider[], ask: (d: Decider) => Promise<T>): Promise<{ value: T; decider: Decider; problems: string[] }> {
  const problems: string[] = [];
  for (const decider of deciders) {
    try {
      return { value: await ask(decider), decider, problems };
    } catch (e) {
      problems.push(`${nameOf(decider.judge)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`no decision model answered: ${problems.join("; ")}`);
}

export interface Decision {
  /** The template that answers, when one is likely enough. */
  readonly template?: Template;
  readonly probability: number;
  readonly probabilities: Readonly<Record<string, number>>;
  /** The decision model that decided (provider/model). */
  readonly by: string;
  /** Why the decision models asked before it did not decide. */
  readonly problems?: readonly string[];
}

const describe = (t: Template) => [t.description, ...t.examples].join(". ");

/** Narrow options to the ones a decision model takes at once, by lexical similarity to the request. */
function narrow<T>(request: string, items: readonly T[], text: (item: T) => string, max: number, stopwords: readonly string[]): T[] {
  if (items.length <= max) return [...items];
  const scores = lexicalScores(request, items.map(text), stopwords);
  return items
    .map((item, i) => ({ item, score: scores[i]! }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.item);
}

/** Ask the deciders, in order, which template answers the request (or none). */
export async function chooseTemplate(deciders: readonly Decider[], request: string, templates: readonly Template[], settings: EngineSettings): Promise<Decision> {
  if (templates.length === 0) return { probability: 0, probabilities: {}, by: "none: no templates" };
  const matched = templates.find((t) => t.match !== undefined && new RegExp(t.match).test(request));
  if (matched) return { template: matched, probability: 1, probabilities: { [matched.id]: 1 }, by: "match" };
  const candidates = narrow(request, templates, (t) => `${t.id} ${describe(t)}`, settings.decision.maxOptions - 1, settings.lexical.stopwords);
  const { value: answer, decider, problems } = await firstAnswer(deciders, (d) => {
    const options: [string, string][] = [[NONE, settings.decision.none], ...candidates.map((t) => [t.id, d.lexical ? describe(t) : t.description] as [string, string])];
    return choose(d, request, settings.decision.question, options, settings.decision.rotate);
  });
  const { probabilities } = answer;
  const probability = probabilities[answer.choice]!;
  const accept = decider.lexical ? settings.lexical.accept : settings.decision.accept;
  const template = answer.choice === NONE || probability < accept ? undefined : candidates.find((t) => t.id === answer.choice);
  return { ...(template ? { template } : {}), probability, probabilities, by: nameOf(decider.judge), ...(problems.length > 0 ? { problems } : {}) };
}

/** What the harness knows, by name, computed when a hole asks. */
export type Facts = Readonly<Record<string, () => string | Promise<string>>>;

/** How a hole is filled: as declared, else from a fact of its name, else by a generator. */
export function holeOf(template: Template, name: string, facts: Facts): Hole {
  return template.holes[name] ?? (name in facts ? { description: name, source: "fact" } : { description: name, source: "text" });
}

export const holeNames = (template: Template) => template.constraint.parts.flatMap((p) => (typeof p === "string" ? [] : [p.hole]));

const lines = (text: string) => text.split("\n").filter((l) => l.trim() !== "");

/**
 * The values of a template's holes that need no generator: facts, patterns in the
 * request, and choices the decision model makes; the rest (text holes, and values that
 * could not be found) are missing, for a generator.
 */
export async function resolveHoles(
  template: Template,
  request: string,
  facts: Facts,
  deciders: readonly Decider[],
  settings?: Pick<EngineSettings, "decision" | "lexical">,
): Promise<{ values: Record<string, string>; missing: string[]; problems: string[] }> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const problems: string[] = [];
  for (const name of holeNames(template)) {
    const hole = holeOf(template, name, facts);
    let value: string | undefined;
    if (hole.source === "fact") value = await facts[hole.fact ?? name]?.();
    else if (hole.source === "pattern") {
      const match = new RegExp(hole.pattern!, "s").exec(request);
      value = match ? (match[1] ?? match[0]) : undefined;
    } else if (hole.source === "choice") {
      const all = hole.options ?? lines((await facts[hole.fact!]?.()) ?? "");
      const options = narrow(request, all, (o) => o, settings?.decision.maxOptions ?? 20, settings?.lexical.stopwords ?? []);
      if (options.length === 1) value = options[0];
      else if (options.length > 1) {
        const asked = await firstAnswer(deciders, (d) => choose(d, request, hole.description, options.map((o) => [o, null] as const), settings?.decision.rotate ?? true));
        problems.push(...asked.problems);
        value = asked.value.choice;
      }
    }
    if (value === undefined) missing.push(name);
    else values[name] = value;
  }
  return { values, missing, problems };
}
