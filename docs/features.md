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
| In-process agent runtime (AI SDK model, Vercel AI Gateway) | built | WK2.1–WK2.6; CLI `--worker model` |
| Deterministic echo worker (tests/demos) | built | WK1.1–WK1.7 |
| SDK harness, native CLI, ACP-agent and UHP workers | not started | |
| Integration modes (integrated/cooperative/opaque) declared | not started | |
| Kernels (interactive, deterministic graph, durable runtime) | not started | |
| Account instances, install/update ownership, readiness | not started | |
| Per-dispatch model/effort | not started | |
| Queue vs steer vs interrupt vs cancel | partial | Cancel built (DM2.8, WK1.5, WK2.5); one prompt at a time (DM2.5); no queue/steer |
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
| Ports: judge, tool router, embedder, compressor, generator (text + vision), document parser | built | `cognitive/ports.ts`; contract suites JC, RC, EC, CC, GC, DC run against fakes and real adapters |
| Task taxonomy mapped to ports (15 categories, including `steered-chat`) | built | `TASK_CATEGORIES`, `TASK_PORTS`; CT1.1, CT1.9 |
| Model catalog, preferences and benchmarks as data: JSON files (`packages/cognitive/data`, one set per extension) with generated JSON Schemas, loaded by the host at runtime and parsed (pinned commits, sha256 weights, ports serving tasks, benchmark rows naming models) | built | CT1.1–CT1.3, CT1.10, CH1.1; 9 models (below) |
| Benchmark-driven selection with head-to-head records, curated tie-breaks, explanations | built | SE1.1–SE1.8, SE2.1–SE2.2 (property), CT1.7 |
| Ensemble: lazy load, failover to next-ranked member, runtime revoke/restore, state events | built | EN1.1–EN1.11 |
| Tool-call cascade: router → judge on middling confidence → generator, traced | built | CA1.1–CA1.9, CA2.1–CA2.6; live: Needle decides and is accepted (cognitive.tool-decision subject) |
| LLMLingua-2 word scoring, rate threshold, windowing (pure) | built | LL1.1–LL2.1 |
| EmbeddingGemma prompts and Matryoshka truncation | built | EG1.1–EG2.4 |
| ChatML / qwen3_xml streaming parser (Qwen3.5, Ornith) | built | QF1–QF2, QF3.1 (any chunking = whole parse) |
| Failover on calls: a member whose service is unavailable (HTTP status other than 400/422, or retryable) is taken out and the next member answers | built | EN3.1–EN3.3 |
| Capabilities mirrored from the ensemble (`cognitive.<task>`, plus each installed extension's id) | built | CM1.1, EN2.4, NH2.1, DM9.7 |
| Extensions: models and `<extension>.<op>` operations installed and removed at runtime; the daemon admits an extension's operations only while its capability is offered | built | EN2.1–EN2.4, CS3.1, DM9.12 |
| ACP `_harness/cognitive/invoke` and `/status` | built | DM9.1–DM9.11, CS1.1–CS1.6, CS2.1–CS2.5, NH2.1–NH2.2 |
| Ensemble worker (sessions on the best generator; images → vision) | built | EW1.1–EW1.5; CLI `--worker ensemble` |
| Candidate-strategy math (coverage, attempts, voting, precision, mixtures, Wilson) | built | AM1–AM5 |
| Local kernel: steerable ONNX (residual tap + steering input spliced into the graph), KV-cached decode loop, steering hook per token | built | OS1.1–OS1.5, OR1.x, SG1.1–SG1.10, SK1.1–SK1.3, CH2.5; real Qwen3-1.7B: zero steering is bit-identical, residual moves by exactly the vector (KS1.4, `check_steerable.py`) |
| Behavior state graphs over SAE features: sensors with hysteresis and hold, nested states with summed steering, priority/specificity transitions, host events, snapshots, replay | built | `packages/behavior`; BV1–BV2, BE1–BE3, BP1–BP2, property tests |
| SAE rows files: only the rows a graph uses, cut from a full SAE (`tools/model-lab/sae_rows.py`), b_dec folded into the bias | built | SR1.1–SR2.1; fixture: 6 labelled features of adamkarvonen/qwen3-1.7b-saes layer 14 (MIT) |
| Behavior graph driving the real kernel: the prompt is sensed token by token (skipping the attention sink), so the state changes before the reply | built | KS1.2 insult → `soothing`, KS1.3 happy news → `cheerful` (reply changes), KS1.4 neutral → no change; fixture `qwen3-1.7b-host.graph.json` |
| Behavior per session (state in the session log, transitions as hook events, plugins raising events) | not started | The native host runs one optional pack for the kernel (`behavior` option) |
| Remote models as retrieval for the steered local kernel | not started | Steering is local only: hosted APIs expose no residual stream |
| Steerable kernel in the browser (onnxruntime-web) | not started | Native only; the int4 export's contrib ops are unverified on web |
| Browser host for the ensemble (Cache API/OPFS byte cache, WebGPU) | not started | Adapters are browser-ready (transformers.js, Needle WASM); no browser platform layer yet |
| Tool use through the daemon's permission flow from the ensemble worker | not started | |
| Execution configurations, performance registry learned from our own runs, value of information | not started | Selection uses published benchmarks only |
| Constrained generation, code mode, planning; agents and skills; templates and improvement loops | not started | |

### Ensemble members

| Model | Tasks | Runs | Verified on real weights |
|---|---|---|---|
| Jev 1.13 (TypeSafe AI) | judgment, classification | hosted (AI Gateway) | evals (live run: calibration 5/5) |
| CLM 8B v0.1 (Contrastive-LM) | judgment, classification: Jev's local fallback | clm-serve (TypeSafe's API; Qwen3-8B encoder), native | CL1.1–CL1.2 against clm-serve's wire format; CH2.2; not yet run against a live clm-serve (needs its encoder on a GPU) |
| Needle 3 (Cactus Compute) | tool calling, extraction, classification, embeddings | WASM, native + browser | NM1.1–NM1.3 + router/embedder contracts |
| EmbeddingGemma 300M (brought by memory, not in the core catalog) | text embeddings | transformers.js, native + browser | EM1.1 + embedder contract (768/512/256/128), MM1.1 |
| LLMLingua-2 (mBERT) | prompt compression | transformers.js, native + browser | LM1.1 + compressor contract |
| Qwen3.5 0.8B | chat, reasoning, tools, extraction, vision QA, OCR, documents, charts | transformers.js, native + browser (the browser LLM) | QM1.1–QM1.3 + generator contract |
| LightOnOCR-2 1B | OCR, document parsing, tables | transformers.js, native + browser | DM1.1 + document-parser contract |
| Ornith 1.5 9B | chat, reasoning, coding, tools | llama-server, native only | OM1.1 + generator contract, CI `models` job only (llama.cpp releases are not reachable from this dev sandbox) |
| OvisOCR2 | OCR, document parsing, tables | llama-server, native only | OV1.1, CI `models` job only |
| Qwen3 1.7B (steerable kernel) | steered chat | onnxruntime, native only; patched at layer 14 on first use | KS1.1–KS1.4 + generator contract |

