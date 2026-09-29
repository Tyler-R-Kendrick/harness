# 0024: `/settings` is the configuration entry point

Status: decided 2026-09-29.

## Question

Harness configuration is a feature that was not started: a requested value, the
value that was accepted, and the value in effect. Where does a caller read and
change it?

## Decision

`/settings` is that entry point, and it is the only harness command that does
so. The host registers the whole catalog when it builds an `InputInterpreter`.
A key outside the catalog is not configuration.

`/settings` lists every entry. `/settings <key>` shows one. `/settings <key>
<value>` stores the request. A closed `values` list accepts only a member; a
setting with no list accepts the text. A refused request stays visible and
does not replace the last accepted value. Effective configuration is that
accepted value, or the fallback when nothing has been accepted. `/settings
<key> --unset` drops the request and the acceptance, so the fallback is in
effect again.

The command is code on the interpreter's parser. It does not ask the decision
model or the generator.

## Why the catalog is registered, not hardcoded

Core cannot import the playground, the model catalog, or a host's files. Those
packages are the ones that know which settings exist. They pass the complete
list in. Adding a setting is a catalog change, not a new command.

## Non-goals

The daemon does not apply the effective values yet. The playground terminal
still has its own cac commands for worker, tier, approval, and models. Moving
those behind `/settings` is later work.
