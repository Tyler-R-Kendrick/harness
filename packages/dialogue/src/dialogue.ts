import { embed, embedMany, experimental_evaluate } from "ai";
import type { EmbeddingModel, LanguageModel } from "ai";
import { embedding, ProbabilitySchema, route, similarity } from "@harness/cognitive";
import type { EvaluationModelV4, Probability, Similarity, TemplateConstraint, ToolSpec } from "@harness/cognitive";
import { shapeSimilarity } from "./align.ts";
import { draft, draftedScript } from "./draft.ts";
import { induce, normalizeUtterance } from "./induce.ts";
import { fill, findValue, fits, matchPattern, replySlots } from "./render.ts";
import { ClusterSchema, groupsOf, parseBook, parseScript, scriptId } from "./schemas.ts";
import type { Cluster, Observation, Script, ScriptId, ScriptInput, Settings, ToolResult } from "./schemas.ts";

/** A step a model is asked to answer: the user's last utterance, or the result of a tool call made for it. */
export interface Step {
  /** The daemon session the step belongs to; without one, nothing is carried between steps (no context, no forms). */
  readonly sessionId?: string;
  /** What the user said last. */
  readonly utterance: string;
  /** For a result step: the tool call whose result the step follows. */
  readonly result?: ToolResult;
}

/** How a script was matched. */
export type Match =
  | { readonly by: "pattern" | "result" | "form" }
  | { readonly by: "exemplar"; readonly similarity: Similarity }
  | { readonly by: "router"; readonly confidence: Probability };

/** A candidate that matched a step the model answers, to be checked against its reply. */
export interface Shadow {
  readonly script: ScriptId;
  readonly slots: Readonly<Record<string, string>>;
  readonly match: Match;
}

/**
 * What a dialogue does with a step: reply with a script's text (no model); have the
 * model write a script's generated holes (a template constraint); ask for a slot the
 * script needs; or pass the step to the model, saying why (and, when a candidate
 * matched, what to check its reply against).
 */
export type Decision =
  | { readonly kind: "reply"; readonly script: ScriptId; readonly text: string; readonly match: Match }
  | { readonly kind: "generate"; readonly script: ScriptId; readonly template: TemplateConstraint; readonly match: Match }
  | { readonly kind: "ask"; readonly script: ScriptId; readonly slot: string; readonly text: string; readonly match: Match }
  | { readonly kind: "pass"; readonly reason: string; readonly context?: ScriptId; readonly shadow?: Shadow };

export interface DialogueOptions {
  readonly settings: Settings;
  /** A script book (authored, or a dialogue's `save()`), to start from. */
  readonly book?: unknown;
  /** Matches utterances to exemplars, and clusters them, by meaning. Without one, clusters are by shape. */
  readonly embedder?: EmbeddingModel;
  /** A tool router: picks a script (each offered as a tool) and fills its slots. */
  readonly router?: LanguageModel;
  /** Drafts scripts (and their follow-ups) for clusters induction cannot align. */
  readonly drafter?: LanguageModel;
  /** Judges whether a candidate's reply is as good as the model's, when the model's does not fit it. */
  readonly judge?: EvaluationModelV4;
  /** Called after every change, e.g. to persist `save()`. */
  readonly onChange?: (dialogue: Dialogue) => void;
  /** Called with what failed when a model or learning fails; the dialogue goes on without it. */
  readonly onError?: (error: unknown) => void;
}

interface Matched {
  readonly script: Script;
  readonly slots: Record<string, string>;
  readonly match: Match;
}

/** A form being filled: the script, the slots it has, the slot asked for and the prompts given so far. */
interface Form {
  readonly script: ScriptId;
  readonly slots: Record<string, string>;
  readonly slot: string;
  readonly tries: number;
}

interface SessionState {
  /** The script the session's previous step matched: the next step's context. */
  last: ScriptId | undefined;
  form: Form | undefined;
}

const pass = (reason: string, context: ScriptId | undefined, shadow?: Shadow): Decision => ({
  kind: "pass",
  reason,
  ...(context === undefined ? {} : { context }),
  ...(shadow === undefined ? {} : { shadow }),
});

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  a.forEach((x, i) => {
    dot += x * b[i]!;
    na += x * x;
    nb += b[i]! * b[i]!;
  });
  return na === 0 || nb === 0 ? 0 : Math.max(-1, Math.min(1, dot / Math.sqrt(na * nb)));
}

