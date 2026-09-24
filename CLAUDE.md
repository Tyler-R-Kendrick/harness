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
| `packages/protocol` | ACP framing, JSON-RPC envelopes, `_harness` profile | pure |
| `packages/core` | sans-I/O daemon core: sessions, subagents, routing, ledger, capabilities, hooks, task graph | pure |
| `packages/cognitive` | cognitive core: model ports, task taxonomy, catalog + benchmarks, selection, ensemble, cascade | pure |
| `packages/behavior` | behavior state graphs over SAE features: parsing, packs, the engine | pure |
| `packages/memory` | memory as a cognitive-core extension: its embedding model, vector recall (Orama), session memory | pure |
| `packages/testkit` | deterministic ports and reusable contract suites | pure |
| `packages/workers` | session workers: echo (deterministic), model (AI SDK / AI Gateway), ensemble (cognitive core) | portable |
| `packages/models` | model adapters: Jev, Needle 3 (WASM), transformers.js models, llama-server models | portable |
| `packages/platform-native` | Node host: stdio/socket ACP bindings, atomic file storage, model files and llama-server, CLI | host |
| `packages/evals` | eval runner; Jev (`typesafe-ai/jev` via Vercel AI Gateway) as judge | host |

`tools/model-lab` holds offline Python tools that produce files the product loads (steerable
exports, SAE rows); nothing in `packages/` imports it.

"Pure" packages may not use host globals, Node builtins, `Date.now`, `new Date()` or
`Math.random`; ESLint enforces this and their tsconfig has no DOM/Node types. Time,
randomness, storage and transport arrive through ports. Do not weaken these rules to
make something compile; add a port instead.

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
- Evals (`packages/evals`): LLM-as-judge with Jev. Results are `passed`, `failed`,
  `inconclusive` or `blocked`; a missing credential is `blocked`, never a pass.

Gates, all required before pushing:

```sh
npm run typecheck
npm run lint
npm run test:coverage   # coverage thresholds in vitest.config.ts
npm run test:mutation   # Stryker; `break` threshold in stryker.config.mjs
npm run test:models     # when touching packages/models or the catalog
```

Benchmark results live in compact tables we own and edit by hand
(`packages/cognitive/src/benchmark-table.ts`, and memory's own): one
`model|task|benchmark|metric|score|setting` row each, `<n` for lower-is-better. They are
compared only when benchmark, metric and setting match.

Never lower a coverage or mutation threshold, skip a test, or add a production mock to
get green. Kill surviving mutants with tests, or document why a mutant is equivalent.

## Shell note

This environment may export a malformed `NODE_OPTIONS`; prefix commands with
`NODE_OPTIONS=--max-old-space-size=8192` if node refuses to start.
