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

| Feature | Status | Evidence / gap |
|---|---|---|
| Generation port | partial | ModelWorker streams text; no typed choice/score/extraction ports in the daemon |
| Candidate-strategy math (coverage, attempts, voting, precision, mixtures, Wilson) | built | AM1–AM5, all mandate fixtures |
| Execution configurations, performance registry, routing, value of information | not started | |
| Candidate strategies (cascade, best-of-N, selection) | not started | Math only |
| Constrained generation, code mode, planning | not started | |
| Agents and skills (file-defined, code-only/hybrid/guided) | not started | |
| Templates, demonstration learning, improvement loops | not started | |

## H. Knowledge modeling

| Feature | Status | Evidence / gap |
|---|---|---|
| Record kinds, orthogonal fields, facets, lineage, snapshots, retrieval, compaction, code intelligence, standards | not started | |

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
| `_harness` profile: attach/detach/ack/tree/event/resync, capabilities, hooks | built | PR1, MX1, MX2, DM6, DM7 |
| Bounded NDJSON framing; JSON-RPC validation | built | FR1–FR3, JR1–JR3 (fuzzed) |
| Transport bindings: stdio, Unix socket | built | NS1, NS2 |
| Bindings: WebSocket, MessagePort, extension ports | not started | |
| Version negotiation | partial | Protocol and profile versions advertised; no range negotiation |
| MCP (south side) | not started | |

## M. Platform layers

| Feature | Status | Evidence / gap |
|---|---|---|
| Native background service (Node): stdio/socket, file storage, workers | built | NS1, NS2, NH1; tested on Linux only |
| Browser extension, browser tab/PWA, remote API, mobile | not started | Core is pure (lint + tsconfig enforced) so it can run there |

## N. Federation

| Feature | Status | Evidence / gap |
|---|---|---|
| Daemon-to-daemon ACP, capability borrowing, state repo sync | not started | |

## O. Observability, evaluation and outcomes

| Feature | Status | Evidence / gap |
|---|---|---|
| Evals with Jev as judge (typesafe-ai/jev via Vercel AI Gateway) | built | EV1–EV7; live runs need `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` and are otherwise `blocked` |
| Judge calibration suite | built | `calibration` suite; live run 2026-09-24: 5/5, including both known-bad cases |
| End-to-end harness suite (daemon, judged by Jev) | built (not yet run live) | `harness` suite, EV7.3–EV7.5: round-trip, turn order, permission deny/allow through the daemon with the echo worker. Jev is the only model the evals call |
| OTel/ATIF export; outcome contracts; protected acceptance suites | not started | |

## P. Reliability, provenance and lifecycle

| Feature | Status | Evidence / gap |
|---|---|---|
| Deterministic core (injected clock/entropy); trace parity | built | DM8.1 |
| Fault-injection properties | built | EF5.1 (effects), HK5.1 (plugin crashes), SL4, TG4.1 |
| Mutation testing with a break threshold | built | Stryker over core, protocol, cognitive |
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
