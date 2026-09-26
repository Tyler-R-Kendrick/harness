# Feature status

Every feature in scope, with its status. Update this file in the same change as the code.

- **built**: implemented, with the listed tests (IDs are test names) passing in CI
- **partial**: some of the behavior exists; the gap is stated
- **not started**

A built library that the daemon does not call yet says so; it is not an end-to-end feature.

## A. Identity and state model

| Feature | Status | Evidence / gap |
|---|---|---|
| Distinct opaque ids, validated at runtime by kind | built | ID1–ID3 (`core/ids.ts`) |
| External ids mapped, never substituted | partial | ACP request ids stay connection-local (`hr-*`); no provider/tracker id mapping yet |
| Pinned resolution of mutable names | not started | |
| Requested / accepted / effective configuration | not started | |
| Capability descriptors: declared vs tested vs enforced | not started | |
| Evidence invalidation when assumptions change | not started | |
| One enforceable owner per scope, epochs/fencing | partial | Effect ledger epochs (EF1.4), input lease epochs (MX7), capability lease epochs (CAP2); no cross-daemon session ownership |

## B. Session multiplexing

| Feature | Status | Evidence / gap |
|---|---|---|
| Create, list, load, attach, detach sessions | built | DM2.1, DM2.10, MX1.1–MX1.7, NS2.1 |
| Fork and close sessions | not started | Tree supports closing a subtree (ST3.3); no ACP `session/fork` or `session/close` |
| Subagent tree; roles are grants; grants narrow down the tree | built | ST1–ST5 |
| Humans as subagent nodes | built | Connection nodes carry the platform identity kind (MX7.14) |
| Ordered, durable, resumable session log; snapshot + replay | built | SL1–SL4, MX1.1, MX1.2, NS2.1 |
| Callback routing to approvers; first answer wins; no auto-approve | built | MX3.1–MX3.24, NS1.2 |
| Input lease; humans preempt agents, never humans | built | MX7.1–MX7.14 |
| Per-client flow control with snapshot resync | built | MX2.1–MX2.14 |
| Metadata-only subscriptions for offscreen sessions | not started | |
| Human-readable addressing | not started | |
| Detach vs close vs cancel vs handoff kept distinct | partial | Detach and cancel are distinct (MX1.6, DM2.8); no close or handoff yet |
| Late events cannot reach the wrong turn or session | built | DM2.7 |
| Team sharing (invite, grant/revoke control) | not started | Attach is owner-only (MX1.3) |
| Attention/review inbox | not started | |

## C. Workers and harness coordination

| Feature | Status | Evidence / gap |
|---|---|---|
| In-process agent runtime: an AI SDK `ToolLoopAgent` on any model (e.g. Vercel AI Gateway) through the agent worker | built | AW1.1–AW1.12; CLI `--worker model` |
| Deterministic echo worker (tests/demos) | built | WK1.1–WK1.7 |
| SDK harness and ACP-agent workers: any AI SDK `HarnessAgent` (Claude Code, Codex, or any ACP agent through `@ai-sdk/harness-acp`) runs through the agent worker via `harnessSessions`: one harness session per daemon session, started on its first turn, given only each turn's new prompt; its calls of host tools run on the host, tool approvals go through the daemon's permission flow, cancel aborts the turn | partial | HS1.1–HS1.9, TH1.1–TH1.4; not wired into the native host yet (the ACP bridge needs a sandbox with an exposed port; no trusted local provider yet); harness sessions are not resumed across daemon restarts |
| Native CLI and UHP workers | not started | |
| Integration modes (integrated/cooperative/opaque) declared | not started | |
| Kernels (interactive, deterministic graph, durable runtime) | not started | |
| Account instances, install/update ownership, readiness | not started | |
| Per-dispatch model/effort | not started | |
| Queue vs steer vs interrupt vs cancel | partial | Cancel built (DM2.8, WK1.5, AW1.5, AW1.11); one prompt at a time (DM2.5); no queue/steer |
| Replay-safe prompt submission | not started | |
| Questions with native option ids; stale answers rejected | built | Via ACP permission requests (MX3.2, MX3.15, MX3.22) |
| Durable addressed messaging between workers | not started | |
| Dispatch-specific completion (idle is not done) | built | Turn ids gate worker events (DM2.7) |
| Restore modes kept distinct | partial | Restart marks interrupted turns (MX5.1); no native resume/handoff |
| Rewind, goal mode, nested orchestrator budgets | not started | |

