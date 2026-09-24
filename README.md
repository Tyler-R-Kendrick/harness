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

The daemon hosts an ensemble of models and routes each task to the best one it can run:

| Model | For | Where |
|---|---|---|
| Jev (TypeSafe) | judgments with calibrated probabilities | hosted, AI Gateway |
| Needle 3 (Cactus) | tool calling, extraction, embeddings | local WASM |
| EmbeddingGemma 300M | text embeddings | local, transformers.js |
| LLMLingua-2 | prompt compression | local, transformers.js |
| Qwen3.5 0.8B | chat and vision; the browser LLM | local, transformers.js |
| LightOnOCR-2 1B | documents, OCR, tables | local, transformers.js |
| Ornith 1.5 9B | coding, reasoning, tools | native, llama-server |
| OvisOCR2 | documents, OCR, tables (strongest) | native, llama-server |
| Qwen3 1.7B | steered chat: the local kernel | native, onnxruntime |

Models declare task categories and published benchmark results. Selection compares two
models only on benchmarks they both report with the same metric and setting, and every
choice comes with its evidence (`_harness/cognitive/status`). Weights are pinned to a
commit and verified by sha256 before use.

```sh
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci
node packages/platform-native/src/main.ts --stdio --cognitive [--llama-server /path/to/llama-server] [--no-hosted]
```

### Behavior graphs (the local kernel)

Like a game character's state machine, a behavior graph reads features of a sparse
autoencoder (SAE) from the model's residual stream and steers the next token with
others. Qwen3-1.7B's int4 export is patched once with a steering tap at layer 14, where
public SAEs exist; sensors see every prompt token, so the state changes before the reply.

```sh
node packages/platform-native/src/main.ts --stdio --cognitive \
  --behavior packages/behavior/fixtures/qwen3-1.7b-host.graph.json \
  --sae-rows packages/behavior/fixtures/qwen3-1.7b-l14-rows.json
```

With that graph an insult moves the host to `soothing` (apology steering) and happy news
to `cheerful` (joy steering); a neutral question leaves it unsteered. Steering is local
only: hosted models expose no residual stream.

Clients and plugins call `_harness/cognitive/invoke` with an `op` of `judge`, `route`,
`decide-tools`, `embed`, `compress` or `parse`; `--worker ensemble` runs sessions on the
best generator.

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
- `--worker model --model <gateway model id>`: streams a model through the
  [Vercel AI Gateway](https://vercel.com/docs/ai-gateway). Requires
  `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`.

## Evals

LLM-as-judge evals use [Jev](https://docs.typesafe.ai) (`typesafe-ai/jev`) through the
Vercel AI Gateway:

```sh
AI_GATEWAY_API_KEY=... npm run eval -- --out eval-results/results.json
```

There are two suites:
- `calibration`: checks the judge on known good and bad examples.
- `harness`: end-to-end turns through the daemon core with the deterministic echo
  worker; Jev judges the prompt round-trip, turn order and permission routing.

Jev is the only model the evals call.

Every result is `passed`, `failed`, `inconclusive` or `blocked`. A missing credential
is reported as `blocked`, never as a pass.

## Layout

| Package | Role |
|---|---|
| `packages/protocol` | ACP framing, JSON-RPC validation, `_harness` profile (pure) |
| `packages/core` | Sans-I/O daemon: sessions, subagents, routing, lease, flow control, effect ledger, capabilities, hook bus, task graph (pure) |
| `packages/cognitive` | Candidate-strategy and statistics math (pure) |
| `packages/testkit` | Deterministic ports, daemon driver, storage contract suite |
| `packages/workers` | Echo worker and model worker (portable) |
| `packages/platform-native` | Node host: stdio and socket bindings, atomic file storage, CLI |
| `packages/evals` | Jev judge, eval runner, suites, CLI |
