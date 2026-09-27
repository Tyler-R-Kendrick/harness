# 0010: A generator as the judge of last resort

## Context

Evals are judged by the best judgment model the catalog can reach: Jev through the AI
Gateway, else CLM through its own server. CI has neither: no gateway credential, and no
CLM server. So every CI eval was `blocked`, which is honest but tells nothing.

CLM was then run live for the first time: `clm-serve` on CPU, its Qwen3-8B encoder
served by llama-server (`--embeddings --pooling last`, Q8_0). It is reachable this way,
and our adapter's answers match CLM's own client exactly. But zero-shot it does not
judge the calibration cases: 17 + 25 = 42 gets P(correct) 0.32 and 43 gets 0.56, and 2
of 7 conclusive cases pass. The model card says as much: its published numbers are for
fine-tuned verifier heads. Wiring it into CI would trade `blocked` for failures that
describe the judge, not the harness.

CI's models job already runs a general-purpose generator (Ornith 1.5 9B on llama-server).
Asked for a letter straight away, it judges the calibration cases backwards: "42" is
false with P 0.96 and "43" is true with P 0.94, whatever the prompt's wording. Its first
token is a reflex ("No." to "is 17 + 25 equal to 42?"), which the rest of its answer then
corrects. Given room to reason first, it judges them right: "42" gets P(correct) 0.96,
"43" 0.007, and the ticket goes to billing with P 0.997. The AI SDK has evaluation
models (`EvaluationModelV4`) but nothing that makes one of a language model.

## Decision

- **`generatorJudge(model)` (`@harness/models`): any AI SDK language model as an
  evaluation model.** Each question goes to the model with the state and its options as
  letters (true/false, each choice, each score level). The model first reasons briefly
  (a bounded, unconstrained call), then is asked for the letter alone, constrained to
  one letter with a JSON Schema enum, which every generator that enforces constraints
  follows. Both calls go through `generateText`. The reasoning costs about 20 seconds a
  question on CI's CPU, which the evals (about 20 questions) can afford.
- **Probabilities from token probabilities.** A call asks for the top tokens at each
  position (`withLogprobs`, our provider option); a model that can reports them as
  provider metadata (`harness.logprobs`). The judge reads the distribution over the
  answer letters at the first answer position, renormalized. llama-server reports them
  (its OpenAI-compatible `logprobs`, surfaced through the provider's metadata extractor).
  A model that reports none is taken at its word, with a warning.
- **A generator that judges is a catalog entry with the `judge` port and the
  `judgment` task**, ranked after Jev and CLM, so it judges only when neither is
  reachable. Ornith is that entry; no judgment benchmark is published for it, which its
  notes say.
- **CI's evals job runs llama-server** with the models job's cached weights, so the
  evals are judged: by Jev if a gateway credential is ever set, else by the generator.
  The real-weights tests hold a generator judge to the judge contract and to calibrated
  answers on real weights.

## Consequences

- CI evals are judged instead of `blocked`, by a model whose judgments are checked on
  real weights (RW6.1).
- A question costs two calls and a few sentences of generation. Locally the default evals
  (calibration and harness, nine cases) take about four minutes on CPU and all pass.
- A weaker judge reads questions more literally, or less: Ornith took "does `reply`
  contain the full text of `prompt`" to mean "equal". Eval questions state the property
  exactly ("appears in `reply` as a substring"), which every judge reads the same way.
- A generator's letter probabilities are a model's confidence in a letter after its
  reasoning, not a calibrated judgment model's; the evals' pass and fail thresholds (0.8 and 0.5) leave a
  band for uncertainty either way.

## Revisit when

- The AI SDK can make an evaluation model of a language model: use it.
- A judgment benchmark covers a local model: rank it by that, not by preference order.
- A CLM checkpoint judges zero-shot, or a fine-tuned head is published: it can take the
  local slot.
