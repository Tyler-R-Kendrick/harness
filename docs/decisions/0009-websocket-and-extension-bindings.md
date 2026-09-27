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
  must be added then) and accepts ports named `acp`. Chrome drops a runtime port's
  messages while nothing listens, so `extensionPort` listens from the start and holds
  what arrives until the daemon starts reading, as a `MessagePort` does: a page may speak
  while a slow service worker is still starting.
- **Code in an extension is packaged, never evaluated.** Manifest V3 forbids `eval` and
  `new Function` (only `'wasm-unsafe-eval'` may be declared, and must be, for WebAssembly).
  The ensemble's Emscripten loaders and XGrammar's binding are normally evaluated from
  their verified source, so an extension packages them instead: a build plugin
  (`factoryImports` from `@harness/platform-browser/vite`) turns `import x from
  "file.js?factory"` into a function that runs the module again on each call.
  `packagedEmscripten` runs the packaged loader whose source has the same sha256 as the
  verified one (the WebAssembly is still fetched and verified), and `xgrammarFromFactory`
  gets a fresh XGrammar instance by calling the factory again.

## Consequences

- Clients use the ACP SDK's WebSocket stream unchanged (WS1.x run it against the host).
- A closed extension page frees its connection and input lease through its port's
  disconnect; no Web Lock is needed there (BI2.2 in Chromium).
- In an unpacked extension in Chromium, XGrammar and a Cactus WASM router run from
  packaged code while evaluating their source is refused (BI2.3).
- An extension must declare `"content_security_policy": { "extension_pages": "script-src
  'self' 'wasm-unsafe-eval'; object-src 'self'" }`: MV3's default refuses WebAssembly.

## Revisit when

- The ACP SDK's server side can drive a multiplexer: use it for the WebSocket binding.
- Remote access is wanted: that needs TLS and real authentication, not a loopback token.
