# `build_app.py` — zero-human full-stack build orchestrator

Give it a spec and an empty (or existing) workspace directory; it drives
`pi -p` through as many corrective rounds as it takes to get real,
current-diff-bound verification evidence and independent review passing, with the installed pi
harness (quality-gate, cross-model-review, git-safety, protected-paths,
stack-router, new-project-scaffold, etc. — whatever `~/.pi/agent` has
installed) doing the in-session hardening. No chat interaction at any
point; the record of what happened is `BUILD_REPORT.md`, written into the
workspace whether the build succeeded or the round budget ran out.

## Why an outer orchestrator, not just `pi -p` once

`quality-gate.ts` and `cross-model-review.ts` deliberately report their
settlement results without trying to inject in-band corrective turns. A
zero-human pipeline still needs to act on those results. `build_app.py`
does that outside the session: it treats every `pi -p` invocation as
possibly final, runs the same canonical verification resolver used by
`quality-gate.ts`, consumes reviewer and `stall-timeout` traces, and starts
a fresh `pi -p --continue` round when any required signal is not clean —
the same shape as the already-proven
`PiHarness.run()` bounded-follow-up fix in `local-model-bench`
(commits `8531917`/`dfe4620`), generalized from
"context-budget-exceeded" endings to "verification still failing"
endings.

The independent reviewer (`cross-model-review.ts`) now also fires a
settlement-time backstop round (added 2026-08-09) even if the model never
runs a broad verification command itself inside the session, so review
coverage doesn't silently depend on the model happening to run one.

## Why `workspace/` is its own git repo

`ticket_runner.py`'s pilot dir holds two git repos, deliberately:

```
pilot/                     <- control repo
  .gitignore               <- ignores workspace/ and .ticket_runner.lock
  Makefile                 <- human entry point: make run / status / reports
  spec/
    contract.md
    tickets/               <- 001-*.md ... NNN-*.md
    acceptance/NNN/        <- CANONICAL acceptance tests (the oracle)
  reports/ticket-NNN/      <- gate.json, build.log, archived BUILD_REPORT.md
  workspace/               <- app repo, created by ensure_git_repo()
    Makefile               <- the app's own verify / verify-full
    spec/contract.md       <- staged copy
    acceptance/            <- staged copies of slices <= current ticket
                              (Go; Dart stages into app/test/)
    ARCHITECTURE.md, PROGRESS.md, app source
```

The split is an adversarial boundary, not organization. Four things
depend on it:

1. **Oracle integrity needs two copies.** `stage()` copies canonical
   acceptance tests from `spec/acceptance/NNN/` into the workspace
   (`acceptance/` for Go, `app/test/` for Dart, per `STAGED_EXTENSIONS`);
   `oracle_drift()` then compares them to catch the agent
   editing its own tests to make them pass. With one copy there is
   nothing to compare against and the check evaporates. Same shape for
   `check_verify_surface_frozen()` / `save_verify_baseline()`.
2. **The agent's cwd is `workspace/`**, so the ground truth is out of
   reach. `stage()` only materializes slices `<= upto`, so on ticket 001
   the agent cannot read ticket 007's acceptance test, the other tickets,
   or its own gate records.
3. **Two histories.** The runner derives its position purely from the
   workspace log — `commit_sha_for()`, `committed_ticket_numbers()`, and
   `prior_boundary_sha()` all expect a history of exactly
   `ticket(NNN): <slug>` commits, with no control-repo commits or gate
   records interleaved into the range the gate diffs.
4. **The deliverable ships clean.** `workspace/` *is* the app; its history
   is already what you would want to hand off.

### Why not one repo at pilot level

Viable, but it converts structural guarantees into discipline. Every diff
consumer (`cross-model-review.ts`, `quality-gate.ts`, `artifact-guard.ts`)
runs with `cwd=workspace` and would resolve to the pilot root, sweeping
`reports/` into the diff — so each would need a `-- workspace/` pathspec
forever, and a missed one fails silently. The model's `git add -A` (the
reason `.pi-build-session/` and `BUILD_REPORT.md` are gitignored before
the first turn) would reach `spec/acceptance/` canon, demoting "the agent
cannot touch the oracle" from a fact to a gitignore that has to stay
correct. And the app's history becomes entangled with the pilot's, so it
can no longer be handed off without a `filter-repo` pass.

