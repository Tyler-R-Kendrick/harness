# 0014: Regularized self-improvement of the harness (RRSI, critiqued and calibrated)

Status: decided, 2026-09-28.

## Question

The harness already improves itself in small ways: learning distils lessons from sessions
(`@harness/learning`), and the dialogue induces scripts from the model's answers and
promotes them after shadow checks (`@harness/dialogue`). Neither changes the harness's own
configuration: its prompts, thresholds and procedures, all of which are data here
(`packages/*/data/*.json`). Xia et al., "RRSI: Regularized Recursive Self-Improvement of
Agent Harnesses" (arXiv:2609.24972, September 2026; code at google-research/rrsi) evolves
a harness against a task suite and argues that the search must be *regularized*, or it
memorizes the suite. Should the harness evolve its data this way, and if so, is the
paper's method sound enough to adopt as published?

## What the paper does

A round drafts m candidate harnesses (LLM proposer, edits in git worktrees), screens them
with a leakage critic, evaluates each on the full evolve set with k trials, and accepts
at most one. Regularization acts on the search, not on what the harness may contain:

| Paper | Its code | Here |
|---|---|---|
| Annealed edit budget b_t (Eq. 4) | `schedule.py` | `editBudget` (RS3.1), unchanged |
| Edit history L_t in the proposer's context | `history.py` | `ledger.ts`, with three-valued verdicts (RS7.1, RS7.6) |
| Stall flag and reserved exploration slots | `history.py: stall_flag, exploration` | both: `paperStall` (RS7.4) and `stalled` (RS7.3); slots judged by the diff (RS9.5) |
| Leakage critic before evaluation | `critic.py` (regex + LLM) | `leaks` (n-gram overlap with task texts and references, RS6.1–RS6.2) + `judgeCritic` (RS12.3) |
| Noise band delta | `calibrate.py` | `noiseBand` (RS2.8–RS2.9), used only by the paper's rule |
| Floor S' >= S* - delta, cost rule, within-band rule, argmax | `selection.py` | `paperDecision`, `choose(…, "score")` (RS8.1) |
| Prune set B_t by component yield | `history.py: prune_set` | `componentYield` (RS7.5), paper's rule only |
| Novelty bonus nu | `components.py: novelty` | paper's rule only |

The loop, the ledger, the budget and the exploration directive are good ideas and are
kept. The selection side is where the paper's claims live ("a noise-adjusted floor blocks
gains within evaluation variance", "removes changes that are too small, too expensive, or
no longer useful"), and it does not do what it says. Each point below is checked by a test
or by arithmetic on the paper's own numbers.

## Critique

### The noise band measures the wrong noise

delta is z = 2 standard deviations of the score difference between two evaluations of the
*same harness on the same tasks* (`calibrate.py`; the bootstrap resamples trials within
each task, tasks fixed). That is re-measurement noise. The paper's claim is transfer, and
the noise that decides transfer is which tasks were sampled. With the task set fixed, a
+1 on two tasks and a +0.1 on twenty tasks are the same 0.02 gain against the same delta
(RS2.2, RS2.9): the first is exactly the "fit to the evolve set" the paper sets out to
prevent, and its own rule cannot tell it from a mechanism (RS9.11: accepted under the
coding instance's delta, refused here). Tasks are also clustered (Harvey LAB's 120 evolve
tasks span 25 practice areas); a gain in one area is evidence about one area (RS2.3).

### Inside the band, the rule admits noise, and its acceptance region is not monotone

For a candidate whose gain is within delta, Algorithm 2 applies
`w_s ΔS − w_c ΔC + w_n ν > 0`. With the workspace instance's weights (w_s = 1414,
w_c = 15), any positive point gain at unchanged cost is admitted, however small: that is
admission *by* the within-band fluctuation the section says it guards against (RS8.3). The
two branches also disagree at the boundary. Engineering (delta 0.020, w_s = 244,
w_c = 2): a gain of 0.019 may add up to 232% more tokens, while a gain of 0.021 is capped at
66%; workspace: 0.0039 may add 37%, 0.0041 is capped at 24.5% (RS8.2). A smaller gain buys
a larger cost allowance. The coding instance (w_s = 0) admits a slightly *worse*
candidate, up to delta below S*, for touching a structural component type never
accepted before (RS8.3): a complexity bonus inside the rule meant to charge for
complexity.

