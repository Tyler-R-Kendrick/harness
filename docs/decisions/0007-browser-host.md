# 0007: One daemon runtime, and a browser host on MessagePorts

## Context

The daemon should run on every hosting platform with one core. The native host had
grown a loop of its own around the pure core: it sent outputs to connections, ran
worker commands, ran cognitive work on the ensemble, mirrored the ensemble's tasks as
capabilities and saved snapshots after every change. A browser host needs the same
loop, and copying it would mean the two drift apart.

In a browser the daemon runs in a tab, a PWA, a shared worker (one per origin, shared
by every tab) or an extension's background. Clients reach it over `MessagePort`s.
The ACP SDK has transports for NDJSON byte streams, HTTP and WebSockets, but none for a
`MessagePort`. Its `Stream` type (a readable and a writable of messages) is
transport-neutral, though, so a port can back it.

Ports have no reliable close event: Chromium does not fire `close` on a `MessagePort`
(checked in the Chromium we test on), and a tab that crashes or is closed says nothing.
A connection that is never disconnected keeps its session's input lease, and nobody
else can prompt that session.

## Decision

- **`@harness/runtime` (pure) is the loop every host wraps.** `DaemonRuntime` drives the
  core by its outputs, dispatches worker commands, runs cognitive work, mirrors
  capabilities and coalesces snapshot saves. Time, entropy and storage are ports; hosts
  add only transports and a ticker. `NodeHost` is now a runtime with NDJSON streams and a
  socket.
- **ACP over a port is one structured message per JSON-RPC message**, with no framing.
  `portStream` adapts a port to the ACP SDK's `Stream`, so the SDK's
  `ClientSideConnection` (and `daemonHarness`) run over it unchanged.
- **Hanging up is explicit.** Beside ACP's messages, a port carries control messages
  under `_harness/port`, which is never a JSON-RPC member so they cannot clash. Either
  end that hangs up posts `close` before closing its port. Where ports do report
  closing (Node), that disconnects too.
- **Liveness comes from Web Locks.** A client holds a lock of its own for as long as its
  context lives and names it to the host (`alive`); the host waits on that lock. The
  browser releases a lock when its holder's context ends, so when a tab dies the host
  gets the lock, disconnects the tab's connection and frees its input lease. This is the
  standard way to learn that a shared worker's client has gone, and the lock is ours to
  name only because no library has an ACP port transport.
- **A shared worker is served with `BrowserHost.serve(self, options)`.** It listens
  before the host starts, because the first `connect` event comes as soon as the
  worker's script runs.
- **Snapshots go to IndexedDB**, one record per daemon and a transaction per save, and
  it runs the same storage contract as the file and memory stores.

## Consequences

- A behavior of the loop (a worker crash ends the turn, saves coalesce, close waits for
  turns) is written and tested once, in the runtime.
- The browser host is tested twice: in Node, with real `MessageChannel`s and
  `fake-indexeddb`, and bundled with Vite and run in Chromium through `playwright-core`.
  The Chromium tests cover a turn in a tab, a restart from IndexedDB, a shared worker
  serving two clients, and a dead tab's lease being freed. CI installs Chromium for them.
- Clients that build their own port transport must post `close` when they hang up, or
  hold a Web Lock and name it. Otherwise their connection lasts until the host closes.

## Revisit when

- Browsers fire `close` on `MessagePort`s everywhere: then the control message can go.
- The ACP SDK ships a `MessagePort` transport: use it and drop `portStream`.
- Extension ports (`chrome.runtime.Port`, which do report disconnects) are bound.
