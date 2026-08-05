# pi harness — investigation history

This is the archive for dated, narrative evidence that used to live inline in
`pi-harness-validation-status.md`, `pi-harness-hardening-observations.md`
(now removed — its content is preserved here in full), and `pi/README.md`.
Those files now state only current status; this file keeps the full
evidence trail (what was tried, what broke, what got fixed, and when) so
nothing is lost, just moved out of the way of the current-state docs.

Nothing here supersedes the current-state docs when the two disagree — treat
this as provenance, not as the current verdict.

## From `pi-harness-hardening-observations.md` (implementation record, 2026-08-03)

This is the implementation record for `plans/pi-harness-hardening-plan.md`.
The real validation task was saved first as
`~/code/test-bed/app-x/VALIDATION-TASK.md`, then run with the installed Pi
0.83.0 harness against the resident ThinkingCap Qwen3.6-27B model. The
hardened runtime and deterministic suite are pinned by commit `151c122`.

### Outcome

Pi produced a coherent full-stack personal command center at app commit
`dc0769e`: editable browser voice capture, text logging, PostgreSQL JSONB
metadata, default and custom categories, timeline, holistic non-medical
feedback, migrations, seed data, and local documentation. After direct audit,
`make verify` passes TypeScript checks, 35 tests in five files, and a
production Vite build. Repeated migration/seed setup remains at four default
categories and five seed entries. Tests reset a separate `appx_test` schema
and leave `appx_dev` untouched. HTTP smoke checks passed for the frontend
shell, categories API, and daily summary API.

### Partial randomized screening battery (2026-08-02) — superseded

A planned nine-pair screen compared stock Pi (only the provider shim required
to reach the local model) with the installed harness. Task order and
within-pair arm order were randomized from seed `20260802`, runs were
strictly sequential, and hidden tests were overlaid only after Pi exited.
Security controls were out of scope. The run was stopped on request after
four complete pairs; the fifth pair was interrupted before producing a
record and is excluded.

| Task | Baseline | Harness | Harness runtime overhead |
|---|---:|---:|---:|
| Go+Dart notes app | pass | fail | 47% |
| Go notes API | pass | pass | 43% |
| Dart task manager | pass | hidden tests pass; extension lifecycle error | 1,744% |
| Go+Dart bookmarks app | pass | pass | 69% |

Across the four completed pairs, baseline hidden-test success was 4/4 and
harness hidden-test success was 3/4. Clean operational success was 4/4 versus
2/4 after treating the task-manager extension exceptions as a harness
failure. There were three task-quality ties, one baseline win, and no harness
win. The median paired runtime overhead was 58.3%; harness prompt-token
usage was 147% higher and completion-token usage was 11.7% higher.

The screen exposed two concrete reliability gaps:

1. `quality-gate.ts` reported `unconfigured` on both nested Go+Dart fixtures.
   On the notes fixture, Pi stopped after one large tool call and missed the
   required `ArgumentError` behavior for two unknown-ID operations; hidden
   tests caught both failures.
2. On the Dart task-manager fixture, the generated implementation passed all
   hidden tests, but `stack-router.ts` and `quality-gate.ts` both raised
   Pi's stale-context error after session replacement or reload. This is a
   harness lifecycle failure, not an inference-service failure or a reason
   to retry the result away.

This partial result did not support an operational-hardening claim. Aggregate
evidence is in `pi/evals/partial-screening-2026-08-02.json`; the reusable
runner is `pi/evals/run_screening.py`.

### Fixes for the two reliability gaps, and the completed nine-pair screen (2026-08-03)

Both gaps above were fixed directly:

1. `resolveVerificationCommand()` in `pi/extensions/lib/verification.ts` now
   falls back to a bounded breadth-first scan for nested
   `Makefile`/`go.mod`/`pyproject.toml`/`pubspec.yaml`/`Cargo.toml`/`package.json`
   directories when the repository root has none, building a combined
   `(cd 'dir' && cmd ) && (cd 'dir2' && cmd2 )` command instead of returning
   `unconfigured`.
2. `stack-router.ts`'s `before_agent_start` handler and `quality-gate.ts`'s
   `tool_result`/`agent_settled` handlers now catch Pi's documented
   stale-extension-context error (`isStaleContextError()` in
   `pi/extensions/lib/stale-context.ts`) and skip gracefully instead of
   crashing the turn. Pi throws this error when a captured `pi`/`ctx` is used
   after session replacement or reload -- confirmed via Pi's own
   `session_before_compact`/`session_compact` lifecycle events as the likely
   trigger (auto-compaction on a long run).

Both fixes had new deterministic tests and the full suite passed at 64/64.

The same seed-`20260802` nine-task schedule was then run to completion (all
nine pairs, eighteen live runs, same model and host):

| Task | Baseline | Harness | Harness runtime overhead |
|---|---:|---:|---:|
| go-flutter/notes-app | fail | pass | -10% |
| go/notes-api | pass | pass | 87% |
| dart/task-manager | pass | pass | 354% |
| go-flutter/bookmarks-app | fail | fail | 1% |
| dart/sequential-runner | pass | pass | 577% |
| dart/notes-app | pass | pass | 138% |
| go/lru-cache | pass | pass | 100% |
| go/lru-cache | pass | pass | 214% |
| go/notes-api | pass | pass | 23% |

Hidden-test success was baseline 7/9, harness 8/9. There were zero extension
errors and zero `quality-gate: unconfigured` outcomes across all eighteen
runs; neither of the two defects above recurred. Median paired runtime
overhead was 100.3% (prompt tokens +212.6%, completion tokens +39.8%), both
worse than the partial screen's numbers and well above the plan's 20%
threshold -- because the fixed quality-gate now actually runs its
nested-manifest verification and corrective-follow-up loop on every pair
instead of silently no-opping or crashing partway through. The partial
screen's lower overhead number was an artifact of the safety net not doing
its job. Full record: `pi/evals/full-screening-2026-08-03.json`.

### Pair 4 deep-dive

Pair 4 (go-flutter/bookmarks-app) was the only task both arms failed, in both
the full battery and an independent standalone rerun. Both failures have the
identical signature: `go test -race` catches a data race in `handleVisit()`
-- the mutex correctly guards the visit-counter increment, but the handler
marshals the response JSON from the shared `*Bookmark` pointer *after*
releasing the lock, so a concurrent visit can race the read. The task spec
explicitly calls this endpoint out as "the primary concurrency stress
point," and both baseline and harness independently wrote the same class of
bug -- a genuine 27B-model concurrency-reasoning gap, unrelated to either
harness fix.

