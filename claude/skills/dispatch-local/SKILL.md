---
name: dispatch-local
description: >
  Delegate a mechanical, well-specified coding task to a locally-served model
  (via Aider) instead of doing the edit yourself, then review the diff it
  produces. Only relevant on machines running a local model-serving stack
  (e.g. ai-stack) with `scripts/dispatch_local.sh` present — check it exists
  before using this skill. Trigger when the user says "use the local model
  for this", "dispatch this to the local harness", "have Aider/the local
  model do this", or when a task is boilerplate/pattern-following enough
  that a smaller/local model can execute it under supervision (scaffolding,
  repetitive edits, test-writing from a clear spec) rather than needing your
  own judgment throughout.
---

# Dispatch Local

Splits work into planner (you) / executor (local model) roles. You are not
handing off judgment — you write the spec, the local model executes it, you
review the result. This is NOT for tasks requiring architectural decisions,
ambiguous requirements, or multi-step debugging: local models in this setup
reliably self-correct syntax/mechanical mistakes but do not reliably
self-correct logic bugs (verified against Qwen3.6-27B and Qwen3-Coder-Next —
see the owning project's PLAN.md for the writeup this skill is based on).

## Step 0 — check the harness exists

```bash
test -x ~/code/ai-stack/scripts/dispatch_local.sh && echo present
```

If absent, this skill doesn't apply on this machine — fall back to doing the
edit yourself.

## Step 1 — write a tight, unambiguous spec

Put it in a plain text file. Vague specs produce vague (or wrong) code —
this model tier does not fill gaps in judgment the way a stronger model
would. Include: exact function/file names if they matter, the expected
behavior, and edge cases you care about. If there's a convention to follow
in the target repo (e.g. an existing similar feature), point to it via
`--read`.

## Step 2 — dispatch

```bash
~/code/ai-stack/scripts/dispatch_local.sh \
  --repo <target-repo-path> \
  --spec <spec-file> \
  --test-cmd "<command that runs the relevant tests>" \
  --read <comma-separated,reference-only,files> \
  --files <comma-separated,editable,target,files>
```

`--test-cmd` matters: it enables Aider's auto-test loop, which is what lets
the local model self-correct mechanical mistakes (missing imports,
unqualified calls, etc.) without you intervening.

## Step 3 — review the diff, don't trust a green run

The script prints the diff and commit log after running. A passing test run
does not mean the logic is correct — only that the tests that exist pass.
Read the diff yourself, or route it through a stronger model for review,
especially for anything beyond syntax-level correctness.