### The nesting is a known tax

The *split* is load-bearing; the *nesting* is not. Because `workspace/`
starts as a plain subdirectory of the control repo, any git command run
with `cwd=workspace` silently answers from the ancestor until
`ensure_git_repo()` creates the real repo. That single fact produced the
nested-repo bug in `ensure_git_repo()` and the foreign-base-sha bug in
`prior_boundary_sha()`, and the guard against it now has to live in two
files that must agree (`ensure_git_repo()` here, `has_own_git_repo()` in
`ticket_runner.py`). A sibling layout (`pilot/` and `app/` as peers, each
its own repo) would keep every guarantee above and remove that class of
bug outright. Not worth migrating existing pilots for; worth doing if the
pilot layout is ever cut fresh.

## Usage

```bash
python3 pi/scripts/build_app.py \
  --workspace /path/to/app \
  --spec /path/to/spec.md \
  --max-rounds 3 \
  --timeout-minutes 45 \
  [--thinking off|minimal|low|medium|high|xhigh] \
  [--review-policy required|degraded|advisory] \
  [--sonnet-fallback] \
  [--containment]
```

- `--spec` should live **outside** `--workspace` (or be added to
  `--workspace`'s `.gitignore` before the first round) — the script writes
  its own `.pi-build-session/` and `BUILD_REPORT.md` into the workspace
  and gitignores those automatically, but it does not manage where you put
  the spec file itself.
- `--containment` is currently **unusable, by design, not a bug**: the
  script refuses it immediately (before any round runs, no
  `BUILD_REPORT.md` produced) because `run-contained.sh`'s network-denied
  profile (`--network=none`, live-proven 17/17 escape checks: workspace-
  only writes, no host creds/socket, no network, `/tmp` noexec, no-new-
  privileges) has no path to this machine's LAN inference service, and
  this script only knows how to drive `pi` through the `ai-stack-local`
  provider. Passing the flag today is guaranteed to exit before doing
  anything. See `pi/containment/README.md`'s network-denied section; this
  will become usable once a reviewed relay/proxy provider exists for the
  container, not before.
- Thinking inherits the installed `settings.json` policy when `--thinking`
  is omitted (currently `medium`). The flag is only an explicit experiment/
  reproduction override; the orchestrator no longer silently forces the
  correctness-regressing `off` setting.
- Independent review is required by default for direct `build_app.py` use. A
  flagged verdict starts a corrective round; an unavailable verdict prevents
  success. `--review-policy degraded` permits a labeled success when review is
  unavailable, but a flagged verdict still blocks. `--review-policy advisory`
  keeps running and recording review while allowing canonical verification to
  determine success; this is the default policy selected by `ticket_runner.py`.
- `ticket_runner.py --review-policy required` is the explicit strict mode for
  release-hardening runs. The normal ticket workflow uses advisory review so a
  mis-scoped or low-confidence reviewer flag does not consume the bounded
  builder budget, while the verdict remains available in the archived report.
  Gate evidence records the policy used; a later strict run rebuilds tickets
  whose passing evidence was produced under a weaker policy.
- `--sonnet-fallback` explicitly authorizes one billed
  `claude-sonnet-5` corrective pass after the bounded local rounds are
  exhausted. Without it, the report exits non-zero with `escalation
  required` rather than spending cloud tokens silently.
- Exit code 0 requires canonical verification plus the selected review
  policy, or a successful explicitly authorized Sonnet fallback. Non-zero
  includes exhausted corrective rounds, timeouts, unavailable required
  review, and an unresolvable canonical command.

## `goal_pilot.py` — outermost loop: idea in, app out

One invocation drives the entire pipeline end to end, using the local
model for every judgment step: `/spec-plan` (draft spec + tickets) → a
human checkpoint (spec freeze, never skippable) → `/contract-plan`
(contract + acceptance suite) → another checkpoint → `ticket_runner.py`'s
build loop → halt/rescue handling → a verdict report. See
`plans/goal-pilot-skill-plan-2026-08-21.md` for the full design and its
reasoning; summary here is deliberately thin so the two don't drift.

```bash
python3 pi/scripts/goal_pilot.py \
  --spec-input /path/to/rough-idea.md \
  --pilot-dir ~/code/pilots/my-app \
  [--checkpoint review|skip]       # default: skip
  [--on-halt report|auto-rescue]   # default: auto-rescue
  [--review-policy advisory|required|degraded]  # default: advisory
```

- `--spec-input` accepts either an existing file path or literal rough-
  input text (written to a scratch file inside the pilot dir on first use,
  then reused as-is on every resume).
- `--checkpoint=review` pauses after `/contract-plan` and shows its self-
  check output verbatim, asking you to bring the draft to a separate cloud
  session for review-and-correct before proceeding (per `/contract-plan`'s
  own required, human-triggered design) — `skip` proceeds on the local
  self-check alone, logging that decision into `EXECUTION_LOG.md`
  unconditionally either way. The spec-freeze checkpoint and the
  post-ticket-001 checkpoint are outside this flag and are never
  skippable.
- `--on-halt` governs three halt classes differently, not uniformly:
  infra halts (a dead model route, a recoverable crashed process) auto-
  retry under `auto-rescue`; frozen-artifact-canon drift (a correct fix to
  a genuine bug in a frozen verify-surface file or acceptance oracle)
  *never* auto-applies regardless of `--on-halt` and always routes through
  `ticket_runner.py --amend-canon` after a human decision; a genuine
  implementation gap gets exactly one bounded, unconditionally-local
  widened retry (`build_app.py --max-rounds 6 --timeout-minutes 90
  --thinking xhigh`) under `auto-rescue`, never a cloud escalation.
- Resume is disk-state-driven, same idempotent pattern as everything else
  in this pipeline: re-invoking `goal_pilot.py` against an existing pilot
  dir picks up wherever `spec/spec.md`'s `STATUS:` line, the
  `spec/.compile-complete` marker, and `ticket_runner.py`'s own
  `git log`-derived position say to.
- `ticket_runner.py --stop-after-ticket N` (added alongside `goal_pilot.py`)
  is the one narrow exception to that script's own "no gate-logic
  changes" rule -- additive control flow so `goal_pilot.py` can honor the
  post-ticket-001 checkpoint without SIGTERM-ing a running build.
- Every rescue `goal_pilot.py` performs — auto or human-approved — is
  logged unconditionally to `EXECUTION_LOG.md` and `.goal-pilot/
  rescues.jsonl`, and the final `VERDICT.md` states the rescued count by
  class. Zero cloud tokens are spent on implementation at any point.

## Current validation status and remaining gaps

- Verification resolution is no longer duplicated in Python:
  `resolve-verification.ts` calls `lib/verification.ts` directly, including
  nested manifests and Flutter-vs-Dart detection. A Python integration test
  proves that either of two nested components failing prevents acceptance.
- Review coverage still depends on `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL`.
  Missing/broken review fails closed for the required policy, is explicitly
  labeled for degraded policy, and is recorded without blocking for advisory
  policy.
- Reviewer flags, canonical verification failures, Pi failures/timeouts, and
  `stall-timeout` traces now all feed the bounded corrective loop. The
  optional Sonnet command path is deterministic-tested but has not yet been
  spent or live-validated by this change.
- One real end-to-end smoke run so far (2026-08-09, Go/net-http/health-
  endpoint task, no `--containment`): round 1 succeeded outright —
  `quality-gate` verified, `cross-model-review` fired via its
  `tool_result` trigger and returned `clean`, git commit made. That's a
  single confirming repro, not a battery. The new reviewer/stall-driven
  corrective policy and Sonnet fallback remain source/integration-tested,
  not live battery evidence; `--containment` and non-Go full builds remain
  unexercised.
- `goal_pilot.py` is unit-tested (halt classification, checkpoint/resume
  markers, the ticket-1-phase/remainder halt-loop sharing) but has not yet
  had a real end-to-end pilot run driven through it start to finish —
  unlike `build_app.py`/`ticket_runner.py`, which the 2026-08-20
  `budget-pilot` run exercised live across all 12+4 tickets. Treat it as
  implemented-and-tested, not yet field-proven.