/** A script as a tool for the router: named by its id, described by its intent, its slots as string parameters. */
const toolSpec = (script: Script): ToolSpec => ({
  name: script.id,
  description: script.intent,
  parameters: {
    type: "object",
    properties: Object.fromEntries(Object.entries(script.slots).map(([name, slot]) => [name, { type: "string", ...(slot.description === undefined ? {} : { description: slot.description }) }])),
    additionalProperties: false,
  },
});

/** A router's arguments as slot values: those with text in them, trimmed. The AI SDK checked them against the tool's string parameters. */
const slotValues = (args: Readonly<Record<string, unknown>>): Record<string, string> =>
  Object.fromEntries(Object.entries(args as Readonly<Record<string, string>>).flatMap(([k, v]) => (v.trim() !== "" ? [[k, v.trim()]] : [])));

/**
 * Scripted dialogue in front of a model: the IVR and call-center pattern, where scripts
 * answer what they can and the rest goes to a live agent (here, the model).
 *
 * `respond` decides a step: a script matched by pattern, exemplar or router (cheapest
 * first; a script in context before one without) answers it, asking for slots it lacks
 * as a VoiceXML form does, escalating through its prompts and handing the step to the
 * model after the last one. A result step is answered by a script for its tool. Only
 * active scripts answer; a matched candidate is checked in shadow.
 *
 * `observe` learns from the model's reply to a step it passed: a shadowed candidate
 * gains a fit (the reply fits its template, or the judge finds its own reply as good)
 * or a miss (and is induced again, wider); candidates are promoted and scripts retired
 * on their evidence. Other steps are clustered, and a cluster at the support becomes a
 * candidate by induction, or by a draft (with follow-ups) when it cannot be aligned.
 *
 * The models are optional and fallible: a model that is missing or fails matches,
 * extracts, judges or drafts nothing (its failure goes to `onError`), and the dialogue
 * goes on without it.
 */
export class Dialogue {
  readonly #settings: Settings;
  readonly #embedder: EmbeddingModel | undefined;
  readonly #router: LanguageModel | undefined;
  readonly #drafter: LanguageModel | undefined;
  readonly #judge: EvaluationModelV4 | undefined;
  readonly #onChange: ((dialogue: Dialogue) => void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  /** Scripts by id (a cluster's script, when it has none, is simply not found). */
  readonly #scripts = new Map<string | undefined, Script>();
  #clusters: Cluster[];
  #next: number;
  readonly #sessions = new Map<string, SessionState>();
  /** Document embeddings (exemplars, cluster heads), by text. */
  readonly #vectors = new Map<string, number[]>();
  /** Learning runs one observation at a time, in order, off the step's path. */
  #work: Promise<void> = Promise.resolve();

  constructor(options: DialogueOptions) {
    this.#settings = options.settings;
    this.#embedder = options.embedder;
    this.#router = options.router;
    this.#drafter = options.drafter;
    this.#judge = options.judge;
    this.#onChange = options.onChange;
    this.#onError = options.onError;
    const book = parseBook(options.book ?? {});
    for (const script of book.scripts) this.#scripts.set(script.id, script);
    this.#clusters = book.clusters;
    this.#next = book.next;
  }

