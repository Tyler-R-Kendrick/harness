/**
 * Which template answers a request, as the decision layer's fork `playground.template`
 * (ADR 0030): a choice among the candidate templates and `none`, put through the layer's
 * ladder. A template's `match` expression is the fork's rule; each decider (a decision
 * model, the lexical judge) is a member with a pinned id and version, asked in order, each
 * in the layer's rotations of the options; one that fails, or is not sure enough, passes
 * the decision on; when none is sure the fork's fallback, `none`, stands. Every decision is
 * a record in a log kept in memory, with the ladder's trace, and an outcome (a rating)
 * can be attached to it later.
 */
import { answerOf, averageAnswers, chooseOne, Decider as Layer, evaluationMember, MemoryDecisionLog, parsePolicy } from "@harness/decision";
import type { Answer, Answers, Asked, Calibrate, Clock, DecisionEvent, DecisionId, Member } from "@harness/decision";
import type { Decider } from "./decide.ts";
import type { EngineSettings } from "./engine-settings.ts";
import type { Template } from "./templates.ts";

/** The option a decision model is given for "none of these". */
export const NONE = "none";

/** The fork's id in the decision log. */
export const TEMPLATE_FORK = "playground.template";

/** The most rotations of its options the layer asks a model for. */
const MAX_ROTATIONS = 16;

/** The name a decision model goes by in the page: its provider and model id. */
export const nameOf = (judge: Decider["judge"]): string => `${judge.provider}/${judge.modelId}`;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A short stable fingerprint of text (FNV-1a, 32 bits, in hex): what makes a version change when what it names does. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** What a decision came to, with the page's own names for it. */
export interface TemplateChoice {
  /** The chosen template's id, or `none`. */
  readonly choice: string;
  /** Whether the choice may be acted on (the fork's policy is not in shadow mode). */
  readonly active: boolean;
  readonly probability: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly by: string;
  readonly problems: readonly string[];
  readonly id: DecisionId;
}

export interface TemplateDecisionsOptions {
  readonly clock: Clock;
  /** Decision records kept in memory (the oldest go first). */
  readonly keep: number;
  /** Told of each decision (`decision.made`). */
  readonly publish?: (event: DecisionEvent) => void;
}

interface Asking {
  readonly request: string;
  /** The templates offered as options. */
  readonly candidates: readonly Template[];
  /** The template whose `match` expression the request fits, if any: the fork's rule. */
  readonly matched: Template | undefined;
  readonly deciders: readonly Decider[];
  readonly settings: Pick<EngineSettings, "decision" | "lexical">;
  /** What the lexical judge reads of a template. */
  readonly describe: (template: Template) => string;
}

/** A question as the lexical judge reads it: each option by the text given for its key (names, descriptions and examples). */
const readBy = (asked: Asked, texts: Readonly<Record<string, string>>): Asked => ({
  state: asked.state,
  questions: Object.fromEntries(
    Object.entries(asked.questions).map(([id, q]) => [id, q.type === "choice" ? { ...q, criteria: Object.fromEntries(Object.entries(q.criteria).map(([key, text]) => [key, texts[key] ?? text])) } : q]),
  ),
});

/** The decider as a member: its answers kept (to say how sure it was), its failures told, a lexical judge read once however the options are ordered. */
function memberOf(decider: Decider, texts: Readonly<Record<string, string>>, problems: string[], seen: Map<Member, Answer[]>): Member {
  const inner = evaluationMember(decider.judge, decider.identity);
  const memo = new Map<string, Promise<Answers>>();
  const member: Member = {
    id: decider.identity.id,
    version: decider.identity.version,
    ask: (asked) => {
      const view = decider.lexical ? readBy(asked, texts) : asked;
      const run = async () => {
        try {
          const answers = await inner.ask(view);
          const choice = answers["choice"];
          if (choice !== undefined) seen.set(member, [...(seen.get(member) ?? []), choice]);
          return answers;
        } catch (e) {
          problems.push(`${nameOf(decider.judge)}: ${message(e)}`);
          throw e;
        }
      };
      // The lexical judge has no order to be biased by: its rotations are the same question, answered once.
      if (!decider.lexical) return run();
      const key = JSON.stringify(Object.entries(view.questions).map(([id, q]) => [id, q.type === "choice" ? Object.keys(q.criteria).sort() : q.type]));
      const known = memo.get(key) ?? run();
      memo.set(key, known);
      return known;
    },
  };
  return member;
}

