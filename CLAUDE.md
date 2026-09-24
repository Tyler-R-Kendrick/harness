# harness

A daemon that multiplexes agent sessions. One portable core runs on every hosting
platform (native background service, browser extension, browser tab/PWA, remote API).
Every client, plugin and peer daemon talks to it over ACP. Plugins are external actors
that react to broadcast hook events and coordinate as sagas.

Feature scope and status: `docs/features.md`. Update it in the same change as the code.

## Layout

| Package | Role | Purity |
|---|---|---|
| `packages/protocol` | ACP framing, JSON-RPC envelopes, `_harness` profile | pure |
| `packages/core` | sans-I/O daemon core: sessions, subagents, routing, ledger, capabilities, hooks, task graph | pure |
| `packages/cognitive` | cognitive core: candidate strategies, statistical math, model ports | pure |
| `packages/testkit` | deterministic ports and reusable contract suites | pure |
| `packages/workers` | session workers: echo (deterministic) and model (AI SDK / AI Gateway) | portable |
| `packages/platform-native` | Node host: stdio/socket ACP bindings, atomic file storage, CLI | host |
| `packages/evals` | eval runner; Jev (`typesafe-ai/jev` via Vercel AI Gateway) as judge | host |

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
- Evals (`packages/evals/cases`): LLM-as-judge with Jev. Results are `passed`, `failed`,
  `inconclusive` or `blocked`; a missing credential is `blocked`, never a pass.

Gates, all required before pushing:

```sh
npm run typecheck
npm run lint
npm run test:coverage   # coverage thresholds in vitest.config.ts
npm run test:mutation   # Stryker; `break` threshold in stryker.config.mjs
```

Never lower a coverage or mutation threshold, skip a test, or add a production mock to
get green. Kill surviving mutants with tests, or document why a mutant is equivalent.

## Shell note

This environment may export a malformed `NODE_OPTIONS`; prefix commands with
`NODE_OPTIONS=--max-old-space-size=8192` if node refuses to start.
