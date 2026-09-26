---
name: agent-brief
description: >
  Write the brief for a subagent and pick its model. Use before delegating
  implementation, debugging, validation, or review to a subagent (fleet mode,
  a task, /delegate), and when a delegated task stalls without finishing.
---

# Agent brief

## Model tier

| Work | Model |
|---|---|
| Implementation from a decided design; "reproduce → read log → patch → rebuild → rerun" loops | a mid-tier model (e.g. Sonnet) |
| Log summarisation, status polling, mechanical low-stakes edits | the cheapest capable model (e.g. Haiku) |
| Adversarial review, correctness-critical validation, merge-conflict resolution, final PR judgement | the session's main model; never downgrade |

The main model writes the brief, reviews the branch, integrates, and merges.
Cheap tiers do the iteration.

## Brief contents

A brief is complete when a fresh agent could finish without asking a question:

1. **Goal and done criterion** — the observable state that means finished
   (tests green, file X contains Y, command Z exits 0), plus "commit on your
   branch and report the SHA".
2. **Decided design** — files to touch, interfaces, what is out of scope.
3. **Exact commands** — build, test, reproduce, with paths. End the brief
   with the literal verify command and "stop only when it passes". Tell the
   agent to derive domain facts (key names, config fields, API shapes) from
   the source by grep, not from memory.
4. **Foreground rule**, verbatim: "Run tests and any long command in the
   FOREGROUND with a long timeout; do not start it in the background and
   wait for a notification. To wait on external state, use a foreground
   `until` loop with `sleep`."
5. **Shared resources** — name any single-instance resource the agent will hit
   (a local model server, a device, a port, a database) and say whether it may
   use it now or must wait its turn.

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

Only when the user asks, and only for a large, mechanical task extending an
existing pattern (e.g. seven tool families shaped like one that exists).
Run `codex exec -C <dir> --sandbox workspace-write` in the background with a
long self-contained prompt: what is done, what remains in dependency order,
constraints ("don't commit or push"). Then rebuild and test from scratch and
read the whole diff before committing; its summary is a claim. It shares the
Codex budget, so confirm budget first.

## Running several agents

- Serialise agents that share a single-instance resource: start the next one
  only after the previous finishes. Fleet-mode subagents each start their own
  process, so a one-at-a-time rule written for sequential jobs does not cover
  them. To pause one mid-flight, pause the thing actually making the calls
  (e.g. `docker pause <container>`), not only the host process.
- Each implementation agent works in its own worktree and branch. After its
  branch merges (`git merge-base --is-ancestor <branch> main`), remove it with
  `git worktree remove <path>` and `git branch -d <branch>`. The auto-mode
  classifier blocks *bulk* removal; hand the user a ready `! ...` command for
  that.
- Merge from the main checkout. `gh pr merge --delete-branch` inside a worktree
  fails at local cleanup because `main` is checked out elsewhere.

## Stall recovery

A task that reports it is "waiting for the background task/monitor" is a
stall; check it with `/tasks`. Check whether the command is still running (`ps aux | grep '[g]o test'`
or equivalent). If nothing is running and the worktree is dirty, send the exact
foreground command to run next.

## Why

- 2026-09-11 (Claude Code): five Sonnet agents stalled 15-25 min each
  waiting on background test monitors; briefs carrying the foreground rule
  never stalled.
- 2026-09-22: two parallel agents each drove a live run against the
  single-instance local model at once; caught only because the user asked.
- Sonnet-tier review passes caught a self-referential hash bug and a
  locale-dependent ordering bug in one session — the reason review stays on
  the main tier.
