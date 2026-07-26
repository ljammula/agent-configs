# pi harness — consolidated validation status

**As of 2026-07-26.** This supersedes nothing by deleting it — it exists
because the real story is split across ~10 documents in two repos
(`agent-configs`, `ai-stack`) written at different points in the same
investigation, and at least one of them was overtaken by events before it
was ever committed. This file is the single place to check current state;
the source documents cited throughout remain the evidence trail.

No new testing was done to produce this document — it is a reconciliation
of existing evidence, checked against what's actually on disk (git logs,
`scratch-phase-validate/results.tsv`, extension source) as of today, not a
restatement of any one prior doc's framing.

## Summary

Of the harness's judgment-dependent extensions, one is adopted on solid
retrospective evidence (`co-change-suggest.ts`), one is adopted but has
already flipped verdict once and rests on single-digit-n
(`cross-model-review.ts`), and one is kept installed but inert because it
has never once fired in a real trial (`continuation-nudge.ts`). The
deterministic extensions (`protected-paths.ts`, `format-on-edit.ts`,
`rtk-rewrite.ts`, `git-checkpoint.ts`, `git-safety.ts`) don't need the same
kind of battery and aren't in question. The validation harness itself
(`scratch-phase-validate/`) took five attempts to produce one clean batch,
each earlier attempt killed by a different real bug. Separately, one full
real-world feature dispatch was analyzed in depth and produced three
concrete fixes. None of the plan's original full-scale kill criteria
(seeded-fixture batteries, live non-retrospective validation) have been
run — every verdict above is real evidence at small n, not a settled
battery.

## What worked

- **`co-change-suggest.ts` — adopted, 2026-07-24.** Real retrospective
  replay against `personal-assistant` (782 commits, real historical
  dispatch). Found and fixed a real seed-selection bug along the way; with
  the fix and real diff-derived identifiers, the target file ranked **#1
  of 8**. Correctly produces no signal on a generic paraphrase (expected
  scoping limit, not a bug).
- **`cross-model-review.ts` — adopted, 2026-07-25, reviewer =
  gemma-4-31B-it-OptiQ-4bit.** Caught the exact known bug the original
  Qwen-family reviewer missed (once a bounded-reasoning prompt fix was
  applied), then separately caught a second, unseeded real bug
  (unbounded `order`-slice growth) on an organic smoke run. The
  bounded-loop rewrite that followed passed 14/14 unit assertions,
  including the adversarial near-miss case, and improved on (not just
  matched) the original disablement case in a regression check. Full
  timeline in "Historical log" below — the verdict here has already
  flipped once, so it's worth reading in full before trusting it.
- **`protected-paths.ts`** caught a real escape attempt live: asked to
  write `main.go` in a temp dir, Qwen3.6-27B emitted an absolute path to
  an unrelated directory; the guard corrected it and the model retried
  correctly.
- **`git-safety.ts` — adopted, 2026-07-25.** Reproduced the exact `git
  reset --hard main` command that caused its creation, against a scratch
  repo; confirmed blocked, repo untouched.
- **The batch validation harness eventually produced one genuinely clean
  27-run batch** — verified today: `results.tsv` on disk has 27 rows,
  `ext_errors` is 0 throughout, no connection errors.
- **The one real end-to-end feature dispatch** (daily-briefing-screen)
  had genuinely good code shape and convention-following, including one
  unprompted refactor judgment call not in the spec.

## What didn't work

- **`continuation-nudge.ts` has fired zero times in ~46 real trials plus 2
  targeted attempts** — every trial to date used the trigger's original,
  narrower form (forward-looking prose only). It was widened 2026-07-25 to
  also catch a silent empty-content stop, the actual failure mode observed
  once for real, but that widened path has not been exercised in a single
  real trial since.
- **`cross-model-review.ts`'s first reviewer (Qwen3.6-35B-A3B) missed a
  known, spec-violating bug twice, at temperature 0** — the initial reason
  for disabling it, before the reviewer was swapped to a different model
  family.
