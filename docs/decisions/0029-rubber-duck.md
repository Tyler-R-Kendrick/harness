# 0029: Rubber duck is a built-in workflow checkpoint

Status: decided 2026-09-29.

## Question

When should the harness take a second opinion on design, planning, or
verification, and who is allowed to give it?

## Decision

Rubber duck is on by default. It is a declarative workflow, not a setting.
`decide-duck` asks one decision pass whether this checkpoint would benefit.
The options are `consult` and `skip`. The checkpoint is named in the request:
design, planning, verification, or whatever else the host is about to do.
The choice wins. A higher probability on the other option does not.

`critique` runs only when the pass says consult and the critic's model family
differs from the session family. A missing critic family does not consult.
The critique is a list of concerns. Each one has a severity (`blocking`,
`non-blocking`, or `suggestion`), the issue, its impact, and a concrete
change. An empty list means the critic found nothing. The workflow has no
edit tool. The session decides what to do with the concerns.

A thrown, complicated, unknown, or non-finite answer consults, provided a
contrasting family is available. An explicit skip stays quiet. That is the
Copilot rubber duck: a built-in second opinion at the checkpoints where a
mistake is still cheap, and silence when the pass says the change is small.
The core does not pick a vendor model. The host supplies both families and
the scripted or live critic.

## Non-goals

No slash command is added to the interpreter. Delivery's verify roles stay
correctness, gates, and budget. The duck does not classify style comments and
does not edit files. A same-family critic is not used as a fallback.
