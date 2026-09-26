# 0001: Effect (effect-ts): not adopted now

Status: decided, 2026-09-24. Revisit on the triggers below.

## Question

Should [Effect](https://effect.website) replace zod and our exception handling, or be
integrated alongside them?

## What was measured

**Versions.** `effect` 3.22.2 is the stable line (Schema built in). Effect 4 is at
4.0.0-rc.117 and renames core APIs (`Either` → `Result`, `Context.Tag` →
`Context.Service`, a new `Schema` checks and issues API). Adopting now means either the 3.x
line with a major migration ahead, or a release candidate.

**Bundle cost** (the same small graph schema, and a retry-with-fallback program with a
service layer; esbuild, minified, browser):

| | min | gzip |
|---|---|---|
| zod/mini schema | 22 KB | 7 KB |
| Effect 4 Schema | 246 KB | 75 KB |
| Effect 4 core (Layer, retry, fallback) | 109 KB | 38 KB |
| Effect 4 Schema + core | 309 KB | 97 KB |
| Effect 3 Schema + core | 411 KB | 129 KB |

zod is already in every bundle we ship: the AI SDK (`ai`, its providers) and the ACP SDK
depend on it. Effect would be added on top.

**How much of our code Effect would improve.** Effect's strengths are typed error channels,
resource scopes, interruption, retries and dependency layers. Counting those patterns in
`packages/*/src` (7,100 lines):

| package | lines | try | .catch | abort / generation / finally |
|---|---|---|---|---|
| core | 2,036 | 2 | 0 | 0 |
| cognitive | 1,616 | 6 | 0 | 3 |
| models | 1,182 | 6 | 0 | 1 |
| platform-native | 749 | 6 | 6 | 2 |
| everything else | 1,532 | 10 | 2 | 2 |

## Analysis

- **The core is a synchronous, deterministic reducer.** `Daemon.receive()` returns outputs
  and never awaits; time, randomness and storage arrive through ports, and replay and trace
  parity tests depend on that. Its request errors (23 `RpcError`s) are caught in one place
  and turned into JSON-RPC errors: a typed error channel already, without a runtime; the
  other throws are invariant violations (programmer errors). Running it on an Effect
  runtime adds a scheduler to code that must not have one.
- **Parsing is already "parse, don't validate".** zod schemas produce branded types (graphs),
  port request types are schema outputs, and zod 4 codecs cover encode/decode if we need
  it. Effect Schema does the same job at 10x the bundle cost, and the AI SDK and ACP SDK
  keep zod in the bundle anyway.
- **Where Effect would genuinely help is small.** Load cancellation in the ensemble
  (generation counters), llama-server process lifecycle, and the host's turn tracking. That
  is roughly 30 try blocks and 10 abort/cleanup sites. Converting them would put Effect in
  the middle of Promise-based libraries (AI SDK, transformers.js, onnxruntime, the ACP SDK)
  with a conversion at every port, for a modest reduction.
- **Maintainability.** Effect raises what every contributor must know, and a partial
  adoption leaves two styles of error handling and concurrency in one codebase.

## Decision

- Keep zod for parsing at boundaries (branded outputs, schema-derived port types).
- Keep exceptions, with typed error classes (`RpcError`, `CognitiveError`) caught at one
  boundary each.
- Do not add Effect.

## Revisit when

- Effect 4 ships a stable release, **and**
- a host layer grows real supervision needs: several long-lived local servers, restarts,
  timeouts and backpressure across the browser, extension and remote hosts. Scopes, fibers
  and layers would then replace more code than they add. The first candidate would be the
  host orchestration in `platform-native`, not the core.