### The incumbent's score is the luckiest draw of its round

When a candidate wins, its selection-round evaluation becomes the incumbent's score
(`loop.py`: the frontier's incumbent `job` is the winner's; `incumbent_eval` loads it next
round), and S* is the running max of those. The winner of m noisy measurements is biased
upward (the winner's curse), so every later Delta S is taken against an inflated
reference and the floor ratchets on luck.

### No error control across the run

Each acceptance is a one-sided z = 2 test (about 2.3% false gains), repeated for m = 2
candidates over T = 20 rounds: 40 tests, with no correction (1 − 0.977^40 ≈ 60% chance of
at least one false out-of-band gain, before the within-band branch adds its own). We ran the
paper's rule through whole runs where no candidate has any effect (RS10.2; 40 seeded runs
of 10 rounds, 60 tasks, delta calibrated as the paper does):

| Rule | Runs that accept a change | Incumbent's recorded score minus its true score |
|---|---|---|
| Paper, workspace weights | 33 / 40 | +3.4 points |
| Paper, coding weights | 10 / 40 | +1.6 points |
| Calibrated (below), alpha = 0.1 | 2 / 40 | +0.02 points |

The workspace instance's inflation under the null (+3.4 points) is three times the whole
evolve-set gain the paper reports for that instance (+1.1 on Harvey LAB).

### Adaptivity is cited, not handled

The paper names the problem correctly: the evolve set is reused adaptively (Dwork et al.
2015), and the proposer reads the evolve set's trajectories. Dwork et al.'s remedy is a
holdout queried through a mechanism (Thresholdout) that keeps it valid under adaptive
reuse. The search uses neither; the only in-search defense against fitting is the
critic, which can catch copied names and values but not a rule tuned to the suite's habits
that copies no words.

### Credit and pruning are assigned to the wrong things

- Bundled edits all inherit their candidate's Delta S (`history.py`), so a harmful edit
  bundled with a strong one early (b_t up to 4) carries positive credit.
- g_t(l) is the *max* Delta S over a window: the more often the proposer tried a component,
  the higher its max by chance, so a component is less likely to be pruned for being tried
  more.
- B_t = {l : g_t(l) <= 0} uses 0, not the noise band that governs every other decision.
- Most importantly, B_t prunes a component *type* because recent *new* edits of that type
  failed, and tells the proposer to delete the *accepted* machinery of that type
  (`propose.py`: "remove the accepted machinery listed"). Whether new prompt edits help says
  nothing about whether the prompt text already accepted still earns its place. That is a
  question about each accepted mechanism's marginal contribution now, which only removing
  it and measuring answers (ablation).
- The history stores point gains and tells the proposer "a rejected mechanism is negative
  evidence; do not redraw it unchanged" (`propose.py`). A gain inside the noise is
  absence of evidence, not a falsification.

### Smaller points

- The L0 budget counts the edits the proposer *declares*; whether they are independent is
  left to the LLM critic, and one declared edit can be any size.
- The cost rule is relative to the incumbent, so allowances compound round after round;
  the final harness uses 55% more tokens than H_0 (2.42M vs 1.56M per trial, Table 2).
- The regularization analogies are inconsistent: Figure 2 labels complexity-aware
  acceptance "L1-style" and pruning "L0-style"; Section 3.1 calls them Ridge/L2 and
  Lasso/L1; the code calls the cost rule the "L1 cost rule" (`config.py`). A linear hurdle
  on cost is a budget constraint (an incremental cost-effectiveness threshold), not a norm
  penalty.
- "Entropy regularization" for exploration: U_t = K \ T_t empties for good once each of
  the nine component types has one measured edit. That is coverage, not entropy.
- The proposer, analyst and critic are the same model; a critic that shares the
  proposer's blind spots screens little.

### The evaluation cannot carry its claims

Every arm is one run; the variance of the search itself, across seeds, is never measured,
and no result has an interval. Against sampling error alone, the out-of-distribution gains
are about one standard error: SWE-bench Verified +1.8 on 500 tasks (unpaired SE of a
difference about 2.4 points), GDPval +3.5 on 185 tasks (about 5.2), APEX-Agents +3.7 on
480 (about 3.1). Paired analyses would be tighter, but none is reported. The ablation's
out-of-distribution differences (1.6 to 2.6 points) have no intervals, and "no held-out
split regresses anywhere" is not evidence at these sizes. The abstract's "up to 14.1
points" is the Gemini 3.5 Flash coding run; the headline experiments (Opus 4.8) gain at
most 6.0.