  /** Every script, authored and built, in the order they were added. */
  get scripts(): readonly Script[] {
    return [...this.#scripts.values()];
  }

  script(id: string): Script | undefined {
    return this.#scripts.get(id);
  }

  /** Add an authored script, or replace the one with its id. It is checked as a book's scripts are. */
  put(input: ScriptInput): void {
    const script = parseScript(input);
    parseBook({ scripts: [...this.scripts.filter((s) => s.id !== script.id), script] });
    this.#scripts.set(script.id, script);
    this.#changed();
  }

  /** Feedback from outside on a script's answers: counted as a fit (helpful) or a miss (harmful). */
  feedback(id: string, kind: "helpful" | "harmful"): void {
    if (!this.#scripts.has(id)) throw new Error(`no script ${id}`);
    this.#count(id, kind === "helpful" ? "fits" : "misses");
  }

  /** What was authored and built, as a script book (see BookSchema). */
  save(): unknown {
    return { next: this.#next, scripts: this.scripts, clusters: this.#clusters.map((c) => ({ ...c, observations: [...c.observations] })) };
  }

  /** Resolves when every observation so far has been learned from. */
  idle(): Promise<void> {
    return this.#work;
  }

  async respond(step: Step): Promise<Decision> {
    const session = step.sessionId === undefined ? undefined : this.#session(step.sessionId);
    const context = session?.last;
    const decision = step.result !== undefined ? this.#onResult(step.result, context) : await this.#onUtterance(step.utterance, session, context);
    if (session) session.last = decision.kind === "pass" ? decision.shadow?.script : decision.script;
    if (decision.kind === "reply" || decision.kind === "generate") this.#count(decision.script, "served");
    return decision;
  }

  /**
   * The model's reply to a step (after `respond` passed it), to learn from; undefined
   * when the model called tools instead. Learning happens in the background (see `idle`).
   */
  observe(step: Step, decision: Decision, reply: string | undefined): void {
    if (decision.kind !== "pass" || reply === undefined || reply.trim() === "") return;
    const observation: Observation = { utterance: step.utterance, ...(step.result ? { result: step.result } : {}), reply: reply.trim() };
    const shadow = decision.shadow;
    // Learning is best effort: a failure (a model's among them) loses one observation, never a turn.
    this.#work = this.#work.then(() => (shadow ? this.#verify(shadow, observation) : this.#learn(observation, decision.context))).catch((e: unknown) => this.#failed(e));
  }

  // ---- responding ---------------------------------------------------------------

  #session(id: string): SessionState {
    // Stryker disable next-line ObjectLiteral: equivalent; a state with nothing in it reads as one without keys
    const state = this.#sessions.get(id) ?? { last: undefined, form: undefined };
    this.#sessions.delete(id);
    this.#sessions.set(id, state);
    for (const oldest of this.#sessions.keys()) {
      if (this.#sessions.size <= this.#settings.sessions) break;
      this.#sessions.delete(oldest);
    }
    return state;
  }

  #onResult(result: ToolResult, context: ScriptId | undefined): Decision {
    const forTool = this.scripts.filter((s) => s.result?.tool === result.tool);
    for (const script of [...forTool.filter((s) => s.status === "active"), ...forTool.filter((s) => s.status === "candidate")]) {
      const filled = fill(script, { slots: {}, result });
      if (filled.kind === "missing") continue;
      const match = { by: "result" } as const;
      if (script.status === "candidate") return pass(`${script.id} is a candidate`, context, { script: script.id, slots: {}, match });
      return filled.kind === "text" ? { kind: "reply", script: script.id, text: filled.text, match } : { kind: "generate", script: script.id, template: filled.template, match };
    }
    return pass(`no script answers this ${result.tool} result`, context);
  }

  async #onUtterance(utterance: string, session: SessionState | undefined, context: ScriptId | undefined): Promise<Decision> {
    const form = session?.form;
    if (session && form) {
      session.form = undefined;
      const decided = await this.#continueForm(utterance, session, form, context);
      if (decided) return decided;
    }
    const matched = await this.#match(utterance, context);
    return matched ? this.#answer(matched, session, context) : pass("no script matches", context);
  }

  /** A matched script's answer: shadowing for a candidate, its reply, or a question for a slot it lacks. */
  #answer(matched: Matched, session: SessionState | undefined, context: ScriptId | undefined): Decision {
    const { script, slots, match } = matched;
    if (script.status === "candidate") return pass(`${script.id} is a candidate`, context, { script: script.id, slots, match });
    const filled = fill(script, { slots });
    if (filled.kind === "text") return { kind: "reply", script: script.id, text: filled.text, match };
    if (filled.kind === "template") return { kind: "generate", script: script.id, template: filled.template, match };
    const unaskable = filled.slots.find((slot) => session === undefined || script.slots[slot]!.prompts.length === 0);
    if (unaskable !== undefined || !session) return pass(`no value for slot ${unaskable}`, context);
    const slot = filled.slots[0]!;
    session.form = { script: script.id, slots, slot, tries: 0 };
    return { kind: "ask", script: script.id, slot, text: script.slots[slot]!.prompts[0]!, match };
  }