export class TemplateDecisions {
  /** Every decision, as the layer records it. */
  readonly log: MemoryDecisionLog;
  readonly #options: TemplateDecisionsOptions;

  constructor(options: TemplateDecisionsOptions) {
    this.#options = options;
    this.log = new MemoryDecisionLog({ maxRecords: options.keep });
  }

  /** Attach a person's rating of the answer to the decision that chose its template; false when the log no longer has the decision. */
  outcome(id: DecisionId, kind: "rated-good" | "rated-bad"): Promise<boolean> {
    return this.log.outcome(id, { at: this.#options.clock.now(), source: "human", kind });
  }

  /** Decide which template answers: ask the deciders through the layer, and record the decision. */
  async decide(asking: Asking): Promise<TemplateChoice> {
    const { request, matched, deciders, settings } = asking;
    if (deciders.length === 0) throw new Error("no decision model answered: ");
    const { candidates } = asking;
    const problems: string[] = [];
    const seen = new Map<Member, Answer[]>();
    const texts = Object.fromEntries(candidates.map((t) => [t.id, asking.describe(t)]));
    const members = deciders.map((decider) => ({ decider, member: memberOf(decider, texts, problems, seen) }));

    // Each kind of decider has its own threshold; the ladder acts at the looser one, and a stricter decider's answer short of its own counts as none.
    const accepts = new Map(members.map(({ decider, member }) => [member.id, decider.lexical ? settings.lexical.accept : settings.decision.accept] as const));
    const act = Math.min(...accepts.values());
    const rotate = settings.decision.rotate ? Math.min(MAX_ROTATIONS, candidates.length + 1) : 1;
    const policy = parsePolicy({ version: `playground-template/act=${act}/rotate=${rotate}`, default: { act, verify: act, accept: act, rotate, explore: 0, mode: "active" }, forks: {} });
    const calibrate: Calibrate = ({ member }, answers) => {
      const accept = accepts.get(member);
      const answer = answers["choice"];
      if (accept === undefined || accept <= act || answer === undefined || answer.distribution[answer.top]! >= accept) return answers;
      return { ...answers, choice: answerOf("choice", Object.fromEntries(Object.keys(answer.distribution).map((key) => [key, 1]))) };
    };

    const options = Object.fromEntries(candidates.map((t) => [t.id, t.description]));
    const fork = chooseOne<string>({
      id: TEMPLATE_FORK,
      // The questions change with the templates offered and how they are put, so the version does.
      version: fingerprint(JSON.stringify([settings.decision.question, settings.decision.none, options])),
      instructions: settings.decision.question,
      options,
      none: { key: NONE, description: settings.decision.none },
      describe: (text) => ({ request: text, options: candidates.map((t) => t.id) }),
      text: (text) => text,
      fallback: () => NONE,
    });
    const layer = new Layer({
      log: this.log,
      clock: this.#options.clock,
      policy,
      members: members.map(({ member }) => member),
      calibrate,
      ...(this.#options.publish ? { publish: this.#options.publish } : {}),
    });
    const decision = await layer.decide(matched === undefined ? fork : { ...fork, rule: () => matched.id }, request);
    const { record } = decision;

    if (record.rung === "rule") return { choice: decision.action, active: decision.active, probability: 1, probabilities: { [decision.action]: 1 }, by: "match", problems, id: decision.id };
    if (seen.size === 0) throw new Error(`no decision model answered: ${problems.join("; ")}`);
    // The decider that decided; else the one that came closest. Its own answers, before any withholding.
    const averaged = members
      .filter(({ member }) => seen.has(member))
      .map(({ decider, member }) => ({ decider, member, distribution: averageAnswers(seen.get(member)!).distribution }));
    const top = (distribution: Readonly<Record<string, number>>) => Math.max(...Object.values(distribution));
    const lead = averaged.find(({ member }) => member.id === record.member) ?? averaged.reduce((best, x) => (top(x.distribution) > top(best.distribution) ? x : best));
    return { choice: decision.action, active: decision.active, probability: top(lead.distribution), probabilities: lead.distribution, by: nameOf(lead.decider.judge), problems, id: decision.id };
  }
}
