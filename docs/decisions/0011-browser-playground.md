# 0011: A browser playground: the daemon in one page, a terminal, and its traces

## Context

The browser host (ADR 0007) runs the daemon in a tab, but the only way to watch it work
was its integration tests. We want a page where a person drives the harness by hand and
sees what each turn does to it: the ACP messages, the worker's commands and events, the
model calls, the hook events, the daemon's snapshot, and the files the agent changed.
It should run anywhere a browser does, including as a claude.ai artifact: one HTML file,
no scripts from other hosts, no network.

## Decision

- **`@harness/playground` is a host-level package** (like the platform packages): the
  browser host started in the page, with one ACP client of it (the official SDK's
  `ClientSideConnection`) over a `MessageChannel`, exactly as another tab would connect.
- **The terminal is Vercel's wterm** (`@wterm/dom`), running **just-bash**
  (`@wterm/just-bash`'s `BashShell`), a bash interpreter over an in-memory filesystem. The
  harness adds `ask` and `harness …` commands to that shell, so turns, sessions, workers,
  approvals and traces are driven from the terminal. Tool approvals are asked in the
  terminal and answered with one key.
- **The agent's tools run in a just-bash shell of their own over the terminal's
  filesystem**, so the person and the agent share one filesystem, but the terminal's
  harness commands (`ask`, `harness`) are not the agent's: a tool call cannot start a
  turn, switch sessions, change approvals or reset the page. They are `bash`, `readFile` and `writeFile`, named and shaped
  as Vercel's `bash-tool`; we do not use `bash-tool` itself because it imports `node:fs`,
  `node:path` and fast-glob at module load and so does not bundle for a page.
- **Claude through the artifact's `sample` capability, as an AI SDK `LanguageModelV4`.**
  The capability takes plain turns and returns text; the call's instructions, tools and
  conversation are rendered as turns, and the reply's shape is fixed as one JSON object
  (`{"text", "toolCalls"}`) whose `text` streams as it is written. The capability takes no
  schema or grammar, so the reply's JSON Schema is sent in the leading turn, the strongest
  constraint it allows; `sample.json` is not used, because it only notes that the reply
  will be parsed (by the same tolerant rules we use) and rejects a reply cut short, whose
  partial text we keep. The model is named by its runtime (`sample`), and its tool-call ids
  are random, since a conversation outlives the page that wrote it. The AI SDK then runs the
  tools, through the daemon's permission flow, as with any provider. The capability's own
  `tools` option is not used: it would run tools inside the capability, out of the
  daemon's sight and approvals. Outside claude.ai the capability is absent, and the page
  says so and offers the other workers.
- **A deterministic `shell` model** (a prompt `$ <command>` is a `bash` call; its result is
  the reply) exercises the full path of a tool call without spending model usage; the
  echo worker needs no model.
- **One timeline.** A `Tracer` records ACP messages (a tap on the client's port), worker
  commands and events (a wrapper of the worker), model calls (AI SDK middleware), tool
  runs (wrapped tools), hook events (read from each snapshot the daemon saves) and every
  turn's filesystem diff.
- **One file.** `build.ts` bundles the app with Vite into one inline module script after
  `page.html`'s markup and styles (about 2 MB), under the artifact limit of 16 MB.

## Consequences

- What the playground keeps lives in the viewer's browser (IndexedDB, one database with a
  record each for the daemon's snapshot, the filesystem and the page's state, and one per
  session's agent conversation), restored on reload and cleared by `harness reset`. Conversations are kept
  by the agent worker through an optional `ConversationStore`, since the daemon's session
  log holds ACP updates, not the model messages an agent continues from. The filesystem
  is saved whole after each command, tool run and turn; a turn running at a reload ends
  as interrupted, as on any daemon restart. The timeline is not kept.
- Claude's usage in the artifact is the viewer's own, asked for at the first call.
- Its model calls report no token usage: the capability does not expose it.

## Revisit when

- The `sample` capability can take a JSON Schema or grammar, or report token usage: send
  the schema as a constraint rather than in the prompt, and record usage in the trace.
- `bash-tool` loads in browsers: use it for the agent's tools.
