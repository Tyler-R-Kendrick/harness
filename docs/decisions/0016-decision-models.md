# 0016: Julia 1: a local decision model, on WebGPU in a page and on the CPU natively

Status: decided, 2026-09-28.

## Context

The harness exists to spend less inference over time. Its judges were Jev (hosted: a
credential and a bill), CLM (a local 8B server that zero-shot does not judge, ADR 0010)
and a generator judging (seconds a question). The playground's template engine (ADR
0014) picks templates with a lexical TF-IDF judge because nothing better ran in a page.
Its owner asked for a real decision model there, WebGPU enabled, and named Julia 1.

[Julia 1](https://huggingface.co/SupersonicLabs/Julia-1) (Supersonic Labs, Apache-2.0) is
a 144.3M-parameter decision model on mmBERT-small: a state, a question and 2 to 20 options
in, a probability per option out, for choice, ordered-score and boolean ("noul")
questions, which is the AI SDK's `EvaluationModelV4` exactly. Its repo holds PyTorch
weights and Python inference code; its publisher's
[Julia-1-ONNX](https://huggingface.co/SupersonicLabs/Julia-1-ONNX) holds the full FP32
ONNX export of the same checkpoint (both repos' provenance name the weights' sha256,
df853bf7…), 577 MB of weights, and 100 requests with the PyTorch checkpoint's logits.

Its encoding is its contract: one sequence per question (the start token, "{type}
question: {question}", a separator, each option behind the mask token, a separator, the
state, a separator), scored at the markers, with a 512-token question head, 48 tokens an
option, 8,192 in all, and strict encoding refusing what would be cut (its inference
policy). No JavaScript library runs such a model; transformers.js runs ModernBERT
encoders but not this head.

Run first with tokenizers.js (the tokenizer transformers.js uses), 98 of 100 reference
cases picked the reference's option and logits were off by up to 3.3. The ids differed:
mmBERT's tokenizer (Gemma's) is SentencePiece-style BPE with a Metaspace pre-tokenizer
that splits at every ▁ (`split: true`). tokenizers.js 0.2 (the latest) ignores `split`, so
a run of spaces merges into "▁▁" where Rust keeps "▁" then "▁word"; and after its
normalizer turns spaces into ▁, it takes a section of only ▁s for an added token of that
text although the added token is not normalized. Compared with Python's `tokenizers` on
6,000 random strings (scripts, spaces, CRLF, no-break spaces), the library's reading
differed on 1,380.

## Decision

- **A runtime for decision models, `onnxruntime-decision`, not a Julia adapter.** Its
  `run` names the files (model, weights, tokenizer.json, tokenizer config) and everything
  particular to a model as data: the question head and option templates, each question
  type's id and name, how JSON is written (Python's ", " and ": "), the limits (tokens,
  head, option, option count) and the cuts the model makes when not strict, strict or
  not, and the padding multiple. The input and output names are the runtime's contract.
  The catalog refuses an entry whose files are not in its artifact, whose type ids
  repeat, whose limits leave no room for the state, or which serves any port but the
  judge.
- **`@harness/models`: `encodeDecision` (a port of the model's `sequence()`, strict and
  not), `collateDecisions`, `OnnxDecisionSession` on onnxruntime (node or web, one
  class), and `decisionModel`**, an `EvaluationModelV4`: a call's questions go in one
  batch; answers are the softmax over each question's options (the most probable choice
  with the whole distribution, the expected score level, P(true)); choice options are
  their descriptions (the name when there is none), boolean options false then true
  (literal "false"/"true" when not described), as the model's own typed API does.
- **`faithfulTokenizer`: tokenizer.json read as Rust reads it.** When a Metaspace splits,
  the library's own pre-tokenizer is made to cut before every ▁, and a normalizer that
  only turns spaces into ▁ is dropped (the Metaspace does the same replacement after
  added tokens are matched) unless an added token is normalized. With it the 6,000 random
  strings match Python's ids exactly, and all 100 reference cases pick the reference's
  option with their logits within 7.3e-5 of PyTorch's (the export reports 7.8e-5 against
  PyTorch); RW6.3 holds the probabilities to 1e-3. Other tokenizers are read as the library reads them.
- **Julia 1 in the catalog** as `SupersonicLabs/Julia-1` (the model its owner named),
  its artifact the publisher's ONNX export pinned by revision and sha256, 614 MB. It
  serves **classification only**: its publisher says it compares the options it is
  given and does not establish knowledge or multi-step reasoning (and asked about plain
  facts it answers them wrong), so it never grades answers, and the evals keep their
  judgment models. It is first in classification's preferences: it runs on every host
  with no key, server or bill. Its benchmark rows are its publisher's (H200 BF16, and
  their CPU FP32 reproduction), on benchmarks no other model reports, so selection
  compares nothing on them.
- **Hosts.** Natively it opens from disk (onnxruntime-node finds the weights beside the
  model). In a browser its files come verified from the Cache API and its weights go to
  onnxruntime-web as external data, on WebGPU when the page has it (then WebAssembly),
  or as the host asks; a page bundled into one file says where onnxruntime-web's
  WebAssembly comes from (`onnxWasm`).
- **Verified on real weights** (`catalog.model.test.ts`, CI's `models` job): the judge
  contract; a ticket routed, reviews rated, and a boolean asked with two specific
  descriptions; and the publisher's 100 reference cases (committed with their source and
  licence, keyed by the artifact, so new weights need new references).

## Consequences

- Asked well (options that are specific descriptions), it is fast and sure: about 50 ms
  a question on a CPU. Asked badly it is sure and wrong: a catch-all option ("something
  else", "none of these") gets a very low score whatever the state, so a question with
  one leans to the other option. Callers phrase both sides.
- All 100 reference cases are choice questions: score and boolean share their encoding
  and differ only in the type id, which is checked against the model's source and on
  real weights by behavior, not against reference logits.
- A page downloads 614 MB once (kept in the Cache API), plus onnxruntime-web's 28 MB
  WebAssembly. The claude.ai artifact may not be allowed to fetch either; the page then
  says so and decides lexically. Run by hand in headless Chromium (no GPU adapter, so
  onnxruntime-web fell back to WebAssembly), the real model loaded from a local hub and
  answered in 9.6 seconds, first question included.
- A browser's storage quota can refuse a 577 MB file (headless Chromium's did). The
  artifact store now treats its cache as a saving only: a cache that cannot be read is a
  miss, one that cannot keep a file leaves the verified bytes in use, and the host hears
  why (`onCacheProblem`).

## Revisit when

- tokenizers.js splits Metaspace itself and matches Rust (TK1.1 and TK1.2 assert the
  library's own reading, so they fail when it changes): drop `faithfulTokenizer`'s fix.
- The publisher releases a quantized export: pin it for the browser (a smaller download).
- A second decision model appears: its entry, its reference cases, and preferences by
  benchmarks the two share.