The harness arm's session for this task is also the battery's token-usage
outlier (37-38 assistant turns, ~487-492K cumulative prompt tokens, driven
by quality-gate's corrective-follow-up loop retrying against a bug it
couldn't repair). Breaking that total down by field (37-turn rerun session)
shows APC absorbing nearly all of it: 21,418 fresh/uncached input tokens vs.
464,956 cache reads (95.6%). The real cost of this outlier session is not
~490K tokens of fresh compute -- it's sustaining a large, continuously-growing
KV cache resident in GPU-wired memory for the session's full multi-minute
duration, which is a more plausible driver of host memory pressure during a
long multi-hour battery than raw token throughput. `sum_cacheWrite=0` for
that session is unexplained and worth checking against `ai-stack`'s own APC
accounting. Full record: `pi/evals/pair4-race-condition-2026-08-03.json`.

### What the app-x run taught us

1. **Loading support modules as extensions is unsafe.** The first launch
   failed because top-level symlinks changed relative import resolution.
   Shared code now lives under the installed `extensions/lib/` directory,
   whose lack of an `index.ts` keeps it from being treated as an entry
   point. A load test covers every installed extension against the pinned
   public API.
2. **The settlement event matters.** An early quality-gate version listened
   to the wrong lifecycle boundary. In the live run, queued follow-ups
   continued after a later green check and the nominal three-attempt cap
   reached attempts four and five. The gate now runs on `agent_settled`,
   refuses work once the cap is reached, and has an explicit five-settlement
   regression test.
3. **Exit code alone is insufficient evidence.** The trace contained
   `npm test; echo EXIT=$?`, which can return zero even when the test fails.
   Verification evidence now rejects unquoted pipelines without pipefail,
   sequencing with later commands, `||`, negation, and background execution.
   The gate reruns the canonical repository command directly when evidence
   is missing, stale, truncated, or maskable.
4. **A green generated suite is not a product audit.** Pi's initial 33 tests
   missed a voice-source attribution bug, zero-count categories being
   described as tracked, a backend entry point that never started,
   migration/seed files that did nothing when invoked, test writes leaking
   into the development database, and a UTC/local-day boundary error. Direct
   audit added regression coverage and raised the suite to 35 tests.
5. **Generated claims must match configuration.** Pi said frontend tests
   ran, but the original Vitest include pattern excluded them. The root
   test config now includes frontend component tests and the canonical
   command also builds the production client.
6. **Routing can only use evidence present at prompt time.** The greenfield
   directory initially contained only the validation brief, so stack
   routing correctly returned no skills. Once manifests exist, deterministic
   tests show Go, Python, Flutter, PostgreSQL, Kafka, Temporal, and GCP
   signals route to the corresponding portable guidance. This is a known
   limitation for an empty repository, not a reason to inject every stack
   skill globally.
7. **Truthful disablement is better than false diversity.** The reviewer
   trace recorded `blocked: missing-configuration`. With only the primary
   Qwen route resident, no current evidence supports an independent-review
   label. A same-primary second pass is available only as explicit
   `blind-self-review`; it remains off by default.

### Evidence boundaries (as of the 2026-08-03 implementation)

- The main Pi session was manually interrupted after 2h34m because the
  original quality-gate loop was not truly capped. The resulting trace has
  122 assistant messages, 120 tool calls, 158,408 input tokens, 26,378
  output tokens, 3,216,866 cached-read tokens, and seven stop errors. These
  are diagnostic facts, not a latency or cost win.
- A fresh no-session Pi audit completed after the lifecycle/cap correction,
  without the runaway behavior. The maintained deterministic suite is the
  repeatable proof for the exact cap branches.
- The pinned Pi 0.83.0 test dependency resolves its nested `brace-expansion`
  to 5.0.7, which npm reports as one high-severity denial-of-service
  advisory. `npm audit fix`, lock-only update, dedupe, and a compatible
  5.0.9 override did not replace Pi's nested resolution. The omit-dev audit
  is zero, but the full development audit is not; this remains an
  upstream/pinning limitation.

Machine-readable aggregates are in `pi/evals/app-x-2026-08-02.json`; the
exact post-fix deterministic baseline is
`pi/evals/hardened-baseline-2026-08-03.json`.

## From `pi-harness-validation-status.md`'s original consolidation

This document started as a pure reconciliation of existing evidence (no new
testing), checked against what's actually on disk (git logs,
`scratch-phase-validate/results.tsv`, extension source). It was updated a
first time, same day, with a real new live batch targeting two
specifically-identified untested branches — see
`ai-stack/cross-model-review-bounded-loop-plan.md`'s "Live validation, round
2" for the full writeup — which surfaced a new `cross-model-review.ts`
false-positive finding. It was updated a second time, later the same day,
once that finding (and a separately-found `continuation-nudge.ts` bug) had
fixes landed and retested — see `ai-stack/cross-model-review-bounded-loop-plan.md`'s
"Live retest, round 3" for the full writeup.

### What worked

- **2026-07-26: `cross-model-review.ts`'s verbose-but-correct "clean"
  reviewer response being misclassified as `flagged` — found, fixed, and
  retested same day.** Real, reproduced instance during the day's live
  validation batch — see `ai-stack/cross-model-review-bounded-loop-plan.md`'s
  "Live validation, round 2" section. The reviewer reasoned at length and
  correctly concluded no issue, ending its reply with the exact
  `NO_ISSUES_FOUND` marker, but the marker-match logic required the
  *entire* (edge-trimmed) reply to equal the marker, so the verdict was
  scored `flagged` instead of `clean`. Fixed via
  `cross-model-review-marker-lastline-fix-plan.md` (Fable-reviewed) and
  landed as this repo's `715f0c7` (match against the reply's last non-empty
  line, not the whole reply). **Retest, same evening** (see
  `ai-stack/cross-model-review-bounded-loop-plan.md`'s "Live retest, round
  3"): live end-to-end review pipeline still correctly flags real bugs
  post-fix (one fresh live run caught a genuine missing-eviction bug); the
  specific verbose-clean reviewer behavior could not be forced live on
  demand within budget, so the fix itself was verified by running the exact
  shipped `normalizeForMarkerMatch`/`extractLastNonEmptyLine` functions
  (copied verbatim, not reimplemented) against the original idx13
  reproduction text plus three other cases (adversarial near-miss,
  fence-wrapped terse clean, accepted residual risk) — all four resolve as
  designed.
- **2026-07-26: `continuation-nudge.ts`'s `verificationRan` scanning the
  whole invocation instead of since the latest ask — found, fixed, and
  retested same day.** Real occurrence in `local-model-bench`'s
  `go/notes-api` run: an early, unrelated `go test` pass permanently
  disarmed the nudge for the rest of the session, so a later real
  abandonment (after a `cross-model-review.ts` followUp flagged a bug) went
  unnudged. Fixed as this repo's `5778d1b` (scope to since the most recent
  user-role message). **Retest, same evening**: two live combined-extension
  runs (`cross-model-review.ts` + `continuation-nudge.ts` together, via a
  new `ai-stack/scratch-phase-validate/run_combined.sh`) on `notes-api` both
  ran out the extended watchdog before completing a full dispatch (the task
  is large enough, and the LAN box contended enough, that 420-600s wasn't
  sufficient) — no live full-agent reproduction landed. Fell back to a
  direct deterministic test of the shipped `verificationRan` logic (copied
  verbatim from the extension) against a synthetic branch reproducing the
  exact real notes-api entry sequence (early `go test` → injected review
  followUp → prose-only abandonment): the old whole-invocation scan
  reproduces the bug (stays silent), the new since-last-ask scan fires the
  nudge as intended.
- **`co-change-suggest.ts` — adopted, 2026-07-24.** Real retrospective
  replay against `personal-assistant` (782 commits, real historical
  dispatch). Found and fixed a real seed-selection bug along the way; with
  the fix and real diff-derived identifiers, the target file ranked **#1 of
  8**. Correctly produces no signal on a generic paraphrase (expected
  scoping limit, not a bug).
- **Historical Gemma configuration: `cross-model-review.ts` — adopted,
  2026-07-25, reviewer = gemma-4-31B-it-OptiQ-4bit.** Caught the exact
  known bug the original Qwen-family reviewer missed (once a
  bounded-reasoning prompt fix was applied), then separately caught a
  second, unseeded real bug (unbounded `order`-slice growth) on an organic
  smoke run. The bounded-loop rewrite that followed passed 14/14 unit
  assertions, including the adversarial near-miss case, and improved on
  (not just matched) the original disablement case in a regression check.
  Full timeline in "Historical `cross-model-review.ts` verdict" below — the
  verdict flipped once, so it's worth reading in full before trusting it.
- **`protected-paths.ts`** caught a real escape attempt live: asked to
  write `main.go` in a temp dir, Qwen3.6-27B emitted an absolute path to an
  unrelated directory; the guard corrected it and the model retried
  correctly.
- **`git-safety.ts` — adopted, 2026-07-25.** Reproduced the exact `git
  reset --hard main` command that caused its creation, against a scratch
  repo; confirmed blocked, repo untouched.
- **The batch validation harness eventually produced one genuinely clean
  27-run batch** — verified on the day: `results.tsv` on disk has 27 rows,
  `ext_errors` is 0 throughout, no connection errors.
- **The one real end-to-end feature dispatch** (daily-briefing-screen) had
  genuinely good code shape and convention-following, including one
  unprompted refactor judgment call not in the spec.

### What didn't work

- **The 2026-07-26-era `cross-model-review.ts` configuration was not the
  configuration that earned adoption.** Both primary and reviewer resolved
  to the same Qwen model on `:8080` at that point; the independently
  trained Gemma reviewer used by the successful 2026-07-25 experiments was
  no longer resident. (Current state: disabled unless truthfully
  configured — see `pi-harness-validation-status.md`.)
- **Extension regression checks were not committed as a maintained test
  suite at that point.** Important branches were checked with temporary
  mocks or copied helper logic, which was useful evidence but made drift
  easy and repeatable verification harder. (Current state: 64 committed
  deterministic tests.)
