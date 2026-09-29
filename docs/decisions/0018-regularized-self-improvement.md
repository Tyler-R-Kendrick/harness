# 0018: Regularized self-improvement of the harness (RRSI, critiqued and calibrated)

First merged as 0014, alongside the playground's template-first-answers ADR 0014 from a
parallel change; renumbered 0018.

Status: decided, 2026-09-28.

## Question

The harness already improves itself in small ways: learning distils lessons from sessions
(`@harness/learning`), and the dialogue induces scripts from the model's answers and
promotes them after shadow checks (`@harness/dialogue`). Neither changes the harness's own
configuration: its prompts, thresholds and procedures, all of which are data here
(`packages/*/data/*.json`), and its source files. Xia et al., "RRSI: Regularized Recursive
Self-Improvement of Agent Harnesses" (arXiv:2609.24972, September 2026; code at
google-research/rrsi) evolves a harness against a task suite and argues that the search
must be *regularized*, or it memorizes the suite. Should the harness evolve its data and
code this way, and if so, is the paper's method sound enough to adopt as published?

## What the paper does

A round drafts m candidate harnesses (LLM proposer, edits in git worktrees), screens them
with a leakage critic, evaluates each on the full evolve set with k trials, and accepts
at most one. Regularization acts on the search, not on what the harness may contain:

| Paper | Its code | Here |
|---|---|---|
| Annealed edit budget b_t (Eq. 4) | `schedule.py` | `editBudget` (RS3.1, RS19.47), with one fix: the paper's `ceil` never reaches b_min inside a run |
| Edit history L_t in the proposer's context | `history.py` | `ledger.ts`, with three-valued verdicts (RS7.1, RS7.6) |
| Stall flag and reserved exploration slots | `history.py: stall_flag, exploration` | both: `paperStall` (RS7.4) and `stalled` (RS7.3); slots judged by the diff (RS9.5) |
| Leakage critic before evaluation | `critic.py` (regex + LLM) | `leaks` (n-gram overlap with task texts and references, RS6.1–RS6.2) + `judgeCritic` (RS12.3) |
| Noise band delta | `calibrate.py` | `noiseBand` (RS2.8–RS2.9), used only by the paper's rule |
| Floor S' >= S* - delta, cost rule, within-band rule, argmax | `selection.py` | `paperDecision`, `choose(…, "score")` (RS8.1) |
| Prune set B_t by component yield | `history.py: prune_set` | `componentYield` (RS7.5), paper's rule only |
| Novelty bonus nu | `components.py: novelty` | paper's rule only |

The loop, the ledger, the budget and the exploration directive are good ideas and are
kept. The selection side is where the paper's claims live ("removes changes that are too
small, too expensive, or no longer useful", abstract; and, in the reference README, "a
noise-adjusted floor blocks gains within evaluation variance"), and it does not do what it
says. Each point below is checked by a test, by arithmetic on the paper's own numbers, or
by reading the paper and its reference code (file names are the reference code's).

## Critique

### The noise band measures the wrong noise

In the reference code delta is z = 2 standard deviations of the score difference between
two evaluations of the *same harness on the same tasks* (`calibrate.py`: repeated base
evaluations, or a bootstrap that resamples trials within each task, tasks fixed). The
paper says only that delta is estimated from repeated evaluations of the unchanged base
harness; its published values (0.017, 0.004, 0.020) are fixed constants in `rrsi.json`.
That is re-measurement noise. The paper's claim is transfer, and the noise that decides
transfer is which tasks were sampled. With the task set fixed, a +1 on two tasks and a
+0.1 on twenty tasks (of 100) are the same 0.02 gain against the same delta (RS2.2,
RS2.9): the first is exactly the "fit to the evolve set" the paper sets out to prevent,
and its own rule cannot tell it from a mechanism (RS9.11: accepted under the coding
instance's delta, refused here). Tasks are also clustered (Harvey LAB spans 25 practice
areas, and its split is proportional per area, `split_workspace.py`); a gain in one area
is evidence about one area (RS2.3).

### Inside the band, the rule admits noise, and its acceptance region is not monotone

For a candidate whose gain is within delta, Algorithm 2 applies
`w_s ΔS − w_c ΔC + w_n ν > 0`. With the workspace instance's weights (w_s = 1414,
w_c = 15, from the reference code's `rrsi.json`; the paper says the weights are in its
Table 5, which lists none), any positive point gain at unchanged cost is admitted, however small: that is
admission *by* the within-band fluctuation the section says it guards against (RS8.3). The
two branches also disagree at the boundary. Engineering (delta 0.020, w_s = 244,
w_c = 2): a gain of 0.019 may add up to 232% more tokens, while a gain of 0.021 is capped at
66%; workspace: 0.0039 may add 37%, 0.0041 is capped at 24.5% (RS8.2). A smaller gain buys
a larger cost allowance (inside the band the allowance rises with the gain, and drops
at delta; it is the boundary that is not monotone). The coding instance (w_s = 0) admits
a candidate up to delta below S* for any token saving, or for touching a structural
component type never accepted before (RS8.3): a complexity bonus inside the rule meant
to charge for complexity. The arithmetic (231.8%, 66.2%, 36.8%, 24.5%) is pinned by
RS8.2.

