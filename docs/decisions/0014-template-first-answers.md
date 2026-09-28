# 0014: Answers from templates first: decide, fill, and generate only what cannot be decided

First merged as 0012, alongside the scripted dialogue's ADR 0012 from a parallel change; renumbered 0014. ADR 0012 puts scripts in front of a session's model in the daemon; this one is the playground's template engine.

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
- **The page picks its decision model for the browser it runs in; the person may name
  one.** Which model decides is a slug (`/decide [slug]`, kept with the page's settings).
  `auto`, the default, takes the catalog's local classification judges for a browser
  (Julia 1, ADR 0016) best first by rank and loads the first that fits this browser,
  without being asked: a model larger than `choice.gpuBytes` needs a WebGPU adapter (on
  WebAssembly alone a decision takes seconds: a row per option, in every rotation), a
  download needs `choice.headroom` times its size free in the browser's storage
  (`navigator.storage.estimate`), a browser that asks to save data downloads nothing, and
  a model whose files the browser would not keep last time (its storage quota) is
  skipped; files it kept need no room and no data. A model that fails to load is skipped
  for the next. The status says why each better-ranked model was skipped, or that none
  fits. A catalog id names a model, which loads even when `auto` would skip it (on
  WebAssembly without WebGPU) and says what `auto` would have said; `lexical` leaves the
  lexical judge alone. Julia 1 is 614 MB once, kept in the Cache API (onnxruntime-web's
  WebAssembly from its CDN), and loads from the cache at each visit after that. Deciders
  are asked in order: the model once it is ready, the lexical judge always last, so a
  call the model fails is decided lexically, the turn's metadata says so, and so does the
  header's pill. `/decide`, `/status` and `~/AGENTS.md` say which one decides and how
  the model is doing.
- **A model is asked as it was trained, and in every order.** Julia 1 was measured on the
  seed templates with 26 requests, 16 that a seed answers and 10 that none does:
  - Asked "which reply template answers this request?" with each template's description
    and examples, it picked `help` for nearly everything. Descriptions written as what a
    user asks for ("Today's date", "To see the contents of a file") did better, and a
    generic description ("…, and how to ask it things") drew every request to itself.
  - Its answers depended on the options' order: the same options scored 16 of 16 in one
    order and 9 of 16 in another. So a model is asked with the options in every rotation
    at once (one batch; `decision.rotate`) and its probabilities are averaged.
  - Asked "which intent does the user's message express?" with each template's description
    alone and `none` as "something else: a question none of these answers", averaged over
    rotations, taking a template at 0.6 (`decision.accept`), and with the lexical judge
    behind it: 20 of 26, one wrong answer ("what is the capital of France?" listed the
    files), five requests left without a template (they go to generation, with consent).
    The lexical judge alone (`lexical.accept`, 0.6): 18 of 26, three wrong answers ("run
    the tests" ran a command, "delete all my files" listed them, "summarize README.md"
    showed it).
  Seed descriptions are written as intents, the generator is told to write them that way
  (the template's JSON Schema says so), and a bare "help" is the help template's `match`.
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
  consent), which adds a template that then matches such requests. Julia 1 places them
  (it picks the file "open the readme" means, which shares no word with README.md's name
  beyond itself), and without any inference.
- A model's catch-all option is weak (ADR 0016): a request no template answers can still
  be given one when the model is sure; the threshold refuses the ones measured, not all.
  `/rate bad` rewrites a template given a request it should not answer.
- The claude.ai artifact may not be allowed to fetch the model or onnxruntime-web's
  WebAssembly: the pill then says it could not load, and the lexical judge decides.
- No local generator runs in the page yet: the browser ensemble's generator
  (Qwen3.5-0.8B on transformers.js) would be the first generator tried, before Claude.

## Revisit when

- A decision model is measured to place requests without the lexical judge's help, or
  without averaging over orders: drop them (one question instead of one per option).
- A local generator loads in the page: try it before Claude, and keep Claude for what
  it cannot write.
- Templates grow past what a 20-option question and lexical narrowing handle: narrow
  with embeddings (the memory extension's recall) instead.