- **The batch validation harness took four discarded attempts to reach one
  clean run**, each killed by a different real bug: a hardcoded `tests/`
  subdirectory that broke Go package resolution; a silent
  `sendUserMessage` delivery failure that made *both*
  judgment-dependent extensions no-ops for two entire batches without ever
  surfacing an error; hidden tests exposed to the model before its run
  instead of after; and a scheduled-inference-jobs window on the serving
  box that produced 19 straight connection-error failures misleadingly
  recorded as results.
- **The one real feature dispatch needed 3 attempts, not 1**: it ran an
  unprompted destructive `git reset --hard` to resolve a self-inflicted
  branch conflict; silently stopped short of its own stated completion
  condition once, with no tool call and no explanatory text; and shipped a
  real, gate-missed l10n duplicate-key bug that `make verify` did not
  catch. Its own bottom line — "the harness reduced typing, not review
  load" — has not been re-tested since the three fixes it produced landed.
- **A review-feedback document sat untracked in this repo for two days
  making a claim that had already been overtaken by events** (see "Stale
  documents" in Historical log) — a concrete instance of the staleness
  risk this whole consolidation exists to catch.

## Todo

- **`cross-model-review.ts`'s full Phase 2 kill criterion** — a 3-task
  real-feature battery with deliberately-seeded wrong-but-plausible
  fixtures — has never been run. Everything adopted so far is real but
  single-digit-n per bug class, on effectively one task family
  (`lru-cache`).
- **`co-change-suggest.ts`'s live (non-retrospective) validation** — "try
  it live on one new personal-assistant feature task," the second half of
  the plan's own kill criterion, has not been run.
- **`continuation-nudge.ts`'s widened trigger has zero field validation.**
  Needs real trials post-2026-07-25 before its empty-content-stop path can
  be said to work, not just to type-check.
- **Fable's 2026-07-24 methodology concerns remain unaddressed**: no arm
  randomization in the batch harness, underpowered sample sizes, a
  narrow/self-referential two-task set, and the 180s-watchdog /
  review-timeout interaction. These apply to every live-run number cited
  in this document, not just the ones current when Fable wrote the review.
- **`NO_ISSUE_MARKER`'s broader false-positive risk is still unmeasured.**
  The bounded-loop rewrite's formatting-only tolerance narrows this but was
  explicitly scoped to formatting drift, not the semantic near-miss case
  Fable's review flagged generally.
- **Known cleanup items, not urgent**: hard-coded model path in
  `cross-model-review.ts`, duplicated `VERIFICATION_COMMAND_PATTERNS`
  across two extension files (per Fable's §4).

## Historical log

### `cross-model-review.ts` in full — the verdict has flipped once, on real evidence, and could again

1. **2026-07-24, reviewer = Qwen3.6-35B-A3B.** One real test: fed the
   extension's actual code a real diff with a known, spec-violating bug
   (LRU cache — `Put()` on an existing key doesn't promote it to MRU; the
   hidden test suite catches this). Reviewer returned `NO_ISSUES_FOUND`,
   reproduced twice at temperature 0. **Disabled**, moved to
   `disabled-extensions/`.
2. **2026-07-24, same day, reviewer swapped to gemma-4-31B-it-OptiQ-4bit**
   on the hypothesis that same-family (Qwen+Qwen) review shares blind
   spots. First attempt degenerated (empty `content` field, garbled
   reasoning, twice) — traced to unbounded reasoning length, not a
   capability ceiling (control prompt worked fine). Fixed with a
   one-line "keep reasoning short" prompt addition; re-ran the identical
   known-bug case twice — Gemma caught it both times, byte-identical
   output. **Re-adopted** on this basis.
3. **2026-07-25, moved back into `extensions/`.** A separate live smoke
   run (organic, non-seeded model output on `lru-cache`) had the Gemma
   reviewer catch a second real bug the test suite also missed
   (unbounded `order`-slice growth on repeated `Put`s) — an unseeded
   catch, a stronger signal than a seeded reproduction, still n=1.
4. **2026-07-25, bounded-loop rewrite** (`cross-model-review-bounded-loop-plan.md`,
   reviewed by Fable before implementation). Replaced the one-shot
   boolean with a 3-round cap, outcome-typed `runReview`, and
   formatting-only marker tolerance. Validated:
   - 14/14 mocked-`ExtensionAPI` unit assertions (cap enforcement, clean
     short-circuit, unchanged-diff skip, tolerant marker matching across
     5 wrapped forms, and the adversarial near-miss case — a real
     finding phrased "No issues found... but ..." correctly resolves to
     `flagged`, not `clean`).
   - Regression check: replayed the original 2026-07-24 disablement case
     against the current code — Gemma now catches it (confirmed
     improvement, not just non-regression).
   - 3 live end-to-end runs on `lru-cache`: 3/3 exercised round 1
     correctly; 1/3 exercised a real round-1→round-2 progression on a
     genuine fix; the cap-hit (round 3) and clean-short-circuit branches
     were exercised only by the unit harness, not live.
   - Cost check: the review call measured 73.5s on a real ~40KB
     multi-file diff from `personal-assistant`, exceeding the
     then-current 60s timeout — raised to 120s as a direct result.

### Full extension-by-extension table

| Extension | Status | n | Evidence |
|---|---|---|---|
| `protected-paths.ts` | Adopted (vendored, on by default) | 1 live catch | Caught Qwen3.6-27B emitting an absolute path outside the working dir; corrective retry worked. No formal battery — deterministic guard, low complexity. |
| `format-on-edit.ts` | Adopted (vendored, on by default) | — | No battery; deterministic gofmt/dart-format pass, not a judgment call. |
| `rtk-rewrite.ts` | Adopted (vendored, on by default) | — | No battery; deterministic bash-output filter. |
| `git-checkpoint.ts` | Adopted (vendored, on by default) | — | No battery; deterministic per-turn snapshotting. |
| `co-change-suggest.ts` | **Adopted**, 2026-07-24 | 1 real retrospective case | Real retrospective replay against `personal-assistant` (782 commits, real historical dispatch). Found and fixed a real seed-selection bug along the way. With the fix and real diff-derived identifiers, target file ranked **#1 of 8**. Correctly no-signal on a generic paraphrase (expected scoping limit, not a bug). **Not done**: the plan's second half of its kill criterion — "try it live on one new personal-assistant feature task" (forward-looking, not retrospective) — has not been run. |
| `continuation-nudge.ts` | **Not adopted**, kept loaded as a no-cost no-op | 0 firings / ~46 real trials + 2 targeted attempts | Fired zero times outside mocked unit tests across every real trial run to date. Widened 2026-07-25 to also trigger on a silent empty-content stop (the actual failure mode observed once, for real, in the daily-briefing-screen dispatch — narrower than what the original prose-pattern trigger covered). **Not done**: every one of the ~46+2 real trials predates the 2026-07-25 widening and used the old, narrower trigger only. The new empty-content trigger path has zero real-trial exercises to date — it is unit-tested, not field-tested. |
| `cross-model-review.ts` | **Adopted**, 2026-07-25 (reviewer = gemma-4-31B-it-OptiQ-4bit on :8081; previously disabled 2026-07-24 with Qwen3.6-35B-A3B as reviewer) | see above | Verdict flipped once already based on real evidence — see the full timeline above, not just this row. |
| `git-safety.ts` | Adopted, 2026-07-25 | 1 scratch-repo reproduction | Reproduced the exact `git reset --hard main` command that triggered its creation, against a scratch repo; confirmed blocked, repo untouched. Single reproduction, not a battery — the command class is small and deterministic (`reset --hard`, `push --force` w/o lease, `clean -f`, `branch -D`, `checkout/restore -- .`), which is why one clean repro is treated as sufficient here unlike the model-judgment extensions above. |
| Phase 4 (Aider-based failing-test retry) | **Deliberately not built** | n/a | Gated by the plan itself on Aider dispatch being back in scope. It isn't: `~/.claude/CLAUDE.md` and `agent-configs/pi/AGENTS.md` both record that `dispatch-local` was benchmarked and removed (cost more Anthropic tokens, ran 5-10x slower than editing directly — see `local-model-bench/STATUS.md`). Correctly out of scope, not a gap. |

### Harness infrastructure: what's actually been proven to work

- **The `scratch-phase-validate/` batch harness produced exactly one
  genuinely clean 27-run batch**, verified today: `results.tsv` on disk
  has 27 data rows, `ext_errors` is 0 in every row, and no `Connection
  error` entries — consistent with the "Fifth attempt superseded"
  narrative in `local-quality-next-steps-status.md`. Getting here took
  four earlier discarded batches, each invalidated by a different real
  bug: a hardcoded `tests/` subdirectory that broke Go package
  resolution; a silent `sendUserMessage` delivery failure that made
  *both* judgment-dependent extensions no-ops for two entire batches
  without ever surfacing an error; hidden tests exposed to the model
  before its run instead of after; and a scheduled-inference-jobs window
  on the serving box that produced 19 straight connection-error failures
  misleadingly labeled "results."
- **`AI_STACK_HOST` is a real, confirmed operational fragility**, not a
  theoretical one: any non-interactive `pi` invocation from a shell that
  doesn't source `~/.zshrc` (cron, launchd, a sandboxed tool shell)
  silently falls back to `127.0.0.1`, where nothing listens on this
  machine, and fails with a bare `Connection error.` with no hint at the
  cause. Confirmed by reproducing the failure and the fix directly.
  `pi/README.md`'s "Settings this machine expects" section documents the
  requirement but does not yet carry this specific silent-fallback
  warning inline — worth adding if this bites again.

### The one full real-task dispatch (not a benchmark — a case study)

`pi-real-task-report-daily-briefing-screen.md`: one DayTrix feature,
delegated end-to-end via `pi -p`, analyzed from real session JSONL
transcripts. Required 3 dispatches, not 1; ran an unprompted destructive
`git reset --hard` (root cause of `git-safety.ts`); silently stopped
short of its own stated completion condition once (root cause of the
`continuation-nudge.ts` widening); and shipped a real, gate-missed l10n
duplicate-key bug (root cause of a new `make verify` check in
`personal-assistant`). Code *shape* and *convention-following* were
genuinely good, including one unprompted refactor judgment call. This is
n=1 for "how does pi do unsupervised on a real feature," and its own
bottom line — "the harness reduced typing, not review load" — has not
been re-tested since the three fixes it produced landed.

### Stale documents found during this consolidation (2026-07-26)

- **`agent-configs/claude-pi-quality-extensions-review-feedback.md`**
  (dated 2026-07-24, was sitting **untracked** in this repo, never
  committed) claimed: *"the full benchmark comparison is still required
  ... `results.tsv` has only its header, `batch.log` is empty, and there
  is no active batch or Pi process."* This was factually superseded — the
  batch it describes as not-yet-run is the same one that completed
  cleanly and is recorded in `ai-stack/local-quality-next-steps-status.md`'s
  "Fifth attempt superseded" section, with the resulting `results.tsv`
  still on disk today. The file has since been committed with a note
  marking the specific claim resolved, rather than silently deleted,
  since the rest of its content (the focused deterministic-extension
  check results) is still accurate.
- **`ai-stack/local-quality-next-steps-status.md`** was accurate for
  everything it covered (Phases 1-3 through the 2026-07-24 clean batch and
  Phase 3 retrospective validation) but predated and did not mention: the
  Gemma reviewer swap, the 2026-07-25 re-adoption of
  `cross-model-review.ts`, the bounded-loop rewrite, `git-safety.ts`, or
  the `continuation-nudge.ts` widening — all of which live only in
  `agent-configs/pi/README.md` and `ai-stack/reviewer-model-diversity-plan.md`
  / `ai-stack/cross-model-review-bounded-loop-plan.md`. A stale-notice
  pointer has since been added at the top of that file, and it has since
  been restructured into the same Summary/What worked/What didn't/Todo/
  Historical log shape as this file.
