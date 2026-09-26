---
name: live-validation
description: >
  Prove a change works end to end against real dependencies before calling it
  done. Use when a change touches a pipeline, integration, build/deploy path,
  gate or check, CLI/onboarding flow, or UI flow, and when defining a phase's
  exit bar.
---

# Live validation

Unit tests, review, and `make verify` validate logic in isolation. Every serious
bug in software-factory's pipeline (a sandbox mount that broke commits, a gate
that silently skipped itself, a budget that overran its ceiling, a missing
`usePathUrlStrategy()`) passed all three and only surfaced on a real run. A
green suite is evidence the *logic* is right, not that the *system* works.

## Steps

1. **Pick the live target.** The real binary, real network/model route, real
   git, a real (disposable) target repo or dataset — not fixtures. A new
   heuristic or check runs against at least one real, messy input; synthetic
   fixtures are shaped to pass.
2. **Check preconditions first.** Probe that each dependency is reachable
   and ask it what it offers (list available models, versions, endpoints)
   instead of assuming. A stale hostname or DNS entry looks exactly like a
   dead service; try the alternate route before calling it down. Then do one
   small scoped run before the big one.
3. **Script it.** One command (`make live-smoke`, `scripts/<name>-walk`) that
   drives the real entry point end to end and reports pass/fail per step. Keep
   it out of the fast unit suite; it needs real services and takes minutes.
4. **Run the user's path, not yours.** Start from what a user would type or
   click: copy-paste every command the help text, README, or error message
   tells them to run. A documented command, flag, or target that doesn't exist
   is a recurring bug class.
5. **Judge the outcome, not the exit code.** Check the artifact the user wants
   exists and is right (the PR opened, the file written, the row stored, the
   page renders), and confirm from the run's own echoed state (printed
   config, labels, its state file) which variant actually ran; a mistyped
   config key can silently fall back to defaults. Exit 0 from a verify step that re-ran pre-existing tests is
   not success. For UI, look at the screenshots yourself. A retry that fails
   at the same spot again is a bug to investigate, not flakiness.
6. **Record it.** Dated write-up in the project's notes repo: setup, timed
   step list (mm:ss), pass/fail, numbered findings. Carry the numbers forward
   so the next run says "#6, #7 confirmed fixed". If the harness deletes its
   scratch data after a pass, keep the evidence without editing the harness:
   point its binary variable (e.g. `FACTORYD_BIN`) at a small wrapper that
   runs the real binary, then copies each run record aside.
7. **Serialise shared resources.** One live run at a time against any
   single-instance dependency (local model server, device, shared DB),
   including runs started by parallel subagents.

Done when the scripted run passes on the current commit and the write-up exists.

## Exit bars

A plan phase names its bar *before* work starts, as something a run can
check: "N/N walk steps pass", "time to first PR < 15 min", "0 hand edits",
"16/16 accepted, 0 false accepts". Track the rate over dated runs; a rising
number is the signal the system is improving, since review alone has no
natural stopping point.

## Controls and comparisons

- Before trusting a new check, harness, or container pipeline, push a
  known-good and a known-bad input through the *real* environment. A missing
  binary inside the container can fail silently and read as "the fix was
  wrong".
- An A/B comparison (two configs, models, or harness arms) needs a confound
  check: make sure nothing shared (the repo's own AGENTS.md, a global hook)
  already forces the behaviour you are isolating. Claim a guardrail works only
  with a with/without ablation, not one run.

## Test oracles

- Assert against an independently known expected value: a spec's published
  vectors, a reference implementation's output, a hand-computed case. An
  assertion on a value the same change computed proves nothing.
- When a reference exists (an RFC's test vectors, a second tool doing the same
  job, the old implementation), add a differential check against it.
- Keep a bug → regression-test index for every live-found bug, so "what proves
  this stays fixed" is one lookup.

## Background processes

Launch long runs with the Bash tool's `run_in_background: true` and no trailing
`&`. Verify the real process by PID or container, not by the tool's
"completed" status. On failure, read the actual log or exception before
theorising; if the failure left no evidence (empty log, lost artifact), fix
that first.
