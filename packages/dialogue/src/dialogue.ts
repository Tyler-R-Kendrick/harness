import { embed, embedMany, experimental_evaluate, tool } from "ai";
import type { EmbeddingModel, JSONValue, LanguageModel, ToolSet } from "ai";
import { z } from "zod";
import { CorrectionInputSchema, correctedArtifact, embedding, PreferenceRecordSchema, ProbabilitySchema, route, similarity } from "@harness/cognitive";
import type { ArtifactText, CorrectionInput, EvaluationModelV4, PreferenceRecord, Probability, Similarity, TemplateConstraint, ToolSpec } from "@harness/cognitive";
import { shapeSimilarity } from "./align.ts";
import { draft, draftedScript } from "./draft.ts";
import { induce, normalizeUtterance } from "./induce.ts";
import { composeReplies, fill, findValue, fits, matchPattern, readHoles, replySlots, stitchAnswer } from "./render.ts";
import { ClusterSchema, DocumentSchema, FlowNameSchema, groupsOf, parseBook, parseScript, scriptId } from "./schemas.ts";
import type { Cluster, DocumentInput, DocumentRecord, Observation, Script, ScriptId, ScriptInput, SessionSave, Settings, ToolResult } from "./schemas.ts";

/** A step a model is asked to answer: the user's last utterance, or the result of a tool call made for it. */
export interface Step {
  /** The daemon session the step belongs to; without one, nothing is carried between steps (no context, no forms). */
  readonly sessionId?: string;
  /** What the user said last. */
  readonly utterance: string;
  /** For a result step: the tool call whose result the step follows. */
  readonly result?: ToolResult;
  /** Where the step is (the session's project): scoped scripts answer only in their scope, and what is learned here is scoped here. */
  readonly scope?: string;
}

/** How a script was matched (a flow's later turns: by the flow that heard them). */
export type Match =
  | { readonly by: "pattern" | "result" | "form" | "flow" }
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
 * script needs; reply with what a flow said; or pass the step to the model, saying why
 * (and, when a candidate matched, what to check its reply against).
 */
export type Decision =
  | { readonly kind: "reply"; readonly script: ScriptId; readonly scripts?: readonly ScriptId[]; readonly text: string; readonly match: Match }
  | { readonly kind: "flow"; readonly flow: string; readonly script?: ScriptId; readonly text: string; readonly match: Match }
  | { readonly kind: "generate"; readonly script: ScriptId; readonly scripts?: readonly ScriptId[]; readonly template: TemplateConstraint; readonly instruction: string; readonly match: Match; readonly said?: string }
  | { readonly kind: "ask"; readonly script: ScriptId; readonly slot: string; readonly text: string; readonly match: Match }
  | { readonly kind: "pass"; readonly reason: string; readonly context?: ScriptId; readonly shadow?: Shadow; readonly said?: string; readonly teaches?: false };

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
  /** Runs flows durably: a workflow host (see @harness/workflows), whose library holds them. */
  readonly flows?: FlowRunner;
  /** Interpreters for the book's documents, by type (see @harness/dialogue-standards). */
  readonly interpreters?: readonly Interpreter[];
  /** The time, for documents that say it (milliseconds since 1970, UTC). */
  readonly now?: () => number;
  /** Called with what happens to the book: a script built, put, promoted or retired; a document put (see DialogueEvent). */
  readonly onEvent?: (event: DialogueEvent) => void;
  /**
   * When a turn passes because no script matches, draft a template for that session
   * from the model's reply. It is kept only when it still reproduces that reply and
   * leaves a particular open as a slot or a hole.
   */
  readonly sessionTemplates?: boolean;
}

/** Something that happened to a dialogue's book, e.g. for plugins on the hook bus: `dialogue.script.built`, `.put`, `.promoted`, `.retired`, `dialogue.document.put`. */
export interface DialogueEvent {
  readonly type: string;
  readonly payload: Record<string, string>;
}

/** A dialogue's book in numbers (see Dialogue.status). */
export interface DialogueStatus {
  readonly scripts: Readonly<Record<"active" | "candidate" | "retired", number>>;
  readonly built: number;
  readonly clusters: number;
  readonly sessions: number;
  readonly documents: readonly string[];
  readonly entry?: string;
}

/**
 * A document's next step, from the last step's state (null to start) and this turn's
 * utterance, slots, or the result of the tool it called (or, as `error`, why that tool
 * could not be called: VoiceXML's `error.badfetch`).
 */
export interface StepInput {
  readonly state: JSONValue | null;
  readonly utterance?: string;
  readonly slots?: Readonly<Record<string, string>>;
  readonly result?: JSONValue;
  readonly error?: string;
  readonly now?: number;
}

/**
 * What a document's step does: says `say`, and then hands the turn on (`pass`), ends
 * (`end`: exit, or transfer the person to the model), calls a tool first (`call`, the
 * next step taking its result), or waits for the next utterance with `state`.
 */
export interface StepResult {
  readonly say: readonly string[];
  readonly state: JSONValue;
  readonly pass?: true;
  readonly end?: "exit" | "transfer";
  readonly output?: JSONValue;
  readonly call?: { readonly tool: string; readonly input: JSONValue };
}

/** A document compiled by its interpreter: what it left out, and its steps. */
export interface CompiledDocument {
  readonly warnings: readonly string[];
  step(input: StepInput): StepResult;
}

/** Runs documents of one type (a dialogue standard) a step at a time; compiling refuses a document it cannot run. */
export interface Interpreter {
  readonly type: string;
  compile(files: Readonly<Record<string, string>>, options: Readonly<Record<string, JSONValue>>): CompiledDocument;
}

/**
 * Runs a flow (a workflow of kind `flow`) as a durable run, with the dialogue's tools for
 * this turn. A `WorkflowHost` is one: the run's journal is the flow's state, so a run
 * that stopped (waiting for the next utterance, or a restart) resumes by replay.
 */
export interface FlowRunner {
  run(name: string, input: unknown, run: string, tools: ToolSet): Promise<{ readonly status: "completed"; readonly output?: unknown } | { readonly status: "failed"; readonly error: string }>;
  /** Forget a run nothing will resume (it ended, or another flow took its place): its journal can go. */
  forget?(run: string): Promise<void>;
  /** Whether a flow can call a tool of this name (one of the host's, or a workflow). */
  has?(tool: string): Promise<boolean>;
}

/**
 * A flow's turn: its answer, or the turn handed on (to the scripts and the model, or, when
 * it transferred the person, to the model), with what it said before handing it on.
 */
type FlowTurn = { readonly answered: Decision } | { readonly said: readonly string[]; readonly transferred: boolean };

/**
 * How the model answered a step the dialogue passed: its reply; `{ acted: true }` when it
 * called tools instead (a script must not answer such steps); nothing when the step
 * teaches nothing (it failed, or was cut off).
 */
export type Outcome = string | { readonly acted: true } | undefined;

