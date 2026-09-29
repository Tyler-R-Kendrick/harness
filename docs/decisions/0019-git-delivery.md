# 0019: Git delivery is a static executor over a workflow file

Status: decided 2026-09-29. Revised the same day: the sequence is a file.

## Question

Landing a change took a fixed sequence: linked worktrees that share one git object
store and one dependency cache, incremental commits, stacked pull requests, a
comment review, resolved threads, a squash merge with one parent, a retarget of the
next branch onto that squash, and removal of the worktree. A budget stopped the run
before the disk filled. Should that sequence be code the host journals, or data a
static executor runs?

## Decision

The sequence is `packages/platform-native/data/git-delivery.workflow.yaml`.
`executeDeclarative` in `@harness/core` interprets that document. The file names
SetVariable, AppendValue, If, Foreach, InvokeFunctionTool, and EndWorkflow. An
unknown kind is refused when the file is parsed, before any git command.

The actions the file may call are fixed in `runDeliveryWorkflow`. A called action
still checks the budget, the hook and local gates, the review event, the squash
parent count, and the retarget commit count. On a failure, that function removes
every worktree it has marked live. A runtime replaces the file (`harness-deliver
--workflow`, or `workflowText` / `workflowPath` on `runDeclarativeDelivery`). The
executor does not change with the file.

`runDelivery` remains the checked model of the same outcomes. `harness-deliver` is
the entry and runs the file. The daemon does not put an ordinary turn through it.

Copy-on-write here means `git worktree add` (one object store) plus a symlink to the
dependency install. Each worktree is a non-cone sparse checkout of that task's
paths, set before the checkout, so the rest of the tree stays in the index and off
the disk. The main worktree is left dense. A copied install is a failure, and the
worktrees come down. This filesystem has no reflink, so the cache is a symlink
rather than a second copy.

The policy is data (`packages/platform-native/data/delivery-policy.json`). The
reserve of free disk is at least one byte, and the shipped reserve is 2 GiB. A
sample on a cap is allowed. A sample past a cap, or below the reserve, refuses and
the live worktrees are removed. Caps cover extra disk, free disk, memory, tokens,
elapsed time, gpu, and how many worktrees a run may hold.

Verification is three checks: the local gates, the repository pre-commit hook, and
the budget on a fresh sample. The author's review is a comment. An approval is not
a pass. A squash has one parent. After it lands, the next branch is rebased onto
that commit and must contain only its own commit. The worktree is removed, and a
worktree that is still there, or a disk sample that grew, stops the run.

A link that fails halfway removes the worktrees it already created inside the host,
before the executor marks them live. After a link returns, every task is live, and
a cache that is not a symlink brings those worktrees down.

## Why this is not a code-mode workflow

ADR 0002's workflows are code the host journals and resumes. This document is data
with a closed set of actions. It is not a `WorkflowHost` program. The checks sit in
the actions, so the file cannot turn off the hook inside commit or a budget refusal
from a tool that ran.

## Non-goals

Budgets across descendant agent calls stay a separate feature. The delivery budget
is the resources of this run. Graphite is not required; the stack is a GitHub pull
request base, or a local commit when no remote is named.
