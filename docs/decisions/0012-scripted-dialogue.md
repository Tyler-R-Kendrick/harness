# 0012: Scripted dialogue: templates in front of inference

Status: decided, 2026-09-27.

## Question

Most turns an agent answers are not new. A support agent says "Order 1234 is on its way
and arrives Tuesday" a thousand times with different numbers and days; a tool loop's last
step reads a tool's result back in the same sentence every time. Each of those turns costs
a full generation today. How can the harness answer such turns from scripts (fixed text,
filled deterministically) and build those scripts itself, ahead of need, so that inference
is spent only on what is actually new?

## What older systems do

Call centers and pre-LLM chatbots answered almost everything from scripts, because they
had no generator. What they learned carries over:

- **IVR (VoiceXML 2.0, SRGS/SISR).** A dialog is a form of fields (slots). The *form
  interpretation algorithm* visits the first unfilled field, plays its prompt, and fills it
  from a grammar whose semantic tags name the slot values. Prompts escalate by count
  (`<nomatch count="2">`), and after the last one the caller is transferred to a person.
  Form-level grammars let a caller fill several fields at once or leave the form (mixed
  initiative).
- **Call-center scripting and canned responses.** Agents read approved text with the
  customer's details merged in. Each script is reviewed before use, and scripts are
  retired when they stop working.
- **AIML, ChatScript.** Patterns with wildcards map an utterance to a template; captures
  (`<star/>`) are merged into the reply. Topics and `<that>` (the bot's last reply) scope
  which patterns apply.
- **Rasa, Dialogflow CX.** An intent classifier and entity extractors fill slots; a
  dialogue policy picks a response template (`utter_*` with `{slot}`); forms ask for
  missing slots. Input contexts (Dialogflow) scope an intent to what was said before.
  Rasa's CALM (2024) keeps business logic in deterministic flows and uses the LLM only to
  understand the user and, optionally, to rephrase templated responses.
- **NeMo Guardrails (Colang), Parlant.** Canonical forms of user and bot messages, and
  canned responses with fields, with a mode where the agent may say only canned text.

And from LLM serving:

- **Semantic caching** (GPTCache and others): reuse an earlier answer when a new prompt is
  near an old one by embedding. It returns whole answers, so it cannot put new values into
  them, and it has no notion of verification beyond the similarity threshold.
- **Plan and workflow caching** for agents: reuse the structure of an earlier solution with
  new details filled in by a small model.
- **Log template mining (Drain).** Online clustering of log lines and alignment of each
  cluster into constant text and variable positions, with no model at all. A reply cluster
  is a log cluster: what every reply shares is the template; what differs is a hole.
- **Constrained decoding with jump-forward** (XGrammar, SGLang; ADR 0004): a template's
  fixed text costs no sampling steps, so a template with holes costs only its holes.

## Decision

A new pure package, `@harness/dialogue`, holds the **dialogue**: scripts, matching,
forms, induction, drafting and promotion. `@harness/workers` puts it in front of a
session's model as AI SDK language-model middleware (`dialogueMiddleware`, applied with
`wrapLanguageModel`; streams need host types, so it is not in the pure package). Every
agent, tool loop and worker keeps working unchanged: a scripted reply is a model response
the model never had to generate.

### Scripts

A script (`ScriptSchema`, data with a generated JSON Schema) answers one kind of step:

- **Trigger.** An *utterance* (the step's prompt ends with the user's message), matched by
  patterns (anchored, case-insensitive regular expressions whose named groups are slots:
  SRGS/SISR, AIML), exemplars (by embedding), or the tool router (each script offered as a
  tool whose parameters are its slots). A slot a matching pattern has a group for comes
  only from that group (a group that took no part means the user did not say it); other
  slots are looked for with their value patterns, then asked of the router. Or a
  *result* (the step's prompt ends with one tool's result): the tool loop's "read the
  result back" step.
- **Context** (optional): the script that matched the session's previous step (AIML
  `<that>`, Dialogflow input contexts), so "yes" means something only after the question.