## D. Task graph and orchestration

| Feature | Status | Evidence / gap |
|---|---|---|
| Typed nodes and edges; all/any/quorum joins; sealed fan-out | built (library) | TG1–TG4; not yet driven by the daemon |
| Resource-aware scheduler; exclusion edges; cancellation is not rollback | built (library) | TG3.1–TG3.6, TG4.1 |
| Every invocation as a durable task | not started | |
| Task system of record (local, GitHub, Linear, Jira) | not started | |
| Compiler (known workflows) and planner (novel parts) | not started | |
| Budgets across descendants | not started | |
| Triggers and automation | not started | |
| Workspaces (worktrees, resources, review, cleanup) | not started | |

## E. Durability and effects

| Feature | Status | Evidence / gap |
|---|---|---|
| Effect ledger: intent first, logical effect ids, outcome-unknown, reconciliation, fencing | built (library) | EF1–EF5 (fault-injection property); workers do not route external effects through it yet |
| Snapshot storage port with shared contract suite | built | SC1–SC6 against MemoryStorage and FileStorage |
| Atomic file storage (native) | built | FS1.1–FS1.3, NS1.3, NS2.4 |
| Browser (OPFS/IndexedDB) and remote storage | not started | |
| Suspend anywhere; durable timers | partial | Snapshot/restore after every change (MX5.1, NS2.4); timers are not durable |

## F. Authority, security and privacy

| Feature | Status | Evidence / gap |
|---|---|---|
| Trusted identity from the platform; peer cannot assert it | built | `Daemon.connect` identity; NS2.3 (socket is owner-only) |
| Effective authority as an intersection of grants | partial | Session owner principal plus node grants; no workspace/platform grant layers |
| Approvals bound to exact operations | partial | Options are bound to the request (MX3.5, MX3.16); no argument binding |
| Dynamic capability registry: runtime add/revoke, leases, events | built | CAP1–CAP3, DM6.1–DM6.3, DM7.3 |
| Secrets port; information-flow labels; egress policy; safe mode | not started | |

## G. Cognitive core

The daemon's model ensemble. Models are mapped to task categories and to published benchmarks; selection compares models only on benchmarks they share (same metric and setting) and explains every choice.

