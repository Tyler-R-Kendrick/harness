# harness

A daemon that multiplexes agent sessions. One portable core runs on every hosting
platform. Every client, plugin and peer daemon talks to it over the
[Agent Client Protocol](https://agentclientprotocol.com), and plugins extend it by
reacting to its hook events as saga-style actors.

Status of every feature: [`docs/features.md`](docs/features.md). Development rules: [`CLAUDE.md`](CLAUDE.md).

## What works today

- **Sessions outlive clients.** Start a turn, disconnect, reconnect from any client
  and replay the session from any offset with no gaps or duplicates.
- **Many clients per session.** Observers see each other's prompts. Permission
  requests go only to approvers; the first answer wins and the others are withdrawn.
- **Humans stay in control.** A human takes the input floor from an agent; agents can
  never take it from a human.
- **Slow clients don't stall anyone.** Flow control per client falls back to a snapshot.
- **Restarts lose nothing.** State is snapshotted atomically, and interrupted turns are marked.
- **Plugins.** External actors subscribe to durable hook events with at-least-once delivery.
- **Capabilities.** Clients can offer and withdraw capabilities at runtime.
- **Stock ACP clients work**, verified with the official ACP SDK client.

## Cognitive core

The daemon hosts an ensemble of models and routes each task to the best one it can run.
No code names a model: code is written per model category (judges, tool routers,
embedders, compressors, generators, document parsers) and per runtime (AI Gateway,
TypeSafe-API servers, Cactus WASM, transformers.js, llama.cpp-server, a steerable ONNX
kernel). Which models exist, how each runtime runs them (`run`), and a category's
settings (an embedder's prompts and sizes, a compressor's window) are catalog data in
`packages/cognitive/data/catalog.json`, so a model is swapped by editing JSON.

Every model is a [Vercel AI SDK](https://ai-sdk.dev) model (`LanguageModelV4`,
`EmbeddingModelV4`, `EvaluationModelV4`), and the ensemble is an AI SDK provider: code
calls `generateText`, `streamText`, `embedMany` or `experimental_evaluate` on
`ensemble.languageModel("chat")`, `ensemble.embeddingModel()` or
`ensemble.evaluationModel()`, and each call goes to the best member that can serve it,
failing over to the next. Any AI SDK provider's model can be a member, and our local
models implement the same specs. Sessions run AI SDK agents (see ADR 0005).

The shipped catalog currently lists:

| Model | Category | Runtime |
|---|---|---|
| Jev (TypeSafe) | judge | hosted, AI Gateway |
| CLM 8B (Contrastive-LM) | judge (the local fallback without a key or budget) | TypeSafe-API server (clm-serve) |
| Needle 3 (Cactus) | tool router | Cactus WASM |
| LLMLingua-2 | compressor | transformers.js |
| Qwen3.5 0.8B | generator with vision; the browser LLM | transformers.js |
| LightOnOCR-2 1B | document parser | transformers.js |
| Ornith 1.5 9B | generator (coding, reasoning, tools) | llama.cpp-server |
| OvisOCR2 | document parser | llama.cpp-server |
| Qwen3 1.7B | steered generator: the local kernel | onnxruntime (steerable) |

Models declare task categories and published benchmark results. Selection compares two
models only on benchmarks they both report with the same metric and setting, and every
choice comes with its evidence (`_harness/cognitive/status`). Weights are pinned to a
commit and verified by sha256 before use.

```sh
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci
node packages/platform-native/src/main.ts --stdio --cognitive [--llama-server /path/to/llama-server] [--no-hosted]
```

### Memory (an extension)

The core carries no embedding model. Memory brings its own (listed in
`packages/memory/data/catalog.json`; EmbeddingGemma 300M today) when it is installed, and the daemon then offers `memory` and `cognitive.text-embedding` in its
capability registry. Clients call `memory.remember` and `memory.recall` through
`_harness/cognitive/invoke`; the ensemble worker's agent is given related memories from
other sessions on each turn, and the turn is remembered afterwards. The index is Orama (pure JS),
saved to a file:

```sh
node packages/platform-native/src/main.ts --stdio --worker ensemble --memory ~/.harness/memory.json
```

### Learning (an extension on memory)

Learning distils lessons from sessions (insights, strategies, procedures, pitfalls) with a
reflection model, edits them incrementally, merges duplicates and retires lessons that
mislead, then puts the related ones before the model on later turns. For a new task it
climbs a ladder: do it natively if the model knows how; else use a tool it has (offered,
discovered, or built earlier); else build one if it knows how and a tool-building plugin
is installed; else ask to be taught. Plugins that clients bring turn lessons into agent
skills, workflows or tools, and teachers turn a recording of a person doing the task
into a demonstration. Operations are `learning.*` through `_harness/cognitive/invoke`;
thresholds and prompts are in `packages/learning/data/settings.json`.

```sh
node packages/platform-native/src/main.ts --stdio --worker ensemble \
  --memory ~/.harness/memory.json --learning ~/.harness/learning.json --workflows ~/.harness/workflows
```

With `--workflows`, learning ships four plugins. The workflow builder compiles learned
procedures into deterministic workflow code. The skill builder writes an agent skill that
runs such a workflow. The tool builder has a model write a tool as workflow code (code mode),
checked before it is kept. The recording teacher turns transcripts, input events and screen
frames into demonstrations. Workflows run durably in AI SDK code mode: every tool call and
model question is journaled, so an interrupted run resumes where it stopped. Session agents
get the library's workflows as tools.

```sh
harness-workflow run path/to/skill/workflow.json --run first-try --input '{"env":"staging"}'
```

### Behavior graphs (the local kernel)

Like a game character's state machine, a behavior graph reads features of a sparse
autoencoder (SAE) from the model's residual stream and steers the next token with
others. The kernel's ONNX export is patched once with the steering tap its catalog entry
names (for the shipped kernel, layer 14, where public SAEs exist); sensors see every
prompt token, so the state changes before the reply.

```sh
node packages/platform-native/src/main.ts --stdio --cognitive \
  --behavior packages/behavior/fixtures/qwen3-1.7b-host.graph.json \
  --sae-rows packages/behavior/fixtures/qwen3-1.7b-l14-rows.json
```

With that graph an insult moves the host to `soothing` (apology steering) and happy news
to `cheerful` (joy steering); a neutral question leaves it unsteered. Steering is local
only: hosted models expose no residual stream.

Clients and plugins call `_harness/cognitive/invoke` with an `op` of `judge`, `route`,
`decide-tools`, `embed`, `compress` or `parse`; `--worker ensemble` runs each session as
an AI SDK agent on the ensemble.

## Quick start

Requires Node 22.18+ (TypeScript runs directly, no build step).

```sh
npm ci
npm run check            # typecheck, lint, tests with coverage thresholds
npm run test:mutation    # Stryker mutation testing
```

Run the daemon as a background service on a user-private socket:

```sh
node packages/platform-native/src/main.ts --socket ~/.harness.sock --state ~/.harness/state.json
```

Or register it with an ACP-capable editor as an agent command. The editor launches it
over stdio:

```sh
node packages/platform-native/src/main.ts --stdio --state ~/.harness/state.json
```

Workers:

- `--worker echo` (default): deterministic; add `!permission` to a prompt to exercise
  permission routing.
- `--worker model --model <gateway model id>`: runs each session as an AI SDK agent on
  a model through the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway). Requires
  `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`.