- **Slots** with an optional value pattern and **prompts**: the form interpretation
  algorithm. A matched script missing a slot that has prompts asks for it; the next
  utterance fills it (by the slot's pattern, the router, or as a whole), escalating
  through the prompts on no-match. After the last prompt, or when the caller says
  something else, the turn goes to the model: the model is the live agent the call
  transfers to, and it sees the whole exchange. A different script matching the answer
  takes over (mixed initiative). A slot may be **confirmed**: once the reply has what it
  needs, the slot's `confirm` question reads the value back ("So 8pm, right?"); a yes
  (`confirm.yes` in the settings, alone or opening the answer) gives the reply, a no asks
  for the slot again, an answer with a new value is read back in its turn, and an unclear
  answer is asked again once; after a second the turn is the model's. A confirmed slot a
  later answer changes is read back again. A turn a form or a read-back gave up on is
  heard out of its context, so nothing is learned from it.
- **Reply**: fixed text and holes. A hole is filled from a *slot*, from a path in the
  result step's tool *input* or *output*, or is *generated*. A reply with no generated
  holes is rendered with no inference at all. One with generated holes is one
  constrained call (a template constraint, ADR 0004): generators that enforce templates
  write only the holes.

The matching cascade is cheapest first, as the tool-call cascade is: patterns (certain),
then exemplar similarity (`match.similar`), then the router (`match.route`). A miss, or a
router below its threshold, goes to the model.

### Flows: multi-turn dialogues as durable workflows

A script's reply can instead start a **flow**: a dialogue of many turns (an IVR call flow,
a whole chatbot) that is a workflow of kind `flow` in the harness's workflow library
(ADR 0002), run by the same `WorkflowHost` as every other workflow. A flow talks through
tools the dialogue gives each run: `say` (its text is the turn's reply), `hear` (this
turn's utterance, once), `pass` (let scripts, then the model, answer this turn and keep
going) and `transfer` (hand the person to the model and end: the turn is the model's, not
the scripts', and the entry flow does not take the session back). What a flow says before
handing a turn on is said first; what it says after is not. Nothing else holds a
flow's state: each turn runs the flow again from its journal, where every `say` and
`hear` is recorded, so the flow replays to where it was and hears the new utterance.
When it asks to hear again, the run stops (a failing effect leaves a run resumable), and
the next turn resumes it. A daemon restart is one more such resume. Flows are not tools:
agents, other workflows and `workflows.run` cannot call them, since they need a person.

A flow may instead end each turn with `{ continue: state }`: the session keeps that state
and the next utterance starts a new run of the flow with it (*continue-as-new*), so a
conversation with no end keeps journals one turn long. Documents imported in a dialogue
standard run this way (ADR 0013).

A book may name an **entry** flow that every session starts in (a call flow answering the
call, or a whole chatbot): it hears each utterance first, and a turn it passes on goes to
the scripts, then the model.

Session state that is not a flow (the context, a form being filled) and the flow a
session is in are saved with the book, so nothing about a session's dialogue lives only
in memory: a restart loses no form, context or flow. Run ids come from a counter in the
book, saved whenever a run starts, and are never reused. A run nothing will resume (it
ended, or another flow took its place) is forgotten: the host deletes its journal.

### Building scripts ahead of need

Scripts are authored (a call flow, reviewed like a call-center script) or built by the
harness from the turns the model answered:

- **Induction (no model).** Each answered step is observed: a result step's cluster is its
  tool; an utterance step joins the cluster whose first utterance is near it (by embedding,
  or without an embedder by Drain's position-wise similarity) in the same context. When a
  cluster reaches `induce.support` observations, its replies are aligned (token LCS, as
  Drain aligns a log cluster): shared text is fixed, the rest are holes. Each hole's
  provenance is looked up: a hole whose value in every observation is a slot of the
  utterance's own alignment becomes a slot hole (and the utterance alignment becomes a
  pattern with that named group); one whose value is at the same path of every tool
  input or output becomes a value hole; anything else is generated. A template is kept only
  when enough of it is determined without the model (`induce.determined`: fixed text and
  slot or value holes), it has few holes (`induce.holes`), and at least `induce.support` of
  the cluster's replies fit it. An induced slot group matches digits only when every
  value was digits, and otherwise a few words at most (`induce.words`: `\S+(?:\s+\S+){0,7}?`
for 8), never `.+`.
  Exemplars keep slot values masked (`{slot_1}`), and numbers, emails and links masked too
  (`{number}`, `{email}`, `{link}`, word by word, in time linear in the utterance), so a
  script does not carry what one user said. A tool result is kept with its values up to
  `induce.valueLength` characters (longer ones are left out); a reply only repeats short ones.
- **Whose replies.** A cluster is built from only when its observations come from
  `induce.sessions` sessions: one person repeating themselves is not everyone's answer.
  A step the model *acted* on (it called tools instead of replying) marks its cluster as
  the model's for good: nothing is built for it, and a candidate matching such a step gets
  a miss and is retired (steps like it are the model's to act on). Replies cut short, failed or empty teach nothing. Clusters without a script are
  capped (`induce.clusters`, least recently added to goes), and a retired script's shape is
  never built again, by induction, drafting or re-induction.
- **Drafting (one model call, off the critical path).** When a cluster's replies are too
  varied to align (the model paraphrases), the drafter model writes the script
  (JSON Schema constrained): intent, exemplars, slots, reply parts, and **follow-ups**:
  scripts for what the user is likely to say next, in the new script's context. This is
  the pre-emptive part: the next turn's script exists before the next turn. A draft is
  kept only if its reply, with the observed slots filled in, is one of the observed
  replies with its generated holes filled (it fits) and it meets the same bar as induction
  (`induce.determined`, `induce.holes`); a drafted slot pattern that could take
  exponential or high-degree polynomial time (a group that may repeat, `*`, `+` or a bound
  past one, containing a quantifier or an alternation; or three repeated atoms in a row
  that can match the same characters, as in `\d*\d*\d*`) is refused, and the refusal
  goes to `onError`. Nothing is drafted when nothing could match a draft (no embedder and no router),
  and follow-ups cannot be checked yet.

### Trust: candidates, shadowing, promotion

A built script starts as a **candidate** and never answers a user until it is **active**.
A matching candidate runs in shadow: the model answers, and the dialogue checks whether the
model's reply fits the candidate's template with its slots filled. A fit, or failing that
the judge accepting the candidate's rendering as an equally good answer (`promote.judge`),
counts for it; a disagreement counts against it and its observation is added to its
cluster, so an induced script is re-induced (a fixed part that varied becomes a hole), and
a re-induced script is a new template whose evidence starts again. A built script starts
with no evidence: what it was built from is not a fit, and neither is a fit from a session
it was built from. At `promote.fits` fits from at least `promote.sessions` sessions a
candidate becomes active (evidence names the first `promote.sessionsKept` sessions, at
least `promote.sessions`); at `promote.retireMargin` more disagreements than fits it is
retired. An active built script stays accountable: every `promote.audit`th time it would
answer (audits counted with the times it served, so audits keep coming), the model answers
in its place, in shadow, and a miss there counts as it would for a candidate. Authored scripts can be active from the start. Feedback from outside
(`feedback`, naming the session when known) counts the same way for active scripts, so a
script that starts to mislead is retired.

Matching is careful where it could be wrong: patterns run only on utterances up to
`match.maxLength` characters (with the regular expressions cached), so a hostile utterance
is bounded (induced gaps are a few words, drafted patterns that could backtrack
exponentially are refused, and normalizing and masking are linear); a long answer is not
taken whole as a slot's value; a pattern's own named groups are authoritative for its slots;
the router is offered active scripts only, so a candidate waits for a pattern or exemplar
match; and in a form, an answer another script matches goes to that script before it can
become the slot's value.

Every decision is traced: the response header `x-harness-model` names the script
(`dialogue/<id>`), and provider metadata `harness.dialogue` says how it matched.

### Where it runs

The dialogue is pure (it takes an embedding model, a router, a drafter and a judge, all
AI SDK models, all optional, and a flow runner: a workflow host). The native host puts it
in front of the worker's model (`--dialogue <file>` with `--worker model` or `--worker
ensemble`, where it can constrain a template's holes), or in front of the worker itself
(`DialogueWorker`, for workers whose models it cannot reach: an external harness such as
Claude Code, the echo worker; a template's holes are then the worker's to write, told the
template, and what a flow said before handing a turn on is said before the worker's reply;
a worker keeping its own history is told it after the user's words, `handoff.said`).
The script book is
saved to that file after every change, and shutdown waits for the last save; flows and
their journals are the workflow library's with `--workflows`, else files in
`--dialogue-flows`, by default next to the book). Saves go one at a time, each of the
latest state, and a failed one is logged; shutdown gives learning under way
`--dialogue-grace` milliseconds (5000 by default), then waits for the last save. Over the
ensemble it uses the ensemble's router, judge and reasoning model, and memory's embedder
when memory is installed; with a gateway model alone it matches by pattern, clusters by
shape and drafts with that model.

It is managed over ACP as the `dialogue` cognitive extension (`dialogue.status`, `.list`,
`.get`, `.put`, `.feedback`, `.import`), on the ensemble or, without one, an ensemble of its
own. Operations are told their caller: authoring (`put`, `import`) is for people and their
clients, not plugins or agents, and `feedback` counts evidence only from a session the
dialogue saw, so a made-up session cannot promote a script. `import` refuses a workflow or
script of the same name unless asked to replace it, and checks everything it can before
it writes anything. What happens to the book (a script built, put, promoted or retired; a
document put) is published on the hook bus as `dialogue.*` events from source `host`, so
plugins can react. In front of a worker that keeps its own history, the dialogue tells it
the exchanges scripts answered since its last turn (`handoff` in the settings), so it
sees the whole exchange, and a turn cancelled while the dialogue decides never reaches it.
The browser host has the same (`browserDialogue`: the book in IndexedDB, flows on
QuickJS).

**Scope.** A step carries its session's working directory as its scope, an absolute path
without trailing separators (a relative one is no scope); the session agent names it in
provider options, and `DialogueWorker` reads it from the prompt command's `cwd`. A script
with a scope answers only there, and steps are clustered, and scripts built, within their
scope: what the model says about one project does not answer in another. Authored scripts
without a scope answer everywhere. (The persona is the daemon's, so one book per daemon is
one book per persona.)

Exemplars are matched by a scan of cached vectors rather than an index: Orama, which
memory uses, searches vectors exhaustively too, so an index would add a dependency without
changing the cost; revisit when books hold tens of thousands of exemplars.

Every model is optional and fallible. A missing model matches, extracts, judges or drafts
nothing; a failing one does the same and its error goes to `onError` (the native host
logs it), so a model outage costs the dialogue its help, never a turn.

Only steps a script could answer are considered: the prompt ends with the user's words
(text only) or with one tool's result. Calls that carry a constraint, a JSON response
format or a forced tool choice are someone else's structured call and go straight to the
model, leaving the session as it was. A user turn that is not a step (a file among its
parts, say) ends its session's form and context, since the dialogue did not see it. A turn
the AI SDK retries after the model fails (the same step, its prompt built again) gets the
decision it had (a call is the same turn when its whole prompt is), so a form or flow
moves on once per turn; decisions still waiting are kept for as many sessions as the
dialogue keeps. When a script's holes are the
model's, the call carries the template both as a constraint (for generators that enforce
it) and as an instruction showing it with its holes as `{name}` (`generate.instruction`,
for those that do not), and `harness.dialogue.fitted` says whether the reply kept to it.
A step the model answered is observed only when it finished its reply (`stop`) or called
tools (it acted). A dialogue that fails decides nothing, and the model answers.

## Alternatives

- **A semantic cache of whole answers.** Cheaper to build, but it cannot put this caller's
  order number into the answer, and it returns an unverified answer on similarity alone.
- **Ask the model for a template on every turn.** Doubles inference, the opposite of the
  goal; drafting is kept for clusters induction cannot align.
- **Rasa or Dialogflow as a dependency.** Server-side Python or a hosted service, not
  portable to the browser host, and built around an intent-classifier training loop the
  harness does not need: its models are already an ensemble.
- **Templates as workflows (`@harness/workflows`).** A workflow can call the model, so it
  could express a script, but a script needs no sandbox and must be matched before any
  call; workflows remain the place for multi-step procedures.

## Revisit when

- Clusters grow past a few thousand: exemplars move to an Orama index as memory's do.
- A turn's scripted text should be rephrased per persona (CALM's rephraser): a generated
  hole spanning the reply, constrained to the script's facts.
- Slot confirmation (implicit and explicit, as IVR does for low-confidence recognition) is
  needed for effects: it belongs with the effect ledger's approvals.
- The browser host needs it: the package is pure, only the host wiring is missing.
