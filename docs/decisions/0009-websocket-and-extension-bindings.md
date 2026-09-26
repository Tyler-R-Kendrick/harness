# 0009: ACP over WebSocket and over extension ports

## Context

The native host speaks ACP over stdio and a Unix socket that only its owner can open.
Some clients cannot use either: a browser extension, a web UI, a client on Windows
without named-pipe support. A WebSocket on the loopback reaches them, but anything on
this machine can connect to a loopback port, and so can any web page the user opens
(browsers do not apply CORS to WebSockets).

The ACP SDK has a WebSocket client stream (`experimental/ws-client`). Its server side
(`experimental/server`) connects each socket to one `Agent` object, which a multiplexing
daemon is not.

In an extension, pages reach the service worker through `chrome.runtime.Port`s. Unlike
`MessagePort`s they report when the other end goes away.

## Decision

- **WebSocket: our listener on `ws`, the library the SDK uses.** One JSON-RPC message per
  text frame into the daemon runtime; a frame that is not JSON gets a parse error, a
  binary frame an invalid-request error, and the connection carries on. Frames are bounded
  like NDJSON lines.
- **Loopback only, a token always.** The host binds 127.0.0.1. Every connection presents
  a token, compared in constant time: an `Authorization: Bearer` header, or (browsers
  cannot set headers) the subprotocol `harness.token.<token>`, which the server echoes.
  The CLI keeps the token in a file only its owner can read (`--ws-token-file`), made at
  random when missing.
- **Browser origins are refused unless allowed** (`--ws-origin`), so a web page cannot
  drive the daemon even with the token leaked into it. Clients without an `Origin`
  (programs) need only the token.
- **Extension ports adapt to the MessagePort binding** (`extensionPort`): messages are
  message events, a disconnect is a close. `BrowserHost.serveExtension` listens on
  `chrome.runtime.onConnect` as the service worker's script runs (a worker's listeners
  must be added then) and accepts ports named `acp`.

## Consequences

- Clients use the ACP SDK's WebSocket stream unchanged (WS1.x run it against the host).
- A closed extension page frees its connection and input lease through its port's
  disconnect; no Web Lock is needed there (BI2.2 in Chromium).

## Revisit when

- The ACP SDK's server side can drive a multiplexer: use it for the WebSocket binding.
- Remote access is wanted: that needs TLS and real authentication, not a loopback token.
