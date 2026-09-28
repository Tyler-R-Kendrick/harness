# 0012: Answers from templates first: decide, fill, and generate only what cannot be decided

## Context

The harness exists to spend less inference over time. The playground (ADR 0011) did the
opposite: every `/ask` went to a model, and when the page could reach Claude it switched
to Claude on its own. Most requests a person makes again (list the files, show a file,
run a command, today's date) have answers whose shape is fixed and whose variable parts
the harness already knows, can read from the request, or can pick from a short list.
Deciding which shape fits is a classification, which small decision models do in
milliseconds on a CPU or WebGPU (Julia 1, CLM), and which a lexical scorer can do with no
model at all. Only the parts nobody can decide need a generator.

## Decision

- **Reply templates are files in the virtual filesystem** (`~/agent/templates/<id>.md`):
  YAML frontmatter (what the template answers and example requests, how each hole is
  filled, feedback counts, version, origin) and a body whose `{{holes}}` make it a
  template constraint of fixed text and holes (`fillTemplate`, the inverse of
  `readTemplate`, in `@harness/cognitive`). A reply template's body is the answer; a
  script template's body is a bash script run through the agent's `bash` tool and its
  approval. The person sees, edits and keeps them like any file; five seeds ship in
  `packages/playground/data/templates` (running a command, listing files, showing a file,
  the date, help).
- **A hole is filled cheapest first:** a *fact* the harness knows (the working directory,
  the files, the date, the templates, the sessions), a *pattern* in the request (the
  first group of a regular expression), a *choice* among options (listed, or a fact's
  lines) made by the decision model, or *text* a generator writes. A template may declare
  a `match` expression: a request it matches is that template's without asking the
  decision model (running `$ <command>` is such a template).
- **The decision model is an AI SDK evaluation model** (`EvaluationModelV4`): which
  template answers is a `choice` question over the candidates and `none`, answered with
  probabilities; a template answers only when its probability reaches the settings'
  threshold. More templates than a question takes are narrowed lexically first. This is
  exactly the interface of Julia 1 (`choice`, `score` and `noul` over 2 to 20 options)
  and of CLM through its judge adapter, so either drops in. Until one is loaded, the
  page uses a lexical decision model: TF-IDF cosine similarity between the request and
  each option, a fixed floor for `none`, and a softmax (`lexicalJudge`, no inference).
- **The engine's model is an AI SDK `LanguageModelV4`** (`TemplateEngine.model()`), so it
  runs in the agent worker like any model: traced, approved, kept in the conversation.
  It never generates text. It replies with a filled template, or calls a tool: `bash` for
  a script, or one of three generation tools when something cannot be decided:
  `write_template` (no template fits), `fill_template` (a chosen template's text holes
  only, under a JSON Schema of those holes, so a generator spends tokens only on the
  holes) and `refine_template` (a template rated harmful with a reason, rewritten the
  next time it is chosen; the old version kept under `.history`). A written template is
  a file, so the next similar request costs no inference.
- **Generating needs consent.** The generation tools ask for approval ("Spend inference to
  …?") unless `/generate auto`; `/generate off` turns them off, and the engine then says
  which holes or request it could not answer. Generators are tried cheapest first; in
  the page the only one is Claude through `sample`, used only this way or when a person
  picks the `claude` worker. Claude is never picked for them.
- **Feedback refines and retires.** `/rate good|bad [why]` counts the last answer's
  template helpful or harmful in its file; a reason makes it rewritten when next chosen,
  and a template harmful by the settings' margin retires to `retired/`.
- **Tuning is data:** `packages/playground/data/templates.json` (thresholds, the lexical
  model's floor, temperature and stopwords, the retire margin, the generators'
  instructions), with a JSON Schema generated from its parser.

## Consequences

- The first turn of the page, and every `$ <command>`, list-files, show-file and date
  request, runs with no inference; the timeline's model spans carry the decision
  (template, decision model, probability, where each hole came from).
- The lexical decision model is weak with paraphrases that share no words with a
  template's description or examples; a request it cannot place goes to generation (with
  consent), which adds a template that then matches such requests. Julia 1 or CLM
  replaces it without changing the engine.
- Julia 1 in the page (its ONNX export on WebGPU) is not wired in yet: its files come
  from a third party released days ago, and loading them is waiting on the owner's go-ahead.
- No local generator runs in the page yet: the browser ensemble's generator
  (Qwen3.5-0.8B on transformers.js) would be the first generator tried, before Claude.

## Revisit when

- Julia 1 is approved for the page: register it as the decision model when WebGPU is
  there, the lexical one otherwise.
- A local generator loads in the page: try it before Claude, and keep Claude for what
  it cannot write.
- Templates grow past what a 20-option question and lexical narrowing handle: narrow
  with embeddings (the memory extension's recall) instead.