- `--worker ensemble`: runs each session as an AI SDK agent on the ensemble (the steered
  kernel when a behavior pack is given), with memory and learning when installed. Tools
  that need approval go through the daemon's permission routing.

## Evals

LLM-as-judge evals use the best judge the host can reach: the catalog's judgment models
in preference order, each tried until one loads. With the shipped catalog that is
[Jev](https://docs.typesafe.ai) through the Vercel AI Gateway when there is a gateway
credential, else [CLM](https://github.com/Contrastive-LM/CLM) when its `clm-serve` answers
(it speaks TypeSafe's API, so the same AI SDK provider talks to both). The report names
the judge that answered.

```sh
AI_GATEWAY_API_KEY=... npm run eval -- --out eval-results/results.json
# or, with clm-serve running (CLM_BASE_URL, default http://127.0.0.1:8700):
npm run eval -- --out eval-results/results.json
```

There are two suites:
- `calibration`: checks the judge on known good and bad examples.
- `harness`: end-to-end turns through the daemon core with the deterministic echo
  worker; the judge checks the prompt round-trip, turn order and permission routing.

The judge is the only model the evals call. In the daemon too, judgment fails over to
the next judge when one cannot load (no credential, server down) or its service becomes
unavailable (out of budget, unauthorized, down).

Every result is `passed`, `failed`, `inconclusive` or `blocked`. No reachable judge is
reported as `blocked`, never as a pass.

## Layout

| Package | Role |
|---|---|
| `packages/protocol` | JSON-RPC validation for the pure core, ACP names from the official SDK, `_harness` profile (pure) |
| `packages/core` | Sans-I/O daemon: sessions, subagents, routing, lease, flow control, effect ledger, capabilities, hook bus, task graph (pure) |
| `packages/cognitive` | The ensemble as an AI SDK provider, task taxonomy, catalog, selection, tool cascade, statistics (pure) |
| `packages/testkit` | Deterministic ports, AI SDK model fakes, daemon driver, contract suites |
| `packages/workers` | Echo worker, and a worker that runs any AI SDK agent (portable) |
| `packages/platform-native` | Node host: stdio and socket bindings, atomic file storage, CLI |
| `packages/evals` | eval runner (the best reachable judge from the catalog), suites, CLI |
| `packages/memory` | Memory extension: embedding models, vector recall, session memory (pure) |
| `packages/learning` | Learning extension on memory: lessons from sessions, capability ladder, plugin contracts (pure) |
| `packages/workflows` | Durable workflows as code: AI SDK code mode, journaled tool calls, library, extension (Node) |
| `packages/learning-plugins` | Workflow, skill and tool builders, and the recording teacher (portable) |