- **`continuation-nudge.ts` had fired zero times in ~46 real trials plus 2
  targeted attempts** as of that point — every trial to date used the
  trigger's original, narrower form (forward-looking prose only). It was
  widened 2026-07-25 to also catch a silent empty-content stop, the actual
  failure mode observed once for real, but that widened path had not been
  exercised in a single real trial since, as of this writing.
- **`cross-model-review.ts`'s first reviewer missed a known, spec-violating
  bug twice, at temperature 0** — the initial reason for disabling it,
  before the reviewer was swapped to a different model family.
- **The batch validation harness took four discarded attempts to reach one
  clean run**, each killed by a different real bug: a hardcoded `tests/`
  subdirectory that broke Go package resolution; a silent `sendUserMessage`
  delivery failure that made *both* judgment-dependent extensions no-ops
  for two entire batches without ever surfacing an error; hidden tests
  exposed to the model before its run instead of after; and a
  scheduled-inference-jobs window on the serving box that produced 19
  straight connection-error failures misleadingly recorded as results.
- **The one real feature dispatch needed 3 attempts, not 1**: it ran an
  unprompted destructive `git reset --hard` to resolve a self-inflicted
  branch conflict; silently stopped short of its own stated completion
  condition once, with no tool call and no explanatory text; and shipped a
  real, gate-missed l10n duplicate-key bug that `make verify` did not
  catch. Its own bottom line — "the harness reduced typing, not review
  load" — was not re-tested as of that entry, since the three fixes it
  produced landed.
