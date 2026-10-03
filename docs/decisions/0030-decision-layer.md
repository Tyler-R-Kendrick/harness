# 0030: A decision layer between the chat layer and the inference layer

Status: decided, 2026-10-03. Builds on ADR 0016 (Julia 1 as the playground's local decision
model, which this layer generalises to every decision), ADR 0010 (the local judge), ADR 0012
(the dialogue lifecycle this layer generalises) and ADR 0018 (regularized self-improvement,
whose frozen outer layer the criteria evolver follows).

## Context

An agent loop makes many model calls whose output is not text anyone keeps: which
worker goes next, whether a tool call is safe, whether a chunk of context still
matters, whether the task is done, whether a person must look. Each is a choice, a
score or a yes/no. Sending them to a generator costs seconds and money, returns a
string to parse, and can invent a field name. In September 2026 a class of small
non-generating models appeared that answer exactly these questions, typed, in one
forward pass, with probabilities: TypeSafe's Jev (hosted), and open ones (Julia 1,
Laya, Verdict, GLiNER2.5-Decide, Kev, CLM, SemIf, Von). They share one request shape,
`POST /v1/systemone` with `choice`, `score` and `noul` questions, and a community
conformance suite (`jevcompat`).

The harness already has decision-shaped code in four places: the tool-call cascade
(`cognitive/cascade.ts`), template choice with a `none` option in the playground, the
capability ladder in `learning`, and the dialogue's shadow, promote and retire
lifecycle. Each does its own thresholds, its own records and its own escalation.

Independent measurements say what to build around. On byte-identical inputs Jev scores
0.907 against Laya's 0.686 (sysone-bench, 1,190 cases); small encoders are near random
zero-shot and useful once fine-tuned; probabilities are "votes rather than odds" until
calibrated on the deployment's own data; and `confidence` means five different things
across servers (`jevcompat`). So the layer must calibrate what it is given, pin the
version calibration belongs to, and never trust a server's `confidence`.

## Decision

Three layers, and the rules between them.

- **Chat layer**: people, sessions, consent, presentation (ACP clients, dialogue
  scripts, approvals, `/rate`). Owns intent and consent.
- **Decision layer** (`@harness/decision`, pure): typed forks. Never generates. Owns
  *which* worker, tool, model, template, person or verdict.
- **Inference layer**: generators, workers, tools, workflows. Owns content.
- Calls point down (chat, decision, inference). Outcomes and feedback point up as
  events. Improvement crosses layers only as data (records, calibration books,
  criteria, rules, policies), each with a JSON Schema, never as code.

**Forks.** A `Fork<In, Act>` is data and pure functions: what to ask, how calibrated
answers become an action and a confidence, what a rule can decide with no model, and
how restrictive each action is. Questions are the AI SDK's evaluation questions;
members are AI SDK evaluation models (`Experimental_EvaluationModelV4`) wrapped with a
pinned id and version.

**The ladder.** A decision climbs only as far as it must: rule, model (each candidate
in preference order, options rotated and averaged against position bias), judge
(a verifier asked a different question), generator, human. Thresholds (`act`,
`verify`, `accept`), rotation, exploration rate and mode are data per fork
(`data/policy.json`, schema generated from the parser). A rung that cannot answer
(unreachable, unusable answer) passes the decision up, and the trace says why. The
human rung returns a request to ask; it never answers.

**Monotone authority.** A deterministic authority (Cedar-like: forbid wins, default is
stated, rules are order-independent and data, no code) sets a floor of restrictiveness
per input. A learned verdict can raise the restriction (allow, escalate, deny) and
never lower it. Learned components cannot approve what the authority does not allow;
this is the same property as "no auto-approve" in the permission flow.

**Calibration.** Members' probabilities are calibrated per fork, member, version and
question from recorded outcomes: temperature scaling (any question) and Platt scaling
(booleans), with ECE and Brier before and after. Calibration is never applied to a
version it was not fitted on. Thresholds come from data, not from a guess: expected
loss with a cost matrix, and a selective-risk threshold chosen by fixed-sequence
testing with a Hoeffding bound, so the share of wrong answers among acted-on ones is
bounded at a stated level with a stated confidence. Split conformal sets give
prediction sets with coverage.