There is also a power floor the paper never meets. We measured what a correctly
calibrated rule can certify in one 20-round run at family-wise alpha = 0.1 (60 tests), 20
seeded runs per cell (RS10.3 pins the last row):

| Evolve tasks (k = 2) | True gain | Spread | Accepted |
|---|---|---|---|
| 60 | +20 points | +1 on 20% of tasks | 10 / 20 |
| 60 | +10 points | +0.25 on 40% | 4 / 20 |
| 240 | +10 points | +1 on 10% | 19 / 20 |
| 240 | +5 points | +0.125 on 40% | 12 / 20 |
| 240 | +10 points | +0.25 on 40% | 19 / 20 |

At the paper's evolve-set sizes (61 to 120 tasks), per-edit gains of 1 to 4 points, which is
what it accepts (Table 6: +3.93, and 6 passes of 244), are below what the data can certify
under any controlled error rate. Its rule accepts them because it controls no error
rate.

## Decision

`@harness/evolution` (pure) runs the paper's loop over a surface of JSON and text
documents, with the selection side replaced, and the paper's rule kept beside it (`select.rule: "paper"`)
so a run can reproduce the paper and the two can be compared (RS10.2, RS9.10–RS9.11).

- **The harness is data, edited by JSON Patch.** A surface names documents and their zod
  schemas; a candidate is edits, each a JSON Patch with its hypothesis
  (`fast-json-patch` applies and diffs them). What the paper takes on the proposer's word is
  computed: edits touching the same part are one edit, so the L0 count is real (RS5.3); a
  change's components come from the paths it changed, not from its tag (RS5.1, RS5.6); a
  document its schema refuses is the liveness failure (RS5.4); every accepted edit keeps
  its inverse, so it can be taken out again (RS5.5).
- **Code is a surface too: text documents.** A source file is a document of `kind: "text"`,
  edited by `edit` ops (`old` must occur exactly once, as in the reference implementation's
  `edit_file`). Independence is computed from the character ranges the edits occupy
  (touching is not overlapping; an edit that depends on another's output is not
  independent), the footprint is the changed lines, the host's `check` (it parses, it
  compiles) is the liveness test and also runs on the base harness, `classifyText` maps a
  changed region to a component, an inverse carries the least surrounding context that
  makes a repeated or deleted text findable again, and the leakage screen reads the text
  an edit adds. Ablation and entanglement work as for JSON (RS13.1–RS13.43).
- **Paired, same-window measurement.** Each round evaluates the incumbent again with the
  candidates. Its evidence is what was measured *after* it was chosen, never the
  measurement it won on, which removes the winner's curse (RS9.2, RS10.1). Earlier fresh
  measurements are pooled only into the reported estimate.
- **Acceptance by an inverted randomization test.** Under the null that candidate and
  incumbent are the same harness, which produced which measurement of a task is
  exchangeable, so groups of tasks flip the signs of their differences. The test is exact
  whatever the reward distribution, however few tasks are informative, and with ties.
  Inverted under a shift model, its bounds are quantiles of the weighted mean difference of
  randomly flipped groups: closed form, no search (`compare`, RS2.1–RS2.7). Tasks are the
  unit, groups when tasks name them, so the bounds carry task sampling as well as trial
  noise.
- **A run-wide error rate.** Every acceptance test gets alpha / (T (m + 1)), a union bound
  valid under the arbitrary dependence an adaptive search has (RS3.2). The cost is power,
  stated in the table above and chosen in data (`select.alpha`, `rounds`, `trials`).