### The incumbent's score is the measurement it won on

When a candidate wins (the admissible one with the highest S', `selection.py`), its
selection-round evaluation becomes the incumbent's score
(`loop.py`: the frontier's incumbent `job` is the winner's; `incumbent_eval` loads it next
round), and S* is the running max of those. The winner of several noisy measurements
is biased upward (the winner's curse), so every later Delta S is taken against an
inflated reference, and the floor rises with the best draw seen so far.

### No error control across the run

Each out-of-band acceptance is a one-sided z = 2 test (about 2.3% false gains, if delta
is two standard deviations of the null difference, as in the reference code), repeated
for m = 2 candidates over T = 20 rounds (coding and workspace; engineering has T = 40, so
80 tests): 40 tests with no correction (1 − 0.977^40 ≈ 60% for independent tests, before
the within-band branch adds its own). We ran the paper's rule through whole runs of a
simulated world where no candidate has any effect (RS10.2; 40 seeded runs of 10 rounds,
60 tasks, a fifth of them coin flips, delta calibrated from two base evaluations at z = 2
as the reference code does):

| Rule | Runs that accept a change | Incumbent's recorded score minus its true score |
|---|---|---|
| Paper, workspace weights | 33 / 40 | +3.4 points |
| Paper, coding weights | 10 / 40 | +1.6 points |
| Calibrated (below), alpha = 0.1 | 2 / 40 | +0.02 points |

In that world delta averages 5.9 points (0.4 in the paper's workspace instance), so the
size of the inflation does not carry over to the paper's numbers; the mechanism does:
whatever delta is, the incumbent's recorded score rises with the noise that got it
accepted (RS10.2).

### Adaptivity is cited, not handled

The paper names the problem correctly: the evolve set is reused adaptively (Dwork et al.
2015), and the proposer reads the evolve set's trajectories. Dwork et al.'s remedy is a
holdout queried through a mechanism (Thresholdout) that keeps it valid under adaptive
reuse. The search uses neither; the in-search defense aimed at the suite's content is the
critic, which is least able to catch a rule tuned to the suite's habits that copies no
words.

### Credit and pruning are assigned to the wrong things

- Bundled edits all inherit their candidate's Delta S (`history.py`), so a harmful edit
  bundled with a strong one early (b_t up to 4) carries positive credit. The paper says so,
  and argues that attribution improves as b_t anneals; but b_t never reaches b_min inside
  a run (t stops at T − 1 and the ceiling rounds anything above 1 up to 2: for T = 20,
  b_max = 4 the budget ends at 2), against Table 5's "final-round edit budget" of 1.
- g_t(l) is the *max* Delta S over a window: the more often the proposer tried a component,
  the higher its max by chance, so a component is less likely to be pruned for being tried
  more.
- B_t = {l : g_t(l) <= 0} uses 0, not the noise band that governs the floor, the cost
  rule and the stall flag.
- Most importantly, B_t marks a component *type* when none of its edits gained more than 0
  in the last n_prune rounds, including when none was tried in them (g_t = −∞: a stable
  accepted mechanism in a type the proposer has stopped editing is flagged), and tells the
  proposer to delete the *accepted* machinery of that type (`propose.py`: "remove the
  accepted machinery listed"). Whether new prompt edits help says nothing about whether
  the prompt text already accepted still earns its place. That is a
  question about each accepted mechanism's marginal contribution now, which only removing
  it and measuring answers (ablation).
- The history stores point gains and tells the proposer "a rejected mechanism is negative
  evidence; do not redraw it unchanged" (`propose.py`). A gain inside the noise is
  absence of evidence, not a falsification.

### Smaller points

- The L0 budget counts the edits the proposer *declares*; whether they are independent is
  left to the LLM critic, and one declared edit can be any size.
- The cost rule is relative to the incumbent, so allowances can compound round after
  round; the final harness uses 55% more tokens than H_0 on the workspace instance
  (2.42M vs 1.56M per trial, Table 2). The paper does not say how much of that is
  compounded allowance.
- The regularization analogies are inconsistent: Figure 2 labels complexity-aware
  acceptance "L1-style" and pruning "L0-style"; Section 3.1 calls them Ridge/L2 and
  Lasso/L1; the code calls the cost rule the "L1 cost rule" (`config.py`). A linear hurdle
  on cost is a budget constraint (an incremental cost-effectiveness threshold), not a norm
  penalty.
- The paper likens exploration to "diversity or entropy regularization"; U_t = K \ T_t
  empties for good once each of the nine component types has one measured edit. That is
  coverage, not entropy.
- The proposer, analyst and critic are the same model (and so is the policy, outside the
  Gemini run); a critic that shares the proposer's blind spots may screen less than an
  independent one. The paper does not test this.

### The evaluation cannot carry its claims

The paper reports one run per arm: no repeats, seeds or intervals appear in it, so the
variance of the search itself is never measured. Against sampling error alone, the
out-of-distribution gains are between 0.7 and 1.2 standard errors: SWE-bench Verified
+1.8 on 500 tasks (the benchmark's size; unpaired SE of a difference 2.4 points), GDPval
+3.5 on 185 tasks (5.2; the appendix's 204 comparisons per judge would give 4.9),
APEX-Agents +3.7 on 480 (3.1); JobBench's and Frontier-Eng's sizes are not stated. Paired
analyses would be tighter, but none is reported. The ablation's out-of-distribution
differences (1.7 and 2.6 points for the two ablations of RRSI, 3.3 for unregularized
evolution, Table 2) have no intervals, and "no held-out split regresses anywhere" is not
evidence at these sizes. The abstract's "up to 14.1 points" is the Gemini 3.5 Flash coding
run on the split it evolves against; the headline experiments (Opus 4.8) gain at most 6.0
there.

There is also a power floor the paper never meets. We measured what a correctly
calibrated rule can certify for a real gain proposed in one round of a 20-round run at
family-wise alpha = 0.1 (60 tests), 20 seeded runs per cell, in a simulated world (RS10.3
and RS17.1–RS17.3 pin the rows, with slack; the fourth row is 40 / 100 in RS14.62's 100
runs):

| Evolve tasks (k = 2) | True gain | Spread | Accepted |
|---|---|---|---|
| 60 | +20 points | +1 on 20% of tasks | 10 / 20 |
| 60 | +10 points | +0.25 on 40% | 4 / 20 |
| 240 | +10 points | +1 on 10% | 19 / 20 |
| 240 | +5 points | +0.125 on 40% | 40 / 100 |
| 240 | +10 points | +0.25 on 40% | 19 / 20 |

At the paper's evolve-set sizes (61 to 120 tasks) the per-candidate gains it shows are 1
to 4 points (Table 6: +3.93, a two-part bundle, and 122 to 128 passes of 244, +2.5
points; the whole 20-round evolve gain on Harvey LAB is +1.1). In our simulated worlds a
gain that size at that many tasks is rarely certified at a run-wide error rate of 0.1;
whether the paper's own gains would be depends on their per-task spread, which it does
not report. Its rule accepts them without a run-wide error rate.

## Decision

`@harness/evolution` (pure) runs the paper's loop over a surface of JSON and text
documents, with the selection side replaced, and the paper's rule kept beside it (`select.rule: "paper"`)
so a run can reproduce the paper and the two can be compared (RS10.2, RS9.10–RS9.11).

- **The harness is data, edited by JSON Patch.** A surface names documents and their zod
  schemas; a candidate is edits, each a JSON Patch with its hypothesis
  (`fast-json-patch` applies them; what each edit did is recorded from the ops themselves,
  so an array insert is one added value, not a positional diff of every shifted element).
  What the paper takes on the proposer's word is computed: edits touching the same part,
  or the same array, are one edit, so the L0 count is real (RS5.3, RS18.14–RS18.26); a
  change's components come from the paths it changed, not from its tag (RS5.1, RS5.6); a
  document its schema refuses is the liveness failure (RS5.4); every accepted edit keeps
  its inverse, so it can be taken out again (RS5.5).
- **Code is a surface too: text documents.** A source file is a document of `kind: "text"`,
  edited by `edit` ops (`old` must occur exactly once, as in the reference implementation's
  `edit_file`). Independence is computed from the character ranges the edits occupy
  (touching counts as overlapping; an edit that depends on another's output, or that could
  not be taken out on its own, is not independent), the footprint is the changed lines, the host's `check` (it parses, it
  compiles) is the liveness test and also runs on the base harness, `classifyText` maps a
  changed region to a component, an inverse carries the least surrounding context that
  makes a repeated or deleted text findable again, and the leakage screen reads the text
  an edit adds. Ablation and entanglement work as for JSON (RS13.1–RS13.43,
  RS18.1–RS18.45); a revert that cannot be done is refused (the mechanism is then
  entangled), never thrown.
- **Paired, same-window measurement.** Each round evaluates the incumbent again with the
  candidates. Its evidence is what was measured *after* it was chosen, never the
  measurement it won on, which removes the winner's curse (RS9.2, RS10.1). Earlier fresh
  measurements are pooled only into the reported estimate.
- **Acceptance by an inverted randomization test.** Under the null that candidate and
  incumbent are the same harness, which produced which measurement of a task is
  exchangeable, so groups of tasks flip the signs of their differences. The test is exact
  whatever the reward distribution and with ties: by enumeration of all 2^G sign vectors
  up to 14 groups, by Monte Carlo above (RS19.31–RS19.35). Inverted under a shift model,
  its bounds are quantiles of the weighted mean difference of flipped groups: closed
  form, no search (`compare`, RS2.1–RS2.7). Tasks are the unit, and groups (which come
  from the task set, never from the evaluator, as do weights; RS19.40–RS19.45) when tasks
  name them. What this certifies is a gain on the evolve tasks, given the history: the
  sharp null "same harness" with fresh trial noise. It is not a guarantee about new
  tasks, because the proposer reads the evolve tasks' failures and designs edits at them;
  the holdout is what checks that. A group with no difference never certifies anything,
  so the guard on group counts is necessary, not sufficient.
- **A run-wide error rate.** Every acceptance test gets alpha / (T (m + 1)), a union bound
  valid under the arbitrary dependence an adaptive search has (RS3.2). The cost is power,
  stated in the table above and chosen in data (`select.alpha`, `rounds`, `trials`). The
  settings that fix the error rate are kept in the saved state, and a resume that changes
  one of them (a run extended from 20 to 30 rounds would silently spend more than alpha)
  is refused, naming which (RS19.70–RS19.76).
- **The error budget can be spent front-loaded, and must be spendable.** `select.spending`
  is `uniform` (equal shares) or `geometric` (round t gets alpha ratio^t / sum ratio^s,
  split among the round's tests). Both are functions of (round, rounds, tests) alone and
  add up to alpha, so the union bound holds (RS14.1–RS14.9, and as a property RS14.20–22).
  Geometric moves power from late rounds to early ones. RS14.71 asserts the direction (a
  gain proposed in round 0, n = 240, +0.05: at least five more of 100 runs certify it
  under geometric than under uniform spending), and RS14.70 that the null stays inside
  alpha. Larger exploratory studies, recorded in the comments of
  `spending.simulation.test.ts` and not asserted, gave 48.5% against 38% for round 0
  and 30% against 38% for round 15. It is deliberately not
  alpha-investing, which lets a test's level depend on earlier outcomes and controls the
  marginal false discovery rate, not the chance of any false acceptance; a wrongly accepted
  change is built on by every later round, so the family-wise rate is what is promised.
  Because a test that flips whole groups of tasks cannot certify anything at a level of
  2^-G or below, a run whose evolve set has fewer groups than its smallest test level can
  resolve is refused before anything is evaluated, also when a saved run is restored
  against a smaller set (RS16.1–RS16.5). Settings whose resamples cannot resolve a round's
  level are refused too (RS14.7).
- **Futility staging saves evaluations without adding acceptances.** With `select.futility`
  a drafted change is first evaluated on a random prefix of the evolve tasks; if the
  prefix gain's upper bound (at the futility level) is below the non-inferiority margin
  it can be neither a supported gain nor a non-inferior saving, and is abandoned with the
  reason recorded. Survivors are evaluated on the rest and the acceptance test runs on
  all tasks at its unchanged level, so staging can only remove acceptances, never add
  them. On the study world the tests pin: no more null acceptances than the budget
  allows in 40 runs, with it and without (RS14.60); bad candidates (harm 0.2) abandoned
  in most runs with about a fifth fewer evolve tasks evaluated overall, about a third
  fewer counting only candidates (RS14.61, observed 331 of 400 abandoned and 18.8%
  fewer); and a real broad gain never abandoned in 140 runs and found about as often as
  without staging (RS14.62). Exploratory runs recorded in the comments of
  `futility.simulation.test.ts` (0 of 300 real +0.05 gains abandoned) are not asserted.
  Ablations are never staged. What is not claimed: a paired power comparison, since
  staging changes which random trials each candidate gets.
- **Gains, savings and removals are different claims, and every claim is tested.** A
  change is a gain only when its lower bound is above zero and its cost is not clearly
  over budget (the cost's lower bound within beta0 + beta1 × the gain's lower bound,
  RS8.4). A saving of at least `saving` and a removal are non-inferiority claims: the
  lower bound above −margin (strictly: a bound exactly at the margin certifies nothing,
  RS19.30), and the cost claim (the saving, or a cost within beta0 for a removal) proved by
  the same paired randomization bounds on per-task token differences, because a point cost
  ratio has no error control and noisy tokens made a do-nothing candidate look like a
  saver in 9 to 19 of 20 runs (RS19.1–RS19.11; with the bounds, 0 of 40 null runs at token
  noise 0.6 and 1.0, and a real 40% saving still found, RS19.20–RS19.21). No extra error
  budget is needed: an acceptance is the intersection of its claims, so it happens with
  probability at most the level of any one false claim. Losses are a CUSUM on lower
  bounds with no reset (drift' = max(0, drift − lower), refused above margin, RS19.12–
  RS19.17): a sawtooth of small saves each followed by a tiny supported gain no longer
  walks downhill. Cost is capped against H_0 by the certified running sum of accepted
  lower bounds, not noisy point scores (RS8.7). There is no novelty bonus: exploration is
  the proposer's job (reserved slots), not a reason to accept.
- **The winner has the best evidence,** the highest lower bound, not the highest point
  estimate (RS8.9).
- **Pruning by ablation.** Each round, the accepted mechanism with the weakest evidence
  that is due is removed in a candidate of its own; the removal is accepted when it is
  non-inferior, and otherwise the mechanism stays. This is backward elimination with a
  non-inferiority test, per mechanism, in the current harness (RS9.6). A mechanism a later edit rewrote is entangled and is no
  longer removed on its own (RS9.7).
- **A budgeted holdout.** When the split has a holdout, a winner is confirmed on it before it
  becomes the incumbent: the winner and the incumbent are measured afresh on the holdout
  in one window and compared by the same paired randomization test, at level
  alpha_holdout / (2^budget − 1). The proposer learns one bit per query (confirmed or
  not; the records keep the numbers for the operator), so what an adaptive analyst can
  ask lies in a binary tree of depth `budget`, and the union bound over its 2^budget − 1
  nodes is the whole guarantee (the description-length argument of Dwork et al. 2015 in
  its plainest form; RS19.50–RS19.65). Thresholdout, which this replaces, failed at the
  sizes a harness run has: its noise was below one task's influence, its evolve-side value
  was the selected winner's own biased gain (it flagged overfitting in 76 to 82% of runs
  at a true gain of zero), and a pure-overfit candidate passed 55 to 60% of the time.
  Measured now: a pure-overfit candidate confirmed in 1 of 100 runs, a real broad gain in
  95 of the 95 that queried the holdout (RS19.80–RS19.81). A spent holdout confirms
  nothing, an invalid holdout measurement throws without spending a query, and a holdout
  too small (in groups) to confirm anything at its level is refused at start.
- **Leakage screening is deterministic first.** An edit must not name an evolve task,
  repeat six words in a row from any task's text or reference answer, or carry a
  credential (RS6.1–RS6.2). Then the judge critic, which refuses when it cannot judge
  (RS12.3). Use a judge from another family than the proposer's model.
- **The history speaks in verdicts.** `supported`, `refuted` or `inconclusive`, with the
  interval; the proposer's instructions say an inconclusive change is not evidence against
  it (RS7.1, RS7.6).
- **A host drives it.** `harness-evolution` (`packages/platform-native`) runs
  `start | round | run | status | documents` from a config file: the documents (JSON or
  text, with optional JSON Schemas, `check` commands and component classification), the
  evolve and holdout tasks (id, text, reference, group) and an evaluator command that runs
  the harness as a child process (`{documents, tasks, k}` on stdin, task runs on stdout,
  parsed into refined types). The run is saved atomically after every completed round, so a
  failed round changes nothing and `run` resumes; documents are written back only on
  request, and never over files that changed since the run started (EH1.1–EH12.6, and end
  to end with a real child-process evaluator and a holdout, EH10.1). The proposer and the
  critic are gateway models, or the critic is the ensemble's judge.
- **Models are AI SDK models, and the proposer is an Ax program.** The critic is
  `experimental_evaluate` (RS12.3). The proposer is an `@ax-llm/ax` signature: Ax
  compiles the prompt from that signature and the system text, and constrains the
  answer to the proposal schema (RS12.1–RS12.2). Once per proposer, when
  `proposer.optimize.maxMetricCalls` is above zero, Ax's `optimize` (GEPA) tunes that
  prompt. The metric is deterministic and is not a second selection test: the answer
  parses and stays within the round's edit budget. The cap and the seed are data
  (RS12.4). The run stores no labeled proposals, so the search is GEPA alone, not a
  bootstrap of gold demos. The student is the same AI SDK language model the host
  already resolved. Ax ships no adapter that takes an AI SDK model — its AI SDK
  package wraps Ax the other way — so the model's chat function is injected as an Ax
  service. A cap of zero leaves the compiled signature prompt untuned. Selection, the
  ledger, the leakage screen and the holdout are unchanged. Settings, prompts
  included, are data with a generated schema (`packages/evolution/data/settings.json`,
  RS11.1–RS11.2).

## How the rule got here

Two earlier versions of the calibrated rule failed their own guarantee, and the tests
caught it. A two-stage bootstrap (tasks, then trials within tasks) counted trial noise
twice, since each task's observed difference already carries it (Davison and Hinkley 1997,
sec. 3.8), and cost power. The one-stage percentile bootstrap that replaced it accepted a
change in 7 of 40 null runs, against a promised 10% at most, because its far tail is too
thin when few tasks carry the signal (7 of 40 null runs is not significant against a
promised 10%, P about 0.11, but it is the wrong shape for a guarantee). The randomization
test is exact by construction, and RS10.1 pins its null behavior (at most 4 of 40 null
runs; observed 2, far under alpha because the union bound and deterministic tasks make
the true rate much smaller). Review then found that the guarantee still had holes, which
are closed above: cost claims tested by point ratios, a drift budget that charged point
losses and reset on any gain, group and weight taken from the evaluator's output, a
Thresholdout regime that flagged selection bias, and error-control settings that could
change between resumes.

## Consequences

- A run on an evolve set the size of the paper's will accept few changes, and only large,
  broad ones. That is what such a set can support. To accept smaller gains, use more tasks
  (the table), fewer rounds, or a larger alpha, all in data.
- Each round costs one more evaluation than the paper's (the incumbent again), plus the
  ablation candidate, plus two on the holdout (the winner and the incumbent, afresh) when
  a winner is put to it; futility staging recovers about a fifth of that on bad candidates.
- The evolve set must have enough groups. A suite of a few dozen tasks each in its own
  group is enough for a short run; a suite whose tasks fall into four practice areas is not,
  and the run says so before spending anything.
- Each evaluation is a child process the host spawns; the harness under test runs with
  the host's authority. Evolving code that runs code is the operator's sandbox decision,
  as it is for any harness session.
- The first proposal a proposer handles spends up to `proposer.optimize.maxMetricCalls`
  extra model calls tuning its prompt. Later proposals on that proposer use the tuned
  program. The cap is the bound; zero skips the tune.

## Limits, and what was decided against

None of these is scheduled work; each is either outside what a search over an evaluator
port can do, or a decision. A host drives the search (`harness-evolution`; see above), and
the surface is documents, JSON and text, so code surfaces are evolvable too: a text
document is edited by replacing one occurrence of a span, and the host checks it with its
own `check` command before the candidate is measured. What a text surface cannot promise
is that the harness is still type-correct or tested afterwards, only that the host's check
passed.

- **Early acceptance.** Stopping an evaluation as soon as a candidate is clearly good needs
  an anytime-valid test (e-values, a confidence sequence) whose error is charged across
  looks, at a price in power. Futility staging already captures about a third of the
  candidate evaluations at no visible power loss, and the acceptance test stays exact; a
  sequential acceptance test was not adopted.
- **Online FDR.** Alpha-investing controls a different guarantee (see above). Not adopted.
- **Interactions.** Ablation measures a mechanism's marginal contribution given the rest.
  Mechanisms that only help together are each found redundant if removed alone, and are
  then kept or removed one at a time; the proposer is asked to make coordinated changes
  one edit (edits that touch the same part are one edit).
- **Judged rewards.** With an LLM judge as the verifier, the paired design cancels only
  what the judge does the same way to both harnesses, and nothing guards against
  optimizing toward the judge. The holdout helps only if it is judged differently; the
  evaluator port lets a host do that.
- **Transfer.** What is certified is a gain on the evolve tasks (given the history, at the
  run's error rate), and what the holdout adds is a check on tasks the proposer never saw,
  not a guarantee about new tasks in general. Whether a harness evolved on one suite helps on another
  is an empirical question that needs real suites, real models and several seeds of the
  whole search, with intervals; nothing in this repository can settle it, and the paper's
  numbers do not settle it either (see the critique).