- **A review-feedback document sat untracked in this repo for two days
  making a claim that had already been overtaken by events** (see "Stale
  documents" below) — a concrete instance of the staleness risk this whole
  consolidation was created to catch.

### Historical `cross-model-review.ts` verdict — it flipped once on real evidence

1. **2026-07-24, first reviewer.** One real test: fed the extension's
   actual code a real diff with a known, spec-violating bug (LRU cache —
   `Put()` on an existing key doesn't promote it to MRU; the hidden test
   suite catches this). Reviewer returned `NO_ISSUES_FOUND`, reproduced
   twice at temperature 0. **Disabled**, moved to `disabled-extensions/`.
2. **2026-07-24, same day, reviewer swapped to gemma-4-31B-it-OptiQ-4bit**
   on the hypothesis that same-family (Qwen+Qwen) review shares blind
   spots. First attempt degenerated (empty `content` field, garbled
   reasoning, twice) — traced to unbounded reasoning length, not a
   capability ceiling (control prompt worked fine). Fixed with a one-line
   "keep reasoning short" prompt addition; re-ran the identical known-bug
   case twice — Gemma caught it both times, byte-identical output.
   **Re-adopted** on this basis.
3. **2026-07-25, moved back into `extensions/`.** A separate live smoke run
   (organic, non-seeded model output on `lru-cache`) had the Gemma reviewer
   catch a second real bug the test suite also missed (unbounded
   `order`-slice growth on repeated `Put`s) — an unseeded catch, a stronger
   signal than a seeded reproduction, still n=1.
4. **2026-07-25, bounded-loop rewrite**
   (`cross-model-review-bounded-loop-plan.md`, reviewed by Fable before
   implementation). Replaced the one-shot boolean with a 3-round cap,
   outcome-typed `runReview`, and formatting-only marker tolerance.
   Validated: 14/14 mocked-`ExtensionAPI` unit assertions (cap enforcement,
   clean short-circuit, unchanged-diff skip, tolerant marker matching
   across 5 wrapped forms, and the adversarial near-miss case — a real
   finding phrased "No issues found... but ..." correctly resolves to
   `flagged`, not `clean`); a regression check replaying the original
   2026-07-24 disablement case against the current code (Gemma now catches
   it — confirmed improvement, not just non-regression); 3 live end-to-end
   runs on `lru-cache` (3/3 exercised round 1 correctly; 1/3 exercised a
   real round-1→round-2 progression on a genuine fix; cap-hit and
   clean-short-circuit branches were exercised only by the unit harness,
   not live); a cost check (73.5s on a real ~40KB multi-file diff from
   `personal-assistant`, exceeding the then-current 60s timeout — raised to
   120s as a direct result).
5. **2026-07-26, marker-lastline fix.** A live batch targeting the
   still-untested round-2/round-3/clean-short-circuit branches (see item 4)
   surfaced a new false positive instead: a verbose-but-correct clean
   verdict scored `flagged`. Fixed same day (`715f0c7`) and retested same
   evening — see "What worked" above. Verdict as of this item: still
   **adopted**, not flipped again.

### Full extension-by-extension table (as reconciled on 2026-07-26)

| Extension | Status at the time | n | Evidence |
|---|---|---|---|
| `protected-paths.ts` | Adopted as a tool guard (vendored, on by default) | 1 live catch | Caught Qwen3.6-27B emitting an absolute path outside the working dir; corrective retry worked. It covers Pi `write`/`edit`, not `bash`, symlink escapes, or OS-level confinement. No formal battery. |
| `format-on-edit.ts` | Adopted (vendored, on by default) | — | No battery; deterministic gofmt/dart-format pass, not a judgment call. |
| `rtk-rewrite.ts` | Adopted (vendored, on by default) | — | No battery; deterministic bash-output filter. |
| `git-checkpoint.ts` | Adopted (vendored, on by default) | — | No battery; deterministic per-turn snapshotting. |
| `co-change-suggest.ts` | Adopted, 2026-07-24 (later default-disabled 2026-08-03 pending paired evidence — see current status doc) | 1 real retrospective case | Real retrospective replay against `personal-assistant` (782 commits, real historical dispatch). Found and fixed a real seed-selection bug along the way. With the fix and real diff-derived identifiers, target file ranked **#1 of 8**. Correctly no-signal on a generic paraphrase (expected scoping limit, not a bug). Not done at the time: the plan's second half of its kill criterion — "try it live on one new personal-assistant feature task" (forward-looking, not retrospective) — had not been run. |
| `continuation-nudge.ts` | Not adopted at the time, kept loaded as a no-cost no-op (later default-disabled 2026-08-03 — see current status doc) | 0 firings / ~46 real trials + 2 targeted attempts, as of that point | Fired zero times outside mocked unit tests across every real trial run to date at that point. Widened 2026-07-25 to also trigger on a silent empty-content stop (the actual failure mode observed once, for real, in the daily-briefing-screen dispatch). A real `verificationRan` scoping bug found 2026-07-26 was fixed (`5778d1b`) and retested the same day via direct logic replay. |
| `cross-model-review.ts` | Enabled but unvalidated in the (then-)current same-model configuration; historical Gemma setup adopted 2026-07-25 | see above | Current primary and reviewer were the same Qwen model on `:8080` at that point. The verdict applies to the historical Gemma reviewer on `:8081`, not that same-model second pass. (Current state as of 2026-08-03: disabled unless explicitly and truthfully configured — see current status doc.) |
| `git-safety.ts` | Adopted, 2026-07-25 | 1 scratch-repo reproduction | Reproduced the exact `git reset --hard main` command that triggered its creation, against a scratch repo; confirmed blocked, repo untouched. |
| Phase 4 (Aider-based failing-test retry) | Deliberately not built | n/a | Gated by the plan itself on Aider dispatch being back in scope. It isn't: `~/.claude/CLAUDE.md` and `agent-configs/pi/AGENTS.md` both record that `dispatch-local` was benchmarked and removed. |

### Harness infrastructure: what was proven to work, as of 2026-07-26

- **The `scratch-phase-validate/` batch harness produced exactly one
  genuinely clean 27-run batch**: `results.tsv` on disk had 27 data rows,
  `ext_errors` was 0 in every row, and no `Connection error` entries —
  consistent with the "Fifth attempt superseded" narrative in
  `local-quality-next-steps-status.md`. Getting there took four earlier
  discarded batches, each invalidated by a different real bug (see "What
  didn't work" above).
- **`AI_STACK_HOST` is a real, confirmed operational fragility**, not a
  theoretical one: any non-interactive `pi` invocation from a shell that
  doesn't source `~/.zshrc` (cron, launchd, a sandboxed tool shell)
  silently falls back to `127.0.0.1`, where nothing listens on this
  machine, and fails with a bare `Connection error.` with no hint at the
  cause. Confirmed by reproducing the failure and the fix directly.
- **Terminal launch, verified live, 2026-07-26**: the LAN box's address had
  changed once already at that point (DHCP reassignment,
  `192.168.1.233` → `192.168.1.79`) — see
  `ai-stack/cross-model-review-bounded-loop-plan.md`'s "Live retest, round
  3" for the retest this triggered. Launched `pi` exactly as a user would
  from a terminal — `zsh -ic 'pi --print ...'` against a real `lru-cache`
  bug, zero explicit `--provider`/`-e`/`--no-extensions` flags. Confirmed
  via `lsof` mid-run: an actual `ESTABLISHED` TCP connection from the `pi`
  process to `192.168.1.79:8080`. `cross-model-review.ts` fired against
  `192.168.1.79:8081`, flagged a real eviction bug in round 1, the model
  fixed it, final `go test` passed, zero extension errors. (The box's
  address has since moved to a stable hostname, `kannasmacstudio.lan` —
  see `pi/README.md`.)

### The one full real-task dispatch (not a benchmark — a case study)

`pi-real-task-report-daily-briefing-screen.md`: one DayTrix feature,
delegated end-to-end via `pi -p`, analyzed from real session JSONL
transcripts. Required 3 dispatches, not 1; ran an unprompted destructive
`git reset --hard` (root cause of `git-safety.ts`); silently stopped short
of its own stated completion condition once (root cause of the
`continuation-nudge.ts` widening); and shipped a real, gate-missed l10n
duplicate-key bug (root cause of a new `make verify` check in
`personal-assistant`). Code *shape* and *convention-following* were
genuinely good, including one unprompted refactor judgment call. This is
n=1 for "how does pi do unsupervised on a real feature," and its own bottom
line — "the harness reduced typing, not review load" — was not re-tested as
of that entry, since the three fixes it produced landed.

### Stale documents found during the 2026-07-26 consolidation

- **`agent-configs/claude-pi-quality-extensions-review-feedback.md`** (dated
  2026-07-24, was sitting **untracked** in this repo, never committed)
  claimed: *"the full benchmark comparison is still required ...
  `results.tsv` has only its header, `batch.log` is empty, and there is no
  active batch or Pi process."* This was factually superseded — the batch
  it describes as not-yet-run is the same one that completed cleanly and is
  recorded in `ai-stack/local-quality-next-steps-status.md`'s "Fifth
  attempt superseded" section, with the resulting `results.tsv` still on
  disk at the time. The file was committed with a note marking the
  specific claim resolved, rather than silently deleted, since the rest of
  its content (the focused deterministic-extension check results) was
  still accurate.
- **`ai-stack/local-quality-next-steps-status.md`** was accurate for
  everything it covered (Phases 1-3 through the 2026-07-24 clean batch and
  Phase 3 retrospective validation) but predated and did not mention: the
  Gemma reviewer swap, the 2026-07-25 re-adoption of
  `cross-model-review.ts`, the bounded-loop rewrite, `git-safety.ts`, or
  the `continuation-nudge.ts` widening. A stale-notice pointer was added at
  the top of that file, and it was restructured into the same
  Summary/What worked/What didn't/Todo/Historical log shape as this file.

## From `pi/README.md`: `cross-model-review.ts`'s full adoption saga

The current-state summary in `pi/README.md` covers what the extension does
and its current disabled-unless-configured status. The detailed history
below (verdicts, live-run counts, cost checks) is kept here for provenance.

**Verdict (2026-07-24, first reviewer): not adopted** — the one real test
run (a known, spec-violating bug the hidden test suite catches) came back
negative, reviewer returned `NO_ISSUES_FOUND`. Moved to
`disabled-extensions/`. **Re-verdict (2026-07-25, reviewer switched to
gemma-4-31B-it-OptiQ-4bit on :8081): adopted, moved back to `extensions/`.**
A live smoke run against the `lru-cache` task (no seeded bug — the model's
own organically-written solution, tests green) had the reviewer catch a
real logic bug the test suite missed: the `order` slice grows unbounded on
repeated `Put`s to existing keys, unpruned during updates. This is a
stronger result than the plan's own kill criterion (an unseeded catch, not
a seeded one) but still n=1. Directly timed the review call against this
diff (953 prompt tokens) at 12.9s, ~20% of `REVIEW_TIMEOUT_MS` (60s).
Separately, this same smoke run got killed by `run_one.sh`'s 180s watchdog
(`PI_EXIT=143`) after the review's fix-it turn extended the session — a
property of the validation harness's fixed timeout, not of real
interactive `pi` usage, which has no such cap.

**Bounded-loop rewrite (2026-07-25, `ai-stack/cross-model-review-bounded-loop-plan.md`):**
the prior one-shot boolean (`reviewedThisRun`) was replaced with a
`reviewCount`/`lastReviewedDiff`/`done` state machine bounded at
`MAX_REVIEW_ROUNDS = 3`, so a flagged issue's *fix* gets re-reviewed instead
of the loop ending after one nudge. `runReview` returns a typed
`ReviewResult` (`unchanged | no-diff | no-spec | transient | clean |
flagged`) instead of a bare boolean, and the clean-verdict marker match
tolerates markdown wrapping (backticks/emphasis stripped from the string
*edges* only) instead of requiring byte-exact equality. Validated:

- **Unit-level**: 14/14 assertions pass, covering cap enforcement,
  clean-short-circuit, unchanged-diff skip, tolerant marker matching across
  five realistic wrapped forms, and the adversarial case Fable's plan
  review called out (a genuine finding phrased "No issues found in the core
  logic, but ..." resolves to `flagged`, not `clean`). This harness caught
  a real bug in the first implementation: the marker normalizer stripped
  `` ` * _ `` globally, which corrupted `NO_ISSUES_FOUND`'s own underscores
  and made every clean verdict register as flagged — fixed to strip only
  at the string's edges before this shipped.
- **Regression check against the original disablement case**: rebuilt the
  seeded bug that caused the 2026-07-24 disablement (`Get` fixed for
  recency, `Put` on an *existing* key left un-touched) and ran it through
  the extension's real, unmodified `runReview` logic against the live
  `:8081` endpoint. No regression — an improvement: the current gemma4
  reviewer correctly flags it, unlike the original reviewer that missed
  this exact class on 2026-07-24.
- **Live smoke tests**, `lru-cache` task, real `pi` + Qwen3.6-27B primary +
  gemma4 reviewer via `scratch-phase-validate/run_one_long.sh` (watchdog
  raised to 600s). 3 sequential runs: run 1 — round 1 flagged, model
  rebutted it as a false positive (correctly, on inspection) and made no
  further edit; a repeat `go build` on the identical diff correctly hit the
  `unchanged` outcome, `PI_EXIT=0` at 156s. Run 2 — round 1 flagged a real
  edge case; the model investigated via an ad-hoc `go run` scratch program
  instead of rerunning a verification-matching command, so round 2
  correctly never triggered, `PI_EXIT=0` at 220s. Run 3 — round 1 flagged a
  real bug (`moveToBack` silently dropped new keys from the order slice),
  the model fixed it, round 2 fired on the updated diff and flagged a
  second issue that the model rebutted as a false positive, session ended
  naturally with no round 3, `PI_EXIT=0` at 335s, tests green throughout.
  Net: 3/3 real end-to-end runs exercised round 1 correctly; 1/3 exercised
  a genuine round-1→round-2 progression on a real fix. The cap-hit (round
  3) and clean-short-circuit branches were not observed live in these 3
  runs but are deterministically exercised by the unit harness above.
- **Cost check on a realistic diff size**: the prior 12.9s figure was only
  ever measured on the 953-token `lru-cache` fixture. Timed the same
  unmodified `runReview` HTTP call against a real multi-file feature diff
  from `personal-assistant` (`186282ef`, ~40KB / ~10.5k prompt tokens):
  73.5s, which exceeds the prior `REVIEW_TIMEOUT_MS` (60s). Raised
  `REVIEW_TIMEOUT_MS` to 120s to leave headroom above the measured 73.5s.
  Separately, on the small `lru-cache` fixture, `run_one.sh`'s real 180s
  watchdog still killed a run mid-fix-it-turn after just one flagged round
  (`PI_EXIT=143`, reproduced again during this validation).

**Last-line marker matching (2026-07-26, `ai-stack/cross-model-review-marker-lastline-fix-plan.md`):**
a live run showed the clean-verdict check's edge-stripped *whole-reply*
equality scoring `flagged` on a reviewer reply that reasoned correctly
through a bug hypothesis at length (~1500 characters) before ending with
`NO_ISSUES_FOUND` on its own line — a false positive that burns a
bounded-loop round on a genuinely clean diff. The check now runs
`normalizeForMarkerMatch` against `extractLastNonEmptyLine(reviewText)`
instead of the full reply, so a verbose-then-terse reply matches while a
single-line near-miss like "No issues found in the core logic, but ..."
still doesn't. This is a trade, not a strict improvement: a genuine
multi-paragraph finding whose literal last line happens to equal the
marker would now also resolve `clean` — an accepted, tracked residual risk,
mitigated by logging the full raw reply via `pi.appendEntry` (session-only,
not in LLM context) on every `clean` verdict over 200 characters. Validated:
8/8 mocked-`ExtensionAPI` assertions, including the idx13 verbose-clean
case, the original single-line adversarial regression, a new multi-line
adversarial case, a fenced terse verdict, and two canaries (formatting
variants that intentionally still don't match, and the residual risk
itself pinned down as a currently-passing test).

## From `pi/README.md`: other extensions' adoption narrative

**`continuation-nudge.ts`** — Phase 1 of
`ai-stack/local-quality-next-steps-plan.md`. **Verdict as of 2026-07-24**
(see `ai-stack/local-quality-next-steps-status.md`): not adopted, but kept
loaded — across ~50 real trials the trigger condition never fired outside
deterministic mocked tests. **Updated 2026-07-25**, after a real occurrence
in the `personal-assistant` daily-briefing-screen dispatch: the model
stopped with `stopReason: "stop"`, no tool call, and *zero text content* —
not forward-looking prose. The original trigger required non-empty text
matching a forward-looking pattern and so, correctly per its own logic,
never fired on this case. Widened to also fire on a stop-with-empty-content
turn, and fixed a related bug found in the same review:
`verificationRan` scanned the whole persisted `--continue` branch, so once
*any* pass in a multi-dispatch session ran a verification command, the
nudge was permanently disarmed for every later pass too — now scoped to the
current invocation only. See `pi-real-task-report-daily-briefing-screen.md`
for the full transcript analysis. **Fixed 2026-07-26**, after a real
occurrence in `local-model-bench`'s `go/notes-api` run: the model ran
`go test` early for its original implementation, `cross-model-review.ts`
then flagged a real routing bug, and the model correctly diagnosed the fix
in prose and abandoned it without a tool call — but the nudge stayed
silent, because `verificationRan` still scanned the *whole current
invocation*, and that early, unrelated `go test` pass permanently disarmed
it for the rest of the session even though the abandoned fix itself was
never verified. Now scoped to since the most recent ask instead of since
the invocation start. See `local-model-bench/SPEC.md`'s 2026-07-26 report
for the full transcript trace. **Updated 2026-08-02** after two Pi
calendar-app runs stopped immediately after `flutter analyze` failed:
verification is now tracked by outcome, so a failing check triggers a
corrective follow-up instead of disarming the nudge.

**`co-change-suggest.ts`** — Phase 3 of the same plan. **Verdict
(2026-07-24, see `ai-stack/local-quality-next-steps-status.md`): adopted.**
Re-ran the plan's retrospective kill criterion for real against
`personal-assistant`'s actual mood-streak dispatch (782 commits of real
history, checked out at the exact pre-dispatch commit): found and fixed a
real seed-selection bug in the process (per-identifier grep counting was
missing, so seed selection was effectively "first 5 files in git's listing
order" with no relevance weighting). After the fix, the target file
(`contract_matrix_phase2_test.go`) surfaced at rank #1 given a spec using
the real identifiers from that dispatch's diff — beating the plan's own
claimed #2 for the original script.

**`git-safety.ts`** — added 2026-07-25. Added after `pi`, in `-p` mode, ran
`git reset --hard main` unprompted to resolve a self-inflicted "branch
already exists" conflict, discarding a prior commit; `git-checkpoint.ts`
could have recovered it but only via `/fork`, which is interactive-UI-only
and does nothing in `-p` mode. Each block names a safe alternative rather
than a bare refusal, since the `flutter gen-l10n` rediscovery flail in the
daily-briefing-screen dispatch (~8 failed bash commands in a 5-minute span)
is direct evidence this model thrashes when blocked with no alternative
given. Verified live: reproduced the exact command against a scratch repo,
confirmed it's blocked and the repo's commits are untouched. See
`pi-real-task-report-daily-briefing-screen.md`.

**`AI_STACK_HOST` / terminal launch, confirmed live, 2026-07-26**: a plain
`pi` launch from an interactive shell (no flags) opened a real connection
to the box at the address `~/.zshrc` exported at the time
(`192.168.1.233`). See "Terminal launch, verified live, 2026-07-26" above
for the fuller version of this same check. The box's address has since
moved to a stable hostname, `kannasmacstudio.lan`, specifically to stop
this kind of note from going stale on every reboot.

## `cross-model-review.ts` wired to a live Gemma route, 2026-08-04

A second model, `gemma-4-26b-a4b-it`, came up on `:8082` on the same LAN
box. Before wiring it in as the reviewer, ran two checks:

1. **Throughput**: single-shot, same prompt/`max_tokens`/temp=0 on both
   routes — Gemma ~19.9 tok/s vs. the resident Qwen route's ~24.3 tok/s
   (~18% slower). Not disqualifying for a once-per-turn reviewer role.
2. **Capability spot-check on the pair-4 concurrency bug**: rather than
   trust the speed number alone, reproduced the exact `go-flutter/
   bookmarks-app` race (see pair-4 deep-dive above — `handleVisit()`
   marshals a shared `*Bookmark` pointer after releasing the mutex) in a
   standalone Go package, confirmed a control build reproduces the same
   `go test -race` failure signature, then gave Gemma only the failure
   output (no hints toward "race condition" or "pointer") and asked it to
   diagnose and fix. It correctly identified the read-after-unlock
   mechanism and applied `snapshot := *bm` taken under the lock — the
   exact fix this history file's root-cause note recommends. `go build`,
   `go vet`, and `go test -race` all passed clean against the fix. This is
   n=1 on an isolated repro, not a battery result — see the todo in
   `pi-harness-validation-status.md` for the pair-4 paired-battery rerun
   needed before drawing a broader conclusion.

Set `AI_REVIEW_BASE_URL=http://${AI_STACK_HOST}:8082/v1` and
`AI_REVIEW_MODEL=gemma-4-26b-a4b-it` in `~/.zshrc`. Verified live:
`resolveReviewerConfig()` now resolves `{ enabled: true, kind:
"independent-review", baseUrl: "http://kannasmacstudio.lan:8082/v1", model:
"gemma-4-26b-a4b-it" }`, and `requestReview()` against the real endpoint
correctly flagged a deliberately planted bug (subtraction instead of
addition) with an accurate explanation instead of returning
`NO_ISSUES_FOUND`. Full deterministic suite still passes 67/67 after the
change (also corrected the validation-status doc's stale "64 deterministic
tests" figure to the current 67 while in there).

## Trying a third reviewer route, KAT-Coder on `:8083`, found and fixed three real bugs, 2026-08-04

A third model, `KAT-Coder-V2.5-Dev-OptiQ-4bit`, came up on `:8083` on the
same LAN box (discovered by port-scanning `kannasmacstudio.lan` after being
told a new model was up but not given its host/port). Rather than trust it
as reviewer on faith, ran it through `pi-harness-history.md`'s pair-4 task
(`go-flutter/bookmarks-app`, the race-condition task) with the full
installed harness and `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` pointed at
this new route — `resolveReviewerConfig()` correctly resolved
`independent-review` (distinct baseUrl/model from the `:8080` Qwen
primary). Five live `pi -p` runs against that one task surfaced three
separate, real bugs, in order:

1. **`go test -race ./...` was invisible to both detectors.**
   `BROAD_VERIFICATION_PATTERNS` in `pi/extensions/lib/verification.ts`
   matched the literal substring `go test ./...` only — no flags allowed
   anywhere in between. `go test -race ./...` (this task's actual
   `meta.json` `run_cmd`, and the flag needed to catch the exact race this
   task exists to test) never matched, so neither `cross-model-review.ts`'s
   live-trigger nor `quality-gate.ts`'s evidence-capture ever saw the
   model's own real verification runs. Separately, `manifestCommandForDir`
   treated any directory with a `pubspec.yaml` as a Flutter project and
   resolved `flutter test` — wrong for `client/`, a plain Dart package with
   no Flutter SDK dependency (checked: no `sdk: flutter` line in its
   pubspec). This affected far more of the existing nine-pair battery than
   just pair 4 — checking all seven unique tasks behind the nine pairs
   found `go/notes-api` (both `-race` pairs) and all three `dart/` tasks
   (`task-manager`, `sequential-runner`, `notes-app`) were also silently
   invisible to both detectors before today; only the two `go/lru-cache`
   pairs (plain `go test ./...`, no flags) and the baseline arm (no
   quality-gate/reviewer at all) were unaffected. **Fixed**: added a
   non-narrowing flag allowlist (`-race`, `-v`, `-count=N`,
   `-timeout[=| ]value`, `-parallel[=| ]value` — deliberately excludes
   `-run`/`-short`/`-list`, which would make a partial run pass as full
   evidence) to the `go test` pattern, and added an `isFlutterPackage()`
   check (looks for `sdk: flutter` in `pubspec.yaml`) so a plain-Dart
   package resolves to `dart test`, added to
   `BROAD_VERIFICATION_PATTERNS` alongside `flutter test`. 5 new tests in
   `pi/tests/verification.test.ts`.

2. **`cross-model-review.ts` crashed the whole `pi` process the first time
   its trigger actually fired on a real task.** With bug 1 fixed, the model
   ran `go test -race ./...` itself, `quality-gate.ts` correctly captured
   it as evidence (it has the `isStaleContextError` guard added
   2026-08-03), but `cross-model-review.ts` never got that same guard when
   it was written. Its `tool_result` handler's `.catch()` unconditionally
   called `appendHarnessTrace(pi, ...)` to log a `transient` outcome — using
   the same `pi` context whose earlier call had just failed with "stale
   after session replacement or reload." That second call threw too,
   uncaught inside a `.catch()` handler, which Node.js treats as a fatal
   unhandled rejection: `pi` exited with a stack trace rooted at
   `cross-model-review.ts:179`, mid-task, non-zero exit. This had been
   latent since the extension was written — it never surfaced before
   because, per bug 1, the trigger essentially never fired on a real task
   until today. **Fixed**: imported `isStaleContextError` from
   `./lib/stale-context.ts` (the same helper `quality-gate.ts` and
   `stack-router.ts` already use) and made the `.catch()` stale-aware:
   returns silently on a stale original error (nothing left to log
   against; a fresh extension instance owns the replacement session), and
   wraps its own fallback `appendHarnessTrace` call in a nested try/catch
   so a second stale-context throw during error-path logging can't cascade
   into another unhandled rejection. 1 new test in
   `pi/tests/cross-model-review.test.ts`, verified against the reverted
   code to confirm it actually fails without the fix.

3. **Even after both fixes, the reviewer still never completed a round —
   because `pi -p` doesn't wait for it.** `cross-model-review.ts`'s review
   is fire-and-forget: `pi.exec(...).then().catch().finally()`, never
   returned or awaited by anything. `pi -p` (non-interactive mode) exits as
   soon as the model's own turns settle. Live timing from one run: the
   model's qualifying `go test -race ./...` call landed at `02:31:39Z`; the
   entire session's last event was at `02:32:42Z` — a 63-second window. A
   deterministic repro built against that run's real session branch, real
   diff, and real base SHA (driving the actual `reviewer()` export
   directly, bypassing `pi` entirely) measured a real KAT-Coder round trip
   at 60.15s even against a healthy, idle route — so there was never
   enough slack for a review to land before the process exited, regardless
   of route health. Confirmed this wasn't a fluke of route contention: the
   Mac Studio was running three large resident models simultaneously
   (Qwen on `:8080`, Gemma on `:8082`, KAT-Coder on `:8083`); a
   `/proxy/health` check on `:8083` showed `queue_timeouts: 4`,
   `upstream_errors: 4`, `queue_wait_seconds: 43`, and a manual probe
   request got no response in 30s. Restarted all four LaunchAgents
   (`qwen36`, `kvproxy`, `whisper`, `katcoder` — bootout/bootstrap on
   `kannasmacstudio.lan`) to rule out a stuck connection; `:8083` came back
   with clean zeroed counters and answered a probe chat completion in a
   few seconds. The timing gap persisted anyway — it's structural, not a
   symptom of an unhealthy route. **Fixed**: `tool_result` now stores the
   review's promise chain (`inFlightReview`), and a new `agent_settled`
   handler awaits it (wrapped in the same stale-context guard, matching
   `quality-gate.ts`'s own `agent_settled` pattern) before letting
   settlement proceed — bounded by `requestReview`'s existing
   `REVIEW_TIMEOUT_MS` (120s), so no new unbounded wait was introduced. 1
   new test in `pi/tests/cross-model-review.test.ts`
   (`agent_settled blocks until a pending review round finishes`),
   confirmed to fail against the reverted code.

With all three fixed, a fifth `pi -p` run against pair 4 produced the
harness's **first-ever recorded `cross-model-review` round on a real live
task**: `{event: "review", outcome: "transient", durationMs: 120035}` — the
request ran the full `REVIEW_TIMEOUT_MS` and timed out rather than being
silently abandoned, which is the honest failure mode now instead of no
signal at all. No crash across all 5 runs post-fix. Across the 5 runs, the
underlying pair-4 race condition itself (unrelated to any of the above)
was fixed by the primary Qwen model in 2 of 5 and still present in 3 of 5
— consistent with `pi-harness-validation-status.md`'s existing
characterization of this as a genuine concurrency-reasoning gap at the
edge of this model's reliability, not something any of today's fixes
touch.

**Open, not fixed today**: KAT-Coder's real-world response time (60-120s
per round, sometimes exceeding `REVIEW_TIMEOUT_MS` entirely even on an
idle route) means it's currently a weak fit for the reviewer role
specifically, independent of the harness bugs above — worth either raising
`REVIEW_TIMEOUT_MS`, investigating why a single review call on an idle
host took the full 120s, or not adopting KAT-Coder as the standing
reviewer route. This is a capacity/model finding, not a code defect;
`AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` in `~/.zshrc` were left pointed at
Gemma (`:8082`) throughout — KAT-Coder was only exported ad hoc per-run for
this investigation, never made the standing configuration. Full
deterministic suite: 74/74 (was 67/67; +5 verification tests, +2
cross-model-review tests, net +7).

## KAT-Coder ruled out as primary model and as reviewer; Gemma's reviewer timeout raised to 240s, 2026-08-04

Two follow-up spot-checks, prompted by the open KAT-Coder questions above,
closed both out — one as primary coding model, one as reviewer — and the
second directly motivated a real config change.

### As primary coding model: not adopted, n=1 result is statistically empty

Ran the fully installed harness (protected-paths, format-on-edit,
quality-gate, stack-router, cross-model-review, etc., all on) with
KAT-Coder-V2.5-Dev-OptiQ-4bit substituted as the *primary* model in place of
Qwen, against pair 4 (`go-flutter/bookmarks-app`) — the task both battery
arms failed on the shared `go test -race` visit-counter data race. `pi
--print` exited 0, no extension errors, 3 files changed (327
insertions/30 deletions).

Result: `go test -race ./...` passed 9/9 — the exact race condition Qwen
missed was fixed. But `dart test` then failed 3/17, and quality-gate
correctly caught it: an early diffHash recorded two passing verification
events (an earlier `go vet`/analyze-only pass), then a later diffHash
recorded two failing events at settlement, the second showing `exitCode:
65, diffChanged: false` — the harness attempted a corrective follow-up, the
model produced no new diff, and quality-gate correctly refused to bind the
diff as passing evidence. Overall task result: **fail**.

Independent Opus review of the actual diffs (not just the pass/fail
summary) found the win is not real signal: this project's own prior
five-run investigation (the section above) already showed Qwen fixes this
exact race in 2 of 5 runs on its own — roughly a 40% base rate — so a
single KAT-Coder success is statistically indistinguishable from Qwen's own
variance, not evidence of a capability edge. It also cuts the other way on
net: the task failed here on the Dart side, which the original Qwen battery
arms did not fail on. The Go fix itself was verified correct where applied
(snapshots `bm` under the lock before encoding in `visitBookmark`) but
incomplete: `getBookmark` and `createBookmark` still release the mutex and
hand the live map pointer to the JSON encoder unsynchronized, the same bug
class, just not exercised concurrently by this task's hidden test. The
Dart failures traced to one root cause: the model added a `_loaded` gate to
satisfy a spec sentence ("before load(), returns an empty list") that was
already true for free from the empty initial list, and the three failing
tests all skip calling `load()` first.

`cross-model-review.ts` produced no trace event during this run — not a
code defect; the run was launched via a detached `nohup bash -c '...'`
subshell that doesn't source `~/.zshrc`, so `AI_REVIEW_BASE_URL`/
`AI_REVIEW_MODEL` were absent and the extension correctly self-disabled.
This is a test-launcher gap, not a harness bug, but it means the earlier
five-run KAT-Coder-as-reviewer investigation remains the only real evidence
on that path — this run didn't add to it.

**Verdict: KAT-Coder is not adopted as an alternate or additional primary
model.** Distinguishing a real edge from Qwen's own ~40% base rate on this
task would need on the order of 8-10 paired runs, not one; this stays a
todo, not a conclusion.

### As reviewer: ruled out — structurally cannot complete a real review request, timeout tuning does not fix it

The section above left KAT-Coder's reviewer viability as an open question:
was the 60-120s round trip (sometimes exceeding `REVIEW_TIMEOUT_MS`) a
symptom of route contention (three resident models competing for the same
Mac Studio GPU/unified memory) or a real capacity limit of the model/route
itself? Remeasured directly, bypassing `pi` entirely: sent the exact prompt
shape `requestReview()` builds (task spec + a real diff — the 327-line
KAT-Coder-as-primary diff above — 22,784 prompt characters, no `max_tokens`
cap, `temperature: 0`) straight to `:8083/v1/chat/completions`, confirming
via `/proxy/health` beforehand that the route was fully idle
(`active: 0`, no other resident model running a concurrent request).

Result: the request ran for **220+ seconds** and never returned a
successful response. A 130s client-side timeout was hit first; polling
`/proxy/health` afterward showed the route still marked `active: 1` for
another ~91 seconds before finally settling — and `upstream_errors`
incremented (8 → 9) rather than `completed`, meaning it failed server-side
rather than merely running long. This rules out contention as the
explanation (the route was idle for the entire request) and rules out
`REVIEW_TIMEOUT_MS` tuning as a fix (raising the timeout only waits longer
for a request that errors out, not one that would have succeeded given more
time).

**Verdict: KAT-Coder is not adopted as the reviewer route.** This is a
structural capacity finding about the route/model, not a config problem —
`AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` remain pointed at Gemma.

### Gemma's own reviewer timeout was too tight — fixed

The same real-prompt methodology was then run against Gemma on `:8082`
(also confirmed idle beforehand) as a sanity check on the standing
reviewer route, since it had only previously been live-checked with a
small deliberately-planted-bug diff, not a full production-shaped prompt.

Result: **HTTP 200 in 121.4 seconds** (7,187 prompt tokens, 1,063
completion tokens), producing a real, correct finding (a partial-mutation
bug in `patchBookmark`: if tag validation fails after `title` has already
been written to the shared map entry, a failed `PATCH` still leaves a
partial update applied). But the prior `REVIEW_TIMEOUT_MS` was 120,000ms —
this request would have been aborted by `requestReview()`'s own
`AbortSignal.timeout` about 1.4 seconds before the model finished, silently
downgrading a correct, useful finding to `{ outcome: "transient" }`. On an
idle route with zero contention; any real contention (as seen in the
KAT-Coder investigation above) would push this further over the line, not
under it.

**Fix applied**: raised `REVIEW_TIMEOUT_MS` from `120_000` to `240_000` in
`pi/extensions/cross-model-review.ts` (commit `83ca0cb`), giving real
headroom above the measured idle-route baseline instead of a margin smaller
than the noise. No test hardcoded the old value; full deterministic suite
still passes 74/74 after the change.

## Full-harness rerun of pair 4 with Gemma configured as reviewer: task passes, but the reviewer's reactive trigger cannot fire against this benchmark's hidden-test methodology, 2026-08-04

With `REVIEW_TIMEOUT_MS` fixed, ran the actual standing configuration — Qwen
primary, `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` explicitly set to Gemma on
`:8082` — through the fully installed harness against pair 4
(go-flutter/bookmarks-app) end to end, not a bypass probe this time. `pi
--print` exit 0, 3 files changed (374 insertions/29 deletions).

Result, verified afterward with the real hidden tests copied in (matching
`run_screening.py`'s own methodology): **`go test -race ./...` 9/9 pass,
`dart test` 17/17 pass — a full task pass.** Cost: 31 assistant messages, 38
tool calls, ~430s wall time, 25.2K fresh input / 517K cache-read / 10.5K
output tokens. This is Qwen fixing the pair-4 race on its own (recall its
established base rate on this bug is 2/5), not new evidence about Gemma or
the harness.

**The reviewer never fired, and this time the cause is structural, not a
missing env var.** The prior KAT-Coder-primary run's missing review trace
was traced to a test-launcher gap (a detached shell not sourcing
`~/.zshrc`); this run explicitly exported `AI_REVIEW_BASE_URL`/
`AI_REVIEW_MODEL` into the process, ruling that out. Instead: tracing the
model's own bash calls in the session shows it never ran a command matching
`BROAD_VERIFICATION_PATTERNS`. `local-model-bench` deliberately copies its
hidden test files into the work directory only *after* `pi` exits (so the
model can't read or game them), so during its own session there is no
`server/bookmarksapi_test.go` and no `client/test/` directory to run
against. The model correctly adapted — it wrote its own hand-rolled Go
`httptest` smoke-test program instead of `go test`, which doesn't match the
broad pattern — and its one literal `dart test` invocation returned "No
test files were passed and the default 'test/' directory doesn't exist,"
a nonzero-exit usage error. `cross-model-review.ts`'s `tool_result` handler
explicitly skips on `event.isError`, so that invocation could never have
triggered a review regardless of route health or timeout value.
`quality-gate.ts`'s two "fail" trace events during this same session are
the same artifact from the other side: unlike the reviewer, quality-gate
runs its *own* settlement-time check rather than waiting on the model, so
it did fire — but against the same tests-not-yet-present repo state, so its
"fail" outcome reflects the same benign timing gap, not a real defect in
the final tree (which passed cleanly once real tests existed to run).

**Conclusion: `cross-model-review.ts`'s purely reactive trigger design (fire
only when the model itself runs a matching, successful verification
command) is structurally incompatible with `local-model-bench`'s
hidden-test-until-after-exit methodology.** No route, model, or timeout
value can fix this — the trigger's precondition never becomes true during
the session on any of these tasks. This is a real, newly identified gap in
the paired-battery evidence path for `independent-review`, separate from
today's KAT-Coder/timeout findings, and blocks the existing todo item
("rerun the seeded battery with `cross-model-review.ts` live") from ever
producing review trace data on this task suite without a design change —
e.g., a settlement-time reactive check mirroring `quality-gate.ts`'s
`agent_settled` hook, instead of (or alongside) the current `tool_result`
trigger.

## `make test`/`make check` recognized alongside `make verify`, 2026-08-05

Follow-up from the same conversation: a real target repo expects to expose
its test entrypoint as `make test`, not `make verify`. Before this fix,
neither `quality-gate.ts`'s settlement check (`resolveVerificationCommand`)
nor `cross-model-review.ts`'s trigger (`BROAD_VERIFICATION_PATTERNS`)
recognized a Makefile `test:` or `check:` target — only `verify:`, a
convention this project's own docs (`pi/AGENTS.md`, `README.md`) assume but
that most real-world repos don't follow. The failure mode was silent in
both directions: quality-gate would quietly bypass the Makefile entirely
and fall back to a bare `go test ./...`/`dart test`/etc (losing whatever
setup the real Makefile target does), and cross-model-review's trigger
would simply never fire on a `make test` invocation, indistinguishable from
the pair-4 hidden-test timing gap documented above but with a different
root cause.

Reasoned through the tradeoff before changing anything: recognizing `make
test` risks accepting a narrower target as if it were the full gate, if a
repo deliberately splits `test`/`lint`/`build` into separate Makefile
targets. But the comparison that matters isn't "make test vs make verify in
the abstract" — it's "make test vs whatever bare fallback command
quality-gate already silently substitutes today," and a real `make test`
target (with its own flags, env setup, fixtures) is very unlikely to be
narrower than that bare fallback. For `cross-model-review.ts`, recognizing
more real invocations has no downside at all: it's a bonus check, not the
enforcement gate, so added coverage can't weaken what's accepted as
"passing."

**Fix**: `BROAD_VERIFICATION_PATTERNS` now matches `make (verify|test|check)`
as one pattern instead of only `make verify`. A new shared
`makefileVerificationCommand()` helper (factored out of the previously
duplicated root/nested-manifest Makefile checks in
`resolveVerificationCommand` and `manifestCommandForDir`) checks Makefile
targets in that same priority order — `verify` still wins if a repo defines
more than one, since it's the more explicit "this is the full gate" signal
when present. Deliberately kept to this fixed three-name allowlist rather
than trying to dynamically infer "any target that looks test-like," which
would be unneeded speculative complexity for the realistic convention
space. 4 new tests in `pi/tests/verification.test.ts`
(`recognizes make test and make check alongside make verify`,
`verification resolution recognizes make test when there is no verify
target`, `...make check when there is no verify or test target`, `...still
prefers make verify over make test when both exist`). Full deterministic
suite: 78/78 (was 74/74). Typecheck clean.

## Live end-to-end test finds three of four new hardening extensions structurally blind, 2026-08-05

`pi/todo-app-hardening-plan.md` (PR #8, merged to main) added four new
extensions -- `new-project-scaffold.ts`, `makefile-scaffold-nudge.ts`,
`artifact-guard.ts`, `error-leak-guard.ts` -- with unit-test coverage but
no live trial. Ran one: `pi -p "Create a minimal Go HTTP backend for a
todo list with SQLite persistence..."` against a fresh empty directory,
non-interactive `-p` mode, `--mode json` for a full event log.

**What worked exactly as designed:** `new-project-scaffold.ts`'s git-init
nudge (repo initialized, `.gitignore` seeded, real commit made) and its
architecture nudge (`cmd/`, `internal/domain/{errors.go,ports.go}`,
`internal/handler` -- the exact layered shape asked for). Final code:
`go build ./...`, `go vet ./...`, `go test ./...` all exit 0, 15 tests
passing.

**What didn't fire, and why, read from the actual `--mode json` event
log rather than assumed:**

1. `makefile-scaffold-nudge.ts` never fired. Its precondition
   (`resolveVerificationCommand` resolves to something) was checked only
   in `before_agent_start`, which fires once, before any files exist. At
   that instant the directory was empty -- nothing to resolve a command
   from -- and the precondition is never re-evaluated after `go mod init`
   creates `go.mod` mid-session.
2. `error-leak-guard.ts` didn't flag a real instance of its exact
   motivating pattern: `handler.go` had `http.Error(w, err.Error(), ...)`
   seven times, verbatim. Event log showed `agent_settled` fires exactly
   once in `-p` mode, and — confirmed by exact ordering — *after*
   `agent_end`, i.e. after the model had already run
   `git add -A && git commit` as its own last action. `git diff` against
   HEAD was empty and there were zero untracked files by the time the
   check ran; the regex/logic was correct (unit tests with mocked diffs
   already proved that), the hook timing was wrong.
3. `artifact-guard.ts` has the identical structural blind spot for the
   same reason, for oversized/binary files instead of error-string leaks.

**Root cause, and the general lesson:** `agent_settled` is a terminal,
once-per-process checkpoint in `-p` mode, not a periodic per-turn sweep —
its name invites exactly the wrong assumption. `before_agent_start` is
once-before-anything-exists, also easy to mis-model as "the state I check
here stays representative." Neither assumption was validated against the
actual SDK before building on it.

**Fix**, advised by an Opus design-review pass and grounded in two SDK
facts confirmed from `node_modules/@earendil-works/pi-coding-agent`'s type
definitions (not guessed): `tool_result` handlers can append into the
tool's own result content in-band (`{content: [...]}` — no new turn, no
nudge budget), and `turn_end` fires once per assistant turn, which is the
actual per-turn sweep hook both guards needed and neither used.

- `error-leak-guard.ts` and `artifact-guard.ts`: primary detection moved
  to `tool_result` (write/edit content scan for the former; build-shaped
  bash commands like `go build -o ...` for the latter), independent of
  git state entirely. `agent_settled` kept only as a backstop, now using
  `baseSha` captured once at `agent_start` (matching `quality-gate.ts`'s
  own pattern) instead of always re-deriving an unresolved base.
  `artifact-guard.ts`'s backstop also now checks paths that changed
  between `baseSha` and current `HEAD` (the file is still on disk after a
  commit; only the path *selection* needed to widen), closing the
  already-committed-artifact case specifically.
- `makefile-scaffold-nudge.ts`: `before_agent_start` still nudges
  immediately for an already-populated repo; for a greenfield one it now
  gives conditional guidance up front and arms a `tool_result` flag when a
  manifest file (`go.mod`/`package.json`/`pubspec.yaml`/`Cargo.toml`)
  appears, nudging once at the next `turn_end` if still eligible — a
  `turn_end` boundary, not immediately on the write, so the nudge lands
  between coherent steps rather than interrupting one.
- A real bug surfaced by the *test suite* while implementing this fix, not
  the live test: collapsing "already covered by an existing Makefile" and
  "genuinely nothing to resolve yet (greenfield)" into one falsy check
  re-nudged already-covered repos with greenfield guidance they didn't
  need. Fixed by making `evaluate()` return a three-state result instead
  of an optional string.
- Explicitly rejected: intercepting/blocking `git commit` via `tool_call`
  to check before it lands. Commits are legitimate; blocking them is
  disproportionate to catching a lint-shaped finding, and costs a retry
  loop for something detect-and-correct handles fine.
- Documented the hook semantics (which fire once vs. per-turn, and what
  each can/can't return) in `pi/README.md`'s new "Hook semantics for
  extension authors" section, specifically so the next extension doesn't
  make the same assumption error twice.

Full deterministic suite: 115/115 (was 104/104). Typecheck clean. The
*revised* designs have not yet been live-tested — only the original,
now-superseded versions were. That's the next thing to verify, not this
write-up.

**Follow-up, same day:** an Opus review pass against the implementation
diff (not just the design) found three more real issues before push:

1. `committedSincePaths()` in `artifact-guard.ts` was permanently dead in
   exactly the greenfield case this whole round targets: `agent_start`
   only captures `baseSha` when `rev-parse HEAD` succeeds, so a repo whose
   first commit happens mid-session leaves `baseSha` `undefined` for the
   rest of the session, and the original code's `if (!baseSha) return []`
   meant the committed-since check silently never ran. Fixed to fall back
   to the empty-tree hash, same as `resolveDiffTarget` already does
   elsewhere — `git diff --name-only <empty-tree> HEAD` still lists
   everything committed since session start.
2. `BUILD_COMMAND_PATTERN`'s generic `\s-o\s+\S` matched `grep -o`,
   `curl -o`, `sort -o` — none of them a build command, each triggering an
   unnecessary full git status+diff scan and risking a false nudge.
   Narrowed to require `-o` specifically alongside a compiler invocation
   (`gcc`/`clang`/`cc`/`g++`), on top of the named build commands
   (`go build`, `cargo build`, `npm run build`, `flutter build`) that don't
   need the `-o` heuristic at all.
3. The new `tool_result` build-command path had no dedup, unlike
   `agent_settled`'s existing `lastFlaggedKeyByCwd`. Once something got
   committed, `committedSincePaths` kept returning it for the rest of the
   session, so every subsequent build command re-appended an identical
   in-band warning. Fixed by sharing the same dedup map across both hooks
   — as a side effect, `agent_settled` now correctly stays quiet for a
   finding `tool_result` already surfaced in-band, instead of repeating it
   as a separate followUp.

Also confirmed, by reading the SDK's actual `ExtensionRunner.emitToolResult`
dispatch loop, that multiple extensions' `tool_result` handlers for the
same event run strictly sequentially (`await`ed one at a time, never
`Promise.all`) — so `format-on-edit.ts`'s `gofmt -w`/`dart format` always
finishes before `error-leak-guard.ts`'s handler for the same write/edit
event reads the file, regardless of extension load order. Not a race.

3 new tests added for the fixes above. Full suite: 118/118. Typecheck
clean. Still no live trial of the revised designs.
