# 0026: Autopilot proposes goals onto reviewable updates

Status: decided 2026-09-29.

## Question

Where does an autopilot that sets its own goals put the work, and how does a
person steer or stop it?

## Decision

`/autopilot` is a built-in command on the input interpreter, beside `/sessions`
and `/settings`. It does not ask the decision model. Optional instructions are
the goal, the way `/goal` steers other harnesses. With no instructions the run
stays up and keeps taking new survey findings until `/autopilot stop` or any
later line that is not itself an autopilot command.

The host supplies the survey and the implementation. The core does not run a
package manager, a network request, or a model. Each landed goal is one harness
update: an id, the branch `autopilot/<id>`, release notes, a kind, and
`applied: false`. The branch is the reviewable fork. `/autopilot apply <id>`
marks that same update applied. It does not move a trunk ref and it does not
call delivery. `/autopilot updates` lists them.

The kinds are upgrades, known vulnerabilities, research, and performance
experiments. A finding is landed once, keyed by kind and subject. After the
current survey is exhausted the run stays active so a later survey can
continue. Research notes on the update are the knowledge record. An experiment
is an [Open Experiment Standard](https://www.openexperiment.org/) draft 0.1.0
document: identity, an A/B design, control and treatment, a primary metric, and
a pending decision. It does not invent a sample size, an interval, or a
p-value. `sourceSystem` is `launchdarkly` only when the survey says the finding
came from LaunchDarkly. LaunchDarkly can publish the same documents; the core
does not call it.

There is no runtime package for that draft. The core constructs and checks the
envelope itself. A vendor SDK would need a key and a network call, which this
package cannot make.

## Non-goals

The daemon does not construct an interpreter and does not start the loop.
Nothing is written into `.harness`, and an autopilot branch is not a delivery
task. The learning lesson store is not updated. The playground keeps its own
slash parser. Apply does not merge.
