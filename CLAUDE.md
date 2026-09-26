# harness

A daemon that multiplexes agent sessions. One portable core runs on every hosting
platform (native background service, browser extension, browser tab/PWA, remote API).
Every client, plugin and peer daemon talks to it over ACP. Plugins are external actors
that react to broadcast hook events and coordinate as sagas.

Feature scope and status: `docs/features.md`. Update it in the same change as the code.
Architecture decisions and when to revisit them: `docs/decisions/`.

## Layout

| Package | Role | Purity |
|---|---|---|
| `packages/protocol` | JSON-RPC envelopes for the pure core, ACP names from the official SDK, `_harness` profile | pure |
| `packages/core` | sans-I/O daemon core: sessions, subagents, routing, ledger, capabilities, hooks, task graph | pure |
| `packages/cognitive` | cognitive core: the ensemble as an AI SDK provider, task taxonomy, catalog + benchmarks, selection, cascade | pure |
| `packages/behavior` | behavior state graphs over SAE features: parsing, packs, the engine | pure |
| `packages/memory` | memory as a cognitive-core extension: its embedding model, vector recall (Orama), session memory | pure |
| `packages/learning` | learning extension on memory: lessons from sessions, capability ladder, plugin contracts | pure |
| `packages/workflows` | durable workflows as code: AI SDK code mode, journaled tool calls, library, extension, workflows as AI SDK tools | host (Node) |
| `packages/learning-plugins` | workflow, skill and tool builders (all run durable workflows), recording teacher | portable |
| `packages/constrained` | constrained decoding on XGrammar(-2): token masks, templates, jump-forward | portable |
| `packages/testkit` | deterministic ports, AI SDK model fakes (on `ai/test`), a scripted AI SDK harness, and reusable contract suites | pure |
| `packages/workers` | session workers: echo (deterministic), and any AI SDK agent (`AgentWorker`, `sessionAgent`), including AI SDK harnesses (`harnessSessions`) | portable |
| `packages/client` | the daemon as an AI SDK harness (`daemonHarness`, a `HarnessV1` adapter over ACP) | portable |
| `packages/models` | adapters per model category and runtime: evaluation judges, Cactus WASM, transformers.js, llama-server, steerable ONNX | portable |
| `packages/platform-native` | Node host: stdio/socket ACP bindings, atomic file storage, model files and llama-server, CLI | host |
| `packages/evals` | eval runner; the best reachable judgment model from the catalog as judge | host |

`tools/model-lab` holds offline Python tools that produce files the product loads (steerable
exports, SAE rows); nothing in `packages/` imports it.

"Pure" packages may not use host globals, Node builtins, `Date.now`, `new Date()` or
`Math.random`; ESLint enforces this and their tsconfig has no DOM/Node types. Time,
randomness, storage and transport arrive through ports. Do not weaken these rules to
make something compile; add a port instead.

Values with invariants are refined types, made only by parsing: `Probability`,
`Similarity`, `Bytes`, `Dimensions`, `Sha256`, `CommitSha` (`packages/cognitive/src/units.ts`),
branded policies and packs, and template-literal ids (`MemoryId`, `LessonId`). Construct
them with their constructor or schema; ESLint forbids casting to them. When a new value
has an invariant (a range, a unit, a format), give it a refined type rather than
checking it where it is used.

Use the Vercel AI SDK (and other trusted libraries) rather than our own versions of what
they provide. Every model is an AI SDK model (`LanguageModelV4`, `EmbeddingModelV4`,
`EvaluationModelV4`); call models through `generateText`, `streamText`, `embedMany` and
`experimental_evaluate`; agents are AI SDK `Agent`s; test with `ai/test` mocks. Our own
settings on a call are provider options under `harness` (`packages/cognitive/src/options.ts`).
Write our own code only for what no library does (the ACP daemon core, SAE steering, token
masks), and say why in an ADR.

When a model's answer has a known shape, send a constraint with the request (JSON Schema,
grammar, regex, or a template of fixed text and holes) rather than asking in prose and
parsing hopefully: generators that enforce it spend tokens only on the holes.

Node runs TypeScript directly (type stripping), so source must be erasable syntax only:
no enums, namespaces, parameter properties or decorators. Import siblings with `.ts`.

## Test-driven development (required)

1. Write the failing test first and run it to see it fail for the expected reason.
2. Write the minimum code to pass. Refactor with tests green.
3. Every behavior needs an atomic test named by an assertion ID, e.g.
   `it("MX3.2 a late second answer is rejected", ...)`.

Test kinds (filename suffix decides the kind):

- `*.test.ts`: atomic unit tests, one behavior each.
- `*.property.test.ts`: fast-check properties/fuzzing. Model-based tests for state machines.
- `*.contract.test.ts`: a suite from `@harness/testkit` run against every implementation of a port.
- `*.integration.test.ts`: real processes and transports (e.g. the official ACP SDK client
  talking to the native host over stdio).
- `*.model.test.ts`: real model weights (pinned, sha256-verified, cached under
  `HARNESS_MODEL_CACHE`). Run with `npm run test:models`; CI runs them in the `models` job.
  Required when you change a model adapter or the catalog. Install with
  `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` to avoid onnxruntime's CUDA download.
- Evals (`packages/evals`): LLM-as-judge with the catalog's best reachable judge. Results
  are `passed`, `failed`, `inconclusive` or `blocked`; no reachable judge is `blocked`,
  never a pass.

Gates, all required before pushing:

```sh
npm run typecheck
npm run lint
npm run test:coverage   # coverage thresholds in vitest.config.ts
npm run test:mutation   # Stryker; `break` threshold in stryker.config.mjs
npm run test:models     # when touching packages/models or the catalog
```

Anything we tune by hand is data, never code: a JSON file with a `$schema` pointing at a
JSON Schema generated from the zod schema that parses it (a test fails if they drift),
loaded by the host at runtime. The model catalog, task preferences and benchmark results
are `packages/cognitive/data/{catalog,benchmarks}.json` (and each extension's own
`data/`); behavior graphs name `packages/behavior/data/graph.schema.json`. Benchmark rows
are `[model, task, benchmark, metric, score, "higher"|"lower", setting?]` and are compared
only when benchmark, metric and setting match.

No code is model specific, tests included. Models will be swapped: code is written per
model category (judge, router, embedder, compressor, generator, document parser) and per
runtime. Everything particular to a model (ids, file names, prompts, dimensions, chat
template options, tap nodes, env names) is catalog data, read from the model's entry, and
tests pick models by runtime or port, never by id.

Never lower a coverage or mutation threshold, skip a test, or add a production mock to
get green. Kill surviving mutants with tests, or document why a mutant is equivalent.

## Shell note

This environment may export a malformed `NODE_OPTIONS`; prefix commands with
`NODE_OPTIONS=--max-old-space-size=8192` if node refuses to start.