/** A JSON value with its long strings left out (null): a result is kept for its short values, the only ones a reply repeats. */
function short(json: unknown, max: number): unknown {
  if (typeof json === "string") return json.length > max ? null : json;
  if (Array.isArray(json)) return json.map((v) => short(v, max));
  if (typeof json === "object" && json !== null) return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, short(v, max)]));
  return json;
}

/** A template as the model is shown it: fixed text, and a blank for each hole. */
const BLANK = "____";
const shown = (template: TemplateConstraint) => template.parts.map((p) => (typeof p === "string" ? p : BLANK)).join("");

/** A script's shape: what it says and when; a retired shape is not built again. */
const shape = (s: Script) => JSON.stringify([s.reply, s.patterns, s.result, s.context]);

/** Whether a script answers in a scope: one without a scope answers in every scope. */
const inScope = (s: Script, scope: string | undefined) => s.scope === undefined || s.scope === scope;

/** The most calls to missing tools one document step may make (each answered with error.badfetch). */
const MISSED_TOOLS = 16;

/** Thrown by `tools.hear` when this turn's utterance is heard already: the flow waits for the next turn. */
class AwaitingUtterance extends Error {}

interface Matched {
  readonly script: Script;
  readonly slots: Record<string, string>;
  readonly match: Match;
  /** Slots the person has confirmed (see Slot.confirm). */
  readonly confirmed?: readonly string[];
  /** Authored text and template sections when the router accepted several scripts. */
  readonly sections?: readonly { readonly script: Script; readonly filled: { kind: "text"; text: string } | { kind: "template"; template: TemplateConstraint } }[];
}

/** A form being filled (see FormSchema). */
type Form = NonNullable<SessionSave["form"]>;

/** A flow running in a session (see RunningFlowSchema). */
type RunningFlow = NonNullable<SessionSave["flow"]>;

interface SessionState {
  readonly id: string;
  /** The script the session's previous step matched: the next step's context. */
  last: ScriptId | undefined;
  form: Form | undefined;
  flow: RunningFlow | undefined;
  /** A flow handed the person to the model: the entry flow does not take them back. */
  transferred: boolean;
  /** A flow to go on with on the next utterance (it ended its turn with `{ continue: state }`). */
  next: NonNullable<SessionSave["next"]> | undefined;
  /** Templates drafted from this session's fallbacks. They answer only here, and are not part of the book. */
  templates: Script[];
}

/** A session's state as saved (without what it does not have). */
const saved = (s: SessionState): SessionSave => ({
  id: s.id,
  ...(s.last === undefined ? {} : { last: s.last }),
  ...(s.form === undefined ? {} : { form: s.form }),
  ...(s.flow === undefined ? {} : { flow: s.flow }),
  ...(s.transferred ? { transferred: true as const } : {}),
  ...(s.next === undefined ? {} : { next: s.next }),
});

/**
 * A decision with what a flow said before handing the turn on put first: in its text, or
 * (for the model's turns) as `said`, which is said before the model's reply.
 */
function after(said: readonly string[], decision: Decision): Decision {
  if (said.length === 0) return decision;
  const before = said.join("\n");
  if (decision.kind === "pass" || decision.kind === "generate") return { ...decision, said: decision.said === undefined ? before : `${before}\n${decision.said}` };
  return { ...decision, text: `${before}\n${decision.text}` };
}

const pass = (reason: string, context: ScriptId | undefined, shadow?: Shadow): Decision => ({
  kind: "pass",
  reason,
  ...(context === undefined ? {} : { context }),
  ...(shadow === undefined ? {} : { shadow }),
});

/** A form or read-back that gave up: the turn is the model's, but it is heard out of its context, so it teaches nothing. */
const givenUp = (reason: string, context: ScriptId | undefined): Decision => ({ kind: "pass", reason, ...(context === undefined ? {} : { context }), teaches: false });

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

