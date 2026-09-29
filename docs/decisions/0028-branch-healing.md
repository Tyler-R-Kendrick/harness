# 0028: Task-graph branches heal from the agent bus

Status: decided 2026-09-29.

## Question

When a branch of the task graph is cancelled, fails, or runs over budget, how
does the work continue?

## Decision

The hook bus is the agent bus for a branch. That follows LogAct
([arXiv:2604.07988](https://arxiv.org/abs/2604.07988)): an intention is appended
before the node starts, so a crash after the append leaves the attempt on the
trajectory and leaves the node unstarted.

`intendBranch` writes `branch.intention`, then starts the node. The branch
declares ordered alternate paths and a budget, which is the number of
intentions one path may spend. The next intention on a path that has already
spent its budget is not started. The node is cancelled, a `branch.failure` is
appended, and only then does a `branch.correction` name the next path.

`completeBranch` records a success and leaves earlier nodes as they are. A
failure, `abandonBranch`, and `recoverBranch` (an intention with no result
whose node is still pending) do the same correction. The trajectory is every
`branch.*` event on that branch. A path is eligible only when none of its nodes
appear as an intention or a failure, every node is still pending, and its first
node is ready. Declaration order breaks the ties. When no path qualifies, the
branch stops.

The choice is the trajectory, not a model. Voters, quorums, and semantic
inference from the paper are not this package.

## Non-goals

Cancellation is still not rollback. A succeeded predecessor stays succeeded.
Skipped nodes are not reopened. The daemon does not drive the graph. Delivery's
budget monitor is a different budget. Descendant budget grants stay unbuilt.
No second log is added beside the hook bus.
