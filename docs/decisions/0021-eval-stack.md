# 0021: The eval stack is a Zod IR and a climber

Status: decided 2026-09-29.

## Question

Case generation, scoring, traces, and full-computer sandboxes already exist as
libraries. Should the harness reimplement them, wrap Harbor and ASSERT in
TypeScript, or own only the interchange and the accept rule?

## Decision

Own a small IR and the climber. Buy the rest.

`packages/ir` is the contract: a Zod spec, cases, a frozen split, trials, grader
marks, and a climb round. `packages/climb` freezes that split, takes one patch,
and accepts only when train and test both pass and nothing over-refused. Those
two policy rates stay separate. A capability spec has no over-refusal rate, so
that gate does not fire. Capability cases report pass@k: a case passes when at
least one of k trials passes, and fewer than k trials fails closed.

Promptfoo is the in-process case runner and the safety generator. Adapters write
Promptfoo YAML; they do not invent a second YAML. openevals and agentevals are
scorer functions. The judge client is ours, built on the Vercel AI SDK, so a
LangChain model wrapper is not required. agentevals still imports
`@langchain/core` to convert messages, and that package is installed for that
import alone. Spans use OpenInference semantic
conventions through `@opentelemetry/api`, `@arizeai/openinference-core`, and
`@arizeai/openinference-vercel` in front of an OTLP exporter. There is no private
span schema.

Harbor, ASSERT, and Inspect stay processes. `execa` builds their argv and the
adapters parse the artifacts they already write. They are not ported and not
wrapped. Inspect is not a default CLI command.

This is not `packages/evals`. That package still judges catalog questions and can
return `blocked`. `npm run eval` is unchanged. The new bin is `harness-eval`.

## Why npm and TypeScript 6 stay

The requested layout was pnpm workspaces and TypeScript 5.9 or newer. This repo
is already npm workspaces (`packageManager` npm, `npm ci` in CI) and TypeScript
6.0.3, which satisfies 5.9. Moving the lockfile and CI to pnpm is a separate
migration. The engine range is `>=22.22` because Promptfoo requires it. CI's
`node-version: 22` tracks the current Node 22 line, which is past that floor.
Node 24 is allowed by the same range.

## Non-goals

Mastra, DeepEval, pydantic-evals, LiteLLM-in-JS, and a hosted trace product are
not the IR. JSONL on disk is the sink. An EEE export is not defined here.
`@e2b/code-interpreter` is not installed; Harbor still owns full-computer tasks.
The climber is not an ADR 0002 code-mode workflow.
