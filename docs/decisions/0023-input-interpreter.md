# 0023: An input interpreter as actors on a hook bus

Status: decided 2026-09-29.

## Question

A turn's new text can be a slash command, a tool call, or an ordinary message.
Should the daemon parse that inline, or should a separate interpreter publish the
decomposition as events?

## Decision

`InputInterpreter` in `@harness/core` decomposes one new line into one action.
It owns a `HookBus` (depth 8). Four plugins handle a turn in order: parser,
decider, inferencer, eliciter. Each publish is caused by the event it handles,
and a plugin does not receive its own events. The submitter's source is `input`.

The parser applies one regex to the new text only, after optional surrounding
whitespace. A slash command in earlier turns is context, not a command. `/tools`
is the harness command for registered skills, MCPs, and native tools: no
argument lists them, `kind:name` or a unique name invokes that registration as a
model tool, and a shared name asks the user which one. `/sessions` with no
arguments lists the current session's managed harness instances. `new`,
`export`, `resume`, `fork`, `btw`, `bg`, and `switch` are subcommands of it.
`fork` takes an optional thread id and an optional message id. `btw`, `bg`,
and `switch` are a side question, a background handoff, and an inspection.
`--help` on a command or subcommand describes it and does not run it. Other
harness commands stay top-level. An unknown slash command stays unknown and
does not fall through.

Anything the regex does not claim goes to a decision-model port (ADR 0016: a
choice among 2 to 20 options, classification only). The port sees the new text
separately from the newest prior turns that fit in 2000 characters. `message`
and a named tool option settle. `complicated`, `use-tool`, an unknown choice, or
a thrown port goes to a generator port with the same text, context, and
registries. A generator action is kept only when it is a message, the real tool
list, a registered harness command (including `tools`), or a registered tool.
Otherwise the eliciter publishes a question. The question is the action. The
interpreter does not block for a person.

The core takes `decide` and `infer` ports. It does not import a model runtime.

## Why the bus is private

The daemon already broadcasts on a hook bus whose causal depth is shared with
plugins. An interpreter chain is four events deep before the action is ready.
A private bus keeps that depth local. The same delivery rule applies: at least
once, acknowledge to advance, and never handle your own event.

## Sessions

`/sessions` is built in, like `/tools`. It is not classified. With no
arguments it lists the current session's managed harness instances by `name`
and `harness`. `new`, `export`, `resume`, `fork`, `btw`, `bg`, and `switch`
are subcommands of `/sessions`. They are not top-level commands, so a host may
register those names as ordinary harness commands. `/sessions new` returns a
`new-session` action. The interpreter does not open a session; the host does.

`/sessions btw <question>` returns `session-btw`. The host asks that question on
a fork of the main thread. Later questions on the same fork see later
main-thread updates. The question and the answer stay off the main transcript.
`/sessions bg` returns `session-bg`. The host keeps the active turn running on
the previous main, takes later input on a new main, and merges the finished
turn into that main. `/sessions switch <session>` returns `session-switch`. The
host reports that session and does not move the input queue. `/sessions fork`
returns `session-fork`. The thread id and the message id are optional and
labeled, so either can be given alone. Neither forks at the end of the active
thread. A thread id alone forks at the end of that thread. A message id alone
forks through that message. Both fork through that message on that thread. The
host copies the conversation through that point into a new session and leaves
the original unchanged. An unknown thread id, an unknown message id, or a
message that is not on the named thread does not create a session. A bare
`/btw`, `/bg`, `/switch`, or `/fork` stays an unknown command, and `/session`
does not list, fork, ask, hand off, or switch.

The host passes the instances (`name`, `harness`, `state`). `/sessions export`
writes one named session, or every session when the name is omitted. The
default destination is a file: `<session>.json`, or `harness-sessions.json`
for the whole list. `--file <filename>` chooses the name. `--clipboard` copies
the same JSON. A bad flag, a bad filename, an unknown name, or an unknown
subcommand writes nothing. `/sessions resume <harness> [session]` resumes that
one instance. Zero matches or several matches report usage and do not resume.

## Help

`--help` is a flag on every slash command. It describes that command and does
not run it, classify it, export, resume, invoke a tool, or change a setting.
`/tools --help` describes the command and every skill, MCP, and native tool.
`/tools <name> --help` and `/tools <kind:name> --help` describe that
registration. A shared name lists each match. `/sessions --help` describes the
command; `new`, `export`, `resume`, `fork`, `btw`, `bg`, and `switch` describe
themselves. `--help` does not list or fork. `/settings --help` describes
the command and the catalog; a key describes that setting's fallback and, when
the set is closed, its values. A registered harness command describes itself
from its registration. An unknown command or tool stays unknown.

## Typeahead

`complete(prefix, context)` proposes the next instruction while a person is
typing, or before the next turn when the prefix is empty. It does not publish
on the hook bus and it does not run a command.

A slash prefix completes known commands one token at a time: `/tools`,
`/sessions`, `/settings`, and registered harness commands, then their
subcommands, tool and `kind:name` registrations, session and harness names,
setting keys and closed values, and `--help`. An empty prefix predicts the
top-level commands. Natural-language suggestions come from an optional
`suggest` port and are lower priority. A slash prefix does not ask for them, a
command list that already fills the option window does not ask for them, and
otherwise they follow the commands. The port failing leaves the command
completions in place.

Two or more candidates, at most `maxOptions`, go to the decision-model port
(ADR 0016). Probabilities rerank them and become the scores. A bare choice
moves that candidate first. `complicated`, a throw, an unknown choice, or a
non-finite probability leaves the priority order with score 0. One candidate
scores 1 and does not ask the model.

## Non-goals

The daemon does not route ordinary turns through the interpreter yet. The
playground terminal keeps its cac slash parser. This interpreter does not call a
tool, a model, or a sandbox. It does not replace ACP permission requests.