| Feature | Status | Evidence / gap |
|---|---|---|
| Models are AI SDK models (Vercel AI SDK 7): generators, tool routers and document parsers are `LanguageModelV4`s, embedders `EmbeddingModelV4`s, judges `EvaluationModelV4`s; any provider's model is a member as is, and our local models implement the same specs (compression, which the AI SDK has no model kind for, is our one port). Our settings travel as provider options (`harness.*`): constraints, embedding kinds and sizes, and a steered model's behavior states as custom stream parts | built | `cognitive/ports.ts`, `options.ts`, `stream-parts.ts`; OP1.1–OP1.4, SP1.1–SP1.6; contract suites JC, RC, EC, CC, GC, DC drive models through `generateText`, `streamText`, `embedMany` and `experimental_evaluate`, against `ai/test` mocks and real adapters |
| Task taxonomy mapped to ports (15 categories, including `steered-chat`) | built | `TASK_CATEGORIES`, `TASK_PORTS`; CT1.1, CT1.9 |
| Refined types (parse, don't validate, in the type system): probabilities, similarities, bytes, embedding dimensions, sha256 and commit hashes are branded units made only by parsing (`units.ts`); cascade thresholds are a branded policy with verify <= act; memory and lesson ids are template-literal types (`m${number}`, `l${number}`), so one cannot stand in for the other; judge answers and router confidences are parsed where they enter an adapter; casting to a refined type is a lint error everywhere, tests included | built | UN1.1–UN1.3, UN2.1 (the lint rule), CA1.9, EV1.3, ADR 0003 |
| Model catalog, preferences and benchmarks as data: JSON files (`packages/cognitive/data`, one set per extension) with generated JSON Schemas, loaded by the host at runtime and parsed (pinned commits, sha256 weights, ports serving tasks, benchmark rows naming models) | built | CT1.1–CT1.3, CT1.10, CH1.1; 9 models (below) |
| Model-agnostic code: adapters per category (judge, router, embedder, compressor, generator, document parser) and runtime (`ai-gateway`, `typesafe-api`, `cactus-wasm`, `transformers.js`, `llama.cpp-server`, `onnxruntime`); each entry's `run` settings and category settings (embedding prompts and sizes, compression window and subword style) are catalog data, parsed per runtime; category settings come exactly with their port | built | CT1.8, CH1.1–CH3.2, EA1.x, LA1.x, ND1.8, TB2.x; tests pick models by runtime or port, never by id |
| Benchmark-driven selection with head-to-head records, curated tie-breaks, explanations | built | SE1.1–SE1.8, SE2.1–SE2.2 (property), CT1.7, CH1.3 |
| Ensemble as an AI SDK provider: `languageModel(task)`, `embeddingModel()`, `evaluationModel()` and `provider()` (for `createProviderRegistry`); each call goes to the best member, loaded lazily, and fails over to the next-ranked; the member that served is named in the `x-harness-model` response header; runtime revoke/restore and state events | built | EN1.1–EN1.13 |
| Tool-call cascade: router → judge on middling confidence → generator, traced; calls through `generateText`, validated by the AI SDK against each tool's JSON Schema (zod); an unusable judge answer counts as p=0 | built | CA1.1–CA1.9, CA2.1–CA2.6; live: the router decides and is accepted (cognitive.tool-decision subject) |
| Token-classification compression: word scoring (WordPiece or SentencePiece subwords), rate threshold, windowing (pure) | built | LL1.1–LL2.1, LA1.1–LA1.3 |
| Embedding prompts from the model's templates, and Matryoshka truncation to its sizes | built | EG1.1–EG2.2, EA1.1–EA1.2 |
| ChatML / qwen3_xml streaming parser | built | QF1–QF2, QF3.1 (any chunking = whole parse) |
| Failover on calls: a member whose service is unavailable (HTTP status other than 400/422, or retryable) is taken out and the next member answers; streams and embeddings fail over when a member cannot start the call | built | EN3.1–EN3.4 |
| Capabilities mirrored from the ensemble (`cognitive.<task>`, plus each installed extension's id) | built | CM1.1, EN2.4, NH2.1, DM9.7 |
| Extensions: models and `<extension>.<op>` operations installed and removed at runtime; the daemon admits an extension's operations only while its capability is offered | built | EN2.1–EN2.4, CS3.1, DM9.12 |
| ACP `_harness/cognitive/invoke` and `/status` | built | DM9.1–DM9.11, CS1.1–CS1.6, CS2.1–CS2.5, NH2.1–NH2.2 |
| Agent worker: any AI SDK `Agent` as a session worker (a `ToolLoopAgent` from `sessionAgent` over the ensemble, or over a gateway model); it keeps each session's conversation, streams text, reasoning and tool calls as ACP updates, and turns with images go to the vision model | built | AW1.1–AW1.6, AW1.9, AW1.12; CLI `--worker ensemble`, `--worker model` |
| Candidate-strategy math (coverage, attempts, voting, precision, mixtures, Wilson) | built | AM1–AM5 |
| Local kernel: steerable ONNX (residual tap + steering input spliced into the graph, tap and decoder shape from the catalog), KV-cached decode loop, steering hook per token | built | OS1.1–OS1.4, OR1.x, SG1.1–SG1.10, SK1.1–SK1.3, CH2.5; real Qwen3-1.7B: zero steering is bit-identical, residual moves by exactly the vector (KS1.4, `check_steerable.py`) |
| Behavior state graphs over SAE features: sensors with hysteresis and hold, nested states with summed steering, priority/specificity transitions, host events, snapshots, replay | built | `packages/behavior`; BV1–BV2, BE1–BE3, BP1–BP2, property tests |
| SAE rows files: only the rows a graph uses, cut from a full SAE (`tools/model-lab/sae_rows.py`), b_dec folded into the bias | built | SR1.1–SR2.1; fixture: 6 labelled features of adamkarvonen/qwen3-1.7b-saes layer 14 (MIT) |
| Behavior graph driving the real kernel: the prompt is sensed token by token (skipping the attention sink), so the state changes before the reply | built | KS1.2 insult → `soothing`, KS1.3 happy news → `cheerful` (reply changes), KS1.4 neutral → no change; fixture `qwen3-1.7b-host.graph.json` |
| Behavior per session (state in the session log, transitions as hook events, plugins raising events) | not started | The native host runs one optional pack for the kernel (`behavior` option) |
| Remote models as retrieval for the steered local kernel | not started | Steering is local only: hosted APIs expose no residual stream |
| Steerable kernel in the browser (onnxruntime-web) | not started | Native only; the int4 export's contrib ops are unverified on web |
| Browser host for the ensemble (Cache API/OPFS byte cache, WebGPU) | not started | Adapters are browser-ready (transformers.js, Cactus WASM); no browser platform layer yet |
| Tool use through the daemon's permission flow: a tool that needs approval (AI SDK `toolApproval`) becomes a permission request routed to the session's approvers, and their answer continues the turn | built | AW1.10–AW1.11 |
| Execution configurations, performance registry learned from our own runs, value of information | not started | Selection uses published benchmarks only |
| Constrained decoding (the capability slot): a call can carry a constraint (a JSON Schema through the AI SDK's structured output, or a grammar, regex, or template of fixed text and holes that reads back into its holes, as `harness` provider options); the catalog says which generators enforce which kinds, and the ensemble sends a constrained call to those first | built | CN1.1–CN1.2, EN1.12, OP1.1–OP1.2, CT1.11 |
| Constraint engine on XGrammar(-2) (`@harness/constrained`, WebAssembly, portable): token masks per step, templates as XGrammar-2 structural tags, jump-forward text, compiled once per constraint; a grammar XGrammar cannot parse is an error and the engine recovers on a fresh instance | built | CD1.1–CD1.7 |
| Enforced where decoding happens: the steerable kernel's own loop masks every step and feeds forced text in one pass (jump-forward, never sampled); transformers.js generators mask through a logits processor; llama.cpp-server gets JSON Schema as structured output | built | SG2.1–SG2.3, TB2.7, TB3.3, LS1.5, CH2.7; real weights RW4.4–RW4.5 |
| Templates for answers: learning's reflection asks for its JSON Schema; the tool builder answers in a template whose code scaffold is fixed (the model writes the name, description, parameters and body); workflows ask with `ctx.ask(prompt, constraint)` | built | LN1.2, LP4.1–LP4.6, WF1.12 |
| Planning; agents; improvement loops | not started | |

### Ensemble members (the shipped catalog; data, not code)

Every native local model is tested on real weights by `catalog.model.test.ts`, by its category: routers RW1.1–RW1.3, embedders RW2.1, compressors RW3.1, chat generators RW4.1–RW4.3 (tools and vision when its tasks say so), document parsers RW5.1, each with its port's contract suite.

| Model | Tasks | Runs | Verified on real weights |
|---|---|---|---|
| Jev 1.13 (TypeSafe AI) | judgment, classification | hosted (AI Gateway) | evals (live run: calibration 5/5) |
| CLM 8B v0.1 (Contrastive-LM) | judgment, classification: Jev's local fallback | clm-serve (TypeSafe's API; Qwen3-8B encoder), native | CL1.1–CL1.2 against clm-serve's wire format; CH2.2; not yet run against a live clm-serve (needs its encoder on a GPU) |
| Needle 3 (Cactus Compute) | tool calling, extraction, classification | Cactus WASM, native + browser | RW1.1–RW1.3 + router contract |
| EmbeddingGemma 300M (brought by memory, not in the core catalog) | text embeddings | transformers.js, native + browser | RW2.1 + embedder contract (768/512/256/128), MM1.1 |
| LLMLingua-2 (mBERT) | prompt compression | transformers.js, native + browser | RW3.1 + compressor contract |
| Qwen3.5 0.8B | chat, reasoning, tools, extraction, vision QA, OCR, documents, charts | transformers.js, native + browser (the browser LLM) | RW4.1–RW4.3 + generator contract |
| LightOnOCR-2 1B | OCR, document parsing, tables | transformers.js, native + browser | RW5.1 + document-parser contract |
| Ornith 1.5 9B | chat, reasoning, coding, tools | llama.cpp-server, native only | RW4.1–RW4.2 + generator contract, CI `models` job only (llama.cpp releases are not reachable from this dev sandbox) |
| OvisOCR2 | OCR, document parsing, tables | llama.cpp-server, native only | RW5.1 + document-parser contract, CI `models` job only |
| Qwen3 1.7B (steerable kernel) | steered chat | onnxruntime, native only; patched at layer 14 on first use | KS1.1–KS1.4 + generator contract |

## H. Knowledge modeling

| Feature | Status | Evidence / gap |
|---|---|---|
| Memory as a cognitive-core extension (`@harness/memory`): brings the embedding model; the core has none of its own; the index size is the largest size its embedding models share | built | MX1.1, MX2.1–MX2.2, CH1.1, CH3.1–CH3.2 |
| Vector memory: remember text (as documents), recall by meaning (as queries), per-session and per-kind filters, forgetting (ids never reused), JSON save/restore; Orama index, pure JS on every platform | built | ME1.1–ME1.6; real weights MM1.1 |
| ACP `memory.remember` / `memory.recall` through `_harness/cognitive/invoke` | built | MX1.2–MX1.3, DM9.12 |
| Session memory: each turn gets related memories from other sessions (in the agent's instructions) and is remembered afterwards | built | AW1.7; CLI `--worker ensemble --memory <file>` |
| Extension dependencies: an extension installs only after the ones it requires, serves only while they serve, and cannot be uninstalled before its dependents | built | EN2.5–EN2.6, LX1.1 |
| Learning as an extension on memory (`@harness/learning`): no models of its own; thinks with the ensemble's generator, judge and router | built | LX1.1–LX1.2, CH3.3; CLI `--memory <file> --learning <file>` (NS1.4) |
| Lessons from sessions: a reflection distils insights, strategies, procedures and pitfalls from successes and failures (ExpeL, ReasoningBank) and edits the lesson set incrementally, add/refine/helpful/harmful (ACE deltas); edits to lessons it was not shown and malformed output are rejected with reasons | built | LN1.1–LN1.5 |
| Curation: a new lesson that says what an old one says merges into it; lessons that mislead more than they help are retired; consolidation merges near-duplicates learned apart; feedback from outside a reflection | built | LN1.3–LN1.4, LN1.6, LN1.8 |
| Lessons inform later sessions: recalled by meaning (through memory) as a playbook, put in the agent's instructions on each turn | built | LN1.1, AW1.8 |
| Capability ladder: native (judge: can it do this without tools?) → a tool it has (offered, found by client discovery, or built and learned earlier; router with confidence) → build one (judge: does it know how? and a tool-building plugin) → ask to be taught (listing what teachers can observe); every rung's decision kept as evidence, and a missing judge or router is "unknown", not a guess | built | LD1.1–LD1.6 |
| Learning plugins: materializers turn lessons into agent skills, workflows, tools (code mode) or any client-defined target, and lessons remember what was made; teachers translate a recording (screen, audio, events, transcript, whatever the client can observe) into a demonstration that is learned from | built | PL1.1–PL1.3, LD1.6; shipped plugins below |
| Workflow builder: learned procedures compile deterministically to workflow code (a step the router fits calls that tool; other steps ask the model with the purpose, guidance, input and results so far), kept in the workflow library | built | LP2.1–LP2.4 (`@harness/learning-plugins`) |
| Skill builder: an agent skill (SKILL.md with name/description frontmatter within the spec's limits) whose procedure is a durable workflow it tells the agent to run and resume; `harnessSkill` gives it as an AI SDK harness skill (`{ name, description, content, files }`, what `HarnessAgent` takes) | built | LP3.1–LP3.4 |
| Tool builder (code mode): a model writes the tool as a code-mode program composing the available tools and model questions; each draft is checked (it parses, and calls only tools that exist) and failures go back to the model; the tool is learned and runs as a durable workflow | built | LP4.1–LP4.6, CH3.4 |
| Recording teacher: transcripts and input events (commands, tool calls, clicks, keystrokes) translate deterministically; screen frames are described by a vision model | built | LP5.1–LP5.3; audio needs a transcript until the core has a speech-to-text category |
| Durable workflows as code (`@harness/workflows`): workflow code is a code-mode program run by AI SDK code mode (`@ai-sdk/code-mode`: QuickJS in a worker, no host access, time, memory and stack limits); every call (`tools.<name>(args)`, `tools.ask({ prompt, constraint })`) is journaled before the code sees it, numbered in the order the code makes it (so parallel calls replay), so an interrupted run resumes by replay and a finished run returns its result; a failed effect stops the run at once (the code cannot swallow it); a call that does not match its journal entry is refused, never performed again | built | WF1.1–WF1.13; ADR 0002 |
| Workflow library and host: workflows kept by name (one file each natively, run journals beside them), other workflows and the host's AI SDK tools callable from the code (nested durable runs), `workflows.list/get/run` through the cognitive invoke operation, `harness-workflow run <file> --run <id>` CLI; the library's workflows are AI SDK tools for session agents (`workflowTools`: a call runs its workflow durably under the call's id), refreshed each turn as learning adds to it | built | WH1.1–WH1.8, WX1.1–WX1.2, WC1.1–WC1.2, CH3.4, AW1.13; CLI `--workflows <dir>` |
| Learning settings (thresholds, prompts) as data with a generated JSON Schema | built | LS1.1–LS1.2; `packages/learning/data/settings.json` |
| Plugins offered by ACP clients (bridged over the capability registry), automatic reflection when a session ends, lesson and plugin evals on real models, client tools inside workflows | not started | Plugins are in-process today; sessions are observed through `learning.observe`; workflow tools are library workflows and the AI SDK tools the host passes |
| Record kinds, orthogonal fields, facets, lineage, snapshots, compaction, code intelligence, standards | not started | |

## I. Tools, environments and action

| Feature | Status | Evidence / gap |
|---|---|---|
| Tool registry, MCP, VFS, terminals, action interfaces, reverse execution, factory, generated clients, robotics | not started | |

## J. Hooks and plugin actors

| Feature | Status | Evidence / gap |
|---|---|---|
| Durable hook bus: at-least-once, per-plugin cursors, causal depth, self-trigger suppression | built | HK1–HK5 |
| Plugins as external actors over ACP (subscribe/poll/ack) | built | DM7.1–DM7.3 |
| Saga correlation and saga view | built | HK1.2, HK3.1 |
| Daemon lifecycle events on the bus | built | session.*, turn.*, permission.*, capability.* (DM7.1, DM7.3) |
| Plugins publishing events and acting through the API | not started | |
| Gates, transformers, around-call hooks; plugin supervision | not started | |

## K. Local state repo

| Feature | Status | Evidence / gap |
|---|---|---|
| Git repo for dynamic state; branches, admission, rollback, pinning | not started | |

## L. Protocol

| Feature | Status | Evidence / gap |
|---|---|---|
| ACP base: initialize, session new/load/list/prompt/cancel, update, request_permission, $/cancel_request | built | DM1–DM2, NS1.1–NS1.3 (official SDK client), ACP1.1–ACP1.2 (SDK contract) |
| `_harness` profile: attach/detach/ack/tree/event/resync, capabilities, hooks, cognitive | built | PR1, MX1, MX2, DM6, DM7, DM9 |
| ACP framing on the official SDK (`ndJsonStream`), with a per-line byte bound in front of it; JSON-RPC validation in the pure core; ACP method names, protocol version and message types from the SDK (responses are checked against them at compile time) | built | NH1.4–NH1.5, LL1.1–LL1.3, JR1–JR3 (fuzzed), ACP1.1–ACP1.2 |
| Transport bindings: stdio, Unix socket | built | NS1, NS2 |
| Bindings: WebSocket, MessagePort, extension ports | not started | |
| Version negotiation | partial | Protocol and profile versions advertised; no range negotiation |
| MCP (south side) | not started | |

## M. Platform layers

| Feature | Status | Evidence / gap |
|---|---|---|
| Native background service (Node): stdio/socket, file storage, workers | built | NS1, NS2, NH1; tested on Linux only |
| Native model hosting: verified artifact cache, streamed GGUF files, Emscripten loader, llama-server processes, ensemble builder with one loader per runtime | built | MC1–MC2, MF1.1–MF1.6, LP1.1–LP1.4, CH1.1–CH3.2; CLI `--cognitive` |
| Browser extension, browser tab/PWA, remote API, mobile | not started | Core is pure (lint + tsconfig enforced) so it can run there |

## N. Federation

| Feature | Status | Evidence / gap |
|---|---|---|
| Daemon-to-daemon ACP, capability borrowing, state repo sync | not started | |

## O. Observability, evaluation and outcomes

| Feature | Status | Evidence / gap |
|---|---|---|
| Evals judged by the best reachable judgment model from the catalog, in preference order with failover (shipped: Jev via the AI Gateway, else CLM locally) | built | EV1–EV7, EV3.8–EV3.9, EV6.1; with no reachable judge cases are `blocked`, with each judge's reason |
| Judge calibration suite | built | `calibration` suite; live run 2026-09-24: 5/5, including both known-bad cases |
| End-to-end harness suite (daemon, judged) | built (not yet run live) | `harness` suite, EV7.3–EV7.5: round-trip, turn order, permission deny/allow through the daemon with the echo worker. The judge is the only model the evals call |
| OTel/ATIF export; outcome contracts; protected acceptance suites | not started | |

## P. Reliability, provenance and lifecycle

| Feature | Status | Evidence / gap |
|---|---|---|
| Deterministic core (injected clock/entropy); trace parity | built | DM8.1 |
| Fault-injection properties | built | EF5.1 (effects), HK5.1 (plugin crashes), SL4, TG4.1 |
| Mutation testing with a break threshold | built | Stryker over core, protocol, cognitive |
| Model tests on real weights (`*.model.test.ts`) | built | `npm run test:models`, CI `models` job; found and fixed: unnormalized images when a processor config omits do_normalize, Pixtral argument order, generation not stopped on early exit |
| TLA+ model; combinatorial conformance; provenance (SLSA/in-toto/TUF); retention | not started | |

## Q. Clients

| Feature | Status | Evidence / gap |
|---|---|---|
| Stock ACP clients work | built | Official ACP SDK client (NS1) |
| Reference TUI, web UI, extension panel | not started | |

## R. Multiplexing outcomes

| Outcome | Status | Evidence |
|---|---|---|
| MX1 detach/reattach with gapless replay | built | MX1.1–MX1.7, NS2.1 |
| MX2 slow consumer | built | MX2.1–MX2.14 |
| MX3 callback routing | built | MX3.1–MX3.24 |
| MX4 heterogeneous fan-out | not started | Needs SDK/CLI/ACP workers |
| MX5 daemon restart | built | MX5.1, NS1.3, NS2.4 |
| MX6 overhead budget | not started | |
| MX7 input lease | built | MX7.1–MX7.14 |