  /** The answer to a form's prompt: its slot's value, another script taking over, the next prompt, or the model. */
  async #continueForm(utterance: string, session: SessionState, form: Form, context: ScriptId | undefined): Promise<Decision | undefined> {
    const script = this.#scripts.get(form.script);
    if (!script || script.status === "retired") return undefined;
    const slots = { ...form.slots };
    for (const pattern of script.patterns) Object.assign(slots, matchPattern(pattern, utterance));
    const value = slots[form.slot] ?? (await this.#valueFor(script, form.slot, utterance));
    if (value !== undefined) return this.#answer({ script, slots: { ...slots, [form.slot]: value }, match: { by: "form" } }, session, context);
    const other = await this.#match(utterance, context, script.id);
    if (other) return this.#answer(other, session, context);
    const tries = form.tries + 1;
    const prompts = script.slots[form.slot]!.prompts;
    if (tries >= prompts.length) return pass(`no ${form.slot} after ${tries} prompts`, context);
    session.form = { ...form, tries };
    return { kind: "ask", script: script.id, slot: form.slot, text: prompts[tries]!, match: { by: "form" } };
  }

  /** A slot's value in an answer: by its value pattern, else the router's, else (with neither) the whole answer. */
  async #valueFor(script: Script, slot: string, utterance: string): Promise<string | undefined> {
    const pattern = script.slots[slot]!.pattern;
    if (pattern !== undefined) return findValue(pattern, utterance);
    if (this.#router) return (await this.#pick(utterance, [script]))?.slots[slot];
    return normalizeUtterance(utterance) || undefined;
  }