## H. Knowledge modeling

| Feature | Status | Evidence / gap |
|---|---|---|
| Memory as a cognitive-core extension (`@harness/memory`): brings the embedding model; the core has none of its own | built | MX1.1, CH1.1, CH3.1 |
| Vector memory: remember text (as documents), recall by meaning (as queries), per-session filters, JSON save/restore; Orama index, pure JS on every platform | built | ME1.1–ME1.4; real weights MM1.1 |
| ACP `memory.remember` / `memory.recall` through `_harness/cognitive/invoke` | built | MX1.2–MX1.3, DM9.12 |
| Session memory: each turn gets related memories from other sessions and is remembered afterwards | built | EW1.7; CLI `--worker ensemble --memory <file>` |
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
| Bounded NDJSON framing; JSON-RPC validation | built | FR1–FR3, JR1–JR3 (fuzzed) |
| Transport bindings: stdio, Unix socket | built | NS1, NS2 |
| Bindings: WebSocket, MessagePort, extension ports | not started | |
| Version negotiation | partial | Protocol and profile versions advertised; no range negotiation |
| MCP (south side) | not started | |

## M. Platform layers

| Feature | Status | Evidence / gap |
|---|---|---|
| Native background service (Node): stdio/socket, file storage, workers | built | NS1, NS2, NH1; tested on Linux only |
| Native model hosting: verified artifact cache, streamed GGUF files, Needle loader, llama-server processes, ensemble builder | built | MC1–MC2, MF1.1–MF1.6, LP1.1–LP1.4, CH1.1–CH2.4; CLI `--cognitive` |
| Browser extension, browser tab/PWA, remote API, mobile | not started | Core is pure (lint + tsconfig enforced) so it can run there |

## N. Federation

| Feature | Status | Evidence / gap |
|---|---|---|
| Daemon-to-daemon ACP, capability borrowing, state repo sync | not started | |

## O. Observability, evaluation and outcomes

| Feature | Status | Evidence / gap |
|---|---|---|
| Evals with Jev as judge (typesafe-ai/jev via Vercel AI Gateway), CLM locally without a credential | built | EV1–EV7, EV3.8; without a gateway credential or a running clm-serve cases are `blocked` |
| Judge calibration suite | built | `calibration` suite; live run 2026-09-24: 5/5, including both known-bad cases |
| End-to-end harness suite (daemon, judged by Jev) | built (not yet run live) | `harness` suite, EV7.3–EV7.5: round-trip, turn order, permission deny/allow through the daemon with the echo worker. Jev and CLM are the only models the evals call |
| OTel/ATIF export; outcome contracts; protected acceptance suites | not started | |

## P. Reliability, provenance and lifecycle

| Feature | Status | Evidence / gap |
|---|---|---|
| Deterministic core (injected clock/entropy); trace parity | built | DM8.1 |
| Fault-injection properties | built | EF5.1 (effects), HK5.1 (plugin crashes), SL4, TG4.1 |
| Mutation testing with a break threshold | built | Stryker over core, protocol, cognitive |
| Model tests on real weights (`*.model.test.ts`) | built | `npm run test:models`, CI `models` job; found and fixed: unnormalized Qwen3.5 images, Pixtral argument order, generation not stopped on early exit |
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