- **The error budget can be spent front-loaded, and must be spendable.** `select.spending`
  is `uniform` (equal shares) or `geometric` (round t gets alpha ratio^t / sum ratio^s,
  split among the round's tests). Both are functions of (round, rounds, tests) alone and
  add up to alpha, so the union bound holds (RS14.1–RS14.9, and as a property RS14.20–22).
  Geometric moves power from late rounds to early ones: measured at n = 240 and a +0.05
  gain, a gain proposed in round 0 is certified 48.5% of the time against 38% uniform, and
  one proposed in round 15 30% against 38% (RS14.70–RS14.71). It is deliberately not
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
  them. Measured on the study world: 0 null acceptances in 40 runs with it (2 without,
  RS14.60); bad candidates (harm 0.2) abandoned 331 of 400 times with 18.8% fewer tasks
  evaluated overall, about a third fewer counting only candidates (RS14.61); a real +0.05
  gain abandoned in 0 of 300 runs (RS14.62). Ablations are never staged. What is not
  claimed: a paired power comparison, since staging changes which random trials each
  candidate gets.
- **Gains, savings and removals are different claims.** A change is a gain only when its
  lower bound is above zero, and its added cost must be paid for by that lower bound, not
  the point estimate (RS8.4). Anything else, a saving of at least `saving` or a removal, is
  a non-inferiority claim: lower bound at least −margin, with the losses of such steps
  since the last supported gain within the margin in total. That keeps what the paper's
  floor was for (no walking downhill by small steps) without a reference that ratchets on
  luck (RS8.5–RS8.6). Cost is also capped against H_0, so allowances do not compound
  (RS8.7). There is no novelty bonus: exploration is the proposer's job (reserved slots),
  not a reason to accept.
- **The winner has the best evidence,** the highest lower bound, not the highest point
  estimate (RS8.9).
- **Pruning by ablation.** Each round, the accepted mechanism with the weakest evidence
  that is due is removed in a candidate of its own; the removal is accepted when it is
  non-inferior, and otherwise the mechanism stays. This is backward elimination with a
  non-inferiority test, per mechanism, in the current harness (RS9.6). A mechanism a later edit rewrote is entangled and is no
  longer removed on its own (RS9.7).
- **A reusable holdout.** When the split has a holdout, a gain accepted on the evolve set
  is confirmed through Thresholdout: the evolve set's answer stands while the holdout
  agrees within a noisy threshold; a disagreement spends budget and answers with the
  holdout's noisy value. A spent holdout confirms nothing, which ends a run's gains
  honestly (RS4.1–RS4.4, RS9.8–RS9.9).
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
  request, and never over files that changed since the run started (EH1.1–EH12.x, and end
  to end with a real child-process evaluator and a holdout, EH10.1). The proposer and the
  critic are gateway models, or the critic is the ensemble's judge.
- **Models are AI SDK models.** The proposer is `generateText` constrained to the proposal's
  JSON Schema; the critic is `experimental_evaluate` (RS12.1–RS12.3). Settings, prompts
  included, are data with a generated schema (`packages/evolution/data/settings.json`,
  RS11.1–RS11.2).

## How the rule got here

Two earlier versions of the calibrated rule failed their own guarantee, and the tests
caught it. A two-stage bootstrap (tasks, then trials within tasks) counted trial noise
twice, since each task's observed difference already carries it (Davison and Hinkley 1997,
sec. 3.8), and cost power. The one-stage percentile bootstrap that replaced it accepted a
change in 7 of 40 null runs, against a promised 10% at most, because its far tail is too
thin when few tasks carry the signal. The randomization test is exact by construction:
2 of 40 (RS10.1). RS10.1 is kept as a regression test for that reason.

## Consequences

- A run on an evolve set the size of the paper's will accept few changes, and only large,
  broad ones. That is what such a set can support. To accept smaller gains, use more tasks
  (the table), fewer rounds, or a larger alpha, all in data.
- Each round costs one more evaluation than the paper's (the incumbent again), plus the
  ablation candidate, plus the winner on the holdout.
- The evolve set must have enough groups. A suite of a few dozen tasks each in its own
  group is enough for a short run; a suite whose tasks fall into four practice areas is not,
  and the run says so before spending anything.
- Each evaluation is a child process the host spawns; the harness under test runs with
  the host's authority. Evolving code that runs code is the operator's sandbox decision,
  as it is for any harness session.

## Limits, and what was decided against

None of these is scheduled work; each is either outside what a library over an evaluator
port can do, or a decision.

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
- **Transfer.** The guarantee is about the evolve set's distribution: a supported gain is
  a gain on new tasks of that kind. Whether a harness evolved on one suite helps on another
  is an empirical question that needs real suites, real models and several seeds of the
  whole search, with intervals; nothing in this repository can settle it, and the paper's
  numbers do not settle it either (see the critique).
