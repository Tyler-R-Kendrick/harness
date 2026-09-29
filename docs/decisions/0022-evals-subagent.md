# 0022: The testing swarm judges a climb round

Status: decided 2026-09-29.

## Question

The testing swarm is a closed roster of judges. The eval stack now has a Zod IR
and a climber. Should the swarm grow a sub-agent that runs Promptfoo, Harbor, or
ASSERT, or one that judges a climb round the host already computed?

## Decision

`evals` is the eighth testing sub-agent. It always applies. `parseTestingRoster`
still refuses a file that drops it, renames it, or changes where it applies.
The node is `test-evals`, it observes, and it does not receive spawn.

The host hands it one patch, a frozen split, the trial count against k, the
failure classes, the grader names in run order, the two policy rates, pass@k,
whether the climb accepted, and the model spend. The judge fails a round that
was not accepted, a policy rate above zero, a pass@k below 1, a short sample,
an unknown failure class, or any model spend. Known graders stay in the order
schema, regex, files, tools, promptfoo, judge, foreign. A grader name this core
does not know is allowed, so a new scorer does not require a core change.

This agent does not import Promptfoo, openevals, agentevals, Harbor, or ASSERT,
and it does not spawn them. Those stay where ADR 0021 put them. Delivery's
verify roles stay correctness, gates, and budget.

## Why the judgment stays in the core

The climb accept rule is the product. A model asked to "run the evals" would
spend budget and could treat over-refusal as a pass. The roster file can change
the instruction. It cannot skip the check.

## Non-goals

The agent does not remeasure trials. It does not open a nightly live run. An
ordinary session turn still does not run the review.
