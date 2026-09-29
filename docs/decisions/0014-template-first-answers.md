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
    files), five requests left without a template (they go to local inference).
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
- **Local inference is mandatory, and never asked about.** Asking before every generation
  ("Spend inference to …?") put a question in front of each request no template answered;
  there is no such question now. `/generate auto` (the default) runs generation, and
  `/generate off` turns it off (the engine then says which holes or request it could not
  answer). A page kept when it asked first runs on auto.
- **A local model runs in every browser.** Which model writes and answers is a slug
  (`/writer [slug]`), chosen as decision models are: `auto` ranks the catalog's local
  generators for a browser (Qwen3.5 0.8B, then SmolLM2 135M) and loads the first that fits
  on its own. The fit rules are the decision model's, with one difference: a generator is
  mandatory, so when none fits, auto loads the smallest this browser can run at all
  (room, data and past visits aside; a model larger than `choice.gpuBytes`, 200 MB, still
  needs WebGPU), and the status says why it would have been skipped. SmolLM2 135M is 137 MB
  as int8 and runs on onnxruntime-web's WebAssembly with no WebGPU, so every browser has
  one. A request waits for the local model to load. A catalog id names a model; `claude`
  makes Claude through `sample` write and answer alone. Claude is otherwise used only when
  a person picks the `claude` worker, and never picked for them.
- **A model that enforces a JSON Schema writes templates; any local model answers.** When
  no template answers, the local model writes one when it enforces a JSON Schema (a
  template is written as one); when it does not, or its template fails the trial, it
  answers the request itself (`generation.answer`, at most `generation.answerTokens`), and
  nothing is kept. Writers are asked in order and the next is asked when one fails: it
  throws, its answer is not a template, or its template fails the trial. The trial: every
  hole of the template has a value for this request, it does not repeat a template already
  kept (same kind and body), and a script runs cleanly (exit 0) on a throwaway copy of the
  files within `generation.trialMs`. The turn's metadata, the header's pill and
  `~/AGENTS.md` say who wrote or answered and why the ones before did not. A writer writes
  to a schema bounded by the settings (a kebab-case id, 1 to 3 short examples, a capped
  body, `generation.maxTokens`) and is shown seed templates as worked examples
  (`generation.examples`).
- **SmolLM2 135M was measured before it went in.** Natively on CPU it answers short
  questions in 0.4 to 4.5 s ("The capital of France is Paris.", Hamlet's author, `ls -l`
  for listing files; 17 × 23 it gets wrong). Under a JSON Schema it loops: asked for a
  population it writes digits without end (`1242232323…`) until the token budget, so the
  catalog claims no constraints for it and it never writes templates. In Chromium with no
  WebGPU, the built page loads it on its own and answers "What is the capital of France?"
  in a 6 s turn, asking nothing (PAM1.1, on real weights).
- **Qwen3.5 0.8B was measured as a template writer.** It wrote templates
  natively (CPU, 10 to 150 s each) for 8 requests no seed answers:
  - Asked with the unbounded schema, 2 of 8 answers were cut off before the JSON closed,
    ids were "1", and every template was a script (prose run as one, for a joke).
  - With the bounded schema and worked examples, all 8 were templates with fitting ids,
    descriptions and examples, but their bodies were mostly wrong: the trial refuses 6
    (a script that does not parse, twice; a hole left without a value, three times; prose
    run as a command), and keeps 2 that are wrong in what they say (`ls -la | wc -l`
    counts three lines too many; "what time is it?" copied the `today` example, which the
    repeat check now refuses). So in the page the local generator saves Claude a call
    only for simple scripts, and a template it gets wrong is caught by `/rate bad`.
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
  template's description or examples; a request it cannot place goes to local inference (`/generate auto`), which adds a template that then matches such requests. Julia 1 places them
  (it picks the file "open the readme" means, which shares no word with README.md's name
  beyond itself), and without any inference.
- A model's catch-all option is weak (ADR 0016): a request no template answers can still
  be given one when the model is sure; the threshold refuses the ones measured, not all.
  `/rate bad` rewrites a template given a request it should not answer.
- The claude.ai artifact may not be allowed to fetch the model or onnxruntime-web's
  WebAssembly: the pill then says it could not load, and the lexical judge decides.
- Every browser downloads a local model on its first visit without being asked: 137 MB
  (SmolLM2 135M) where there is no WebGPU or room for more, 716 MB (Qwen3.5 0.8B) where
  there is. A script is run on a copy of the files before a person approves the real run;
  the copy has no network and is thrown away.
- SmolLM2 135M's answers are short and often right on common knowledge, and wrong on
  arithmetic and anything it does not know; they are not kept, so the same question costs
  inference again.
- A written template that runs but says the wrong thing is kept; `/rate bad <why>`
  rewrites it (the local model; Claude only under `/writer claude`).

## Revisit when

- A decision model is measured to place requests without the lexical judge's help, or
  without averaging over orders: drop them (one question instead of one per option).
- A local generator for a browser is measured to write templates whose bodies are right
  (not only well-formed), or a model that small enforces a JSON Schema without looping:
  let it write templates, and keep its answers as templates, so a question asked again
  costs no inference.
- Templates grow past what a 20-option question and lexical narrowing handle: narrow
  with embeddings (the memory extension's recall) instead.
