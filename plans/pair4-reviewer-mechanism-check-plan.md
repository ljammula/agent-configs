# Pair-4 (go-flutter/bookmarks-app) reviewer mechanism check — plan

**Status: reviewed by Opus, pre-registered, not yet executed.**

## Origin

Last open item from `pi-harness-validation-status.md`'s acceptance-boundary
list: "Reviewer-candidate batteries: pair 4 (go-flutter/bookmarks-app) needs
a full paired rerun, not just an isolated bug repro, before any
candidate-model claim beyond n=1."

## What this is not

Not a statistics run. The primary model's own unaided base rate on this
task's race condition (2/5, from the KAT-Coder investigation) has a
binomial 95% CI of roughly 5-85% — even the history's own "roughly 8-10
paired runs" target is under-powered against a base rate that uncertain.
No affordable number of additional pair-4 reruns produces a real
candidate-model capability claim. That half of the original open item is
being deliberately dropped, not pursued.

## What this is

A mechanism check. The 2026-08-04 history entry found `cross-model-
review.ts`'s reactive `tool_result` trigger structurally cannot fire on
`local-model-bench` tasks, because hidden tests don't exist during the
model's own session — no route/model/timeout fix could change that, only
a design change could. That design change (a settlement-time trigger) now
exists and is separately live-confirmed on a different task (2026-08-12).
The open, unanswered question: under real battery methodology (fixture
copy-in, hidden-test-after-exit, actual `execute_arm()` scoring), does the
harness arm now emit a genuine `cross-model-review` trace on pair 4, where
it structurally could not five weeks ago? This is binary — n=1 settles it.

## Corrected bookkeeping

Pair 4 already has **three** real Qwen-primary harness data points, not
two: original battery (fail), same-day standalone rerun (fail), and the
2026-08-04 full-harness run with Gemma-as-reviewer and the 240s timeout
already applied, which **passed** both `go test -race ./...` (9/9) and
`dart test` (17/17). This run adds a fourth, not a third, and is not being
framed as closing any statistical gap.

## Pre-registered criteria (fixed before running)

- **Primary, decisive at n=1**: harness arm emits a `pi-harness-trace`
  entry with `extension:"reviewer", event:"review", outcome ∈
  {clean,flagged}`. A `blocked`/`transient` outcome or no reviewer trace
  at all means the structural gap persists.
- **Secondary (pass/fail on the hidden tests)**: declared uninterpretable
  in advance. No pass/fail result from this run will be used to support or
  retract any adoption or candidate-model claim.
- **Invalidity, declared in advance**: a killed process, `valid:false` on
  either arm (per `execute_arm`'s own gate), reviewer route unreachable or
  model-id-mismatched, or a concurrently running heavy job on
  `kannasmacstudio.lan` at launch time → discard and redo, don't
  reinterpret.
- **No pooling** with `full-screening-2026-08-03.json` or the 2026-08-04
  run's harness-arm numbers — `REVIEW_TIMEOUT_MS` (120s→240s), the
  settlement trigger, `buildReviewDiff()`'s untracked-file fix, and
  `BROAD_VERIFICATION_PATTERNS` now tolerating `go test -race` (which
  never matched at all during the original battery) are all real harness
  changes since those runs.

## Mechanics

`pi/evals/run_single_pair.py` (new, written): reuses `run_screening.py`'s
actual `execute_arm()` and scoring/trace-parsing code for one named pair
instead of the full nine-task shuffle. Replicates `main()`'s full preflight
(model identity check, pinned `pi --version` == 0.83.0, isolated
`baseline_agent_dir`, runtime manifest) plus one addition `run_screening.py`
itself doesn't do: a reviewer-route check (`AI_REVIEW_BASE_URL`/
`AI_REVIEW_MODEL` resolve and match a live model id on `:8081`), since this
script exists specifically to check whether the reviewer fires.

Confirmed live before running: `AI_REVIEW_BASE_URL=http://
kannasmacstudio.lan:8081/v1`, `AI_REVIEW_MODEL` matches Gemma's live id;
`:8082` references in the 2026-08-04 entries were that route's numbering at
the time, not a live discrepancy today. Pair 4's recorded arm order under
seed `20260802` is `("baseline", "harness")` — this run uses that order.

Invocation:

```
python3 pi/evals/run_single_pair.py --seed 20260802 --pair 4 \
    --host kannasmacstudio.lan --output <artifact dir>
```

Launched detached (`nohup ... & disown`) per the documented mitigation for
the open background-process-kill bug. Expected runtime: prior pair-4 arms
took ~3-6.5 min of actual agent time each; setup (`go mod tidy`,
`dart pub get`) and hidden-test scoring (`go test -race`, `dart test`) add
more; ballpark 20-40 minutes total for both arms.

## After running

Record results as `pi/evals/pair4-rerun-2026-08-13.json` (or actual run
date), update `pi-harness-history.md` with the outcome against the
pre-registered criteria above, and update
`pi-harness-validation-status.md`'s open-items list to reflect the
narrowed scope (mechanism check answered; candidate-model statistical
claim explicitly dropped as infeasible, not left open).

## Review provenance

Reviewed by an independent Opus pass before writing this plan. Original
draft framed this as accumulating paired samples toward a candidate-model
claim (n=2→n=3); Opus's review found that framing wrong (miscounted
existing evidence, and even a much larger n wouldn't be statistically
meaningful given the base rate's own wide CI) and reframed the run around
the mechanism question above, which is what this plan reflects.