  /** The eligible scripts matching an utterance, cheapest way first: pattern, exemplar, router. */
  async #match(utterance: string, context: ScriptId | undefined, exclude?: ScriptId): Promise<Matched | undefined> {
    const rank = (s: Script) => (s.status === "active" ? 0 : 2) + (s.context === undefined ? 1 : 0);
    const eligible = this.scripts
      .filter((s) => s.result === undefined && s.status !== "retired" && s.id !== exclude && (s.context === undefined || s.context === context))
      .sort((a, b) => rank(a) - rank(b));
    for (const script of eligible)
      for (const pattern of script.patterns) {
        const slots = matchPattern(pattern, utterance);
        // A slot the pattern has a group for is where the group says, or not in the utterance at all.
        if (slots) return { script, slots: await this.#slotsFor(script, utterance, slots, { parsed: groupsOf(pattern) }), match: { by: "pattern" } };
      }
    const alike = await this.#nearestExemplar(utterance, eligible).catch((e: unknown) => this.#failed(e));
    if (alike && alike.similarity >= this.#settings.match.similar) return { script: alike.script, slots: await this.#slotsFor(alike.script, utterance, {}), match: { by: "exemplar", similarity: alike.similarity } };
    if (eligible.length === 0) return undefined;
    const picked = await this.#pick(utterance, eligible);
    return picked && { script: picked.script, slots: await this.#slotsFor(picked.script, utterance, picked.slots, { routed: true }), match: { by: "router", confidence: picked.confidence } };
  }

  async #nearestExemplar(utterance: string, scripts: readonly Script[]): Promise<{ script: Script; similarity: Similarity } | undefined> {
    const pairs = scripts.flatMap((script) => script.exemplars.map((exemplar) => ({ script, exemplar })));
    if (!this.#embedder || pairs.length === 0) return undefined;
    const { embedding: query } = await embed({ model: this.#embedder, value: utterance, maxRetries: 0, ...embedding({ kind: "query" }) });
    const documents = await this.#documents(pairs.map((p) => p.exemplar));
    let best = { script: pairs[0]!.script, similarity: cosine(query, documents[0]!) };
    pairs.forEach(({ script }, i) => {
      const s = cosine(query, documents[i]!);
      if (s > best.similarity) best = { script, similarity: s };
    });
    return { script: best.script, similarity: similarity(best.similarity) };
  }

  /** The router's one pick among scripts, at or above its threshold, with the slots it filled; nothing without a router, or when it fails. */
  async #pick(utterance: string, scripts: readonly Script[]): Promise<{ script: Script; slots: Record<string, string>; confidence: Probability } | undefined> {
    if (!this.#router) return undefined;
    const routed = await route(this.#router, { input: utterance, tools: scripts.map(toolSpec) }).catch((e: unknown) => this.#failed(e));
    if (!routed || routed.problems.length > 0 || routed.valid.length !== 1 || routed.confidence < this.#settings.match.route) return undefined;
    const [call] = routed.valid;
    // A valid call names an offered tool, which is one of the scripts.
    return { script: scripts.find((s) => s.id === call!.name)!, slots: slotValues(call!.arguments), confidence: routed.confidence };
  }

  /**
   * Slots for a matched script: those given, else found by the slots' value patterns, else
   * (for any the reply still lacks, unless the router made the match) the router's. Slots a
   * matching pattern parsed are not looked for elsewhere.
   */
  async #slotsFor(script: Script, utterance: string, given: Record<string, string>, how: { readonly parsed?: readonly string[]; readonly routed?: true } = {}): Promise<Record<string, string>> {
    const needed = replySlots(script).filter((slot) => !how.parsed?.includes(slot));
    const found = needed.flatMap((slot) => {
      const pattern = script.slots[slot]!.pattern;
      // Stryker disable next-line ConditionalExpression: equivalent; no pattern is an empty one, which finds no value
      const value = pattern === undefined ? undefined : findValue(pattern, utterance);
      return value === undefined ? [] : [[slot, value] as const];
    });
    const slots = { ...Object.fromEntries(found), ...given };
    if (how.routed || needed.every((slot) => slots[slot] !== undefined)) return slots;
    const picked = await this.#pick(utterance, [script]);
    return { ...picked?.slots, ...slots };
  }

  /** Embeddings of documents (exemplars, cluster heads), each embedded once. */
  async #documents(texts: readonly string[]): Promise<number[][]> {
    const missing = [...new Set(texts.filter((t) => !this.#vectors.has(t)))];
    if (missing.length > 0) {
      const { embeddings } = await embedMany({ model: this.#embedder!, values: missing, maxRetries: 0, ...embedding({ kind: "document" }) });
      missing.forEach((t, i) => this.#vectors.set(t, embeddings[i]!));
    }
    return texts.map((t) => this.#vectors.get(t)!);
  }

  // ---- learning -----------------------------------------------------------------

  async #verify(shadow: Shadow, observation: Observation): Promise<void> {
    const script = this.#scripts.get(shadow.script);
    if (!script || script.status !== "candidate") return;
    const fillers = { slots: shadow.slots, ...(observation.result ? { result: observation.result } : {}) };
    if (fits(script, observation.reply, { ...fillers, utterance: observation.utterance }) || (await this.#judged(script, fillers, observation))) return this.#count(script.id, "fits");
    const cluster = this.#clusters.find((c) => c.script === script.id);
    if (cluster) {
      this.#add(cluster, observation);
      this.#reinduce(cluster, script);
    }
    this.#count(script.id, "misses");
  }

  /** Whether the judge finds the candidate's reply as good as the model's (never for a script the model must finish). */
  async #judged(script: Script, fillers: { readonly slots: Readonly<Record<string, string>>; readonly result?: ToolResult }, observation: Observation): Promise<boolean> {
    const filled = fill(script, fillers);
    if (!this.#judge || filled.kind !== "text") return false;
    const verdict = await experimental_evaluate({
      model: this.#judge,
      maxRetries: 0,
      state: { request: observation.utterance, ...(observation.result ? { result: observation.result } : {}), reply: observation.reply, candidate: filled.text },
      questions: { equivalent: { type: "boolean", instructions: this.#settings.promote.question } },
    }).catch((e: unknown) => this.#failed(e));
    return verdict !== undefined && ProbabilitySchema.parse(verdict.answers.equivalent.probability) >= this.#settings.promote.judge;
  }

  async #learn(observation: Observation, context: ScriptId | undefined): Promise<void> {
    const cluster = await this.#clusterFor(observation, context);
    this.#add(cluster, observation);
    const script = this.#scripts.get(cluster.script);
    if (script?.origin === "induced") this.#reinduce(cluster, script);
    else if (!script && cluster.observations.length >= this.#settings.induce.support) await this.#build(cluster);
    this.#changed();
  }

  /** The cluster an observation belongs to: its tool's, or the nearest in its context at the threshold; else a new one. */
  async #clusterFor(observation: Observation, context: ScriptId | undefined): Promise<Cluster> {
    const tool = observation.result?.tool;
    if (tool !== undefined) return this.#clusters.find((c) => c.tool === tool) ?? this.#newCluster({ tool });
    const alike = this.#clusters.filter((c) => c.tool === undefined && c.context === context);
    if (alike.length === 0) return this.#newCluster(context === undefined ? {} : { context });
    const scores = await this.#similarities(
      observation.utterance,
      alike.map((c) => c.observations[0]!.utterance),
    );
    let best: { cluster: Cluster; score: number } | undefined;
    alike.forEach((cluster, i) => {
      if (scores[i]! >= this.#settings.induce.cluster && (best === undefined || scores[i]! > best.score)) best = { cluster, score: scores[i]! };
    });
    return best?.cluster ?? this.#newCluster(context === undefined ? {} : { context });
  }

  /** How alike an utterance is to each of `heads`: by meaning with an embedder (by shape if it fails), else by shape. */
  async #similarities(utterance: string, heads: readonly string[]): Promise<number[]> {
    const vectors = this.#embedder && (await this.#documents([utterance, ...heads]).catch((e: unknown) => this.#failed(e)));
    return vectors ? vectors.slice(1).map((v) => cosine(vectors[0]!, v)) : heads.map((head) => shapeSimilarity(utterance, head));
  }

  #newCluster(fields: { readonly tool?: string; readonly context?: ScriptId }): Cluster {
    const cluster = ClusterSchema.parse({ ...fields, observations: [] });
    this.#clusters.push(cluster);
    return cluster;
  }

  #add(cluster: Cluster, observation: Observation): void {
    cluster.observations.push(observation);
    cluster.observations.splice(0, cluster.observations.length - this.#settings.induce.keep);
  }

  /** The next built script's id, skipping any an authored script took. */
  #nextId(): ScriptId {
    while (this.#scripts.has(`s${this.#next}`)) this.#next++;
    return scriptId(`s${this.#next}`);
  }

  /** A candidate from a cluster at the support: induced, else (for utterances, once) drafted. */
  async #build(cluster: Cluster): Promise<void> {
    const induced = induce(cluster, this.#settings.induce, this.#nextId());
    if ("script" in induced) {
      this.#next++;
      cluster.script = induced.script.id;
      return this.#set(this.#due(induced.script));
    }
    if (cluster.tool !== undefined || !this.#drafter || cluster.drafted) return;
    cluster.drafted = true;
    await this.#draft(cluster, this.#drafter);
  }

  /** A drafted script, kept when it reproduces a reply the cluster saw, with its valid follow-ups. A failed draft builds nothing. */
  async #draft(cluster: Cluster, drafter: LanguageModel): Promise<void> {
    const drafted = await draft(drafter, this.#settings.draft, cluster.observations);
    const main = draftedScript(drafted, this.#nextId(), cluster.context);
    const fitting = cluster.observations.filter((o) => fits(main, o.reply, { slots: {}, utterance: o.utterance })).length;
    if (fitting === 0) return;
    this.#next++;
    cluster.script = main.id;
    this.#set(this.#due({ ...main, evidence: { fits: fitting, misses: 0, served: 0 } }));
    let kept = 0;
    for (const followUp of drafted.followUps) {
      if (kept === this.#settings.draft.followUps) break;
      try {
        this.#set(draftedScript(followUp, this.#nextId(), main.id));
        this.#next++;
        kept++;
      } catch {
        // A follow-up that is not a valid script is dropped.
      }
    }
  }

  /** Induce a candidate again from its cluster, keeping its id, status and evidence (unless the cluster no longer aligns). */
  #reinduce(cluster: Cluster, script: Script): void {
    const induced = induce(cluster, this.#settings.induce, script.id);
    if ("script" in induced) this.#set({ ...induced.script, status: script.status, evidence: script.evidence });
  }

  /** A script's status as its evidence has it: one misleading by the margin is retired; a candidate with enough fits is active. */
  #due(script: Script): Script {
    const { fits: fit, misses } = script.evidence;
    const { fits: needed, retireMargin } = this.#settings.promote;
    if (misses - fit >= retireMargin) return { ...script, status: "retired" };
    if (script.status === "candidate" && fit >= needed) return { ...script, status: "active" };
    return script;
  }

  #count(id: string, field: "fits" | "misses" | "served"): void {
    const script = this.#scripts.get(id)!;
    this.#set(this.#due({ ...script, evidence: { ...script.evidence, [field]: script.evidence[field] + 1 } }));
  }

  /** Keep a script; a cluster is dropped once its script is no longer a candidate (its observations are no longer needed). */
  #set(script: Script): void {
    this.#scripts.set(script.id, script);
    if (script.status !== "candidate") this.#clusters = this.#clusters.filter((c) => c.script !== script.id);
    this.#changed();
  }

  #changed(): void {
    this.#onChange?.(this);
  }

  /** Report a failure; what failed gives nothing. */
  #failed(error: unknown): undefined {
    this.#onError?.(error);
    return undefined;
  }
}