/** Which scripts come first: active before candidate, and in context before without. */
const rank = (s: Script) => (s.status === "active" ? 0 : 2) + (s.context === undefined ? 1 : 0);

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
  readonly #flows: FlowRunner | undefined;
  /** The flow every session starts in, if the book names one. */
  #entry: string | undefined;
  readonly #onEvent: ((event: DialogueEvent) => void) | undefined;
  /** Draft a session template when a turn passes because no script matches. */
  readonly #draftForSession: boolean;
  /** Flow runs started (run ids are never reused). */
  #runs: number;
  readonly #interpreters: readonly Interpreter[];
  readonly #now: (() => number) | undefined;
  /** The book's documents, by name, as imported and as compiled. */
  readonly #imported = new Map<string, { readonly record: DocumentRecord; readonly compiled: CompiledDocument }>();
  /** Scripts by id (a cluster's script, when it has none, is simply not found). */
  readonly #scripts = new Map<string | undefined, Script>();
  /** Preference records appended from a person's corrections. */
  #preferences: PreferenceRecord[];
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
    this.#flows = options.flows;
    const book = parseBook(options.book ?? {});
    for (const script of book.scripts) this.#scripts.set(script.id, script);
    this.#clusters = book.clusters;
    this.#next = book.next;
    this.#entry = book.entry;
    this.#runs = book.runs;
    this.#preferences = [...book.preferences];
    this.#interpreters = options.interpreters ?? [];
    this.#now = options.now;
    this.#onEvent = options.onEvent;
    this.#draftForSession = options.sessionTemplates === true;
    for (const document of book.documents) this.#imported.set(document.name, { record: document, compiled: this.#compile(document) });
    for (const s of book.sessions) this.#sessions.set(s.id, { id: s.id, last: s.last, form: s.form, flow: s.flow, transferred: s.transferred === true, next: s.next, templates: [] });
  }

  /** A document compiled by the interpreter for its type; one it cannot run throws. */
  #compile(document: DocumentRecord): CompiledDocument {
    const interpreter = this.#interpreters.find((i) => i.type === document.type);
    if (!interpreter) throw new Error(`no interpreter for ${document.type} documents (document ${document.name})`);
    return interpreter.compile(document.files, document.options);
  }

  /** Add a document to the book, or replace the one of its name (see DocumentSchema); one its interpreter refuses throws. */
  putDocument(input: DocumentInput): void {
    const record = DocumentSchema.parse(input);
    const compiled = this.#compile(record);
    this.#imported.set(record.name, { record, compiled });
    this.#onEvent?.({ type: "dialogue.document.put", payload: { name: record.name, type: record.type } });
    this.#changed();
  }

  /** Whether the dialogue holds a session's state (it saw the session, and has not forgotten it). */
  hasSession(id: string): boolean {
    return this.#sessions.has(id);
  }

  /** The settings the dialogue runs with. */
  get settings(): Settings {
    return this.#settings;
  }

  /** Make a flow the one every session starts in (or none). */
  setEntry(name: string | undefined): void {
    this.#entry = name === undefined ? undefined : FlowNameSchema.parse(name);
    this.#changed();
  }

  /** The book in numbers: scripts by status, how many were built, clusters, sessions kept, and the documents and entry. */
  status(): DialogueStatus {
    const scripts = { active: 0, candidate: 0, retired: 0 };
    for (const s of this.scripts) scripts[s.status]++;
    return {
      scripts,
      built: this.scripts.filter((s) => s.origin !== "authored").length,
      clusters: this.#clusters.length,
      sessions: this.#sessions.size,
      documents: [...this.#imported.keys()],
      ...(this.#entry === undefined ? {} : { entry: this.#entry }),
    };
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
    this.#onEvent?.({ type: "dialogue.script.put", payload: { id: script.id } });
    this.#changed();
  }

  /** Feedback from outside on a script's answers: counted as a fit (helpful; for the session, when named) or a miss (harmful). */
  feedback(id: string, kind: "helpful" | "harmful", session?: string): void {
    if (!this.#scripts.has(id)) throw new Error(`no script ${id}`);
    this.#count(id, kind === "helpful" ? "fits" : "misses", session);
  }

  /** Preference records stored for a later trainer, oldest first. */
  preferences(): readonly PreferenceRecord[] {
    return this.#preferences.map((record) => ({ ...record, artifact: { ...record.artifact } }));
  }

  /** Append a preference record and, for a replacement or a steering instruction, update the artifact that answered. */
  async correct(input: CorrectionInput, port?: ArtifactText): Promise<PreferenceRecord> {
    const correction = CorrectionInputSchema.parse(input);
    const record = PreferenceRecordSchema.parse({ ...correction, signal: "negative" });
    const { kind, id } = record.artifact;
    // A steering instruction is one more part. Flattening the reply would drop a hole or a flow.
    if (kind === "script" && record.action === "steering") {
      const script = this.#scripts.get(id);
      if (!script) throw new Error(`no script ${id}`);
      this.#preferences.push(record);
      // A flow is a reply of its own: the instruction is applied when that flow answers.
      const [only] = script.reply;
      if (script.reply.length === 1 && typeof only === "object" && "flow" in only) this.#changed();
      else this.put({ ...script, reply: [...script.reply, `\n${record.text}`] });
      return record;
    }
    const content = await this.#artifactText(kind, id, port);
    const next = correctedArtifact(kind, content, record.action, record.text);
    this.#preferences.push(record);
    if (next !== content) await this.#writeArtifact(kind, id, next, port);
    this.#changed();
    return record;
  }

  async #artifactText(kind: PreferenceRecord["artifact"]["kind"], id: string, port: ArtifactText | undefined): Promise<string> {
    if (kind === "script") {
      const script = this.#scripts.get(id);
      if (!script) throw new Error(`no script ${id}`);
      return script.reply.map((part) => (typeof part === "string" ? part : "")).join("");
    }
    if (port === undefined) throw new Error(`no ${kind} store`);
    const content = await port.read(id);
    if (content === undefined) throw new Error(`no ${kind} ${id}`);
    return content;
  }

  async #writeArtifact(kind: PreferenceRecord["artifact"]["kind"], id: string, content: string, port: ArtifactText | undefined): Promise<void> {
    if (kind === "script") {
      const script = this.#scripts.get(id);
      if (!script) throw new Error(`no script ${id}`);
      this.put({ ...script, reply: [content] });
      return;
    }
    if (port === undefined) throw new Error(`no ${kind} store`);
    await port.write(id, content);
  }

  /** A turn of a session the dialogue did not see (the step was not one it answers): its form and context end there. */
  skip(sessionId: string): void {
    const state = this.#sessions.get(sessionId);
    if (!state || (state.form === undefined && state.last === undefined)) return;
    state.form = undefined;
    state.last = undefined;
    this.#changed();
  }

  /** What was authored and built, as a script book (see BookSchema). */
  save(): unknown {
    return {
      next: this.#next,
      ...(this.#entry === undefined ? {} : { entry: this.#entry }),
      scripts: this.scripts,
      clusters: this.#clusters.map((c) => ({ ...c, observations: [...c.observations] })),
      sessions: [...this.#sessions.values()].map(saved).filter((s) => Object.keys(s).length > 1),
      runs: this.#runs,
      documents: [...this.#imported.values()].map((d) => d.record),
      ...(this.#preferences.length > 0 ? { preferences: this.#preferences } : {}),
    };
  }

  /** Resolves when every observation so far has been learned from. */
  idle(): Promise<void> {
    return this.#work;
  }

  async respond(step: Step): Promise<Decision> {
    const session = step.sessionId === undefined ? undefined : this.#session(step.sessionId);
    const before = session && JSON.stringify(saved(session));
    const runs = this.#runs;
    const context = session?.last;
    const decision = step.result !== undefined ? await this.#onResult(step, session, context) : await this.#onUtterance(step, session, context);
    if (session) session.last = decision.kind === "pass" ? decision.shadow?.script : decision.script;
    if (decision.kind === "reply" || decision.kind === "generate") for (const id of decision.scripts ?? [decision.script]) this.#count(id, "served");
    // A session's state is saved too, so a restart loses no context, form or flow.
    // Run ids come from a counter saved with the book: a run started is saved, so its id is never reused.
    if ((session && JSON.stringify(saved(session)) !== before) || this.#runs !== runs) this.#changed();
    return decision;
  }

  /**
   * How the model answered a step `respond` passed (see Outcome), to learn from. Learning
   * happens in the background (see `idle`).
   */
  observe(step: Step, decision: Decision, outcome: Outcome): void {
    // A turn a form gave up on is heard out of its context: nothing is learned from it.
    if (decision.kind !== "pass" || decision.teaches === false || outcome === undefined) return;
    const acted = typeof outcome !== "string";
    if (!acted && outcome.trim() === "") return;
    const observation: Observation = {
      utterance: step.utterance,
      ...(step.result ? { result: this.#shortResult(step.result) } : {}),
      reply: acted ? "" : outcome.trim(),
      ...(step.sessionId === undefined ? {} : { session: step.sessionId }),
      ...(step.scope === undefined ? {} : { scope: step.scope }),
      ...(acted ? { acted } : {}),
    };
    const shadow = decision.shadow;
    // Learning is best effort: a failure (a model's among them) loses one observation, never a turn.
    this.#work = this.#work
      .then(async () => {
        if (shadow) return this.#verify(shadow, observation);
        await this.#learn(observation, decision.context);
        if (this.#draftForSession && decision.reason === "no script matches" && step.sessionId !== undefined && !acted) await this.#sessionTemplate(step.sessionId, observation);
      })
      .catch((e: unknown) => this.#failed(e));
  }

  // ---- responding ---------------------------------------------------------------

  #session(id: string): SessionState {
    const state = this.#sessions.get(id) ?? { id, last: undefined, form: undefined, flow: undefined, transferred: false, next: undefined, templates: [] };
    this.#sessions.delete(id);
    this.#sessions.set(id, state);
    for (const oldest of this.#sessions.keys()) {
      if (this.#sessions.size <= this.#settings.sessions) break;
      this.#sessions.delete(oldest);
    }
    return state;
  }

  async #onResult(step: Step, session: SessionState | undefined, context: ScriptId | undefined): Promise<Decision> {
    const result = step.result!;
    const forTool = this.scripts.filter((s) => s.result?.tool === result.tool && inScope(s, step.scope) && (s.context === undefined || s.context === context));
    for (const script of [...forTool.filter((s) => s.status === "active"), ...forTool.filter((s) => s.status === "candidate")]) {
      if (fill(script, { slots: {}, result }).kind === "missing") continue;
      return this.#answer({ script, slots: {}, match: { by: "result" } }, step, session, context);
    }
    return pass(`no script answers this ${result.tool} result`, context);
  }

  async #onUtterance(step: Step, session: SessionState | undefined, context: ScriptId | undefined): Promise<Decision> {
    const { utterance } = step;
    // A flow hears first: the session's running flow, else the one it goes on with, else the entry flow, started with this utterance.
    let said: readonly string[] = [];
    if (session && this.#flows) {
      let heard: string | undefined = utterance;
      const next = session.next;
      if (!session.flow && next !== undefined) {
        session.next = undefined;
        session.flow = { ...this.#newFlow(session, next.name, { utterance, slots: {}, state: next.state }), ...(next.script === undefined ? {} : { script: next.script }) };
        heard = undefined;
      } else if (!session.flow && this.#entry !== undefined && !session.transferred) {
        session.flow = this.#newFlow(session, this.#entry, { utterance, slots: {} });
        heard = undefined;
      }
      const turn = session.flow && (await this.#runFlow(session, heard, { by: "flow" }));
      if (turn && "answered" in turn) return turn.answered;
      // A transfer hands the person to the model: the scripts do not answer in its place.
      if (turn?.transferred) return after(turn.said, pass(`the flow handed the person to the model`, context));
      said = turn?.said ?? [];
    }
    return after(said, await this.#afterFlows(step, session, context));
  }

  /** A turn no flow answered: a form's, else a script's, else the model's. */
  async #afterFlows(step: Step, session: SessionState | undefined, context: ScriptId | undefined): Promise<Decision> {
    const { utterance } = step;
    const form = session?.form;
    if (session && form) {
      session.form = undefined;
      const decided = await this.#continueForm(step, session, form, context);
      if (decided) return decided;
    }
    const matched = await this.#match(utterance, context, step.scope, undefined, session?.templates);
    return matched ? this.#answer(matched, step, session, context) : pass("no script matches", context);
  }

  /** A matched script's answer: shadowing for a candidate, its reply, its flow, or a question for a slot it lacks. */
  async #answer(matched: Matched, step: Step, session: SessionState | undefined, context: ScriptId | undefined): Promise<Decision> {
    const { script, slots, match } = matched;
    const sections = matched.sections;
    if (sections !== undefined && sections.length > 1) {
      const composed = composeReplies(sections.map((section) => stitchAnswer(section.filled)));
      const scripts = sections.map((section) => section.script.id);
      const scriptId = scripts[0]!;
      if (composed.kind === "text") return { kind: "reply", script: scriptId, scripts, text: composed.text, match };
      return { kind: "generate", script: scriptId, scripts, template: composed.template, instruction: `${this.#settings.generate.instruction}\n\n${shown(composed.template)}`, match };
    }
    if (script.status === "candidate") return pass(`${script.id} is a candidate`, context, { script: script.id, slots, match });
    // A built script is checked again now and then: the model answers in its place, in shadow.
    // Every `audit` serves (an audit of 0 never: n % 0 is NaN).
    // Audits count too, so the turn after an audit is served again.
    if (script.origin !== "authored" && (script.evidence.served + script.evidence.audits + 1) % this.#settings.promote.audit === 0) {
      this.#count(script.id, "audits");
      return pass(`auditing ${script.id}`, context, { script: script.id, slots, match });
    }
    const filled = fill(script, { slots, ...(step.result ? { result: step.result } : {}) });
    const confirmed = matched.confirmed ?? [];
    // A slot to confirm is read back before the reply (once every slot the reply needs is in).
    const unconfirmed = filled.kind === "missing" ? undefined : Object.keys(script.slots).find((n) => script.slots[n]!.confirm !== undefined && slots[n] !== undefined && !confirmed.includes(n));
    if (unconfirmed !== undefined) {
      if (!session) return pass(`slot ${unconfirmed} needs confirming, in a session`, context);
      session.form = { script: script.id, slots, slot: unconfirmed, tries: 0, confirmed: [...confirmed], confirming: true };
      return { kind: "ask", script: script.id, slot: unconfirmed, text: script.slots[unconfirmed]!.confirm!.split("{value}").join(slots[unconfirmed]!), match };
    }
    if (filled.kind === "text") return { kind: "reply", script: script.id, text: filled.text, match };
    if (filled.kind === "template") return { kind: "generate", script: script.id, template: filled.template, instruction: `${this.#settings.generate.instruction}\n\n${shown(filled.template)}`, match };
    if (filled.kind === "flow") {
      if (!session || !this.#flows) return pass(`flow ${filled.flow} needs a session and a flow runner`, context);
      this.#count(script.id, "served");
      // A flow that passed a turn on and is still running gives way to this one.
      if (session.flow) await this.#forget(session.flow.run);
      session.next = undefined;
      // A flow's input is saved with the session: a result's long values are left out, as in observations.
      const result = step.result && this.#shortResult(step.result);
      session.flow = { ...this.#newFlow(session, filled.flow, { utterance: step.utterance, slots, ...(result ? { result } : {}) }), script: script.id };
      const turn = await this.#runFlow(session, undefined, match);
      const decision = "answered" in turn ? turn.answered : after(turn.said, pass(turn.transferred ? "the flow handed the person to the model" : `flow ${filled.flow} handed the turn on`, context));
      const notes = this.#preferences.flatMap((record) => (record.artifact.kind === "script" && record.artifact.id === script.id && record.action === "steering" ? [record.text] : []));
      const aside = `${script.reply.flatMap((part) => (typeof part === "string" ? [part] : [])).join("")}${notes.length === 0 ? "" : `\n${notes.join("\n")}`}`;
      if (aside === "") return decision;
      if ("text" in decision) return { ...decision, text: `${decision.text}${aside}` };
      return { ...decision, said: decision.said === undefined ? aside.replace(/^\n/, "") : `${decision.said}${aside}` };
    }
    const unaskable = filled.slots.find((slot) => session === undefined || script.slots[slot]!.prompts.length === 0);
    if (unaskable !== undefined || !session) return pass(`no value for slot ${unaskable}`, context);
    const slot = filled.slots[0]!;
    session.form = { script: script.id, slots, slot, tries: 0, confirmed: [...confirmed] };
    return { kind: "ask", script: script.id, slot, text: script.slots[slot]!.prompts[0]!, match };
  }

  /** The answer to a form's prompt: its slot's value, another script taking over, the next prompt, or the model. */
  async #continueForm(step: Step, session: SessionState, form: Form, context: ScriptId | undefined): Promise<Decision | undefined> {
    const { utterance } = step;
    const script = this.#scripts.get(form.script) ?? session.templates.find((item) => item.id === form.script);
    if (!script || script.status === "retired") return undefined;
    if (form.confirming) return this.#confirming(step, session, script, form, context);
    const slots = { ...form.slots };
    if (this.#short(utterance)) for (const pattern of script.patterns) Object.assign(slots, matchPattern(pattern, utterance));
    const value = slots[form.slot] ?? (await this.#valueFor(script, form.slot, utterance));
    // A confirmed slot the answer changed is read back again.
    const answered = (value: string) => {
      const next = { ...slots, [form.slot]: value };
      return this.#answer({ script, slots: next, match: { by: "form" }, confirmed: form.confirmed.filter((n) => next[n] === form.slots[n]) }, step, session, context);
    };
    if (value !== undefined) return answered(value);
    // Another script taking the answer comes before taking the whole answer as the value.
    const other = await this.#match(utterance, context, step.scope, script.id, session.templates);
    if (other) return this.#answer(other, step, session, context);
    // A long answer is not a slot's value.
    const whole = this.#router || script.slots[form.slot]!.pattern !== undefined || !this.#short(utterance) ? undefined : normalizeUtterance(utterance) || undefined;
    if (whole !== undefined) return answered(whole);
    const tries = form.tries + 1;
    const prompts = script.slots[form.slot]!.prompts;
    if (tries >= prompts.length) return givenUp(`no ${form.slot} after ${tries} prompts`, context);
    session.form = { ...form, tries };
    return { kind: "ask", script: script.id, slot: form.slot, text: prompts[tries]!, match: { by: "form" } };
  }

  /** The answer to a read-back: yes goes on, no asks for the slot again, a new value is read back in its turn; else once more, then the model. */
  async #confirming(step: Step, session: SessionState, script: Script, form: Form, context: ScriptId | undefined): Promise<Decision> {
    const said = step.utterance.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
    const { yes, no } = this.#settings.confirm;
    const opens = (words: readonly string[]) => words.some((w) => said === w || said.startsWith(`${w} `));
    const confirm = script.slots[form.slot]?.confirm;
    // A script changed meanwhile to not confirm the slot has nothing to read back.
    if (confirm === undefined || yes.includes(said)) return this.#answer({ script, slots: form.slots, match: { by: "form" }, confirmed: [...form.confirmed, form.slot] }, step, session, context);
    const corrected = await this.#valueFor(script, form.slot, step.utterance);
    if (corrected !== undefined && corrected !== form.slots[form.slot]) return this.#answer({ script, slots: { ...form.slots, [form.slot]: corrected }, match: { by: "form" }, confirmed: form.confirmed }, step, session, context);
    // "Yes, that's right" is a yes (a new value in it was taken above).
    if (opens(yes)) return this.#answer({ script, slots: form.slots, match: { by: "form" }, confirmed: [...form.confirmed, form.slot] }, step, session, context);
    if (opens(no)) {
      const { [form.slot]: _denied, ...slots } = form.slots;
      const prompt = script.slots[form.slot]!.prompts[0];
      if (prompt === undefined) return givenUp(`no ${form.slot} after it was denied`, context);
      session.form = { script: script.id, slots, slot: form.slot, tries: 0, confirmed: form.confirmed };
      return { kind: "ask", script: script.id, slot: form.slot, text: prompt, match: { by: "form" } };
    }
    if (form.tries >= 1) return givenUp(`${form.slot} not confirmed`, context);
    session.form = { ...form, tries: form.tries + 1 };
    return { kind: "ask", script: script.id, slot: form.slot, text: confirm.split("{value}").join(form.slots[form.slot]!), match: { by: "form" } };
  }

  /** A new flow run for a session: its run id is never reused. */
  #newFlow(session: SessionState, name: string, input: { readonly utterance: string; readonly slots: Readonly<Record<string, string>>; readonly result?: ToolResult; readonly state?: JSONValue }): RunningFlow {
    // The input is JSON (a tool result's input and output are).
    return { name, run: `dialogue/${session.id}/${++this.#runs}`, input: input as RunningFlow["input"] };
  }

  /**
   * One turn of a session's flow: it hears `utterance` (nothing, on the turn it starts)
   * and what it says is the reply. It ends when its run completes, fails (reported) or
   * transfers the turn; it waits for the next turn when it asks to hear again. A turn it
   * passes on, or says nothing on, is not its to answer.
   */
  async #runFlow(session: SessionState, utterance: string | undefined, match: Match): Promise<FlowTurn> {
    const flow = session.flow!;
    const said: string[] = [];
    let heard = utterance === undefined;
    // What the flow said before it handed the turn on (what it says after is not said).
    let handed: number | undefined;
    let transferred = false;
    let ended = true;
    let output: unknown;
    // Stryker disable StringLiteral: a tool's description is for code that reads it, not behavior
    const tools: ToolSet = {
      say: tool({ description: "Say text to the person.", inputSchema: z.object({ text: z.string() }), execute: async ({ text }) => (said.push(text), null) }),
      hear: tool({
        description: "Hear what the person says next: this turn's utterance once, then wait for the next turn.",
        inputSchema: z.object({}),
        execute: async () => {
          if (heard) throw new AwaitingUtterance();
          heard = true;
          return { utterance: utterance! };
        },
      }),
      pass: tool({ description: "Let the rest of the dialogue (scripts, then the model) answer this turn; keep going after it.", inputSchema: z.object({}), execute: async () => ((handed ??= said.length), null) }),
      transfer: tool({ description: "Hand the person over to the model: this turn is the model's, and the flow ends.", inputSchema: z.object({}), execute: async () => ((handed ??= said.length), (transferred = true), null) }),
      interpret: tool({
        description: "The next step of one of the book's documents (VoiceXML, AIML): what to say, and whether to hand the turn on, end, or call a tool first.",
        inputSchema: z.object({ document: z.string(), state: z.json().nullable(), utterance: z.string().optional(), slots: z.record(z.string(), z.string()).optional(), result: z.json().optional() }),
        execute: async ({ document, state, utterance, slots, result }) => {
          const found = this.#imported.get(document);
          if (!found) throw new Error(`no document ${document} in the book`);
          const now = this.#now?.();
          const at = now === undefined ? {} : { now };
          let step = found.compiled.step({ state: state ?? null, ...(utterance === undefined ? {} : { utterance }), ...(slots === undefined ? {} : { slots }), ...(result === undefined ? {} : { result }), ...at });
          // A tool the host does not have cannot be called: the document hears why, and goes on (this step is journaled, so a replay takes it alike).
          for (let missed = 0; step.call !== undefined && this.#flows?.has && !(await this.#flows.has(step.call.tool)); missed++) {
            // A document whose error handlers call missing tools again would never end.
            if (missed === MISSED_TOOLS) throw new Error(`document ${document} kept calling tools the host does not have`);
            const next = found.compiled.step({ state: step.state, error: `error.badfetch: no tool ${step.call.tool}`, ...at });
            step = { ...next, say: [...step.say, ...next.say] };
          }
          return step;
        },
      }),
    };
    // Stryker restore StringLiteral
    try {
      const result = await this.#flows!.run(flow.name, flow.input, flow.run, tools);
      if (result.status === "failed") this.#failed(new Error(`flow ${flow.name} failed: ${result.error}`));
      else output = result.output;
    } catch (e) {
      if (e instanceof AwaitingUtterance) ended = false;
      else this.#failed(e);
    }
    if (ended || transferred) {
      session.flow = undefined;
      await this.#forget(flow.run);
    }
    if (transferred) session.transferred = true;
    // A flow that ends its turn with `{ continue: state }` goes on from that state on the next utterance, as a new run (continue-as-new).
    const going = ended && !transferred && typeof output === "object" && output !== null && "continue" in output ? (output as { continue: unknown }).continue : undefined;
    if (going !== undefined) session.next = { name: flow.name, ...(flow.script === undefined ? {} : { script: flow.script }), state: going as NonNullable<SessionSave["next"]>["state"] };
    if (handed !== undefined || transferred) return { said: said.slice(0, handed), transferred };
    if (said.length === 0) return { said: [], transferred: false };
    return { answered: { kind: "flow", flow: flow.name, ...(flow.script === undefined ? {} : { script: flow.script }), text: said.join("\n"), match } };
  }

  /** Forget a run nothing will resume (its journal can go); failing to is reported, never a turn lost. */
  async #forget(run: string): Promise<void> {
    await this.#flows?.forget?.(run).catch((e: unknown) => this.#failed(e));
  }

  /** A slot's value in an answer: by its value pattern (on an utterance short enough), else the router's. */
  async #valueFor(script: Script, slot: string, utterance: string): Promise<string | undefined> {
    const pattern = script.slots[slot]!.pattern;
    if (pattern !== undefined) return this.#short(utterance) ? findValue(pattern, utterance) : undefined;
    return (await this.#pick(utterance, [script]))?.picked[0]?.slots[slot];
  }

  /** A tool result with its long values left out, as observations and flows keep it. */
  #shortResult(result: ToolResult): ToolResult {
    const max = this.#settings.induce.valueLength;
    // The short values of JSON are JSON.
    return { tool: result.tool, input: short(result.input, max), output: short(result.output, max) } as ToolResult;
  }

  /** Whether an utterance is short enough for patterns (which bounds the time they take). */
  #short(utterance: string): boolean {
    return utterance.length <= this.#settings.match.maxLength;
  }

  /**
   * The eligible scripts matching an utterance, cheapest way first: pattern, exemplar,
   * router (active scripts only: a candidate is not worth a model call). Scripts in
   * context come before those without, and active ones before candidates.
   */
  async #match(utterance: string, context: ScriptId | undefined, scope: string | undefined, exclude?: ScriptId, sessionTemplates: readonly Script[] = []): Promise<Matched | undefined> {
    const eligible = [...sessionTemplates, ...this.scripts]
      .filter((s) => s.result === undefined && s.status !== "retired" && s.id !== exclude && inScope(s, scope) && (s.context === undefined || s.context === context))
      .sort((a, b) => rank(a) - rank(b));
    for (const script of this.#short(utterance) ? eligible : [])
      for (const pattern of script.patterns) {
        const slots = matchPattern(pattern, utterance);
        // A slot the pattern has a group for is where the group says, or not in the utterance at all.
        if (slots) return { script, slots: await this.#slotsFor(script, utterance, slots, { parsed: groupsOf(pattern) }), match: { by: "pattern" } };
      }
    const alike = await this.#nearestExemplar(utterance, eligible).catch((e: unknown) => this.#failed(e));
    if (alike) return { script: alike.script, slots: await this.#slotsFor(alike.script, utterance, {}), match: { by: "exemplar", similarity: alike.similarity } };
    const active = eligible.filter((s) => s.status === "active");
    if (active.length === 0) return undefined;
    const picked = await this.#pick(utterance, active);
    if (!picked) return undefined;
    const detailed: { script: Script; slots: Record<string, string> }[] = [];
    for (const one of picked.picked) detailed.push({ script: one.script, slots: await this.#slotsFor(one.script, utterance, one.slots, { routed: true }) });
    const [first] = detailed;
    if (!first) return undefined;
    const routed = { by: "router" as const, confidence: picked.confidence };
    if (detailed.length === 1) return { script: first.script, slots: first.slots, match: routed };
    const sections = detailed.flatMap((one) => {
      if (one.script.origin !== "authored") return [];
      const filled = fill(one.script, { slots: one.slots });
      return filled.kind === "text" || filled.kind === "template" ? [{ script: one.script, filled }] : [];
    });
    if (sections.length < 2) return { script: first.script, slots: first.slots, match: routed };
    return { script: sections[0]!.script, slots: first.slots, match: routed, sections };
  }

  /** The best-ranked script with an exemplar alike enough (the most alike, among equals), and how alike. */
  async #nearestExemplar(utterance: string, scripts: readonly Script[]): Promise<{ script: Script; similarity: Similarity } | undefined> {
    const pairs = scripts.flatMap((script) => script.exemplars.map((exemplar) => ({ script, exemplar })));
    if (!this.#embedder || pairs.length === 0) return undefined;
    const { embedding: query } = await embed({ model: this.#embedder, value: utterance, maxRetries: 0, ...embedding({ kind: "query" }) });
    const documents = await this.#documents(pairs.map((p) => p.exemplar));
    let best: { script: Script; similarity: number } | undefined;
    pairs.forEach(({ script }, i) => {
      const s = cosine(query, documents[i]!);
      if (s < this.#settings.match.similar) return;
      if (best === undefined || rank(script) < rank(best.script) || (rank(script) === rank(best.script) && s > best.similarity)) best = { script, similarity: s };
    });
    return best && { script: best.script, similarity: similarity(best.similarity) };
  }

  /** The router's picks among scripts, at or above its threshold, in the order offered; nothing without a router, or when it fails. */
  async #pick(utterance: string, scripts: readonly Script[]): Promise<{ picked: { script: Script; slots: Record<string, string> }[]; confidence: Probability } | undefined> {
    if (!this.#router) return undefined;
    const routed = await route(this.#router, { input: utterance, tools: scripts.map(toolSpec) }).catch((e: unknown) => this.#failed(e));
    if (!routed || routed.problems.length > 0 || routed.valid.length === 0 || routed.confidence < this.#settings.match.route) return undefined;
    const names = routed.valid.map((call) => call.name);
    if (new Set(names).size !== names.length || names.some((name) => scripts.every((script) => script.id !== name))) return undefined;
    const calls = new Map(routed.valid.map((call) => [call.name, call]));
    const picked = scripts.flatMap((script) => {
      const call = calls.get(script.id);
      return call === undefined ? [] : [{ script, slots: slotValues(call.arguments) }];
    });
    if (picked.length === 0) return undefined;
    return { picked, confidence: routed.confidence };
  }

  /**
   * Slots for a matched script: those given, else found by the slots' value patterns, else
   * (for any the reply still lacks, unless the router made the match) the router's. Slots a
   * matching pattern parsed are not looked for elsewhere.
   */
  async #slotsFor(script: Script, utterance: string, given: Record<string, string>, how: { readonly parsed?: readonly string[]; readonly routed?: true } = {}): Promise<Record<string, string>> {
    const needed = replySlots(script).filter((slot) => !how.parsed?.includes(slot));
    const found = (this.#short(utterance) ? needed : []).flatMap((slot) => {
      const pattern = script.slots[slot]!.pattern;
      // Stryker disable next-line ConditionalExpression: equivalent; no pattern is an empty one, which finds no value
      const value = pattern === undefined ? undefined : findValue(pattern, utterance);
      return value === undefined ? [] : [[slot, value] as const];
    });
    const slots = { ...Object.fromEntries(found), ...given };
    // The router is asked only for an active script's slots: a candidate is not worth a model call.
    if (how.routed || script.status !== "active" || needed.every((slot) => slots[slot] !== undefined)) return slots;
    const picked = await this.#pick(utterance, [script]);
    return { ...picked?.picked[0]?.slots, ...slots };
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

  /**
   * Check a shadowed script (a candidate, or an active one being audited) against how the
   * model answered: acting instead of replying is a miss; a reply that fits (or that the
   * judge finds its own as good as) is a fit, counted only from a session the script was
   * not built from; any other reply is a miss, and a candidate is induced again from its
   * cluster with it.
   */
  async #verify(shadow: Shadow, observation: Observation): Promise<void> {
    const script = this.#scripts.get(shadow.script);
    if (!script || script.status === "retired") return;
    const cluster = this.#clusters.find((c) => c.script === script.id);
    if (observation.acted) {
      if (cluster) cluster.acted = true;
      this.#count(script.id, "misses");
      // The model acts on steps like these: a candidate for them never answers.
      if (script.status === "candidate") this.#set({ ...this.#scripts.get(script.id)!, status: "retired" });
      return;
    }
    const fillers = { slots: shadow.slots, ...(observation.result ? { result: observation.result } : {}) };
    if (fits(script, observation.reply, { ...fillers, utterance: observation.utterance }) || (await this.#judged(script, fillers, observation))) {
      if (observation.session !== undefined && cluster?.observations.some((o) => o.session === observation.session)) return;
      return this.#count(script.id, "fits", observation.session);
    }
    if (cluster && script.status === "candidate") {
      this.#add(cluster, observation);
      // Induced again, it is a new template, with no evidence yet: the miss was the old one's.
      if (this.#reinduce(cluster, script)) return;
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
    if (observation.acted) {
      // The model acts on steps like these: nothing may answer them in its place.
      cluster.acted = true;
      if (script?.status === "candidate") {
        this.#count(script.id, "misses");
        this.#set({ ...this.#scripts.get(script.id)!, status: "retired" });
      }
      return this.#changed();
    }
    if (script?.origin === "induced") this.#reinduce(cluster, script);
    else if (!script && cluster.observations.length >= this.#settings.induce.support) await this.#build(cluster);
    this.#changed();
  }

  /** The cluster an observation belongs to: its tool's, or the nearest in its context at the threshold; else a new one. */
  async #clusterFor(observation: Observation, context: ScriptId | undefined): Promise<Cluster> {
    const tool = observation.result?.tool;
    const { scope } = observation;
    const fields = { ...(scope === undefined ? {} : { scope }), ...(context === undefined ? {} : { context }) };
    if (tool !== undefined) return this.#clusters.find((c) => c.tool === tool && c.scope === scope) ?? this.#newCluster({ tool, ...(scope === undefined ? {} : { scope }) });
    const alike = this.#clusters.filter((c) => c.tool === undefined && c.context === context && c.scope === scope);
    if (alike.length === 0) return this.#newCluster(fields);
    const scores = await this.#similarities(
      observation.utterance,
      alike.map((c) => c.observations[0]!.utterance),
    );
    let best: { cluster: Cluster; score: number } | undefined;
    alike.forEach((cluster, i) => {
      if (scores[i]! >= this.#settings.induce.cluster && (best === undefined || scores[i]! > best.score)) best = { cluster, score: scores[i]! };
    });
    return best?.cluster ?? this.#newCluster(fields);
  }

  /** How alike an utterance is to each of `heads`: by meaning with an embedder (by shape if it fails), else by shape. */
  async #similarities(utterance: string, heads: readonly string[]): Promise<number[]> {
    const embedder = this.#embedder;
    // The utterance is embedded each time (it is not kept); the heads are kept, as exemplars are.
    const vectors =
      embedder &&
      (await Promise.all([embed({ model: embedder, value: utterance, maxRetries: 0, ...embedding({ kind: "document" }) }), this.#documents(heads)]).catch((e: unknown) => this.#failed(e)));
    return vectors ? vectors[1].map((v) => cosine(vectors[0].embedding, v)) : heads.map((head) => shapeSimilarity(utterance, head));
  }

  /** A new cluster; it is kept once an observation is added to it (see #add). */
  #newCluster(fields: { readonly tool?: string; readonly context?: ScriptId; readonly scope?: string }): Cluster {
    return ClusterSchema.parse({ ...fields, observations: [] });
  }

  /** Add an observation to a cluster, now the most recently added to; beyond the cap, the least recent cluster without a script goes. */
  #add(cluster: Cluster, observation: Observation): void {
    cluster.observations.push(observation);
    cluster.observations.splice(0, cluster.observations.length - this.#settings.induce.keep);
    this.#clusters = [...this.#clusters.filter((c) => c !== cluster), cluster];
    const idle = this.#clusters.filter((c) => c.script === undefined);
    const over = new Set(idle.slice(0, Math.max(0, idle.length - this.#settings.induce.clusters)));
    this.#clusters = this.#clusters.filter((c) => !over.has(c));
  }

  /** The next built script's id, skipping any an authored script took. */
  #nextId(): ScriptId {
    while (this.#scripts.has(`s${this.#next}`)) this.#next++;
    return scriptId(`s${this.#next}`);
  }

  /** Whether a script has the shape of one retired before. */
  #retired(script: Script): boolean {
    // A retired script without a scope retires its shape everywhere; a scoped one, in its scope.
    return this.scripts.some((s) => s.status === "retired" && (s.scope === undefined || s.scope === script.scope) && shape(s) === shape(script));
  }

  /**
   * A candidate from a cluster at the support: induced, else (for utterances, once)
   * drafted, when a draft could ever match (there is an embedder or a router). Never one
   * shaped as a retired script.
   */
  async #build(cluster: Cluster): Promise<void> {
    const induced = induce(cluster, this.#settings.induce, this.#nextId());
    if ("script" in induced) {
      if (this.#retired(induced.script)) return;
      this.#next++;
      cluster.script = induced.script.id;
      return this.#set(induced.script);
    }
    // Drafts are held to the rules induction checks first: independent sessions, and no acting.
    if (cluster.tool !== undefined || !this.#drafter || cluster.drafted || cluster.acted || (!this.#embedder && !this.#router)) return;
    const sessions = new Set(cluster.observations.flatMap((o) => (o.session === undefined ? [] : [o.session]))).size;
    if (sessions < this.#settings.induce.sessions) return;
    cluster.drafted = true;
    await this.#draft(cluster, this.#drafter);
  }

  /** A template for this session from one fallback, kept only when it generalises that reply. */
  async #sessionTemplate(sessionId: string, observation: Observation): Promise<void> {
    const drafter = this.#drafter;
    if (!drafter) return;
    const drafted = await draft(
      drafter,
      {
        ...this.#settings.draft,
        system: `${this.#settings.draft.system}\n\nWrite it so a later request of the same kind can use it: names, numbers and places that are particular to this one request are slots or generated holes, not fixed text.`,
      },
      [observation],
    );
    const id = this.#nextId();
    const main = observation.scope === undefined ? draftedScript(drafted, id, undefined) : draftedScript(drafted, id, undefined, observation.scope);
    if (!this.#general(main, observation) || this.#retired(main)) return;
    this.#next++;
    this.#session(sessionId).templates.push({ ...main, status: "active" });
  }

  /** The reply is reproduced, and something particular is left open, without the open part swallowing it. */
  #general(script: Script, observation: Observation): boolean {
    const open = script.reply.filter((part) => typeof part !== "string");
    if (open.length === 0 || open.length > this.#settings.induce.holes) return false;
    const read = readHoles(script, observation.reply, { slots: {}, utterance: observation.utterance });
    if (read === undefined || observation.reply.length === 0) return false;
    const free = script.reply.flatMap((part) => (typeof part === "object" && "generate" in part ? [read[part.generate]?.length ?? 0] : [])).reduce((sum, n) => sum + n, 0);
    return 1 - free / observation.reply.length >= this.#settings.induce.determined;
  }

  /**
   * A drafted script, kept when it reproduces a reply the cluster saw, as much of it
   * determined without the model as induction requires and with no more holes; with its
   * valid follow-ups. A failed draft builds nothing.
   */
  async #draft(cluster: Cluster, drafter: LanguageModel): Promise<void> {
    const drafted = await draft(drafter, this.#settings.draft, cluster.observations);
    const main = draftedScript(drafted, this.#nextId(), cluster.context, cluster.scope);
    const { determined, holes } = this.#settings.induce;
    const reproduced = cluster.observations.some((o) => {
      const read = readHoles(main, o.reply, { slots: {}, utterance: o.utterance });
      const free = main.reply.flatMap((p) => (typeof p === "object" && "generate" in p ? [read?.[p.generate]?.length ?? 0] : [])).reduce((a, b) => a + b, 0);
      return read !== undefined && 1 - free / o.reply.length >= determined;
    });
    if (!reproduced || main.reply.filter((p) => typeof p !== "string").length > holes || this.#retired(main)) return;
    this.#next++;
    cluster.script = main.id;
    this.#set(main);
    let kept = 0;
    for (const followUp of drafted.followUps) {
      if (kept === this.#settings.draft.followUps) break;
      try {
        this.#set(draftedScript(followUp, this.#nextId(), main.id, cluster.scope));
        this.#next++;
        kept++;
      } catch {
        // A follow-up that is not a valid script is dropped.
      }
    }
  }

  /** Induce a candidate again from its cluster (unless it no longer aligns): a new template, so its evidence starts again. */
  #reinduce(cluster: Cluster, script: Script): boolean {
    const induced = induce(cluster, this.#settings.induce, script.id);
    if ("problem" in induced || this.#retired(induced.script)) return false;
    this.#set({ ...induced.script, status: script.status });
    return true;
  }

  /**
   * A script's status as its evidence has it: one misleading by the margin is retired; a
   * candidate with enough fits, from enough sessions, is active.
   */
  #due(script: Script): Script {
    const { fits: fit, misses, sessions } = script.evidence;
    const { fits: needed, retireMargin } = this.#settings.promote;
    if (misses - fit >= retireMargin) return { ...script, status: "retired" };
    if (script.status === "candidate" && fit >= needed && sessions.length >= this.#settings.promote.sessions) return { ...script, status: "active" };
    return script;
  }

  /** A template drafted for a session still kept, and where it sits. */
  #templateAt(id: string): { session: SessionState; index: number } | undefined {
    for (const session of this.#sessions.values()) {
      const index = session.templates.findIndex((item) => item.id === id);
      if (index >= 0) return { session, index };
    }
    return undefined;
  }

  /** Count a fit (from a session, if named), a miss, or a time served, and apply what it means. */
  #count(id: string, field: "fits" | "misses" | "served" | "audits", session?: string): void {
    const apply = (script: Script): Script => {
      const { sessions } = script.evidence;
      const counted = session === undefined || sessions.includes(session) || sessions.length >= this.#settings.promote.sessionsKept ? sessions : [...sessions, session];
      return this.#due({ ...script, evidence: { ...script.evidence, [field]: script.evidence[field] + 1, sessions: counted } });
    };
    const at = this.#scripts.has(id) ? undefined : this.#templateAt(id);
    if (at) {
      at.session.templates[at.index] = apply(at.session.templates[at.index]!);
      return;
    }
    this.#set(apply(this.#scripts.get(id)!));
  }

  /** Keep a script; a cluster is dropped once its script is no longer a candidate (its observations are no longer needed). */
  #set(script: Script): void {
    const before = this.#scripts.get(script.id);
    if (!before && script.origin !== "authored") this.#onEvent?.({ type: "dialogue.script.built", payload: { id: script.id, origin: script.origin, ...(script.scope === undefined ? {} : { scope: script.scope }) } });
    else if (before && before.status !== script.status && script.status !== "candidate") this.#onEvent?.({ type: `dialogue.script.${script.status === "active" ? "promoted" : "retired"}`, payload: { id: script.id } });
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
