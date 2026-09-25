# 0005: The Vercel AI SDK is the model and agent layer

Status: decided, 2026-09-25.

## Question

We had our own model ports (`Generator`, `GenerateRequest`, `ChatMessage`, `Embedder`,
`Judge`, `ToolRouter`, `DocumentParser`), our own chat message and event types, our own
test fakes, and workers with their own turn loops. AI SDK 7 already defines all of this,
and a way to provide our own implementations. Should we keep ours?

## Decision

No: every model is an AI SDK model, and every agent is an AI SDK agent.

- **Models.** Generators, tool routers and document parsers are `LanguageModelV4`s;
  embedding models are `EmbeddingModelV4`s; judges are `EvaluationModelV4`s. A provider's
  model is an ensemble member as is. Our local models (transformers.js vision chat, the
  steerable ONNX kernel, Cactus WASM, prompted embedders) implement the same specs
  (`@harness/models`, `localLanguageModel`). Prompt compression has no AI SDK model kind,
  so the `Compressor` port stays ours.
- **The ensemble is an AI SDK provider.** `languageModel(task)`, `embeddingModel()`,
  `evaluationModel()` and `provider()` (usable in `createProviderRegistry`) return models
  whose calls go to the best member, lazily loaded, with failover. Consumers call
  `generateText`, `streamText`, `embedMany`, `experimental_evaluate` and `Output.object`
  like any AI SDK code.
- **Our settings are provider options.** What the AI SDK has a setting for goes there (a
  JSON Schema is `responseFormat`, via `Output.object`). The rest travels under the
  `harness` provider-options key: grammar, regex and template constraints, embedding kinds
  and sizes. A steered model's behavior state changes are custom content parts
  (`harness.state`). A router's calibrated confidence is `providerMetadata.harness.confidence`.
- **Workers run agents.** `AgentWorker` runs any AI SDK `Agent`; `sessionAgent` builds a
  `ToolLoopAgent` whose instructions carry learning's playbook and recalled memories.
  Tool approvals (`toolApproval`) become the daemon's permission requests.
- **Tests use `ai/test`** (`MockLanguageModelV4`, `MockEmbeddingModelV4`,
  `Experimental_EvaluationMockModelV4`). Our contract suites drive models through AI SDK
  functions.
- **Middleware for cross-cutting behavior.** A document parser's trained instruction is
  `pageInstruction` middleware on the model (`wrapLanguageModel`).

## What stays ours, and why

- The ACP daemon core (sessions that outlive clients, the grant tree, callback routing,
  input leases, hooks and sagas): the AI SDK has no multiplexing daemon.
- SAE steering and behavior graphs: they need the residual stream, which no provider exposes.
- Token-level constrained decoding (XGrammar) in our local decoders: providers enforce a
  JSON response format at most.
- Benchmark-based selection and the tool cascade: the AI SDK's `customProvider` maps ids to
  models but does not rank, fail over, or verify.
- Learning (lessons, the capability ladder).

## Consequences

- Swapping in any AI SDK provider's model, middleware or agent needs no adapter.
- AI SDK calls add their own validation: tool calls are checked against their JSON Schema
  (zod), evaluation answers against their question types (an unusable judge answer counts
  as no), structured output against its schema.
- The AI SDK does not cancel a model's stream when its consumer stops reading, so a caller
  stops a call by aborting it; our local models stop decoding on abort.
- Harness adapters, sandboxes, code mode and durable workflows (`@ai-sdk/harness`,
  `@ai-sdk/code-mode`, `@ai-sdk/workflow`) are the next layer to adopt in place of our own.

## Revisit when

- The AI SDK adds a compression model kind, a ranking/failover provider, or residual access.
