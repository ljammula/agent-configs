---
name: agent-brief
description: >
  Write the brief for a subagent and pick its model tier. Use before any Agent
  call that delegates implementation, debugging, validation, or review, and
  when a delegated agent goes idle without finishing.
---

# Agent brief

## Model tier

| Work | Model |
|---|---|
| Implementation from a decided design; "reproduce → read log → patch → rebuild → rerun" loops | `model: "sonnet"` |
| Routine review: wiring, tests, docs, deletions, UI (an Agent with a review brief: the checks to make, file:line + failure scenario per finding, a word cap) | `model: "sonnet"` |
| Mechanical edits against a known list (docs, claims tables, plans, renames, deletions), log summarisation, status polling | `model: "haiku"` |
| Design passes (read-only, one phase ahead); review of trust-boundary or correctness-critical code (credentials, sandbox/relay, gates, workflow determinism); merge-conflict resolution; final PR judgement | main model; never downgrade |

The main model designs, writes the brief, reviews trust-boundary code,
integrates, and merges. Cheap tiers do the iteration and routine review.

## Brief contents

A brief is complete when a fresh agent could finish without asking a question:

1. **Goal and done criterion** — the observable state that means finished
   (tests green, file X contains Y, command Z exits 0), plus "commit on your
   branch and report the SHA".
2. **Decided design** — files to touch, interfaces, what is out of scope.
   Check the design (a read-only design pass) before writing the brief: most
   fix rounds come from a brief that describes the design imprecisely. In a
   large file, name the exact functions and line ranges instead of letting
   the agent explore it.
3. **Exact commands** — build, test, reproduce, with paths. End the brief
   with the literal verify command and "stop only when it passes". Tell the
   agent to derive domain facts (key names, config fields, API shapes) from
   the source by grep, not from memory. Iterate with targeted tests
   (`go test -run <pattern>` or equivalent); run the full suite once before
   committing and the slow or race variant once before merge. Judge a run by
   its exit status, never by a `head`-truncated grep of its output.
4. **Foreground rule**, verbatim: "Run tests and any long command in the
   FOREGROUND with a 600000 ms timeout on the Bash call; do not use a
   background monitor. To wait on external state, use a foreground `until`
   loop with `sleep`."
5. **Shared resources** — name any single-instance resource the agent will hit
   (a local model server, a device, a port, a database) and say whether it may
   use it now or must wait its turn.
6. **Report format** — SHA, files changed, test result lines, deviations from
   the brief. No narrative: the report lands in the orchestrator's context.

## Checking the result

"Tests pass" is the agent's claim, not proof the work happened. Before
accepting delegated work:

- The files the brief named actually changed and contain the new code (the
  function, key, or route by name). A stalled agent can leave only scaffolding
  while pre-existing tests still pass.
- The diff stays inside the brief's scope; unrelated files riding along get
  reverted or explained.
- "Diagnosed but not fixed" is a failed task, not partial credit.
- New tests assert against an independently known expected value, not a value
  the same change just computed.

## Delegating to Codex CLI

Not for implementation: the budget is small, and its `workspace-write`
sandbox cannot commit in a git worktree (the worktree's `.git` is outside the
writable root), so every result needs a second pass. When the user offers
Codex, spend it on validation runs. If the user explicitly asks for a Codex
implementation anyway, run `codex exec -C <dir> --sandbox workspace-write` in
the background with a long self-contained prompt (what is done, what remains
in dependency order, "don't commit or push"), then rebuild, test and read the
whole diff before committing; its summary is a claim.

## Running several agents

- Serialise agents that share a single-instance resource: spawn the next one
  only after the previous finishes. Parallel Agent calls each start their own
  process, so a one-at-a-time rule written for sequential jobs does not cover
  them. To pause one mid-flight, pause the thing actually making the calls
  (e.g. `docker pause <container>`), not only the host process.
- Run 2-3 agents at a time on disjoint files. More than that caused CPU
  contention (timing-sensitive tests flake) and rebase conflicts on shared
  files. Merge each as soon as it is green so rebase distance stays short.
- Don't route reviews through a single-instance local model: one round takes
  20+ minutes and reviews queue behind each other.
- Each implementation agent works in its own worktree and branch. After its
  branch merges (`git merge-base --is-ancestor <branch> main`), remove it with
  `git worktree remove <path>` and `git branch -d <branch>`. The auto-mode
  classifier blocks *bulk* removal; hand the user a ready `! ...` command for
  that.
- Merge from the main checkout. `gh pr merge --delete-branch` inside a worktree
  fails at local cleanup because `main` is checked out elsewhere.

## Stall recovery

An idle message saying it is "waiting for the monitor/background task" is a
stall. Check whether the command is still running (`ps aux | grep '[g]o test'`
or equivalent). If nothing is running and the worktree is dirty, send the exact
foreground command to run next.

The foreground rule lowers the odds of a stall; it does not prevent one. An
agent's "finished" notice is a claim too: before trusting a report, confirm
the branch has a commit and the worktree is clean.

## Why

- 2026-09-11: five Sonnet agents stalled 15-25 min each waiting on background
  test monitors. Later briefs carried the foreground rule and stalled less,
  but on 2026-09-26 an agent with the rule verbatim still went idle
  "waiting on its own background work" with a dirty, uncommitted worktree.
- 2026-09-22: two parallel agents each drove a live run against the
  single-instance local model at once; caught only because the user asked.
- Sonnet-tier review passes caught a self-referential hash bug and a
  locale-dependent ordering bug in one session — the reason trust-boundary and
  correctness-critical review stays on the main tier.
- 2026-09-27 (buildgate, ten PRs): implementation agents used 200k-950k
  tokens each and reviews 100k-170k per round; about half of agent spend was
  fix rounds from briefs that described the design imprecisely. A read-only
  design pass before the brief caught three plan errors for the price of one
  review. Four parallel agents caused load flakes and a rebase that broke
  `main`; Codex output needed a second pass every time.
