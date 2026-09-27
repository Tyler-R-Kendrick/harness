# 0011: Scripted dialogue: templates in front of inference

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
  takes over (mixed initiative).
- **Reply**: fixed text and holes. A hole is filled from a *slot*, from a path in the
  result step's tool *input* or *output*, or is *generated*. A reply with no generated
  holes is rendered with no inference at all. One with generated holes is one
  constrained call (a template constraint, ADR 0004): generators that enforce templates
  write only the holes.

The matching cascade is cheapest first, as the tool-call cascade is: patterns (certain),
then exemplar similarity (`match.similar`), then the router (`match.route`). A miss, or a
router below its threshold, goes to the model.

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
  when enough of it is fixed (`induce.fixed`) and it has few holes (`induce.holes`).
  Exemplars keep slot values masked (`{slot_1}`), so a script does not carry what one user
  said.
- **Drafting (one model call, off the critical path).** When a cluster's replies are too
  varied to align (the model paraphrases), the drafter model writes the script
  (JSON Schema constrained): intent, exemplars, slots, reply parts, and **follow-ups**:
  scripts for what the user is likely to say next, in the new script's context. This is
  the pre-emptive part: the next turn's script exists before the next turn. A draft is
  kept only if its reply, with the observed slots filled in, is one of the observed
  replies with its generated holes filled (it fits); follow-ups cannot be checked yet.

### Trust: candidates, shadowing, promotion

A built script starts as a **candidate** and never answers a user until it is **active**.
A matching candidate runs in shadow: the model answers, and the dialogue checks whether the
model's reply fits the candidate's template with its slots filled. A fit, or failing that
the judge accepting the candidate's rendering as an equally good answer (`promote.judge`),
counts for it; a disagreement counts against it and its observation is added to its
cluster, so an induced script is re-induced (a fixed part that varied becomes a hole). At
`promote.fits` a candidate becomes active; at `promote.retireMargin` more disagreements
than fits it is retired. Authored scripts can be active from the start. Feedback from
outside (`feedback`) counts the same way for active scripts, so a script that starts to
mislead is retired.

Every decision is traced: the response header `x-harness-model` names the script
(`dialogue/<id>`), and provider metadata `harness.dialogue` says how it matched.

### Where it runs

The dialogue is pure (it takes an embedding model, a router, a drafter and a judge, all
AI SDK models, all optional). The native host wraps the worker's model with it
(`--dialogue <file>` with `--worker model` or `--worker ensemble`; the script book is
saved to that file after every change, and shutdown waits for the last save). Over the
ensemble it uses the ensemble's router, judge and reasoning model, and memory's embedder
when memory is installed; with a gateway model alone it matches by pattern, clusters by
shape and drafts with that model.

Every model is optional and fallible. A missing model matches, extracts, judges or drafts
nothing; a failing one does the same and its error goes to `onError` (the native host
logs it), so a model outage costs the dialogue its help, never a turn.

Only steps a script could answer are considered: the prompt ends with the user's words
(text only) or with one tool's result. Calls that carry a constraint, a JSON response
format or a forced tool choice are someone else's structured call and go straight to the
model. A dialogue that fails decides nothing, and the model answers.

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
