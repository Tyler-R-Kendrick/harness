# 0008: An isolating sandbox for harness sessions on Docker

## Context

Harness sessions (Claude Code, Codex, any ACP agent through `@ai-sdk/harness-acp`) run in
an AI SDK sandbox: a `HarnessV1SandboxProvider` gives each session a place to run
commands and files, and a port for the harness bridge. The host sandbox (`hostSandbox`)
runs them on this machine as the daemon's user, which isolates nothing.

The AI SDK's own providers are hosted (`@ai-sdk/sandbox-vercel`) or simulated
(`@ai-sdk/sandbox-just-bash`, a bash interpreter in memory that cannot run a bridge's node
process). Other hosted providers exist (E2B, Coder, Cloudflare), and a community
`ai-sdk-sandbox-docker` (0.1.x, one maintainer).

## Decision

- **`dockerSandbox` is ours, on the Docker CLI.** Each session is a container
  (`docker run --init … sleep infinity`), commands run through `docker exec`, and files
  are read and written through the container. The community package does the same in
  about as much code; for something that runs arbitrary agents we depend on Docker, not
  on an early single-maintainer wrapper, and keep the behavior under our tests.
- **Commands lead a session of their own** (`setsid -w`) and record its id in the
  container, so killing one reaches what it started; the docker CLI on this side is only
  a client. Stopping a sandbox stops its container (everything in it ends) and keeps its
  files; resuming starts it; destroying removes it.
- **Networking.** `bridge` (default): a network of its own, and the session's port
  published on this machine's loopback, where the harness reaches its bridge. `none`: no
  network and no port. `host`: this machine's network, shared (files and processes are
  still isolated), for a daemon whose egress goes through a proxy on its loopback.
- **Setup and environment are options**, not image builds: a command run once per new
  container (e.g. installing pnpm, which the ACP adapter's bridge needs), variables for
  every command (a harness's credentials), and read-only mounts.
- On the native host: `--sandbox docker:<image>` (the host sandbox stays the default),
  `--sandbox-setup`, `--sandbox-env <NAME>`.

## Consequences

- A harness session in a Docker sandbox cannot read or write this machine's files, and its
  processes are the container's. Its network egress is not restricted in `bridge` mode.
- Tests run against a real Docker daemon: the sandbox itself (DS1.x) and the official ACP
  adapter end to end in a container (HI1.3). CI's runner has one.

## Revisit when

- The AI SDK ships a local isolating provider: use it and drop ours.
- Egress policy lands (features: secrets port, egress policy): containers should get it.