**Records.** Every decision is a `DecisionRecord` (input as the fork describes it,
calibrated and raw answers, rung, member and version, policy version, action,
confidence, propensity, whether it explored, trace) in a `DecisionLog` (memory, a file
on native, IndexedDB in browsers, one contract suite). Outcomes attach later, from a
person, a verifier, a judge or the system. `decision.made` is published on the hook bus
so plugins see decisions as events in the same sagas. Records map to OpenTelemetry
GenAI spans.

**Exploration and evidence.** A small share of decisions take a random option with its
propensity recorded, from an injected entropy port. Off-policy estimators (IPS,
self-normalized IPS, doubly robust) estimate what another policy would have done from
the log, so thresholds are tuned on evidence that is not biased by the branches taken.

**Loops between the layers.**

- *Compile* (inference to decision): recorded decisions become labelled examples with
  provenance and a deterministic holdout, disagreements between rungs are mined, and
  frequent structured decisions are induced into rules that answer at rung 0 once they
  pass shadow (the dialogue's Soar-chunking idea one level up).
- *Skip and dispatch* (decision to inference): switching-cost-aware model routing
  (staying versus switching, with cache read and write prices and the expected length
  of the easy stretch, computed in code), stuck detection (repeats and no-progress,
  code first), and the value of asking a person against the cost of interrupting.
- *Ground truth* (chat to decision): approvals, denials, edits and ratings are outcomes.
  They calibrate; they never auto-approve.
- *Attention* (decision to chat): a ranked inbox over sessions by urgency, staleness and
  what is blocked.
- *Evolve* (meta): criteria text and thresholds are data; a proposer edits them, the
  candidate is replayed on recorded decisions, and it is accepted only on a paired sign-flip
  test (exact up to 20 changed outcomes, sampled beyond, and the record says which) against
  the incumbent on a protected holdout the proposer cannot touch, with an
  archive of versions to roll back to. The evolver may not edit its own evaluator, the
  authority, or the holdout (frozen outer layer).
- Lifecycle for every learned artefact: candidate, shadow (decides and records, never
  acts), active on evidence, audited while active, retired on a margin of misses.

**The System One wire.** `@harness/decision` implements the request and response of
`/v1/systemone` (parse, validate, derive `choice`, `score` and `confidence` from
probabilities, 422 errors with the documented shapes) over any evaluation model. Hosts
serve it (`--systemone <port>`, loopback, token) so the harness's own ensemble is a
System One provider to any client, and the client side is TypeSafe's AI SDK provider
already in `@harness/models`. A conformance suite in `@harness/testkit` (the MUSTs of
`jevcompat`, written as a contract suite) runs against the handler. The layer's own
confidence is derived from probabilities and never read from a server.

**Hosts.** `decisionExtension` serves `decision.*` operations through
`_harness/cognitive/invoke`. A plugin actor connects to the daemon like any other peer,
reads `permission.requested`, `turn.*` and `session.*` from the hook bus, runs the
`permission.risk`, `attention` and `stuck` forks and publishes `decision.made`;
permission risk only annotates and escalates. The native host takes `--decision <dir>`
(records, calibration book, policy) and `--systemone <port>`; the browser host keeps
records in IndexedDB.

## Consequences

- Cost per completed task, latency and escalation precision are measurable from
  records; a threshold is a number with a bound, not a hope.
- A model can be swapped by catalog entry: the layer sees an evaluation model, a pinned
  version and a calibration book. A version change invalidates its calibration until
  refitted.
- The layer is only as good as the labels: outcomes from people are noisy (approval
  fatigue) and are used to calibrate, never to approve.
- Small local decision models are weak zero-shot. The design expects a fine-tuned or
  calibrated head per fork and an escalation path to a larger model, not one model.
- Exploration (a share of decisions taking a random option, with its propensity recorded)
  applies to the model, judge and generator rungs. A rule is deterministic and a question
  to a person is not the policy's to randomise, so their propensity is always 1.
- The decision plugin keeps its inbox in memory: a permission left open across a daemon
  restart gets no outcome from the plugin, though the decision itself is in the log.
- The ensemble cannot pin a distinct second model, so the judge rung asks the same ensemble
  a different question (with failover) rather than a different model.
- Prompt injection can move a model's verdict. Verdicts on untrusted content only
  tighten; the authority, not a model, is the last word.

## Revisit when

- A published benchmark covers decision models on independent, adjudicated labels: rank
  members by it in the catalog.
- The AI SDK adds an evaluation-model middleware or a standard record: use it.
- OpenTelemetry's agent conventions stabilise: track them in the span mapping.
