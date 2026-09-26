# 0006: ACP on the official SDK, around a multiplexing core

## Context

The daemon speaks the Agent Client Protocol to every client, plugin and peer. We had
written our own NDJSON framing, method-name constants and message shapes. The official
`@agentclientprotocol/sdk` provides the framing (`ndJsonStream`), the method names, the
protocol version and generated types for every message.

The SDK's connection classes (`AgentSideConnection`, `ClientSideConnection`) bind one
stream to one `Agent` or `Client` object and dispatch each request to a method on it. The
daemon core is different: a pure, sans-I/O step function that owns many connections at
once, routes a worker's permission request to every approver but the worker, answers the
first reply and cancels the others (`$/cancel_request`), replays session logs from any
offset, and fences stale input holders. That routing is the point of the daemon and no
library does it.

## Decision

- **Framing is the SDK's.** Hosts bind a byte stream with `ndJsonStream`; a line that is
  not JSON gets the SDK's parse error. The SDK buffers each line whole, so the native host
  puts a per-line byte bound (`lineLimit`, default 16 MiB) in front of it: a longer line
  is refused with an error and skipped up to its newline, and the connection carries on.
- **Names and types are the SDK's.** `ACP_METHODS` and `ACP_PROTOCOL_VERSION` are read
  from the SDK's constants. The core's stop reasons, session updates, tool calls and
  permission options are the SDK's types, and its responses to `initialize`,
  `session/new`, `session/load`, `session/list`, `session/prompt` and its
  `session/request_permission` requests are checked against the SDK's types when compiled.
- **The multiplexing core stays ours**, including its small JSON-RPC classifier: the core
  is pure (no streams, no promises) and every connection's messages go through one step
  function. The SDK's per-stream connection classes are used by clients and in the
  integration tests (the official client talks to the native host over stdio).

## Consequences

- Upgrading the SDK surfaces protocol drift as a type error or a failing contract test.
- Our framing code and its tests are gone; the byte bound is the only framing code left.

## Revisit when

- The SDK offers a pure message router a multiplexing server can drive, or exports its
  zod schemas so the core can validate request params with them.
