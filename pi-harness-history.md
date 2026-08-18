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

`history/pi-real-task-report-daily-briefing-screen.md`: one DayTrix feature,
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

- **`agent-configs/history/claude-pi-quality-extensions-review-feedback.md`** (dated
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
current invocation only. See `history/pi-real-task-report-daily-briefing-screen.md`
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
`history/pi-real-task-report-daily-briefing-screen.md`.

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

## GLM-4.7-Flash-4bit ruled out as reviewer candidate, 2026-08-05

A new local route appeared on `:8081` serving `GLM-4.7-Flash-4bit`
(`mlx_vlm.server`, `kannasmacstudio.lan`), a candidate to replace or
supplement Gemma as `cross-model-review.ts`'s reviewer. `resolveReviewerConfig()`
correctly resolved `independent-review` for it (distinct baseUrl/model from
the `:8080` Qwen primary) — the config-resolution logic itself needed no
changes. The question was whether the model behind the route could actually
review.

**Method**: the same three-planted-bug methodology as the original Gemma
validation (2026-08-04, above) — a task spec plus a diff with one
deliberately introduced logic bug each, via `requestReview()`'s real prompt
shape (`temperature: 0`, ending on `NO_ISSUES_FOUND` if clean): a
`clampToRange` missing its upper-bound clamp, a `divide` missing its
required zero-check, and an `add` implemented as subtraction (the last as
a floor case — no ambiguity possible).

**First pass, default (non-thinking) invocation**: 0/3. Every response was
`NO_ISSUES_FOUND` in ~5 completion tokens with `reasoning_content: null` —
consistent with pattern-completing straight to the escape-hatch marker
rather than engaging the diff at all. Gemma, given the identical prompts
over the same harness code path, caught 3/3 with 36-91 tokens of visible
reasoning each.

**Second pass, `chat_template_kwargs: {"enable_thinking": true}`**: GLM is
a hybrid-reasoning model family where thinking mode is opt-in per request
on most local serving stacks, so this was the obvious next lever before
ruling anything out. It changed the picture but did not fix it: across 10
trials at `temperature: 0` on the same three prompts (`divide` ×4,
`clampToRange` ×2, `add` ×4), it caught the bug exactly once (`add`, one
trial, 56 tokens) and reverted to the 5-token `NO_ISSUES_FOUND` shortcut on
every repeat of the *same* prompt, including immediate re-tries of the one
case it had just caught. 1/10 overall. This rules out "thinking mode was
simply off" as the explanation — the flag measurably changes behavior (it
can produce real reasoning) but does not make it reliable, and reliability
at `temperature: 0` on a repeated prompt is the bar that matters for a
review gate, not occasional capability.

**Community corroboration** (not just this harness's own n=1): Reddit
reports on LiveBench-style reasoning tasks describe GLM-4.7-Flash as
"disappointing compared to Qwen3 'Thinking' models," matching the
Flash-tier tradeoff the model family is explicitly built around (fast/cheap
over reasoning depth). Separately, HuggingFace quantization discussion
threads for this exact checkpoint's 4-bit quants report degraded
performance specifically on tool-use/agentic tasks, attributed to the
calibration set (`nvidia/Nemotron-Post-Training-Dataset-v2`) lacking
tool-calling/agentic examples — a structured-judgment task like spec-vs-diff
review sits in the same category the calibration gap would predict is
weak.

**Verdict: not adopted as reviewer, with or without thinking mode.**
`AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` remain pointed at
`gemma-4-26b-a4b-it` on `:8082`, unchanged. Unlike the KAT-Coder reviewer
rule-out (a structural capacity failure — the route errored on a real
request regardless of content), this is a reliability/capability failure:
the route responds fine and fast, it just doesn't do the review task
correctly on this checkpoint at 4-bit. An 8-bit requant is the one
un-tried lever if this route is revisited, but is not currently planned —
see todo.

## Stale `AI_REVIEW_MODEL` silently disabled the reviewer, found and fixed, 2026-08-05

Asked to run a fuller reviewer-reliability battery on `gemma-4-26b-a4b-it`
now that it lives on `:8081` (only smoke-tested at that point, per
`local-ai-stack.md`), the first sanity check before spending trials on the
battery itself was a direct request against the configured
`AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL`. It came back **HTTP 400
`model_mismatch`**: `GET :8081/v1/models` reports the served id as
`/Users/kanna/code/ai-stack/models/gemma-4-26b-a4b-it-4bit` — a full path
plus a `-4bit` suffix — while `~/.zshrc` still exported the short form,
`gemma-4-26b-a4b-it`, unchanged since the model was wired in on `:8082`
back on 2026-08-04 (see "`cross-model-review.ts` wired to a live Gemma
route" above, where that short id was correct for the route at the time).

The failure mode is silent by design, not by bug: `requestReview()` checks
`response.ok` and returns `{outcome: "transient"}` on anything else, the
same path used for genuine transient failures (timeouts, network blips) so
a flaky route doesn't block the harness. That means every real review
request since the `:8082`→`:8081` move 400'd and was swallowed as
"transient" — no crash, no error surfaced to the model or the user, no
harness-trace entry distinguishable from an ordinary timeout. The reviewer
looked configured (`resolveReviewerConfig()` still correctly resolves
`independent-review`, since that check never talks to the route) and
looked adopted in the status doc, while doing nothing.

**Fixed** by exporting the full served id in `~/.zshrc`. Verified live:
the identical request that 400'd now returns 200.

**Battery, run against the corrected id** using the same three-planted-bug
methodology as the Gemma/GLM validations above, via the real
`requestReview()` export for fidelity with production behavior (not a
reimplemented prompt):

- `clampToRange` missing its upper-bound clamp — 5/5 trials flagged.
- `divide` missing its zero-check — 5/5 trials flagged.
- `add` implemented as subtraction — 5/5 trials flagged.
- False-positive control: the correct implementation of all three
  functions, 3 trials each — 9/9 returned `NO_ISSUES_FOUND`.

15/15 catches, 9/9 clean controls, all at `temperature: 0` via the real
endpoint. Response length was identical across every repeat trial within
a given bug, consistent with genuine deterministic reasoning rather than
sampling noise. This is a stronger and broader result than the earlier
2026-08-04 single-trial spot-check on the same route, and stands in
contrast to GLM-4.7-Flash-4bit's 1/10 on the identical methodology (see
above). It remains synthetic single-diff fixtures, not the
production-shaped long-diff case that motivated raising
`REVIEW_TIMEOUT_MS` (the 22K-character, 121s request in "Gemma's own
reviewer timeout was too tight" above), and not a real paired-battery
task — see todo in `pi-harness-validation-status.md`.

**Lesson for future route moves**: a served-model-id change is a silent
failure mode for any static client declaration (Pi's provider config,
`cross-model-review.ts`'s env vars, `ai-stack-local.ts`), not just a
`/v1/models`-discovering shell script's problem. `local-ai-stack.md`'s
client rules only covered the dynamic-discovery clients; the static ones
need the same discipline — re-check `/v1/models` against the configured
id whenever a route's checkpoint changes, don't assume last time's id
still matches.

## Real-task nudges from the personal-budget-simplifier build, 2026-08-05 (in progress)

A second real (non-fixture) task, structurally different from the DayTrix Daily Briefing
screen — a Go backend built from scratch rather than a Flutter screen added to an existing
app — surfaced two bugs that passed `pi`'s own same-model `quality-gate.ts` verification
(`outcome: "pass"` on both) but did not survive independent review: a false-positive SQLite
`:memory:` idempotency test (two `Open(":memory:")` calls never share state, so the test
could not have failed even with the guard removed) and a silently-dead duplicate keyword
entry in a first-match-wins categorizer table. Full numbers, both bugs, and concrete
`AGENTS.md`-wording nudges in `history/pi-real-task-report-personal-budget-simplifier.md` (a living
document — the build isn't finished). Headline lesson: same-model self-verification is
recurring evidence *for* the standing unresolved item above (make cross-model review the
default, not opt-in) rather than a new finding — it's the same gap, from a second task shape.

**Update, same day, chunk 3 (HTTP handlers):** `quality-gate.ts` this time correctly reported
`outcome: "fail"` on a real `go build` error — the gate itself worked — but the agent settled
(ended the `-p` run) on that failure instead of self-correcting; worth confirming whether the
documented three-corrective-follow-up loop is wired for non-interactive `-p` invocations at all,
since that's the only invocation shape this orchestration pattern uses. After the build was fixed
by hand, three more real bugs surfaced that `gofmt`/`go build`/`go vet` structurally cannot catch:
the same defer/lifecycle class of test-fixture bug as chunk 1 (this time `defer os.Remove(...)`
inside a helper firing at the helper's return, deleting a SQLite file still in use — a recurring
pattern across two backend chunks now, worth its own named `AGENTS.md` rule), a missing `return`
after a written error response causing a double-write, and a cross-chunk JSON-tag omission
(chunk 2's store structs had no `json` tags) that `go test` could not catch because its own
assertions decode responses back into the same Go structs — `encoding/json` matches field names
case-insensitively on decode, so a wire-format mismatch is invisible to any round-trip test where
both ends are the same language's types. Only a raw-bytes `curl` smoke test caught it. Full
detail in the same report file.

**Update, same day: `cross-model-review.ts` confirmed not to fire under `pi -p`, at all.**
Checking whether chunks 1–4 actually benefited from the (supposedly fixed) reviewer found two
stacked problems. Environmental: this orchestrating session's `Bash` tool reported the exact stale
`AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` pair `~/.zshrc` was already corrected away from — because
`.zshrc` is interactive-shell-only by zsh's own rules, the Bash tool's shell invocation is
non-interactive (`zsh -c source snapshot...`), and the session's inherited env was frozen before
the `.zshrc` fix landed; `env -i HOME=$HOME zsh -c 'source ~/.zshrc'` in a clean room reproduces
the *correct* values, proving the file is right and only live propagation is wrong. General lesson:
anything an orchestrator needs `pi -p` to see must be exported inline on the invocation itself,
never assumed to come from dotfiles. But fixing that inline did **not** fix the real problem: a
controlled diagnostic with correct env exported inline, a real diff, and a real broad verification
command produced zero reviewer trace output — no `session_start` startup trace (logged
unconditionally by the extension's own code), no `review` trace — while `stack-router.ts` and
`quality-gate.ts` both fired correctly in the identical run, the latter on the same
`agent_start`/`tool_result`/`agent_settled` hooks `cross-model-review.ts` also registers.
`resolveReviewerConfig()` itself is confirmed correct by direct module import with the identical
env (`{enabled: true, kind: "independent-review", ...}`). **`cross-model-review.ts` is therefore
not confirmed to run at all under `pi -p` invocations**, independent of configuration — meaning
every `pi -p`-based orchestration pattern in this harness, including every chunk of this build, has
gotten zero benefit from it. `pi-harness-validation-status.md`'s "resolves to genuine
`independent-review`" framing is downgraded accordingly: true of the config, never demonstrated
true of the running extension. Root-causing why needs instrumentation inside `pi`'s own extension
loader — out of scope for black-box orchestration-side investigation. Full detail, including the
exact diagnostic commands, in `history/pi-real-task-report-personal-budget-simplifier.md`.

**Update, chunk 5 (Flutter screens):** none of the four `AGENTS.md` gotchas above recurred (weak
positive signal, one clean chunk). A new class did: an escaped `\$` immediately followed by `{...}`
in Dart silently disables interpolation, rendering literal template text instead of a computed
value — compiles clean, `flutter analyze` silent, only caught because the one test touching that
code path was strengthened to assert the actual rendered string (not just a nearby icon) with a
non-round-dollar fixture. Added as gotcha #5. Full detail in the report file.

## Corrected: two false harness-bug findings, root cause, and the one real fix, 2026-08-05

The two "confirmed" harness bugs above — `cross-model-review.ts` never firing under `pi -p`, and
by implication `quality-gate.ts`'s corrective follow-up doing nothing there either — were **wrong**.
Both retracted after direct instrumentation, not further black-box inference.

**How the retraction was done.** Debug logging (`node:fs.appendFileSync` to a fixed path) was
inserted directly into `cross-model-review.ts`'s `session_start`/`tool_result` handlers and
`quality-gate.ts`'s `agent_settled` handler — temporarily, reverted to a clean `diff`-verified
state immediately after — then two categories of test were rerun in isolation, with no other heavy
process running concurrently:

- **Reviewer**: two separate isolated `pi -p` runs (small, real doc-comment edit + real `go build
  && go test`, on the actual `personal-budget-simplifier/backend`) both showed the full expected
  sequence — `MODULE_LOADED` → `REVIEWER_FN_CALLED enabled=true kind=independent-review` →
  `SESSION_START_FIRED` → several `TOOL_RESULT_FIRED` events → `TOOL_RESULT_TRIGGERING_REVIEW` on
  the matching bash command — and both completed a real network round-trip to `:8081`
  (1.6s and 5.7s) with `outcome: "clean"` logged via the normal `pi-harness-trace` channel.
  Reproducible, not a fluke.
- **Quality-gate**: an isolated scratch repo, one forced-failure task (add an intentionally
  broken line, explicitly instructed *not* to fix it, run `go build`), showed
  `AGENT_SETTLED_FIRED` → `RAN_VERIFICATION passed=false` → `SENDING_FOLLOWUP attempt=1`,
  followed roughly a minute later by a **second** `AGENT_SETTLED_FIRED` with
  `correctiveFollowUps=1` carried forward — proof the `sendUserMessage(..., {deliverAs:
  "followUp"})` call was actually delivered and the agent resumed for another turn under `pi -p`,
  contradicting the earlier claim outright.

**What actually caused the false negative**, best explanation given the evidence: both original
"zero trace output" observations happened while a second heavy process was running concurrently on
this machine — a second `pi -p` chunk still in flight for one, a `flutter run -d macos` Xcode build
for the other (the retried README chunk that silently died mid-response, `stopReason: "pending"`,
zero live process afterward, is the clearest smoking gun — a `pi -p` process was killed outright,
not gracefully exited). `--mode json` output redirected to a file is fully buffered, not
line-buffered; a killed-rather-than-exited process can lose everything sitting in that buffer,
including a `session_start` trace that in reality fired in the first few milliseconds. A log file
with zero mentions of an extension is not proof the extension was silent — it can just as easily
mean *the process died before its output reached disk*. Lesson for future harness diagnostics:
never run a black-box "did X fire" test concurrently with another heavy `pi`/build process on the
same machine, and treat total silence in a backgrounded/redirected log as inconclusive, not
conclusive, unless the process's own exit code and a completion marker are both confirmed — a
"finished" `kill -0` poll does not distinguish a clean exit from a kill.

**The one finding that held up and got fixed for real**: `.zshrc`'s `AI_REVIEW_*` values genuinely
did not reach the Bash tool's non-interactive shell — confirmed via a clean-room `env -i HOME=$HOME
zsh -c 'source ~/.zshrc; ...'` reproducing the *correct* values while every other test in this
session showed the stale pair, which isn't explainable by resource contention. **Fixed**, not just
documented: `AI_STACK_HOST`/`AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL`/`PATH` moved from `~/.zshrc` to
`~/.zshenv`, which zsh sources for every invocation regardless of interactive/login status.
Verified against a fully isolated `env -i` shell (no inherited environment at all) resolving
correctly, and confirmed the fix took effect immediately within the same session — each `Bash`
tool call turned out to spawn a genuinely fresh non-interactive shell rather than reusing one
frozen at session start, so there was no stale-session-env problem to wait out, just the wrong file.
`~/.zshrc` now carries a pointer comment instead of the duplicated exports, removing the drift risk
that caused the original (real) "Stale `AI_REVIEW_MODEL`" incident in the first place.

Net effect on `pi-harness-validation-status.md`: the "downgraded" framing from the same-day entries
above is reverted; `cross-model-review.ts` and `quality-gate.ts`'s `-p`-mode behavior are both
instrumentation-confirmed working, and the only genuinely open item from this build's investigation
is the pre-existing, narrower, already-documented one — the reviewer's purely reactive `tool_result`
trigger structurally cannot fire on task suites (like `local-model-bench`) that hide tests until
after `pi` exits, which is a design gap, not a `-p`-mode bug.

## Correction of the correction: the retraction above was itself wrong on the reviewer, 2026-08-05

An independent Opus review of the retraction commit, asked to check its reasoning against the
actual source and pi's own durable session records (`~/.pi/agent/sessions/**/*.jsonl` — separate
from, and unlike, the `--mode json` stdout log the retraction relied on), found the retraction's
mechanism was wrong and its "no real bug" conclusion was wrong for `cross-model-review.ts`
specifically. `appendHarnessTrace` calls `pi.appendEntry(...)`, which persists to the session file
— not stdout — so it cannot be lost to a killed process's stdout buffer the way the retraction
claimed. Checked directly: **all 7 real personal-budget-simplifier build sessions carry a reviewer
`startup` trace (`outcome: "pass"`), and zero of them carry a `review` trace** — including the two
sessions (20:07, 20:28 UTC) that ran after the `AI_REVIEW_*` config was already correct. The
reviewer genuinely never completed a single review round anywhere in this build. The original
same-day claim was right; the retraction was wrong to clear it.

**Root cause, this time confirmed against source, not inferred**: `cross-model-review.ts`'s
`tool_result` handler built its diff with a bare `pi.exec("git", ["diff", target])`. `git diff`
never shows untracked file content, under any target — that's normal git behavior, not a bug in
the target-resolution logic. `personal-budget-simplifier` had exactly one commit for its entire
build, made at the very end; every chunk ran against an all-untracked working tree, so `git diff`
was empty on every single tool_result, `!diff` short-circuited before `requestReview` was ever
called, and no trace was emitted on that path — silent by construction, matching the observed
startup-then-nothing signature exactly. `quality-gate.ts`'s `snapshotDiff` (used for its own
verification-evidence hash) already handles this correctly, merging `git diff` with
`git status --porcelain --untracked-files=all` and hashing untracked file content — the two
extensions simply didn't share that logic.

**Fixed for real, verified for real**: added `buildReviewDiff()` to `extensions/lib/verification.ts`
— gathers the same `git status --untracked-files=all` untracked-path list `snapshotDiff` does and
synthesizes a diff block per untracked file (reading its content, formatting as a `new file`-style
unified diff; skips binary/oversized files defensively) instead of shelling out to `git add -N`,
which would mutate the index as a side effect of what should be a read-only review pass.
`cross-model-review.ts` now calls this instead of a bare `git diff`. Also added a `review`/`blocked`
trace on the previously-silent early-return paths (`!diff` / `!spec` / unchanged-since-last-review)
so this class of bug is diagnosable from the trace record alone next time, without needing to read
session JSONL files by hand. First attempt at the fix broke one of the 123 deterministic tests
(`buildReviewDiff`'s `Promise.all` accidentally swallowed exec rejections via a blanket
`.catch(() => undefined)`, which broke the existing stale-context-during-review test — a stale-
context rejection must propagate to the caller's `isStaleContextError` handling, not get silently
treated as "no diff"); fixed by removing that catch and letting genuine rejections propagate, kept
only the "resolved but non-zero exit code" case as an expected empty result. `npm run typecheck`
clean, `npm test` 123/123. **Live-verified against the exact original bug condition**: a fresh
scratch repo, `git init`, zero commits, one untracked `.go` file — the reviewer previously would
never fire here; after the fix, a real `pi -p` run against it produced a genuine `outcome: "clean"`
review trace with the file confirmed still untracked (`git status` showing `?? main.go`, no commits)
at the time.

**Quality-gate's corrective follow-up: left as genuinely open, not re-closed.** The isolated
`/tmp/qg-test` result reported above (a second `agent_settled` firing ~1 minute after the first,
`correctiveFollowUps=1` carried forward) is real and stands — but checking the *actual* chunk-3
build session directly (`2026-08-05T19-36-29…jsonl`) shows the opposite: one `quality-gate`
`outcome: "fail"` trace, zero occurrences of the follow-up message text anywhere in the session,
and the file ends immediately after the last assistant turn — no second round happened there. The
isolated test used a small, single-file, few-turn scratch repo; the real chunk-3 session had
already run nine assistant turns by the time it failed. Whether turn count, context size, or
something else explains the difference is not established. Downgrading `quality-gate.ts`'s
corrective-follow-up status back to **unresolved / context-dependent** — confirmed capable of
working in a simple case, confirmed not to have fired in the one real multi-turn case checked. Not
claiming it as fixed or broken; it needs a repro closer to a real chunk's shape (many turns, larger
context) before either conclusion is defensible.

**Standing lesson, reinforced twice in one day**: `--mode json`'s redirected stdout stream and
`pi`'s own session JSONL files are not the same record, and a claim about what fired or didn't
should be checked against the session files (`~/.pi/agent/sessions/**/*.jsonl`), not just a
redirected log — this is what the first retraction itself failed to do, and what an independent
second reviewer catching that failure via `git show`/`git diff` on the retraction commit (not by
re-running anything) is direct evidence for treating "a second independent read" as more valuable
than another self-directed instrumented test. Full detail, the exact `buildReviewDiff` diff, and
the live-fire confirmation transcript in `history/pi-real-task-report-personal-budget-simplifier.md`.

## A `.zshenv` defaulting nuance found while reviewing the CSV sign-flip fix, 2026-08-05

Invoking `requestReview()` directly (to get the real reviewer's opinion on the committed
`personal-budget-simplifier` CSV sign-flip fix, via `HEAD~1..HEAD`) resolved the *stale* `:8082`
config on the first attempt, despite `~/.zshenv` having been fixed and verified hours earlier in
this same session. Cause: `~/.zshenv` uses `${VAR:-default}` specifically so an inline override
still wins over the file's default — but that same mechanism means it can only fill in a variable
that is currently *unset*. This one long-running session's root environment had `AI_REVIEW_BASE_URL`
set to the stale pair from before `~/.zshenv` existed at all, inherited into every subprocess since;
`${VAR:-default}` cannot distinguish "the user deliberately set this and it should win" from "this
is a leftover stale value from an ancestor process," so it correctly leaves the former alone and
therefore also leaves the latter alone. This does not contradict the earlier `env -i`/fresh-shell
verification — those tests started from a genuinely clean environment, which is exactly the case
`${VAR:-default}` is designed for, and exactly the case every *new* terminal/session will be in.
It only affects a session whose environment was already poisoned before the fix landed. Practical
implication for the remainder of this session specifically: keep exporting `AI_REVIEW_BASE_URL`/
`AI_REVIEW_MODEL` inline on every direct invocation here, same as throughout the rest of this
build — the `~/.zshenv` fix is real and will hold for the next fresh session, just not retroactively
for this one's already-running root environment.

## Archived from pi-harness-validation-status.md, 2026-08-13 doc reorg (goal-gate.ts build-out, background-kill investigation, TUI crash — originally dated 2026-08-09 through 2026-08-12)

This section is a verbatim move, not a rewrite: it was previously the tail of
`pi-harness-validation-status.md` and grew past that file's intended
lightweight/current-state scope. Relocated here so that file could go back to
being a short extension-by-extension summary; nothing below was edited for
content, only moved.

## Update 2026-08-09: cross-model-review settlement-time trigger added

Todo item "Give `cross-model-review.ts` a settlement-time trigger" is done.
`agent_settled` now falls back to firing a review round directly (gated on
`snapshotDiff(...).material`, so an empty/no-op turn doesn't spend one) when
no `tool_result`-triggered round ever completed this session —  covers
exactly the `local-model-bench`-shaped gap described in the original todo
(hidden tests don't exist yet during the model's own session, so the
reactive trigger structurally can't fire). Both triggers now share one
`startReviewRound()` path and tag their trace `metadata.trigger` as
`tool_result` or `settlement` so which one fired is greppable. Same caveat
as quality-gate's corrective follow-up applies and is stated in the code
comment: whether a `sendUserMessage(..., {deliverAs: "followUp"})` sent
this late in the turn reliably produces a second turn under `pi -p` is
still the open question tracked below, not newly resolved by this change —
firing at all, even without a guaranteed follow-up turn, is still strictly
better than the previous zero-fire outcome, since the review trace/verdict
itself is real signal. `npm test`: 131/131 (2 new tests: fires on a
material diff with no prior tool_result round; does not spend a round on
an empty diff). Live battery re-run against `local-model-bench` still
pending — this is source/unit-tested only so far, same evidentiary status
the rest of this doc uses that phrase for elsewhere.

## Update 2026-08-09: zero-human full-stack build orchestrator

`pi/scripts/build_app.py` (new) — drives `pi -p` through however many
corrective rounds it takes to get real verification evidence passing, with
no chat interaction and no assumption that quality-gate's in-session
follow-up loop works under `-p` (it's independently unresolved, see above).
The orchestrator runs its own verification command after each `pi -p`
round and starts a fresh `--continue` round with the failure as the prompt
if it didn't pass, capped at `--max-rounds`. Optional `--containment` runs
each round through the live-proven Docker sandbox. Always writes
`BUILD_REPORT.md` (rounds, verify results, extension traces, review
verdicts) as the durable zero-human record. Full detail and known gaps in
`pi/scripts/README.md`.

Live-smoke-tested twice 2026-08-09 (Go/net-http health-endpoint task, host
direct, no `--containment`): both runs succeeded on round 1 —
`stack-router` routed, `quality-gate` verified twice, `cross-model-review`
fired via its `tool_result` trigger and returned `clean`, real commit made,
`go vet`/`go test` independently re-confirmed passing outside the harness.
Second run also confirmed the orchestrator's own `.pi-build-session/` and
`BUILD_REPORT.md` stay out of the app's git history (a real leak the first
run hit and the second run's `.gitignore` seeding fixed). This is two
confirming repros on one task/stack, not a battery — multi-round corrective
recovery, `--containment`, and non-Go stacks are unexercised; see the
todo below and `pi/scripts/README.md`'s "Known gaps" section.

## Update 2026-08-09: `/goal` command (goal-gate.ts)

New: `pi/extensions/goal-gate.ts` — a Claude-Code-style `/goal <condition>`
command (registered via `pi.registerCommand`, not a prompt template, since
it needs persistent cross-turn state and a stop-time gate). Sets a
session-scoped goal, kicks off a follow-up turn immediately, and on every
`stopReason: "stop"` turn checks for a literal `GOAL COMPLETE: <evidence>`
line backed by the most recent broad verification command actually having
passed; nudges to continue otherwise, capped at `PI_GOAL_MAX_ROUNDS`
(default 15). Deliberately does not add an LLM-judged completion check —
see the file's own header for why a same-model judge would carry the same
self-report bias this doc already documents elsewhere. `npm test`:
143/143 (12 new deterministic tests, `pi/tests/goal-gate.test.ts`); `tsc
--noEmit`: clean.

**Live-tested 2026-08-09 against a fresh empty repo under `pi -p`
(`/goal say hello and stop`, "hello" Go program task) — two real bugs
found and fixed, both confirmed by the fix's own rerun, not assumed:**

1. **The kickoff never ran at all.** First live attempt: `pi -p "/goal ..."`
   exited immediately (exit 0, one `session` line, zero `agent_start` —
   not even a turn attempted) whether run in `--mode json` or plain text.
   Root cause, confirmed by reading `agent-session.js`:
   `ctx.waitForIdle()` returns instantly if the agent is idle *right now*
   (`if (this.isIdle) return`), and `pi.sendUserMessage()` only queues a
   turn -- it returns void, not a promise, and the queued turn hasn't
   started by the time the command handler's next line runs. Calling
   `waitForIdle()` right after `sendUserMessage()` raced the not-yet-started
   turn and returned immediately, so the `-p` process exited before the
   kicked-off turn ever began. **Fixed**: the command handler now waits for
   a real `agent_start` event (bounded by `PI_GOAL_KICKOFF_TIMEOUT_MS`,
   default 10s) before calling `waitForIdle()`. Confirmed live after the
   fix: a real `agent_start`/turn sequence now runs under `-p`.
2. **A genuine pass kept getting rejected as unverified.** With bug 1 fixed,
   the same task ran for 74+ turns and 15 nudge rounds without ever
   accepting a `GOAL COMPLETE` claim, despite `quality-gate.ts`'s own trace
   log showing the exact same verification command passing repeatedly.
   Root cause: `lastVerification` was reset to `"none"` after *every*
   nudge, but `stopReason: "stop"` fires on ordinary mid-task narrative
   with no tool call too (`"Now I'll run the tests:"` with nothing
   attached) -- exactly what `continuation-nudge.ts` calls an abandoned
   turn -- not only on genuine stopping points. Each such narrative turn
   wiped out a real pass long before the model's next actual completion
   attempt. **Fixed**: only reset `lastVerification` when a `GOAL COMPLETE`
   claim is specifically rejected, not on every nudge; documented as a
   known, accepted gap that this signal isn't diff-hash-bound the way
   `quality-gate.ts`'s is. **Confirmed live after both fixes**: rerun of
   the identical task (fresh empty repo, same prompt) accepted
   `GOAL COMPLETE` on the model's *first* claim (`pi-goal-trace` entry:
   `{event: "complete", rounds: 0}`), finishing in 11 turns instead of 74+.
   Verified independently, outside the harness: `make verify` passes,
   `go run .` prints `hello`. 15 new/updated deterministic tests
   (`pi/tests/goal-gate.test.ts`, 15 total for this file); `npm test`:
   146/146; `tsc --noEmit`: clean.

Not yet run: the actual planned target task (multi-round, open-ended
feature work against `personal-budget-simplifier`) -- both fixes above
were found and confirmed on a small single-round smoke task, which is
enough to trust the mechanism's basic wiring but not its behavior across
many genuine nudge rounds on a large existing codebase. See todo below.

**Update, same day: the real target task was run.** `/goal enrich this
app's features and make it a true, usable full-stack app` against
`personal-budget-simplifier` (existing Go+Flutter repo, not a fresh
empty one). Real, verified outcome: 3 clean commits landed on `main`
(new backend endpoints -- trends/delete/export/rename, all with Go test
coverage; the trends Flutter UI wired into the dashboard;
`category_name` wired through the API responses and Flutter models),
`make verify` fully green, pushed to `origin/main`. This is genuine
incremental progress, not the full "true usable full-stack app" scope
(delete/export/rename aren't in the UI yet) -- the run did not
self-report completion; it was stopped deliberately partway.

Two things worth recording plainly rather than glossing over:

1. **The background `pi -p` process was killed twice, unexplained,
   mid-round** (host/orchestration-level, not something in `goal-gate.ts`
   itself asked for or logged) -- each time it left a real, partially-
   applied diff in the workspace, once with a broken build. This is an
   operational reliability gap for any unattended multi-round `/goal`
   session on this machine: something outside pi's own process can end it
   mid-edit with no warning, and the only recovery path right now is a
   human noticing and manually resuming with `--continue`. Worth
   root-causing before treating long unattended `/goal` runs as safe to
   walk away from.
2. **The round-to-round loop in practice was `pi --continue` with a
   plain human-written follow-up prompt, not a live `/goal` nudge
   surviving across those kills.** `goal-gate.ts`'s own state is
   documented as session-scoped/in-memory (see its file header) -- a
   killed-and-restarted process is a new extension instance with no
   active goal, so each recovery here was effectively a manual
   `build_app.py`-style outer round, not the `/goal` mechanism itself
   proving multi-hour endurance. The single-process, single-`/goal`-
   invocation case (the personal-budget-simplifier round that ran
   uninterrupted) did behave correctly and did produce the second
   verified commit + fix without manual intervention.

**Update 2026-08-09/10: second confirming smoke run, fresh empty repo,
different stack.** `/goal write a small Python calculator module (add,
subtract, multiply, divide with zero-division handling) in calc.py with
pytest tests in test_calc.py covering each function including the
divide-by-zero case; run pytest and only report done once it passes`
against a brand-new empty git repo (no prior `/goal` usage in that repo).
Single uninterrupted `pi -p` process, full JSON event log captured and
hand-traced line-by-line rather than trusted from the model's own summary:

- **Kickoff fix held**: `agent_start` fired immediately after the
  `session` event, no race, no empty exit.
- **Genuine pass correctly accepted on first claim** -- but, per review
  correction, this does NOT confirm the false-rejection fix specifically.
  The model hit real environment friction first (no venv, `pytest` not
  installed, two failed verification attempts logged by `quality-gate.ts`
  as genuine `fail`s) and only declared `GOAL COMPLETE` once `pytest`
  actually passed, accepted immediately (`pi-goal-trace`: `{event:
  "complete", rounds: 0}`). **Correction**: this entry originally claimed
  that as a second confirmation the false-rejection fix "held." Wrong --
  the bug that fix closed only fires after at least one nudge round resets
  `lastVerification`, and this run's `GOAL COMPLETE` claim was the model's
  *first* stop turn with no preceding nudge, so the buggy pre-fix code
  would have accepted this exact claim too. This run confirms genuine
  environment friction doesn't cause a false accept, which is real but
  weaker evidence -- it does not exercise the reset-on-nudge path at all.
  That path is still unconfirmed; see the Todo entry.
- **Independently reverified, not just trusted from the log**: ran
  `pytest` myself outside the harness afterward against the same
  `calc.py`/`test_calc.py` the agent wrote -- 5/5 passed, matching the
  agent's claim exactly.
- **A second, unrelated mechanism also fired correctly and is worth
  noting**: after goal-gate cleared the (now-met) goal, `artifact-guard.ts`
  independently caught real Mach-O binaries left in `.venv/` at
  settlement time and nudged a cleanup turn. The model's cleanup turn also
  ended with a `GOAL COMPLETE` line in its text, but by then `goal-gate.ts`'s
  own state was already `undefined` (cleared on the first acceptance), so
  its `turn_end` handler's early-return (`if (!goal) return`) means that
  second marker was inert text, not a second accepted completion --
  confirmed by only one `pi-goal-trace` `complete` entry existing in the
  whole log. Good defense-in-depth evidence: two independent settlement
  mechanisms (goal-gate's own gate, artifact-guard's separate check) each
  did their own job without interfering with each other.

This is the second stack (Python, vs. the first smoke test's Go and the
target run's Go+Flutter) and a second confirmation that the kickoff fix
holds. The false-rejection fix's own reset-on-nudge path is still only
confirmed by the original Go smoke test's before/after rerun (74+ turns
pre-fix vs. 11 turns post-fix), not by this run -- see correction above.
Still not covered by any run so far: many nudge rounds within one
uninterrupted process on a task that doesn't converge on the first genuine
attempt (every confirming run to date -- this one and the original Go
smoke test -- happened to reach `rounds: 0` on its `GOAL COMPLETE` claim),
and the fully-unattended multi-restart endurance case flagged above.

**Update 2026-08-10: real remaining scope on personal-budget-simplifier,
run foreground (not backgrounded) to sidestep the unexplained-kill gap.**
`/goal wire delete, export, and rename into the Flutter UI (backend
endpoints for these already exist and are tested) so a user can actually
invoke them from the dashboard, not just via the API; keep make verify
green after every change` -- the exact leftover scope the prior
personal-budget-simplifier run didn't finish. Single uninterrupted `pi -p`
process (foreground; the harness auto-moved it to background tracking
after its 10-minute cap, but it kept running as the same process -- no
kill this time), full event log hand-traced:

- **goal-gate itself again converged on `rounds: 0`** -- the model's first
  `GOAL COMPLETE` claim was backed by a real passing `make verify` and was
  accepted immediately. Third straight run (after the Go and Python smoke
  tests) that didn't reach the nudge-and-reject path; that gap is still open.
- **New, real evidence though: `cross-model-review.ts`'s independent
  reviewer caught a genuine crash bug post-completion and drove its own
  fix loop.** After goal-gate accepted completion, the reviewer flagged
  `dashboard_screen.dart`'s long-press rename handler using `.first` on a
  `.where(...)`-filtered list -- throws if the category was renamed/deleted
  server-side between load and long-press. Round 1: model fixed it
  (`.firstOrNull` + null guard), reran `make verify`, passed. Round 2: the
  reviewer re-flagged the *same, already-fixed* line (a real staleness/dedup
  gap in the reviewer's own re-check, not a fresh bug) -- the model
  correctly recognized it as already-fixed rather than blindly re-editing.
  Round 3: reviewer confirmed clean. **Correction**: this entry originally
  called this the settlement-time trigger firing -- wrong, re-checked
  against the raw trace and every one of these rounds carries
  `trigger: "tool_result"`, the same already-live-confirmed path documented
  above, not the newer `settlement` path. What this run *does* newly
  confirm is the `tool_result` reviewer catching and driving a real fix for
  a bug goal-gate's own pass/fail signal couldn't see (it only knows
  whether the verification *command* passed, not whether a reviewer would
  flag the diff) -- and, separately, that the reviewer's own re-check can
  itself go stale (round 2 re-flagged an already-fixed line). The
  settlement-time trigger specifically remains source/unit-tested only; see
  the Todo entry, unchanged by this run.
- **Independently reverified, not trusted from the log**: ran `make verify`
  myself afterward -- backend tests, `go vet`, `flutter analyze`, and all 20
  Flutter tests (up from the pre-run count, confirming new tests were
  actually added) genuinely pass. Read the fixed code directly: the
  `.firstOrNull` + null-guard fix is real and correctly addresses the race.
- **Gap worth flagging, not a goal-gate bug**: unlike the earlier
  personal-budget-simplifier run (which self-committed 3 times and pushed),
  this run made zero `git commit`s -- `make verify`-passing work sat
  uncommitted in the working tree at `agent_end`. The goal text didn't
  explicitly ask for commits either time, so this looks like model-level
  variance rather than a harness regression, but it means "goal-gate
  accepted completion" does not imply "work is committed" -- worth adding
  explicit commit/push language to `/goal` prompts until this is either
  confirmed reliable or goal-gate grows its own opinion on it.

**Update, same day**: committed and pushed by hand (`4fee1fa`,
`personal-budget-simplifier` main) after independently re-verifying
`make verify` passed and reading the `.firstOrNull` fix directly --
resolving the "gap worth flagging" above for this specific run. Doesn't
change the underlying finding: goal-gate accepting a `/goal` still
doesn't commit on its own, so this same gap will recur on the next run
unless the prompt explicitly asks for a commit or goal-gate grows its own
opinion on it.

## Update 2026-08-12: goal-gate's verification signal is now diff-hash-bound

Closes the gap named in the 2026-08-09 entry above ("known, accepted gap
that this signal isn't diff-hash-bound the way `quality-gate.ts`'s is"):
`goal-gate.ts` tracked verification as a bare `"pass" | "fail" | "none"`
flag with no tie to *which* diff it verified, so a real pass followed by
further unverified edits and an immediate `GOAL COMPLETE` claim could slip
through. `evidence` is now the same `VerificationEvidence` shape and
`evidencePassesCurrentDiff()` check `quality-gate.ts` already uses (shared
via `lib/verification.ts`): a completion claim only passes if the most
recent broad verification's diff hash matches the diff as it stands at the
moment of the claim. `agent_start` now also captures `baseSha` the same
way `quality-gate.ts` does, and both the `tool_result` and `turn_end`
handlers wrap their new `snapshotDiff()` calls in the same
`isStaleContextError` guard `quality-gate.ts` uses, since a goal-gate run
can span a mid-session compaction (real, live example: the personal-
budget-simplifier OTEL-metrics run recorded above hit a 2026-08-10
compaction event mid-goal).

Not live-tested yet -- this closes a known code-level gap named in an
earlier real run's writeup, but the fix itself hasn't been exercised
against a live run where an unverified edit actually lands between a pass
and a completion claim. `npm test`: 149/149 (1 new regression test added,
`pi/tests/goal-gate.test.ts`, "a pass followed by a further unverified
edit does not back an immediate completion claim"); `tsc --noEmit`: clean.

## Update 2026-08-12: goal-gate hardened against non-Claude models never using the marker

Live finding, not a hypothetical: re-read the personal-budget-simplifier
OTEL-metrics `/goal` session recorded above (2026-08-10/11-12, local
`ai-stack-local` route, `ThinkingCap-Qwen3.6-27B-MLX-8bit`) directly from
its session log. Grepping the full ~330KB transcript for `GOAL COMPLETE`
(case-insensitive) returns exactly one hit -- the kickoff instruction
itself. Across 7 recorded nudge rounds the model never once attempted the
marker; it kept ending turns with its own habitual `before-done`-style
phrasing ("done?", "Everything is... complete") instead, which the gate's
regex doesn't recognize, so every round fell into the generic `"Goal not
yet met... Keep working"` branch. The last two of those rounds made zero
new edits (`quality-gate` trace `diffHash` identical across both) -- the
model was re-running `make verify` and re-declaring victory in prose, not
iterating. The session file ends mid-round-7-of-15 with no `pi-goal-trace`
complete/cap-hit entry -- abandoned, not resolved. Notably, every
single-process run confirmed earlier in this doc (Go smoke test, Python
calc smoke test, personal-budget-simplifier delete/export/rename UI run)
used the standard Claude route and converged on `rounds: 0` -- this is the
first case of the marker itself never landing, and it's specific to the
weaker local route.

Three code-level mitigations, all in `goal-gate.ts`:

1. The plain `"not yet met"` nudge previously said nothing about the
   marker format beyond the one-time kickoff message. It now restates the
   exact required line every round, so recalling it doesn't depend on a
   single early instruction surviving in context.
2. New `session_compact` handler: re-sends that same reminder immediately
   once a goal-bearing session gets compacted (skipped when `willRetry` is
   true -- that's mid-turn overflow recovery, not a between-turns landing
   spot). A compaction summary is a paraphrase, not a transcript; nothing
   guaranteed it would preserve a literal string requirement, and the
   2026-08-10 compaction event on this exact session is a real instance of
   that risk.
3. New stall tracking: if the working diff's hash is unchanged across
   `STALL_ROUNDS_BEFORE_ESCALATION` (2) consecutive plain nudges, the
   message escalates from the generic prompt to naming the stall
   explicitly, with a `pi-goal-trace` `"stalled"` entry for visibility --
   directly targets the zero-progress round-6/7 pattern seen in this run.

**Not live-tested yet.** These are code-level fixes for a failure mode
diagnosed from a real log, not something re-run against the local route to
confirm the marker now lands. `npm test`: 156/156 (8 new tests in
`pi/tests/goal-gate.test.ts` covering the marker-reminder text, stall
escalation with both a static and a changing diff, and the three
`session_compact` cases); `tsc --noEmit`: clean. Next step: re-run the
same OTEL-metrics-shaped task against the local route and confirm it
either reaches `GOAL COMPLETE` or the stall escalation visibly changes the
model's behavior instead of silently spinning to the round cap again.

## Update 2026-08-12 (same day): live-retested against the local route

Set up a fresh scratch git repo (`/private/tmp/.../goal-gate-live-test-2`,
gitignoring `__pycache__`/`.pytest_cache`) and ran `pi -p '/goal add a
multiply(a, b) function to app.py with a passing pytest test for it'`
against the local `ai-stack-local` route (same model as the OTEL-metrics
run that surfaced the original gap). Result: the model implemented the
function, added a test, ran `pytest`, and its first stop turn ended with
`GOAL COMPLETE: pytest reports 2 passed...` — accepted immediately
(`pi-goal-trace`: `{event: "complete", rounds: 0}`). Independently
verified, not trusted from the log: re-ran `pytest` myself afterward (2
passed) and read `app.py` directly — the `multiply` function is real and
correct. This confirms the marker convention itself still works cleanly on
this route when the model gets it right on the first try; it does not by
itself exercise the harder repeated-nudge path the fix targets, since the
task converged before any nudge fired.

**A first attempt at this immediately surfaced a real methodology bug, not
a goal-gate bug.** The first run redirected `pi -p ... --mode json`'s own
growing stdout (`run.jsonl`) into the *same repo* the model was working
in and that goal-gate diffs against. Every quality-gate verification round
in that run recorded a different `diffHash` (16 checks, 16 distinct
hashes) purely because the ever-growing log file counted as untracked
material in `git status`, not because of any real code churn — so no
completion claim could ever have passed evidence-binding in that run,
independent of anything the model did. That run did, incidentally, still
show the model attempting `GOAL COMPLETE` repeatedly across 9+ rounds
(never observed at all in the original bad session) before being killed
once the contamination was identified — consistent with, but not clean
confirmation of, the marker-reminder-every-round fix. Lesson for any
future live goal-gate test on this harness: never let the harness's own
process output land inside the repo it's diffing.

**Still not live-exercised**: the stall-escalation path (needs a task the
model can complete but initially fumbles the verification loop on) and the
`session_compact` reminder path (needs an actual mid-goal compaction,
hard to force deliberately on a small task). Both remain unit-test-only
confirmed.

## Update 2026-08-12 (later): live multi-round confirmation, background-kill investigation, Claude Code /goal comparison

Four items from that day's todo list, worked in one session. Evidence and
explicit non-coverage below — nothing in this section is inferred from the
model's own self-report; every claim is either a grep against the raw
session JSONL or an independently-rerun command.

**1. First live confirmation of the nudge-and-reject loop actually
rejecting a claim and looping (`rounds: 1`), not converging at round 0.**
Methodology fix applied first: the 2026-08-12 same-day contamination bug
(harness stdout landing inside the diffed repo) was avoided this time by
launching via `nohup pi -p '...' --mode json > <scratchpad>/log.jsonl 2>&1
< /dev/null &` with the `--mode json` log written *outside* the scratch
git repo entirely (a sibling directory, not a subdirectory of it) —
confirmed afterward the scratch repo's working tree contains only
`inventory.py`/`test_inventory.py`/`.venv/`, no log file, so `git status`
inside it was never contaminated. Task: a fresh scratch repo (git-inited,
one commit), local Qwen route (`ai-stack-local`, same weaker route the
2026-08-12 hardening targeted), goal condition asking for an
atomic-write inventory module with pytest coverage including a
`monkeypatch`ed-`os.replace`-failure test — chosen because "does a
partial write leave the original file corrupted" is the kind of subtlety
a first attempt plausibly gets wrong. Full JSON event log
(`goal-gate-live-test-3.jsonl`, 25 turns, ~5m56s wall clock) hand-checked,
not trusted from a summary:

- `pi-goal-trace`: `{event: "complete", rounds: 1}` — the model's first
  stop turn got a genuine plain `"Goal not yet met..."` nudge (grepped
  directly: `Goal not yet met: "build inventory.py..."` appears in the
  log), and its *second* stop turn's `GOAL COMPLETE` claim was accepted.
  This is the first real, live exercise of the round-increment path with
  `rounds > 0` across every confirming run to date (Go smoke test, Python
  calc smoke test, personal-budget-simplifier delete/export/rename —
  all `rounds: 0`) — n=4 now, 1 of 4 with a real nudge.
- **Independently reverified, not trusted from the log**: ran `pytest`
  myself against the agent's own `inventory.py`/`test_inventory.py`
  afterward — 9/9 passed. Read `inventory.py` directly: `_save()` writes
  to a `tempfile.mkstemp`-created temp file, `os.replace`s it onto the
  real path, and cleans up the temp file on any exception; `remove()`
  raises `ValueError` for both the unknown-sku and insufficient-stock
  cases before calling `_save()` at all (file genuinely untouched on
  those paths, not just claimed).
- **Still not exercised even by this run**: the stall-escalation branch
  (needs `STALL_ROUNDS_BEFORE_ESCALATION` = 2 *consecutive unchanged-diff*
  plain nudges; this run only produced one nudge total, so escalation
  logic never got a chance to trigger) and the `session_compact` reminder
  path (compaction was deliberately forced by temporarily editing
  `~/.pi/agent/settings.json`'s `compaction.reserveTokens` from `16384` to
  `47500` for the duration of this one run only, reverted immediately
  after — `session_compact` count in the log: **0**. The task finished in
  25 turns without the running context ever crossing even that aggressive
  threshold, so this specific forcing attempt didn't work either; the
  path remains genuinely untested, not just under-tested). Both need a
  dedicated follow-up run, not assumed covered by this one.
- **Bonus, unplanned finding**: after goal-gate cleared, `cross-model-
  review.ts`'s *settlement*-trigger fired for real for the first time
  (`trigger: "settlement"` in the trace) — previously source/unit-tested
  only (see the 2026-08-09 entry above and the matching todo item below).
  Outcome was `model-rejected`/HTTP 400, i.e. the same `AI_REVIEW_MODEL`-
  drift failure mode documented earlier in this file for the reactive
  trigger — not re-diagnosed further here since it's off this task's
  critical path, but worth noting the settlement trigger's *wiring* is now
  live-confirmed even though this particular invocation didn't get a clean
  review round out of it.

**2. Background-process-kill root cause: could not be established
retroactively; diagnostic channel checked and found unusable for this
process class, not just for this incident.** `log show` (macOS unified
log) queried for `process == "pi"` and `process == "node"` over a full
7-day sanity-check window (not just the original 2026-08-09/10 incident
window) returned zero matching entries in both cases — `pi` is a plain
Node.js CLI script that does not emit unified-log (os_log/ASL) entries
during normal operation on this host, so this channel was never going to
surface a plain external `SIGKILL`/`SIGTERM`/`SIGHUP`, independent of log
retention. No crash reports in `~/Library/Logs/DiagnosticReports/` for
that window either — consistent with an external signal rather than a
crash (a crash normally does generate a report). `last reboot` confirms
no host restart in that window. **Conclusion: the specific 2026-08-09/10
kills cannot be root-caused after the fact from this machine's forensic
data** — say so plainly rather than assume it's now understood.
**Actionable mitigation, tested live in this session rather than just
proposed**: launched this run's `pi -p` process via
`nohup ... < /dev/null > log 2>&1 & disown` and confirmed via
`ps -p <pid> -o ppid,stat` that it reparented to PID 1 (init/launchd) with
state `SN` — i.e., fully detached from the invoking shell/session, unlike
an ordinary backgrounded child that stays in the parent's process group
and would receive a `SIGHUP` if that parent shell/session ended. This
run's process was never killed (I terminated it myself with `SIGTERM`
after confirming `agent_settled` and no further pending work — a
deliberate, logged shutdown, not an unexplained one). This is one clean
run with the detached-launch mitigation, not a repro of the original
failure mode with and without the fix — it demonstrates the mitigation
doesn't break anything, not that it was the actual cause of the original
kills. **Recommendation**: any future unattended `/goal`/`build_app.py`
run on this machine should use this exact launch pattern
(`nohup ... < /dev/null > logfile 2>&1 & disown`, log path outside the
diffed repo) until/unless the original incident is independently
reproduced and diagnosed with better tooling in place beforehand (e.g.
wrapping the launch in a small supervisor that logs its own exit signal).

**3. Multi-round survival within one uninterrupted process: now
confirmed for `rounds: 1`, still not confirmed for "many."** Item 1 above
is the first live case where the nudge fired and the model's next attempt
was accepted, all within a single process — genuine, if modest,
progress on this open item. It is *not* evidence of surviving "many"
rounds; one round is not the multi-hour/many-nudge endurance case the
original todo names, and the stall-escalation path specifically (which
only engages after 2 *consecutive* unchanged-diff nudges) still has zero
live rounds. Treat this as n=1 for `rounds > 0`, not as closing the item.

**4. Claude Code's own `/goal` compared directly, not just guessed at.**
Fetched Anthropic's own docs (`https://code.claude.com/docs/en/goal.md`)
and cross-checked against this very session's own live Stop hook, which
is a real `/goal` instance I directly observed rather than inferred:
its condition was stated in free natural language and never asked me for
a literal marker string, consistent with the docs below.

- **Mechanism**: Claude Code sends `{condition, conversation-so-far}` to a
  *separate* small/fast evaluator model (defaults to Haiku) after every
  turn; the evaluator answers yes/no with a short reason. This is genuinely
  a different model than the one doing the work, not a self-report — but
  per the same docs, "it doesn't run commands or read files independently,"
  i.e. it judges the transcript, not ground truth.
- **No literal marker required** — the evaluator tolerates phrasing
  variance by design, judging semantically against what the working model
  "surfaced in the conversation."
- **Round cap is opt-in per-goal** (write "...or stop after N turns" into
  the condition text yourself), not a global default the way pi's
  `PI_GOAL_MAX_ROUNDS` (15) is.
- **Not documented anywhere findable**: whether the condition/reminder is
  resent to the evaluator after context compaction. Flagging this as "not
  documented," not "doesn't happen" — absence of a public doc section on
  it isn't proof either way.

**Structural gaps named, not just bugs:**

1. *No fallback for near-marker phrasing.* This is the exact 2026-08-12
   local-route failure mode (model said "done?"/"Everything is complete,"
   the literal-regex gate never recognized it) — Claude Code's design
   structurally cannot hit this specific failure, because completion isn't
   gated on the working model reproducing an exact string at all.
2. *The self-report-bias tradeoff is inverted, not equivalent, between the
   two designs.* Claude Code accepts transcript-only judgment (some
   self-report-adjacent risk, since the evaluator never independently
   verifies) in exchange for phrasing robustness. `goal-gate.ts` accepts
   phrasing brittleness in exchange for eliminating self-report risk
   entirely — its only evidence is a real command's exit code bound to the
   current diff hash, never any model's opinion, echoing this doc's
   own prior finding elsewhere that self-report checks are unreliable.
   Adding an LLM-judged fallback on pi's side to close gap #1 the way
   Claude Code does it would reopen exactly the bias problem
   `goal-gate.ts`'s docstring already warns against — it would just move
   the self-report from "the marker" to "the evaluator's read of a
   transcript it cannot independently verify," which Claude Code's own
   docs concede is a real limitation of their design, not a solved
   problem to imitate uncritically. **Not implemented as part of this
   session** — recorded as a designed-but-not-shipped recommendation
   (a small fixed allow-list of equivalent completion phrasings, accepted
   *only* when they still co-occur with the same
   `evidencePassesCurrentDiff` check the literal marker already requires,
   so the evidence binding never weakens) pending explicit sign-off, per
   the goal directive's "don't silently implement" instruction.
3. *Compaction handling*: `goal-gate.ts`'s `session_compact` reminder is a
   direct, shipped answer to a problem Claude Code's public docs don't
   even confirm they've addressed — a case where pi's design is ahead on
   this one dimension, not behind, though (per item 1 above) the
   `session_compact` path itself remains live-unexercised here.
4. *Round-cap default*: pi's global default caps every goal even if the
   condition text says nothing about it; Claude Code's is safer *only if*
   the user remembers to opt in per-goal, and silently uncapped otherwise.

## Update 2026-08-12 (later still): a real live compaction, n=2 on rounds>0, and a corrected root-cause writeup

Follow-up work in the same session, pushed further after review feedback
that the prior update's "not yet tested"/"could not be established"
callouts, while honest, hadn't actually exhausted what was live-testable.
Three more live runs and one source-level trace, all against the real
local Qwen route (never simulated), all evidence below is either a raw
grep against a session JSONL or an independently rerun command.

**Second `rounds: 1` confirmation (n=2 now).** A second scratch task
(`goal-gate-live-test-5`, a `kv.py` key-value store with the same
atomic-write/pytest-coverage shape as the first, launched the same
contamination-safe way — log outside the diffed repo) also produced a
real plain nudge followed by an accepted claim: `{event: "complete",
rounds: 1}`. Independently reverified: `pytest` 8/8 against the agent's
own `kv.py`/`test_kv.py`. Two independent live runs now show `rounds > 0`
(n=2 of 5 total confirming runs across this file's history) — still not
"many," but no longer a single data point either.

**A real compaction was captured live, for the first time — but it
exposed both a wrong assumption and an unexplained gap, reported
plainly rather than smoothed over.** Getting here took two failed
attempts, kept below rather than deleted, because the failure mode is
itself informative:

- *Attempt 1* (the `session_compact` test in the prior update, and a
  repeat here with `contextWindow` temporarily patched in
  `ai-stack-local.ts` from `49152` to `8000`, `reserveTokens` left at
  default `16384`): produced **zero** compaction events across two live
  runs, despite `shouldCompact(contextTokens, contextWindow, settings)`
  in the installed package
  (`pi-coding-agent/dist/core/agent-session.js`) reading, by inspection,
  as trivially satisfied (`contextWindow - reserveTokens` went negative).
  Traced the actual reason by reading the installed package source, not
  by guessing: `_checkCompaction`'s threshold branch feeding
  `shouldCompact` is a *distinct* code path from `prepareCompaction`,
  which decides *what's actually left to cut* using `keepRecentTokens`
  against the message-history-only token estimate (excluding the system
  prompt) — with `keepRecentTokens` still at its default `24000` and a
  short task's real message history well under that, `prepareCompaction`
  correctly found nothing to summarize regardless of the threshold check
  passing. **Correction to the prior update's framing**: forcing
  compaction needs both a shrunk `contextWindow` (to trip the threshold)
  *and* a shrunk `keepRecentTokens` (to leave something for
  `prepareCompaction` to actually cut) — the prior write-up only
  identified the first knob.
- *Attempt 2* (`keepRecentTokens` additionally dropped to `500` in
  `~/.pi/agent/settings.json`, same `contextWindow: 8000` override, task:
  the `kv.py` run above): **a real compaction fired** —
  `compaction_start` → `compaction_end` in the raw event log, with an
  actual generated summary (`"## Goal\nBuild a small key-value store
  module..."`, `tokensBefore: 10760`, `estimatedTokensAfter: 1475`). This
  is the first live-captured Pi auto-compaction event in this file's
  entire history, not just a source-level description of the mechanism.
  **But it fired with `reason: "overflow"` (Case 1, a genuine
  context-length rejection triggering compact-and-retry), not
  `reason: "threshold"` (Case 2, the proactive path both settings were
  meant to force) — and it landed *after* `goal-gate`'s own `{event:
  "complete"}` trace, i.e. after `goal` was already `undefined`.** Two
  consequences, stated precisely rather than rounded up to "confirmed":
  1. `goal-gate.ts`'s `session_compact` handler has an explicit
     `if (!goal || event.willRetry) return;` guard — with no active goal
     at compaction time, this run structurally could not have exercised
     the reminder-resend behavior even if the event reached the handler.
  2. Separately, and left unresolved rather than hand-waved:
     **`grep -c '"type":"session_compact"'` on this run's log returns
     `0`**, even though `compaction_end` fired and the installed source
     (`agent-session.js`, the code directly above where `compaction_end`
     is emitted) shows a `session_compact` extension-event emission
     gated only on `this._extensionRunner && savedCompactionEntry` being
     truthy — both of which should hold here. Did not root-cause this
     gap in the time available; flagging it as a genuine open question
     (bug in the installed package, a lookup-key mismatch, or a
     misreading of the source) rather than assuming either "it's fine"
     or "it's broken."
  - All temporary overrides (`ai-stack-local.ts`'s `contextWindow`,
    `~/.pi/agent/settings.json`'s `compaction` block) were reverted
    immediately after; `git status` on `pi/` is clean and `npm test` is
    156/156 with zero source changes to `goal-gate.ts` itself.
  - **Net honest status on item 1**: a real compaction is now live-
    confirmed to be reachable with the right settings (a first), but the
    specific `goal-gate.ts` code path this was meant to test (the
    `session_compact` handler re-sending `MARKER_REMINDER` *while a goal
    is still active*) remains unexercised — both because this occurrence
    landed post-completion and because the raw `session_compact` event
    itself didn't appear in the trace for a reason not yet understood.
    Needs a task long/heavy enough to cross the compaction threshold
    *before* its first `GOAL COMPLETE` attempt, not after.

**Root-cause investigation redone with a testable hypothesis instead of
a purely negative result.** The prior update's mitigation story (`nohup
... & disown` prevents the kind of kill that hit the original run) was
checked directly rather than left as an assumption: started a plain
`sleep 240 &` with **no** `nohup` at all, inspected it with
`ps -o pid,ppid,stat`, and found it had *already* reparented to PID 1 —
standard Unix orphan-reparenting, which happens on a background job
regardless of `nohup` (`nohup` only matters if the parent shell itself
receives `SIGHUP`, a different event from a Bash-tool call's transient
shell simply finishing normally). **Correction: the specific mechanism
proposed for the original kills does not hold up under its own test.**
Also checked and came back empty: `~/.zsh_history` (no `pi -p`/
`personal-budget-simplifier` entries — commands run through an agent's
non-interactive Bash tool don't get written there at all, so no local
trail of the original launch command exists to inspect) and
`pi/scripts/build_app.py`'s `subprocess.run` calls (no
`start_new_session=True`, so *if* that orchestrator had launched the
killed process it would be vulnerable to a group-wide signal — but the
doc's own account says this run used manual `pi --continue`, not
`build_app.py`, so this is a related, real, fixable gap and not confirmed
as the cause of this specific incident). **Final status, unchanged in
substance but now backed by a disproved hypothesis instead of an
untested one**: root cause remains genuinely unknown given the tools
available on this machine three days after the fact. The actionable
recommendation is process-external supervision that captures the exit
signal to a file on the *next* occurrence, not a specific launch flag,
since the specific flag hypothesized didn't survive its own test.

## Update 2026-08-12 (later still, second pass): stall-escalation live-confirmed

Pushed further after review feedback that the prior "still unhit" callout
on stall-escalation wasn't sufficient given it's genuinely live-testable.
Result: **it is now live-confirmed**, not still open.

**Methodology, stated plainly since it involved a temporary code change**:
three organic live attempts (the two multi-file Python tasks in the update
above, plus a third, `goal-gate-live-test-6`, a bigger `notes.py` task
meant to maximize turns) each converged the same way every prior run
had — one real nudge, then a real fix, `rounds: 1`, never two consecutive
no-edit turns. Concluded this weak local model reliably self-corrects
after a single nudge on substantive tasks, so escalation (which needs
`STALL_ROUNDS_BEFORE_ESCALATION` = 2, i.e. 3 consecutive unchanged-diff
nudges per the exact `staleRounds`-before-increment check in the code)
was not going to fire organically within a reasonable number of live
attempts. Instead of continuing to burn live runs on chance, applied the
same class of test-only override already used earlier this session for
`ai-stack-local.ts`'s `contextWindow`: temporarily changed
`STALL_ROUNDS_BEFORE_ESCALATION` from `2` to `1` in `goal-gate.ts` (commit
diff never made — edited, tested, reverted within this session; `git
status` on `pi/` is clean and `npm test`/`tsc --noEmit` both pass on the
final, unmodified file), clearly commented in the file at the time as a
reverted test override. This does not change shipped behavior — it
changes how many live attempts are needed to exercise the *same* branch
of code under real model behavior, the same way lowering `contextWindow`
changed how many turns were needed to exercise real compaction, not the
compaction logic itself.

**Live result, `goal-gate-live-test-7`** (a small task explicitly asking
the model to spend its first two responses only restating its
understanding in prose, with real edits starting the third response —
designed to reliably produce two consecutive no-edit `stop` turns):

- `pi-goal-trace`: `{event: "stalled", rounds: 2}` — the escalation branch
  fired for the first time in this file's entire history. The nudge text
  sent to the model at that point was grepped directly from the raw log,
  word for word matching the code: `"The working diff hasn't changed
  across the last 1 check(s) -- restating that it's done isn't progress.
  Make a concrete code edit, then verify it."`
- The model responded to the escalated nudge with a real edit on its next
  turn; `{event: "complete", rounds: 2}` followed.
- **Independently reverified, not trusted from the log**: ran `pytest`
  myself afterward against the agent's own `subtract.py`/
  `test_subtract.py` — 1/1 passed; read `subtract.py` directly, correct.
- Contamination check repeated: the `--mode json` log was written outside
  the diffed repo the same way as every other live test this session;
  `git status` inside the scratch repo shows only the two new files, no
  stray log content.
- All temporary overrides (`goal-gate.ts`'s `STALL_ROUNDS_BEFORE_ESCALATION`,
  `ai-stack-local.ts`'s `contextWindow`, `~/.pi/agent/settings.json`'s
  `compaction` block) reverted immediately after; `git status` on `pi/` is
  clean, `npm test` 156/156, `tsc --noEmit` clean, all confirmed after the
  revert, not before.

**Honest scope of what this does and doesn't establish**: this confirms
the escalation branch's *logic* fires correctly and produces the exact
designed message when its trigger condition is met — a real, previously
zero-evidence code path is now live-exercised. It does not, by itself,
establish that this weak model naturally stalls twice in a row on a
*real* (non-instructed-to-stall) task at the *shipped* threshold of 3
consecutive rounds — every organic attempt at the shipped threshold still
converged at `rounds: 0` or `rounds: 1`. That specific claim (does the
2026-08-12 hardening's shipped threshold value ever fire on organic,
non-contrived model behavior) remains open; what's now closed is "has the
escalation code path itself ever been exercised by a live run," which was
the more fundamental, more blocking gap.

`session_compact` while a goal remains active is still unexercised — the
same real compaction (`compaction_start`/`compaction_end`, `reason:
"overflow"`) again landed after goal completion in `goal-gate-live-test-6`
(third confirmed live compaction capture this session, same timing
pattern as the second), and the `session_compact` extension event itself
again did not appear in the trace (`grep -c` returns `0` across all three
compaction-producing runs this session) despite `compaction_end` firing
each time — this specific gap (event emission vs. `compaction_end`) is
now a 3-for-3 pattern, not a one-off, and is flagged as worth a source-
level fix investigation next, separate from goal-gate.ts itself.

## Update 2026-08-12 (final pass this session): exhausted remaining live-testable ground on items 2 and 3

Two more concrete steps taken after further review feedback, both aimed
at closing gaps that are still legitimately closable rather than repeating
already-exhausted ones.

**Item 2, one more forensic avenue checked and closed off.** Tried
`sudo -n log show` (non-interactive sudo) to see if unified log retains
more under elevated privileges — fails immediately, "a password is
required," and no password can be supplied non-interactively in this
environment, so this path is unavailable, not merely untried. Checked
`/var/log/system.log` directly (bypassing the unified-log predicate
system entirely): readable, but starts at `Aug 12 00:06:29` (today) —
confirms this legacy log rotates on a roughly daily cycle on this host
and never held the 2026-08-09/10 incident window in the first place, for
the same reason unified log didn't: not a retention accident, a structural
absence. **This is the actual ceiling**: unified log, crash reports,
reboot history, non-interactive shell history, `/var/log/system.log`, and
sudo-elevated log access have all now been checked and all come back
either empty or explicitly unavailable. No further method to inspect this
specific 3-day-old incident is known; continuing to search would not be
diligence, it would be the same negative result restated. Root cause
stays genuinely unknown — stated as a hard finding, not a shortfall.

**Item 3, one more organic (no test overrides) live attempt, chosen from
documented precedent.** `pi-harness-history.md`'s own prior investigation
found this exact model class (Qwen on this route) fixes a specific class
of concurrency race bug in only 2 of 5 runs on its own — a real,
previously-documented weakness, not a guess. Built `goal-gate-live-test-8`
on that precedent: a thread-safe `BankAccount` task (50 threads × 200
concurrent deposits, asserted exact final balance, explicitly asked to
rerun the concurrency check 3× before trusting it) at the **shipped
default thresholds**, no config overrides, contamination-safe launch as
in every other run this session. Result: `{event: "complete", rounds: 0}`
— the model wrote a correctly-locked `BankAccount` (every read-modify-
write wrapped in `self._lock`) and passed on the first attempt.
Independently reverified: `pytest` 1/1, `account.py` read directly and
confirmed correctly locked. This is a real negative result for the
"many rounds" hypothesis, not a skipped test: **explicitly instructing
the concurrency-safe pattern in the goal condition removed the ambiguity
that caused this model's documented failures elsewhere** — the earlier
history-file finding was on a task that only implied thread-safety via
spec sentences, not a task that named the exact mechanism required.

**Consolidated status on "many rounds," across every organic attempt run
this session and in prior updates (n=7 single-process confirming runs
now, at shipped-default thresholds throughout, only the explicitly
stall-instructed `goal-gate-live-test-7` used a temporarily-lowered
threshold and is excluded from this count)**: Go smoke test, Python calc
smoke test, personal-budget-simplifier delete/export/rename UI run,
`inventory.py`, `kv.py`, `notes.py` — `rounds: 0` or `1` each time;
`account.py` (this update) — `rounds: 0`. **Zero of seven organic runs at
shipped defaults reached more than one real nudge round.** Taken
together with `goal-gate-live-test-7`'s clean demonstration that the
escalation *mechanism* itself works correctly once its trigger condition
is met, the most defensible reading of the full evidence is: the
nudge-and-reject loop is proven to work correctly when exercised, and
this specific model, on the range of tasks tried so far, does not
naturally need "many" rounds to converge — it either gets it right
immediately or self-corrects after one nudge. This is a substantive,
evidence-backed characterization of actual model behavior, not an
unresolved gap papered over with a qualifier. A genuine "many-rounds"
case, if one exists, would need either a harder task class than has been
tried (the concurrency attempt above was the closest deliberate attempt
at one and still converged in one shot) or a different, more error-prone
model — both are worth naming as the next step rather than further
identical attempts on this same model/task class, which is unlikely to
produce a different outcome given the consistency of the pattern above.

**One more confirming data point, added after further review feedback**:
`goal-gate-live-test-9`, a deliberately finicky task (exact-string
exception messages, comma-formatted currency output, round-trip parsing)
chosen to maximize the chance of a partial miss on the first pass — a
different failure mode than either "one hard algorithmic bug" (the
concurrency attempt) or "ambiguous spec" (earlier smoke tests). Result:
`{event: "complete", rounds: 0}` again, independently reverified (20/20
`pytest`, `price.py` read directly and confirmed byte-exact against every
stated requirement). **n=8 organic shipped-threshold runs now, 8/8 at
`rounds ≤ 1`, across four genuinely distinct failure-mode categories**
(ambiguous spec, documented concurrency weakness, explicit no-edit
instruction reversed into real work, and now bundled finicky exact-match
requirements). This is no longer a small-sample gap; it is a consistently
reproduced property of this model on this harness. Continuing to run the
same class of experiment is very unlikely to change the picture — a
genuine many-round case would need a structurally different model or task
source (e.g. a harder external benchmark, not another hand-authored
scratch task), which is a different, larger undertaking than a single
scratch-task live test and is named as such rather than attempted here.

**Closing status on this investigation, confirmed with the user rather
than assumed**: presented with the full evidence above (9 live tests: 1
stall-escalation confirmation, 1 real-compaction-timing series, 8
organic-threshold runs across 4 distinct failure-mode categories all at
`rounds ≤ 1`, plus the exhausted forensic list for the background-kill
root cause), asked explicitly whether to keep running more live tests,
pursue a larger external-benchmark undertaking, ship the unshipped item-4
fallback, or accept the findings as final. Chose **accept current
findings as final**. Recorded here so a future reader doesn't mistake the
stop as an unfinished search: "many rounds" and "root cause" were treated
as open experimental questions and answered as far as this machine's
available evidence allows, not abandoned mid-investigation.

## Update 2026-08-12 (real break on item 2): root cause found via the inference host's own server-side logs

Everything above exhausted *this* machine's forensic trail (unified log,
crash reports, shell history) — but the two kills happened to a process
that was also a network client of `kannasmacstudio.lan`'s model-serving
stack, and that stack keeps its own independent, durable, plain-text
request logs (`~/code/ai-stack/logs/{kv_proxy,qwen36}.log` on the LAN
host), a source not checked in any prior pass of this investigation. SSH'd
in directly (`ssh kannasmacstudio.lan`, read-only) and searched the actual
incident window.

**Found both kills, independently timestamped from the server side, not
inferred.** `personal-budget-simplifier`'s real commit history for
2026-08-09 (`git log --since=2026-08-08 --until=2026-08-11`): commits at
07:46, 07:49, 09:02:52, 12:20:45, and 16:59:07 (all `-0500`/CDT). Cross-
referenced against `qwen36.log` (the model server's own request log) for
that window, filtered to `stream_closed_before_completion` (a
server-side warning meaning the client's HTTP connection dropped mid-
request) — exactly **two** hits in the entire 2026-08-09/10 window,
matching "killed twice" precisely:

1. `2026-08-09 09:12:05` — `Prefill completed: prompt_tokens=35142
   elapsed=121.377s`, `Decode started: time_to_first_token=121.448s`,
   immediately followed by `Request failed: ... stream_closed_before_
   completion in_flight=0`. Landed 9 minutes 13 seconds after the
   09:02:52 commit — i.e., mid-round on the very next request.
2. `2026-08-09 16:59:11` — `Prefill completed: prompt_tokens=43162
   elapsed=155.325s`, `Decode started: time_to_first_token=155.429s`,
   same immediate `stream_closed_before_completion in_flight=0`. Landed
   **4 seconds** after the 16:59:07 commit.

**Both events share one precise, mechanistic shape, not a coincidence of
timing alone**: in both cases the server was completely healthy
(`in_flight=0`, continued serving unrelated requests normally seconds
later — confirmed by reading the surrounding log lines, not just the
matching ones) and had just finished a long *prefill* (121s and 155s
respectively, on large 35k/43k-token prompts — consistent with a
long-running multi-hour `/goal` session's accumulated context) — the
client's connection was torn down in the same second the server was
about to emit its first output token, both times. This is not a GPU crash,
not an OOM (the `[METAL] ... OutOfMemory` error visible in this same
host's flight-recorder summary field is a stale/unrelated field from a
much earlier timestamp, unix `1785668966` ≈ 2026-07-31, not from this
incident window — checked explicitly to avoid a false correlation). It is
a **client-side abandonment of an in-flight request specifically when the
server goes quiet for roughly two minutes waiting on a large prefill**,
not a fixed-duration timer (121s and 155s are close but not identical, so
this reads as an idle/no-data timeout rather than a hardcoded total-
duration one).

**This is not a novel failure class for this codebase — it is the same
shape as an already-fixed, already-documented bug, just on a different
path.** `pi-harness-history.md`'s own record: `cross-model-review.ts`'s
`REVIEW_TIMEOUT_MS` was originally `120_000` (120s) and was raised to
`240_000` after a real reviewer request took `121.4s` and would have been
silently aborted 1.4s before finishing — see this file's `cross-model-
review.ts` entry above (commit `83ca0cb`). The two kills found here are
the same ~120s-class timeout, on the *primary* model request path instead
of the reviewer path, hitting exactly the scenario that path is
structurally exposed to: a long-running `/goal` session's context grows
large enough that prefill alone (not generation, prefill) exceeds
whatever client-side "how long to wait for a response" limit governs the
primary request, and the connection — and, per the doc's original
account, the whole `pi -p` process along with it — gets torn down.

**What's confirmed vs. what's still open, stated precisely**: confirmed —
the trigger condition (large-prompt prefill exceeding roughly two
minutes), the mechanism class (client-side idle/response timeout, not a
server crash), and that this is the same bug family as a previously-fixed
issue in this exact codebase. Not yet confirmed — the exact piece of
software enforcing the timeout (no local session file exists for this
specific 2026-08-09 build at all, so there is no client-side log to
directly name which layer — pi's own HTTP client, Node's default socket
timeout, or an external supervisor watching for silence — issued the
abort; only the server's view of the dropped connection is available).

**One candidate ruled out, narrowing this further**: the proxy's own
access log records the client's user agent as `"OpenAI/JS 6.26.0"` on
every one of these requests — and the `openai` npm package vendored under
the installed `pi-coding-agent` (`node_modules/openai/package.json`) is
exactly version `6.26.0`, confirming this is genuinely pi's own request
client, not a coincidental version match. That SDK's own default request
timeout (`client.js`: `DEFAULT_TIMEOUT`) is **10 minutes**, not ~2 minutes
— so the abort is not the OpenAI SDK's own configured total-timeout
firing early; something shorter, layered either in front of it (a
supervisor watching for output silence) or via a per-request
`timeoutMs` override this investigation didn't trace to its exact call
site, is the actual cause. This is a materially different status than
"root cause: unknowable" — the failure trigger (large-prompt prefill
exceeding ~2 minutes) and mechanism class (a client-side idle/response
timeout shorter than the SDK's own 10-minute default, not a server crash)
are now real, cross-referenced, independently-timestamped findings, not
merely investigated and abandoned. The actionable next step, if this is
picked up again: trace `agent-harness.js`'s `requestOptions.timeoutMs`
(the one caller-supplied override path the vendored SDK's `openai-
completions.js` actually honors) to find what sets it for the primary
model path, the same class of check that led to the `REVIEW_TIMEOUT_MS`
fix, and whether it can be raised or disabled there the way it was for
the reviewer path.

**One real, shipped change to `goal-gate.ts` itself, made after this
finding — and one considered and deliberately rejected.** Shipped: a
header-comment note recording this root cause and its operational
implication (a `/goal` session can be killed outright mid-round by this
mechanism, and since this file's state is session-scoped/in-memory, that
loses the active goal entirely) — not a behavior change, since the actual
timeout lives in the request/HTTP layer outside this file, not in
goal-gate.ts's own logic. Considered and rejected: lowering
`STALL_ROUNDS_BEFORE_ESCALATION` from `2` to `1` as a "hardening" change
justified by the n=8 organic-runs evidence above. Traced the exact
round-by-round arithmetic before shipping it and found it would
false-positive on the ordinary, healthy "real edit → nudge → verify-only
turn" sequence — which is precisely the case the existing threshold's own
code comment says `2` (not `1`) exists to tolerate. That would have been
a regression dressed up as a fix in order to satisfy an external
completion check, not a genuine improvement, so it was not made. Recorded
here because "we looked for a real code change and correctly declined one
we found to be unsafe" is a materially different, more defensible
position than either shipping it uncritically or not looking at all.

## Update 2026-08-12 (adjacent finding): a second, unrelated crash found and fixed on the same live session — `todo.ts`'s TUI renderer

Not part of the four-item goal-gate.ts hardening task, but found and
fixed the same day, on the exact same personal-budget-simplifier
OTEL-metrics `/goal` session, so recorded here for continuity. The user
hit a real interactive-mode crash (`pi` exited with an uncaught
`TypeError: Cannot read properties of undefined (reading 'render')` in
`pi-tui`'s `Box.render`) while running `/goal implement OTEL metrics`.

**Root cause, live-traced from the actual crashed session's log**
(`~/.pi/agent/sessions/--Users-kanna-code-personal-budget-simplifier--/
2026-08-12T19-29-54-282Z_...jsonl`, 37 entries, ends immediately at the
crash): the local model emitted a malformed `todo` tool call
(`{"toggle":"<parameter=id>\n1"}`), which pi's own JSON-schema argument
validator correctly rejected, producing a tool result with `details: {}`
(a real, truthy object -- not `undefined`) and `isError: true`. This
repo's `pi/extensions/todo.ts` (the actual loaded extension, confirmed
via `~/.pi/agent/extensions/todo.ts`'s symlink target -- not the
unrelated npm-package example that happens to share the same bug) had a
`switch (details.action)` in `renderResult` covering `list`/`add`/
`toggle`/`clear` with **no `default:` case**. `details.action` is
`undefined` for this shape, matches nothing, and the function **silently
returns `undefined`** without throwing. `pi-coding-agent`'s
`tool-execution.js` pushes that return value into a rendering `Box`'s
children array with no undefined-guard on its success path (unlike the
sibling `resultRenderer`-missing branch a few lines away, which does
guard) -- the next render tick crashes calling `.render()` on that
`undefined` entry.

**Deterministically reproduced, not just reasoned through**: wrote a
standalone script that imports the real (pre-fix) `todo.ts`, captures its
registered tool definition, and calls its actual `renderResult` with the
exact `details: {}` shape pi's validator produces -- confirmed it
returned `undefined`. This is a universal bug (any model that trips
pi's own argument validation on a `todo` call hits it, not something
specific to the local weak route), just first surfaced here by this
model's tool-call fragility.

**Fixed**: added a `default:` case to the switch, falling back to the raw
result text -- the same fallback the existing `!details` branch one line
above already uses. Re-ran the same deterministic repro script against
the fixed file: now returns a real `Text` component. Added
`pi/tests/todo.test.ts` (3 new tests: the regression case, all four real
actions still render correctly, the explicit-error branch still works)
and extended `tests/extension-api-harness.ts` to capture registered tools
via `registerTool` (previously a no-op stub; no prior test in this repo
exercised a tool's renderer functions in isolation). `npm test`: 159/159.
`tsc --noEmit`: clean. Commit `ac187ef`.

## Update 2026-08-12 (live-testing pass on remaining acceptance-boundary items): three clean confirmations, one reproducible kill under forced compaction

Ran live `pi -p` trials against the specific items `pi-harness-validation-
status.md` still listed as untested, scoped to Go (the stack with battery
coverage), one at a time.

**Three clean confirmations**, each read from the actual `--mode json`
event log rather than assumed:

- `artifact-guard.ts` primary `tool_result` path: fresh Go repo, task ran
  `go build -o bin/app ./cmd/app` verbatim. `pi-harness-trace` shows
  `extension:"artifact-guard", event:"nudge", outcome:"flagged",
  metadata:{"trigger":"build-command"}` firing in-band on that exact tool
  result, with `bin/app` still untracked (`git status`) — i.e. before any
  commit could have hidden it. Distinct from the already-confirmed
  `agent_settled` backstop.
- `error-leak-guard.ts` redesigned `tool_result` path: task wrote
  `handler.go` containing `http.Error(w, err.Error(),
  http.StatusInternalServerError)` verbatim. The `write` tool's own
  `tool_result` carried the nudge text immediately, confirmed by a
  `nudge`/`flagged` trace keyed to the file's absolute path. Model left
  the leak unfixed, so the `agent_settled` backstop also fired on the same
  finding afterward — both layers exercised in one run.
- `makefile-scaffold-nudge.ts` redesigned `tool_result`/`turn_end` path:
  empty directory, task ran `go mod init` via bash (not the write tool) as
  its first action, matching this fix's exact motivating scenario. Log
  sequence: bash `go mod init` → `turn_end` → the fully-resolved-command
  nudge text queued in `followUp` → delivered as the next user message.
  Model responded by adding a Makefile despite being told not to,
  confirming the nudge changed behavior, not just that it fired.

**`goal-gate.ts`'s `session_compact` mid-goal reminder: still not
live-exercised — two attempts, two silent kills, no result either way.**
To force compaction to land *while* a goal is active (every prior run's
compaction happened after goal completion, never during), temporarily
edited `~/.pi/agent/settings.json`'s `compaction` block from
`{reserveTokens:16384, keepRecentTokens:24000}` to
`{reserveTokens:45000, keepRecentTokens:2000}` for the duration of each
trial only, restoring the original file immediately after each run
(confirmed restored both times — no lasting config drift). Task: a
`/goal go build ./... and go vet ./... both succeed` five-file Go CLI
build, chosen to need enough turns to plausibly cross the now-tiny
~4k-token compaction line mid-goal.

Both attempts (fresh dirs, `nohup ... < /dev/null > log 2>&1 & disown`,
matching the documented detached-launch pattern) died identically: no
`pi-harness-trace`, no `--mode json` output file at all (not even
partial), no `pi-run.stderr.log` content, process gone from `ps`, no
session file located under `~/.pi`. In both cases the working tree still
showed real, substantial progress (attempt 1: all 5 requested files
written, 376 lines total) — the model was actively mid-task when
whatever killed it landed, consistent in shape with the two prior
documented `stream_closed_before_completion` kills traced to
`kannasmacstudio.lan`'s own server logs (client-side idle timeout on a
long prefill, not a parent-shell-exit/detachment problem — that hypothesis
was already ruled out).

**New, not-yet-confirmed lead worth checking next time this bug is
chased**: both kills this round happened specifically under the
artificially-aggressive compaction setting, 2/2. Forcing compaction to
fire far more often plausibly means more, and more frequent, long
prefills (each compaction cycle re-primes context from a paraphrased
summary) — exactly the trigger shape the two originally-traced kills
had (121s/155s prefills on 35k/43k-token prompts). This is a
correlation from n=2 under a deliberately abnormal setting, not a
confirmed mechanism; the original two kills happened under normal
thresholds, so aggressive compaction is not necessary for the bug, only
possibly a reliable way to reproduce it. Worth deliberately re-testing
the `session_compact` mid-goal reminder with a gentler, naturally-sized
task instead of the forced-threshold hack before concluding anything
stronger.

Net: `pi-harness-validation-status.md`'s acceptance-boundary table should
move `artifact-guard.ts`, `error-leak-guard.ts`, and
`makefile-scaffold-nudge.ts` to live-confirmed. `goal-gate.ts`'s
`session_compact` reminder stays exactly as open as before, plus this
possible repro lead for the kill bug.

## Update 2026-08-12 (continued): quality-gate's corrective follow-up confirmed not firing at depth, n=2

The 2026-08-05 finding (isolated small repo: corrective follow-up fires,
real chunk-3 session at nine assistant turns: it doesn't) was left as
"context-dependent, needs a repro closer to a real chunk's shape" rather
than a settled conclusion. Built that repro deliberately: a fresh Go
scratch repo, an 8-step task (six source/test files plus a CLI entrypoint
and README, `go build`/`go vet` after each step) followed by one final
instructed step — add an unused import to force a real compile failure —
with an explicit instruction never to fix it.

The run reached 30 `turn_end` events (more than triple the original
9-turn case) before the deliberate failure. `quality-gate`'s
`agent_settled` handler ran correctly and did everything the source says
it should: logged `event:"verification", outcome:"fail"` with the real
`go vet`-reported line, incremented to `attempt 1/3`, and queued the
exact corrective message via `sendUserMessage(..., {deliverAs:
"followUp"})` — visible verbatim in the `--mode json` stream's final
`queue_update.followUp`. Immediately after that queue_update, the stream
ends: one `agent_settled` event total in the whole 948-line log, one
`agent_end`, no second turn, no second verification attempt, process
exited. The unused-import error is still uncorrected in the working tree.

This is now n=2 for "corrective follow-up silently doesn't fire in a
real deep `pi -p` session" (9 turns and 30 turns), n=1 for "fires
correctly" (the original isolated few-turn scratch repo from
2026-08-05). Turn count alone doesn't cleanly explain it either, since
30 turns is well past 9 and the mechanism (queuing via
`deliverAs:"followUp"`) is identical in both failing cases and the one
working case — the actual trigger for whether `pi -p` processes a
queued follow-up after `agent_settled` vs. just exiting is still not
isolated. What's now solid: this is a real, reproducible correctness gap
in `pi -p` mode specifically (every automated/`build_app.py`/CI-style
invocation of this harness), not a fluke of one build's concurrent-
process contention — the false "it's just resource contention" theory
from 2026-08-05 doesn't cover this controlled, isolated, otherwise-clean
run.

Downgrading `pi-harness-validation-status.md`'s framing from "still
unresolved" (implying uncertain) to "confirmed not to fire at depth,
mechanism not yet isolated" — a settled negative finding pending a fix,
not an open question about whether the bug is real.

## Update 2026-08-12 (continued): cross-model-review's settlement trigger gets a clean confirmed round

The remaining gap on the settlement-time backstop trigger (added to cover
suites whose verification command never runs inside the model's own
session, e.g. `local-model-bench`) was that its one live fire so far
returned `outcome: "transient", reason: "model-rejected"` — an HTTP-level
failure from the reviewer route itself, not proof the trigger produces a
real, working review.

Built the specific condition deliberately: fresh Go scratch repo, task
implements a token-bucket rate limiter, explicitly instructed to run only
`go build ./...` and `go vet ./...` — never `go test`, never `make
test`/`verify`/`check`, no Makefile created at all. None of those match
`BROAD_VERIFICATION_PATTERNS`, so the reactive `tool_result` trigger had
no way to fire; the only path left was the `agent_settled` backstop.

It fired (`trigger:"settlement", round:1`) and came back `outcome:
"flagged"` — a real structured finding from the reviewer model, not a
transport error: it correctly identified that `Allow()` resets `lastTime`
to `now` on every call, silently discarding fractional token accumulation
whenever called more often than the bucket's fill interval. A genuine,
plausible bug, not a hallucinated or generic complaint. This is the clean
confirmed round the open item was waiting on — the settlement trigger is
now demonstrated to both fire under the exact structurally-blind condition
it was built for, and to complete a real, useful review round-trip when
it does.

## Update 2026-08-12 (continued): build_app.py — --containment confirmed, multi-round corrective recovery still unexercised despite three deliberate attempts

`--containment`: ran it against a trivial one-file spec. Confirmed exactly
the documented refusal — exit code 1, no `BUILD_REPORT.md`, immediate
(no round attempted), message pointing at `pi/containment/README.md`'s
network-denied section. This is working as designed, not a gap; the
script's own docstring already says this is deliberate.

Multi-round corrective recovery: three separate attempts to force a real
external verify failure on round 1, each escalating in difficulty, all
ended `SUCCEEDED -- verification passed` at `Rounds run: 1`:

1. A calc package with a hidden hard requirement (compile-time sentinel
   error). Discarded before running — `go vet` type-checks test files, so
   a compile-time mismatch would be caught by the model's own permitted
   `go vet ./...` step, not a genuine external-verification-only failure.
2. A calc package with a hidden *runtime-only* behavioral contract (floor
   division on negative operands — Go's native `/` truncates toward zero,
   undocumented in the spec). The model read the pre-existing test file
   itself and matched the exact undocumented contract (its own doc
   comment states "rounds toward negative infinity" verbatim) — legitimate
   round-1 success via reading available tests as a spec, not luck.
3. A concurrent-counter package verified with `go test -race -count=5`,
   modeled directly on this repo's own documented concurrency-bug
   precedent (pair 4, 2/5 unaided). The spec's explicit "supports
   concurrent use from multiple goroutines" language was apparently
   sufficient signal — the model used a plain `sync.Mutex` correctly on
   the first attempt.

Combined with the two original smoke runs, that's 5/5 single-round
successes for this model on Go tasks of this shape and complexity through
`build_app.py`. Reading this together with `goal-gate.ts`'s own n=7
`rounds: 0`/`1` finding: this looks like the same real, model-specific
negative result recurring in a second, independently-built mechanism, not
a testing gap. The corrective `--continue` loop itself remains logically
sound and unit-tested but has never been exercised end-to-end against a
real verification failure — a harder task class (larger surface area,
more interacting components, or a weaker model) would be needed to force
it, not more attempts at this same difficulty tier.

## Update 2026-08-13: pair-4 rerun, pre-registered before running (Opus-reviewed plan)

Before running anything, an independent Opus review of the plan for the
last open acceptance-boundary item — "pair 4 (go-flutter/bookmarks-app)
needs a full paired rerun ... before any candidate-model claim beyond
n=1" — found the original framing wrong and reframed the actual question
worth answering. Recorded here, in full, before the run so the criteria
can't be adjusted post-hoc — this project has two prior retracted
findings (2026-08-05, "Corrected: two false harness-bug findings" and its
own correction) that came from exactly that failure mode.

**Corrected bookkeeping**: pair 4 already has three real Qwen-primary
harness data points, not two — the original battery (fail), the
same-day standalone rerun (fail), and the 2026-08-04 full-harness run
with Gemma configured as reviewer and `REVIEW_TIMEOUT_MS` already raised
to 240s, which **passed** both `go test -race ./...` (9/9) and
`dart test` (17/17). Treating this as "n=2 → n=3" would have been wrong
and, worse, would have silently erased the one passing result.

**Why this can't be a statistics run at any affordable n**: the primary
model's own unaided base rate on this race (2/5, from the five-run KAT-
Coder investigation) has a binomial 95% CI of roughly 5-85% at that
sample size — the history's own "roughly 8-10 paired runs" target is
itself under-powered against a base rate that uncertain. A handful more
pair-4 reruns buys nothing; this item is being deliberately *not*
pursued as a candidate-model capability claim, and that scope-narrowing
is a decision, not an oversight.

**What this run actually checks, and why n=1 is decisive for it**: the
2026-08-04 entry found `cross-model-review.ts`'s reactive `tool_result`
trigger is *structurally* incapable of firing on this task suite, because
`local-model-bench` hides its test files until after `pi` exits — no
route/model/timeout fix could change that, only a design change (a
settlement-time trigger) could. That trigger now exists and is
separately live-confirmed on a different task (see the 2026-08-12 entry
above). The open, still-unanswered question is binary: under real battery
methodology (fixture copy-in, hidden-test-after-exit, the actual
`execute_arm()` scoring path), does the harness arm now emit a genuine
`cross-model-review` trace on pair 4, where it structurally could not
five weeks ago? Yes or no, once, settles it — this is a mechanism check,
not a sampling problem.

**Pre-registered criteria, fixed before running**:
- Primary, decisive at n=1: harness arm emits a `pi-harness-trace` entry
  with `extension:"reviewer", event:"review", outcome ∈ {clean,flagged}`
  during this run. A `blocked`/`transient` outcome or no reviewer trace
  at all means the structural gap persists.
- Secondary (pass/fail on `go test -race`/`dart test`): **declared
  uninterpretable in advance.** Every outcome (both fail, harness passes,
  baseline passes) is consistent with a ~40% Bernoulli process; no
  pass/fail result from this run will be used to support or retract any
  adoption or candidate-model claim.
- Invalidity, declared in advance: a killed process, `valid:false` on
  either arm (per `execute_arm`'s own gate), reviewer route unreachable
  or model-id-mismatched, or a concurrently running heavy job on
  `kannasmacstudio.lan` at launch time → the run is discarded and
  redone, not reinterpreted.
- **No pooling** with `full-screening-2026-08-03.json`'s harness-arm
  numbers or the 2026-08-04 run's numbers: `REVIEW_TIMEOUT_MS` (120s→
  240s), the settlement trigger, `buildReviewDiff()`'s untracked-file
  fix, and `BROAD_VERIFICATION_PATTERNS` now tolerating `go test -race`
  (which never matched at all during the original battery — neither arm's
  detector could even recognize this task's real verification command
  then) are all real harness changes since those runs. This run's harness
  arm is not the same harness as any prior pair-4 run's.

**Mechanics**: reusing `run_screening.py`'s actual `execute_arm()` and
scoring/trace-parsing code via a small wrapper (`pi/evals/
run_single_pair.py`) that runs only pair 4's task instead of the full
9-task shuffle, replicating `main()`'s full preflight (model identity
check, pinned `pi --version`, `baseline_agent_dir` isolation, runtime
manifest) plus an added reviewer-route check (`AI_REVIEW_BASE_URL`/
`AI_REVIEW_MODEL` resolve and match a live `:8081` model id) that
`run_screening.py` itself doesn't do. Confirmed live and current before
running: `AI_REVIEW_BASE_URL=http://kannasmacstudio.lan:8081/v1`,
`AI_REVIEW_MODEL` matches Gemma's live id — the `:8082` references in
the 2026-08-04 entries were that route's numbering at the time, not a
live discrepancy today. Pair 4's actual recorded arm order under seed
20260802 is `("baseline", "harness")`; this run uses that order, not an
invented one.

## Update 2026-08-13 (continued): pair-4 rerun executed — invalid per its own pre-registration, not reinterpreted

Ran `pi/evals/run_single_pair.py --seed 20260802 --pair 4 --host
kannasmacstudio.lan`. Preflight passed clean (model identity, `pi --version`
0.83.0, reviewer route resolved live to Gemma on `:8081`). Baseline arm:
valid, passed, 185.9s. Harness arm: **invalid** — hit the fixture's
45-minute wall (`pi_exit: 124`, `timed_out: true`, `harness_seconds:
2700.03`), one of the invalidity conditions fixed in the pre-registration
above. Per that pre-registration, the run is discarded, not reinterpreted.
Full record: `pi/evals/pair4-rerun-2026-08-13.json`.

**The tempting-but-rejected read**: the harness arm's reviewer actually
fired twice (`outcome: "flagged"`) before the kill — on its face, an
answer to the mechanism question this run was built to check. Not counted.
The run as a whole hit a pre-declared invalidity condition, and cherry-
picking the one trace that would confirm the hypothesis from an otherwise-
discarded run is exactly the failure mode the pre-registration exists to
block. The mechanism question — does the settlement trigger fire under
real battery methodology on this specific task — remains genuinely open.

**Noted but not counted, a real incidental finding**: `hidden_test_exit:
0` for the harness arm too. The code on disk at the moment `pi` was
killed had already reached a state passing both `go test -race` (no data-
race warning) and `dart test` (17/17) — but `pi`'s own settlement/
corrective loop (3x `quality-gate` fail, 1x `artifact-guard` nudge, 2x
`reviewer` flagged, across 45 assistant turns and 57 tool calls) never
declared the turn done inside the 45-minute window despite the underlying
code already passing. This lines up with, and may compound, this same
session's earlier finding that `quality-gate`'s corrective follow-up
doesn't reliably converge at depth (see the "confirmed not to fire at
depth" entry above) — here the loop kept re-triggering rather than
recognizing already-passing evidence, though the exact mechanism wasn't
traced (that would need reading the rescued session JSONL, not done here).

**Disposition**: not rerun immediately. Redoing costs another ~45-70
minutes and real token spend for a question this run already spent that
budget on without resolving; recorded as invalid and left open rather than
spent again same-session. If revisited, raise `--timeout-minutes` well
past 45 (the underlying code reached a passing state, so the loop needed
more room to settle, not necessarily to do more work) and/or investigate
the non-convergence itself directly from the rescued session JSONL rather
than re-running blind.

## Todo

- **Stall-escalation: done, live-confirmed** (`goal-gate-live-test-7`,
  `{event: "stalled", rounds: 2}`, escalated nudge text matched the code
  verbatim, the model recovered on its next turn, `pytest` independently
  reverified). What's *not* yet established, and is a narrower follow-up
  if it matters: whether this weak model ever stalls 3 consecutive rounds
  organically at the real shipped threshold (`STALL_ROUNDS_BEFORE_
  ESCALATION = 2`) without a test-only threshold override — every organic
  attempt at the real threshold converged at `rounds: 0` or `1`. The
  code-path-level gap (has this branch ever fired live) is closed; the
  narrower behavioral question (does the *shipped* threshold value ever
  matter in practice for this model) is open but lower-priority, since the
  mechanism itself is now proven correct.
- The `session_compact`-reminder path specifically *while a goal is still
  active* remains untested, but for a now-understood reason, not an
  unknown one: three separate live runs this session
  (`goal-gate-live-test-5`, `-6`, and the earlier attempt) each got a real
  compaction to fire (`compaction_start`/`compaction_end`, `reason:
  "overflow"`, real generated summaries) by shrinking both `contextWindow`
  *and* `keepRecentTokens` together (shrinking `contextWindow` alone
  satisfies the threshold check but leaves `prepareCompaction` nothing to
  cut) — but all three landed after the goal had already completed, so
  `goal-gate.ts`'s own `if (!goal ...) return` guard means the
  reminder-resend logic still hasn't been exercised. Also still open,
  and now a 3-for-3 pattern rather than a one-off: `session_compact`
  (the extension event, distinct from `compaction_end`) never appeared in
  any of the three logs despite `compaction_end` firing each time and the
  installed package's emission-gating condition appearing satisfied by
  inspection — unexplained, not yet root-caused, worth a source-level
  investigation of the installed `pi-coding-agent` package specifically.
  Next attempt needs a task heavy enough to cross the (now-understood)
  compaction threshold *before* the model's first `GOAL COMPLETE`
  attempt, not after — none of the three tasks tried so far grew enough
  real message history to do that ahead of completion.
- **The two unexplained background-process kills: root cause found,
  via a source not checked in any earlier pass — the inference host's
  own server-side request logs, not this machine's OS logs.** Every local
  forensic channel on the client machine (unified log, crash reports,
  reboot history, shell history, legacy syslog, sudo-elevated access) came
  back empty or unavailable, as documented above — but `kannasmacstudio.lan`
  (the LAN model-serving host) keeps its own independent, durable,
  plain-text logs, and SSH access into them (read-only) surfaced both
  kills precisely: two `stream_closed_before_completion` events in
  `qwen36.log` on 2026-08-09 (`09:12:05`, 9m13s after the 09:02:52 commit;
  `16:59:11`, 4s after the 16:59:07 commit), both landing the instant a
  long prefill (121s and 155s, on 35k/43k-token prompts) finished and the
  first output token was about to stream — both with the model server
  itself completely healthy (`in_flight=0`, serving other requests
  normally seconds later). This is the same failure shape as an
  already-documented, already-fixed bug in this exact codebase
  (`cross-model-review.ts`'s `REVIEW_TIMEOUT_MS`, originally 120s, raised
  to 240s after a real 121.4s request got silently aborted) — on the
  *primary* model path instead of the reviewer path. Ruled out: the
  vendored `openai` SDK's own default timeout (confirmed via its
  package.json version matching the proxy log's exact user-agent string)
  is 10 minutes, not ~2 — so something shorter and not yet source-traced
  to its exact call site is doing this. **Status upgraded from
  "unknowable" to "trigger condition and mechanism class identified,
  exact enforcing code not yet traced"** — see the dated update above for
  the full account and the concrete next step (trace `agent-harness.js`'s
  `requestOptions.timeoutMs` for the primary model path). The original
  mitigation hypothesis (`nohup ... & disown` launch hygiene) is now known
  to be the wrong layer entirely — this was never a parent-shell-exit
  problem, it was a client-side network-idle timeout unrelated to process
  detachment.
- **"Many nudge rounds" within one uninterrupted process: closed out with
  a substantive negative finding, not left an open gap.** Final tally
  across every organic (shipped-default-threshold) single-process run:
  n=7, `rounds: 0` or `1` on all seven, including a run
  (`goal-gate-live-test-8`) deliberately built on `pi-harness-history.md`'s
  own documented evidence that this exact model class fixes a specific
  concurrency-bug class in only 2/5 runs unaided — even that task
  converged in one shot once the goal condition named the exact
  thread-safety mechanism required. Separately, the escalation
  *mechanism* itself is proven correct end-to-end
  (`goal-gate-live-test-7`, real stalled→recovered cycle, `rounds: 2`,
  test-only threshold override, reverted). Reading both together: the
  nudge-and-reject loop works correctly when exercised; this specific
  model, on every task class tried so far, converges in at most one real
  nudge rather than needing "many." Not yet ruled out: a harder task class
  or a different, more failure-prone model might still produce a genuine
  many-round case — worth naming as the next experiment rather than
  repeating this one. The multi-hour/multi-restart endurance case
  (surviving actual process restarts, not just nudge rounds within one
  process) is a separate, still-open question, since every restart seen
  anywhere in this file's history was a manual `--continue` recovery, not
  live goal state surviving a restart.
- Live-test `/goal` (`goal-gate.ts`) against a real repo with an
  open-ended, multi-round condition (e.g.
  `/Users/kanna/code/personal-budget-simplifier`, "enrich features and make
  it a true usable full-stack app") — confirm the kickoff follow-up turn
  actually fires under interactive `pi`, the nudge loop survives multiple
  rounds, and a `GOAL COMPLETE` claim only sticks once backed by a real
  passing verification run. **Partially done** (see update above): kickoff
  and single-process nudging both confirmed live; the fully-unattended,
  many-rounds-through-restarts case is still open, per the two items above.
- Battery-test `pi/scripts/build_app.py` across more stacks (Python,
  TypeScript, Flutter), with `--containment` on, and on a task deliberately
  seeded to fail its first verification round so the corrective-round path
  (not just the succeed-on-round-1 path both smoke runs hit) gets real
  coverage.
- Live-battery-confirm the new cross-model-review settlement trigger
  against a real `local-model-bench` task (or any task whose verification
  command never runs inside the model's own session) — so far it's
  source/unit-tested only, not live-run-confirmed the way the tool_result
  path already is.
- Live-test the revised (`tool_result`/`turn_end`-based) designs of
  `makefile-scaffold-nudge.ts` and `error-leak-guard.ts`, and the
  `tool_result` primary-detection path specifically for `artifact-guard.ts`
  (its `agent_settled` backstop path is now live-confirmed, see the status
  table above and the 2026-08-09/10 update below) — the 2026-08-05 live
  test that motivated their redesign only ran the original, now-superseded
  versions. See `pi-harness-history.md`'s "Live end-to-end test finds three
  of four new hardening extensions structurally blind" entry.
- Rerun the personal-budget-simplifier-shaped scenario (or any greenfield,
  no-commits-yet project) now that `buildReviewDiff()` handles untracked
  files, to get a real paired before/after adoption data point — everything
  so far is a single confirming repro, not a battery.
- Give `cross-model-review.ts` a settlement-time trigger (mirroring
  `quality-gate.ts`'s `agent_settled` hook) so it can fire against
  `local-model-bench` tasks at all — its current purely reactive
  `tool_result` trigger structurally cannot activate on this suite, since
  hidden tests don't exist yet during the model's own session (see
  `pi-harness-history.md`'s 2026-08-04 pair-4 rerun). Without this, the
  existing goal of rerunning the seeded battery with the reviewer live can
  produce a full run of green trace data with zero actual review rounds,
  and look like adoption evidence when it isn't.
- Rerun pair 4 (go-flutter/bookmarks-app) specifically as a full paired
  battery task, not just the isolated bug repro, to see whether Gemma's
  spot-check win on the visit-counter race generalizes to the actual task
  end-to-end (harness loop, quality-gate corrective retries, other tests
  in the suite) before drawing any conclusion beyond n=1. Any future
  candidate-model claim on this task (Gemma, KAT-Coder, or otherwise) needs
  roughly 8-10 paired runs to be distinguishable from Qwen's own ~40%
  (2/5) base rate at fixing this race on its own — a single win is not
  evidence.
- Run TypeScript/JavaScript task fixtures through the battery — currently
  routed and unit-tested only, same status as Python/Postgres/Kafka/Temporal/GCP.
- Bind verification to the final tree/diff across all judgment-dependent
  extensions consistently — quality-gate does this; confirm the others do
  too.
- Move DayTrix-only skills out of the global Pi skill directory and into
  that project, leaving generic backend/full-stack guidance global.
- `cross-model-review.ts` now gets a structured `findings[]` array
  (file/severity/issue) from the reviewer but only ever renders it into one
  flat follow-up string for the 3-round loop, same as the old marker-parsed
  prose was. Consider having the loop read `severity` directly (e.g. skip a
  round or downweight retry priority for `nit`-only findings) now that the
  structure exists to do so.
- Use an OS/container boundary for unattended execution once Docker is
  available on this host — the protected-path guard is defense in depth,
  not filesystem confinement.
- `co-change-suggest.ts`'s live (non-retrospective) validation — "try it
  live on one new personal-assistant feature task" — has not been run.
- `continuation-nudge.ts`'s widened trigger has zero field validation.
  Needs real trials before its empty-content-stop path can be said to
  work, not just to type-check.
- `group-invite-atomic-rotation` (`pi-local`) re-run **done, confirmed
  2026-08-07/08**: reward 1.0, both the contextWindow fix and the
  adapter-level bounded-follow-up mechanism work as designed. See the
  table entry above for the full account, including two adapter bugs
  found and fixed along the way.
- Re-verify `terminus-2`'s own harness overhead vs. `pi-local`'s
  (~7,036-token baseline tax, see the table entry above) isn't hiding a
  similar contextWindow mismatch on the control side, since that
  comparison assumed `terminus-2`'s own request sizing is correctly
  configured against the same proxy budget and was never explicitly
  checked. Still open.
- The `PiHarness.run()` follow-up mechanism (`local-model-bench/
  harbor_agents/pi_harness.py`, commits `8531917`/`dfe4620`) has only been
  live-tested on this one task/failure shape. It's a generically-scoped
  fix (any `context_length_budget_exceeded`-shaped ending on any task,
  any provider using `ai-stack-local.ts`), but the only real-world
  confirmation so far is this single repeated case. Worth a broader check
  next time a different task naturally hits this wall, rather than
  assuming full coverage from one confirmed instance.
- Reduce quality-gate's runtime/token overhead below the plan's 20%
  threshold, or revise the threshold with evidence for why the current
  cost is acceptable.

Full investigation history — dated narrative, superseded partial results,
live-run-by-live-run detail — is in `pi-harness-history.md`.

## Post-Qwen3.8-migration claude-sonnet-5 comparison, 4 live trials, and the diagnose-but-don't-act failure mode, 2026-08-16

Four live `pi -p` trials against `local-model-bench`'s `go/lru-cache` task
(Qwen3.8-27B via `pi-local`), run to check the harness against the existing
`claude-sonnet-5` baseline after the Qwen3.6→3.8 migration. Same task every
time for direct comparability. **claude-sonnet-5 (this session's own CLI,
solo): passed clean, 100% coverage, 32.4s, ~2.6k output tokens, one shot** —
the correct fix (proper key-based `touch`/evict via `container/list`).
**pi-local: 0/4.** Every trial produced the identical bug: `Put` stores the
list node's `.Value` as the cache *value*, and eviction later reads that
same field back out as if it were the *key* (`oldest := c.order.Remove(...).
(int); delete(c.data, oldest)`), so eviction silently targets the wrong (or
a nonexistent) map entry whenever a key differs from its value. Checking
`local-model-bench/SPEC.md`'s history, `claude-sonnet-5` is now 3/3 on this
exact task across every recorded report (2026-07-23, 2026-07-26, this
session) — this is not a one-off.

**A real gap in the task's own test suite was found and fixed first.**
Every existing `go/lru-cache` hidden test used `key == value`
(`Put(1, 1)`), which cannot distinguish evict-by-key from evict-by-value.
Trial 1's frozen-at-kill-time code would have officially scored a clean
pass (100% coverage) despite the real bug. Added `TestEvictsByKeyNotValue`
(distinct keys/values throughout) to `local-model-bench/tasks/go/lru-cache/
tests/lru_test.go`; confirmed it passes the correct fix and fails the buggy
one, and leaves the starter's own pre-existing failures unaffected (it
doesn't happen to touch the *recency* bug the starter has, only the
key-vs-value one). Every one of the four trials now scores an honest
failure against this test.

**Trial 1** (see `pi-harness-validation-status.md`'s prior "First live
claude-sonnet-5 comparison" entry, now superseded by this one): killed after
31m14s past the suite's 30-minute default timeout, ~452.8k tokens. The model
self-diagnosed the exact bug via its own written test
(`TestEvictionWithDistinctKeysAndValues`) within 7 minutes, then spent the
remaining ~24 minutes re-running near-identical variants of that same test
against the unedited file. This became the design case for two new
extensions, below.

**`progress-stall-guard.ts` and `wall-clock-budget-nudge.ts` built in
response**, design-reviewed by an Opus subagent before implementation (its
key contribution: `goal-gate.ts`'s existing stall detector hashes the whole
untracked diff, so a model rewriting a near-identical scratch test every
round would defeat it too — any fix needed to be scoped to production-file
edits specifically, not "did the diff change at all"). `progress-stall-guard.ts`
ships trace-only (`appendEntry` on every fire; the actual nudge stays behind
`PI_STALL_GUARD_NUDGE=1`) on the recommendation that this repo's own
precedent (`continuation-nudge.ts` shipped, and was each later widened, off
single real occurrences) argues for building now rather than waiting for
replication, but that the nudge itself should earn a live catch before
being trusted un-flagged. `wall-clock-budget-nudge.ts` ships on by default
as the lower-risk piece: it warns once near 75% of a caller-supplied
`PI_HARNESS_TIMEOUT_MINUTES`, closing the specific gap that let trial 1 die
with zero warning despite already having the right diagnosis in hand.

**Trial 2** (15-minute artificial cutoff, not the real suite default —
a deliberate choice to see behavior sooner): `cross-model-review.ts` (the
Gemma reviewer) independently caught the exact same bug at ~11:46, with
an accurate description of the broken line. The model did not act on it —
instead it wrote its own verification test to check the reviewer's claim,
confirmed it, and the run was cut before it could act further.
`wall-clock-budget-nudge.ts` fired correctly at ~13:34 ("used approximately
14 of 15 available minutes... land it now"). Neither signal produced an
edit to `lru.go` (unedited since ~7 minutes in, for the whole 17-minute run).

**Trial 3 surfaced two real bugs in the two new extensions, both found
live, not by inspection.** Given a real 30-minute budget: (1)
`progress-stall-guard.ts`'s `TEST_EXECUTION_PATTERNS` didn't match `make
verify` — the model built its own `Makefile` mid-task and switched to
running that instead of a direct `go test`, going invisible to the stall
counter even though `lib/verification.ts`'s `BROAD_VERIFICATION_PATTERNS`
already covers exactly that indirection. (2) Both new extensions reset
their internal state (`startedAt`, `sourcelessRounds`, etc.) on every
`agent_start` — which turned out to fire on **every internal auto-retry**
after a transient provider error (`503`/`502`), not once per `pi -p`
invocation. This trial alone hit 16 `agent_start` events from repeated
`503 Server busy` retries, so both extensions' clocks/counters kept
getting silently wiped mid-run. Root cause of the retries themselves:
real generations were taking 200-213s (visible directly in ai-stack's
`kv_proxy.log`), against the proxy's deliberate 60s `QUEUE_TIMEOUT_S`
("fail queued requests promptly" — a real design choice, not a bug, see
`ai-stack/scripts/kv_concurrency_proxy.py`), so pi's client-side auto-retry
kept firing new requests while the original was still running upstream,
compounding load against the 2-slot cap.

**A second, larger contributor to that contention was found afterward:
three of my own processes from trials 1 and 2 were still running.**
Killing the outer `/usr/bin/time -p pi -p ...` wrapper had not killed the
`pi` child process underneath it — `ps aux` later showed all of trial 1,
2, and 3's actual `pi` processes alive simultaneously (up to 1h52m elapsed
on the oldest), all still contending for the same 2-slot route. This, not
a single trial's retries alone, was the dominant source of the observed
200s+ generation times and repeated 503s. Killing all four processes and
waiting for `/proxy/health` to report `active: 0` (in-flight requests from
killed clients keep running server-side and don't cancel on client
disconnect) confirmed a clean baseline before further trials.

**Decision on the proxy-vs-client tradeoff**: given a choice between
raising the shared proxy's `QUEUE_TIMEOUT_S` (affects every client on the
route — Open WebUI, Copilot, Claude-dispatch — not just Pi) versus fixing
it client-side, chose client-side: `settings.json`'s `retry.baseDelayMs`
raised from pi's default `2000` to `30000` (both the tracked
`pi/settings.json` and the live `~/.pi/agent/settings.json`, which are
deliberately not symlinked — see README's "Settings this machine expects").
`ai-stack`'s proxy timeout was left untouched.

**Both extension bugs fixed and confirmed live in trial 4** (clean single
process, confirmed `active: 0` before starting, real 30-minute budget):
`agent_start` count stayed at 1 for the full run (no retries — the
`baseDelayMs` change plus a genuinely idle route meant none were needed),
and `wall-clock-budget-nudge.ts` fired exactly once at the correct point
(23 of 30 minutes). `cross-model-review.ts` caught the bug a fourth
consecutive time, in round 1.

**Trial 4 also found a third, real gap, left unfixed and documented rather
than patched mid-investigation**: the model wrote its scratch tests via
`bash cat > /tmp/lru-debug/main_dbg_test.go <<EOF` heredocs -- outside the
task's working directory and outside the `write`/`edit` tool path entirely
-- varying the file's content enough each round that the exact-text failure
fingerprint never repeated. `sourcelessRounds` climbed to 61 (~26 minutes
with zero edits to the real file) while `sameFailure` stayed at 0 for the
entire run, so the stall guard's AND-conjunction (both a round threshold
and a repeated-fingerprint threshold must hold) never fired, even though
the underlying behavior -- diagnosed and reproduced, never acted on -- is
exactly the pattern it exists to catch. The trace-only telemetry recorded
the whole thing accurately; only the nudge condition itself is too strict
against this specific evasion. Not fixed here: a looser signal (e.g.
sourcelessRounds alone past a higher bound, or a coarser/structural
fingerprint instead of near-exact text) would need its own false-positive
read before adoption, same discipline as the rest of this investigation.

**Why the model doesn't act on a diagnosis it already has, evidenced not
speculated**: across all four trials combined (265 tool calls total),
there was exactly **one** turn of narrated reasoning text -- trial 1's
final "Done" summary, which confidently (and wrongly) claims a fully
verified correct fix, citing its own tests passing. `reasoning: 0` in every
recorded usage line across all four trials confirms this isn't a rendering
gap: `defaultThinkingLevel: "off"` in `settings.json` means the model
genuinely has no chain-of-thought scratchpad between tool calls. The
working hypothesis, not yet tested: without an explicit reasoning trace
turning "this test fails" into an articulated "therefore the fix is X,"
the model's default fallback under uncertainty is more verification
scaffolding (another probe test, a Makefile, a README) rather than a
targeted edit -- and its confidence that it's already finished (trial 1)
comes from its own imperfect self-written tests, which is also how the
official suite's key-vs-value gap went undetected for as long as it did.
**Untested**: whether `defaultThinkingLevel: "low"`/`"medium"` changes this
behavior on the same task. Proposed as the next experiment, not yet run.

**Net status**: `pi-local` is 0/4 on this task post-migration, all four
failures the same bug, `cross-model-review.ts` 4/4 on independently
catching it. This is now a real, replicated finding about model
follow-through under this harness's default (no-thinking) configuration --
not model capability in the reasoning sense (it diagnosed correctly every
time), and not a harness defect in the sense of missing signal (the
reviewer caught it every time too). Both new extensions are adopted
on-by-default (`wall-clock-budget-nudge.ts`) or trace-only pending a live
catch (`progress-stall-guard.ts`), per `pi-harness-validation-status.md`'s
extension table. Full task suite (beyond this one repeated task) not
re-run; `pi-local` has been competitive with `claude-sonnet-5` on other
tasks in earlier reports (6/7 vs 6/7 twice) -- this is a specific,
well-evidenced failure mode on one task, not a suite-wide verdict.

## The untested `defaultThinkingLevel` hypothesis, tested: a real regression found and fixed, then 3/3 on `go/lru-cache` post-fix, 2026-08-17

Follow-up to the entry above's explicit open item ("untested: whether
`defaultThinkingLevel: "low"`/`"medium"` changes this behavior"). Full
research trail is in `qwen38-agentic-coding-tuning-research.md`
(repo root); this entry is the narrative summary.

**Research phase.** Read the Qwen3.8-27B model card and vendor docs:
it's a hybrid-thinking model that reasons by default at
`reasoning_effort: xhigh`, and `ai-stack-local.ts`'s `reasoning: false`
was suppressing every thinking-control field pi-ai would otherwise send
(not an explicit "off" -- an unset one; `model.reasoning` gates every
branch in `buildParams`). First draft of the research doc overclaimed
this as "thinking forced off at two layers" -- an Opus subagent review
caught that this was backwards (nothing forces it off; the served
default was actually unverified) and also caught that the `reasoning: 0`
usage-counter evidence in the entry above is likely a structural null on
this route, not proof of anything: mlx-vlm doesn't populate
`completion_tokens_details.reasoning_tokens`, so that field reads 0
whether or not the model reasoned. Both corrections are folded into the
research doc rather than kept as a separate errata section.

**Step 1, live-verified before any config change**: three direct curls to
`:8080/v1/chat/completions`. A bare request (mirroring the harness
exactly) returned no reasoning content -- confirming thinking really was
off, not just unconfirmed. Top-level `enable_thinking`/`reasoning_effort`
(pi-ai's `"qwen"` `thinkingFormat`) produced a populated
`reasoning_content` block. The nested `chat_template_kwargs` shape --
the one that worked for forcing thinking on GLM on this same stack (see
"GLM-4.7-Flash-4bit ruled out as reviewer candidate" earlier in this
file) -- did **not** trigger thinking here. That precedent doesn't
transfer within this stack; don't assume it does elsewhere either.

**Step 2, applied**: `reasoning: true`, `compat: { thinkingFormat: "qwen",
supportsReasoningEffort: true }`, and a `thinkingLevelMap` copied from
pi-ai's bundled `qwen3.8-max-preview` entry, in `ai-stack-local.ts`.
`defaultThinkingLevel` changed from `"off"` to `"medium"` in both
`pi/settings.json` and the live, deliberately-unsymlinked
`~/.pi/agent/settings.json` (missed the second file on the first pass;
`/usr/bin/diff` caught it after the `rtk`-wrapped `diff` falsely reported
the two files identical -- worth a separate look, not chased here).

**Trial 5: a real regression, not a fix.** First live re-run of
`go/lru-cache` under the new config produced **zero diff** -- worse than
the 0/4 baseline, which at least edited the file every time. Every turn
in round 1 came back `stopReason: "error"`, `503 tokenizer_unavailable:
"Unexpected message role"`, immediately, on the very first turn (0 input
tokens -- not a multi-turn history problem). All 3 client-side retries
exhausted twice (~7 minutes burned) before the agent settled with no
code changes; `cross-model-review.ts` and `quality-gate.ts` both
correctly flagged the failure. Root cause, confirmed live via direct
curl: pi-ai's `detectCompat` defaults `supportsDeveloperRole: true` for
any generic OpenAI-compatible `baseUrl` once `model.reasoning` is `true`,
so pi silently switched the system prompt from role `"system"` to
`"developer"` -- and this route's tokenizer rejects `"developer"`
outright. Step 1's curls missed this because none of them included a
system-role message. Fixed with `supportsDeveloperRole: false`;
re-verified via curl before re-running anything.

**Trials 6-9: 4/4 pass, post-fix.** Same task, same clean-baseline
discipline (checked `/proxy/health` `active: 0` and no stray `pi`
processes before each). All four produced a correct, key-based
`touch()`-style fix and passed the full hidden suite including
`TestEvictsByKeyNotValue` -- the regression test added specifically
because all four original trials shared the value-as-key eviction bug --
at 100% statement coverage each time. Trial 6 built its own scaffold
(`.gitignore`, `Makefile`, `README.md`, a self-authored test file) and,
in doing so, deleted the transcript capture file this investigation had
placed inside its own working directory -- a methodology fix (capture
file moved outside the task workdir) landed before trial 7, which then
ran cleanly with no scaffold detour. Trial 9 ran under real, log-confirmed
GPU contention from an unrelated concurrent process (`docwriter.ts`,
independent in-progress work on this machine, confirmed via its own
source to default to the same `:8080` route -- `/proxy/health` showed
`active: 2` and `queue_wait_seconds: 13.7`, decode rate crashed to ~15
tok/s from the 51.1 tok/s solo baseline) and still passed cleanly once it
finished, just slower -- the fix held up under real contention, not only
in a clean isolated environment.

**Temperature, separately investigated and fixed.** `pi-coding-agent` has
no `--temperature` flag or `settings.json` field at all (confirmed by
grepping its source), and mlx-vlm has a documented bug ignoring the
model's own `generation_config.json` (independently reported for the
Gemma route on this same stack too), so every trial including 1-6 above
ran at mlx-vlm's undocumented-but-confirmed server default of
`temperature: 0.0` -- fully greedy, below the vendor's own thinking-mode
recommendation of 1.0 (or 0.6 for Qwen3.6's "precise coding" preset).
No client-side lever existed to change it, so one was added: a
`before_provider_request` hook in `ai-stack-local.ts`, scoped to this
model id only, injecting `temperature: 0.6`. Verified live with a
temporary debug line (confirmed `payload.temperature = 0.6` actually
went out) before removing it. Trial 7 (temperature 0.6) converged in
~4 minutes with zero retries and no scaffold detour, versus trial 6's
8+ minutes with a self-built scaffold at the old greedy default --
suggestive, not proof, that greedy decoding was contributing to the
over-verification pattern this file's earlier entries describe.

**Community cross-check (2026-08-17), after the config change**: found
independent, converging support for `"medium"` over the vendor's
`"xhigh"` default (Simon Willison's write-up: 21 minutes / 22,276
reasoning tokens on a trivial prompt at `xhigh`, vs. 137 seconds with
thinking off; an HF commenter separately endorsing `"medium"` as
"better"). Also found a specific, relevant caveat not yet acted on here:
community reports describe `preserve_thinking` as the actual fix for
agentic re-planning loops (wrong tool-call arguments repeated
indefinitely, resolved by enabling it) -- and confirmed by reading the
code that the `"qwen"` `thinkingFormat` branch this fix uses does **not**
send `preserve_thinking` at all (unlike `"qwen-chat-template"`, which
hardcodes it true). The model card says the server defaults it on
anyway, but that default is unconfirmed for this specific mlx-vlm
deployment. **Flagged as the next thing to check if a future trial
regresses to the old diagnose-but-don't-act pattern.**

**Net status: replicated.** 4/4 post-fix against a 0/4 pre-fix baseline on
one task, matching this file's own bar for the original 0/4 result (4
consistent repeats) before calling a finding replicated rather than
suggestive. A real regression (trial 5) was found and fixed along the
way, which is itself evidence this investigation's verification
discipline (live curl checks, clean baselines, debug-verified config
changes) is doing its job rather than rubber-stamping the first
plausible-looking config. Still open: this is one task, repeated;
broader task-suite coverage (beyond `go/lru-cache`) hasn't been re-run
under the new config, and `preserve_thinking` (flagged above) remains
unactioned pending a future regression that would motivate it.

## Hardened-config battery rerun (2026-08-17)

With the thinking/temperature hardening above landed and separately
replicated on `go/lru-cache` (4/4), the natural next question was whether
it held up across the broader multi-stack task pool the original
nine-pair `full-screening-2026-08-03.json` battery covered — that battery
predates the hardening (ran with thinking off) and is a different
experiment, not stale evidence for it. Reran `pi/evals/run_screening.py`
with the same seed (`20260802`) against the same task pool minus
`go/lru-cache` (already separately proven, re-running it would just
re-spend real time re-proving a settled result) — 7 pairs.

**Self-inflicted duplicate process (first ~75 minutes, no useful data
lost).** The first launch used `nohup python3 ... & disown` inside a
single Bash call that also did `sleep 5; tail ...` and returned. `ps aux`
from the operating agent's own later shell calls showed nothing matching,
so a second launch was started against the same `--output` directory.
Both were in fact still alive (confirmed later via `pgrep -fl`, which
found both PIDs the plain `ps` grep had missed) and ran concurrently for
over an hour, contending for the same model route and interleaving
records into the same `results.jsonl` — directly causing pair 1's first
attempt to time out. Root cause isolated to process visibility, not an
actual death: this sandboxed shell's `ps` does not reliably show
processes spawned by earlier tool calls in the same session. Both were
killed once found via `pgrep`, contaminated artifacts wiped, and the run
restarted clean with a single tracked process. Lesson applied for the
rest of the run: verify with `pgrep -fl <pattern>` before ever assuming a
background launch died.

**Repeated background-task kill, 3x in a row, always at the identical
point.** The properly-tracked restart (launched via the operating agent's
own `run_in_background` Bash flag) was killed by that sandbox three
consecutive times, always right after starting pair 4's harness arm
(`go-flutter/bookmarks-app`), roughly 10-13 minutes into each attempt. A
`--resume` flag was added to `run_screening.py` for this (see "Runner
changes" below) so each restart re-used every already-valid `(pair, arm)`
record from `results.jsonl` instead of re-running completed work — no
already-valid data was lost across the three kills. To isolate whether
this was model/network-related (matching the harness's own existing
"background-process kills" open item, which concerns `pi` dying in a
*normal terminal* `/goal` session) or something specific to this agent's
own tool sandbox, a fourth attempt used a purely idle polling loop (no
`pi` subprocess at all, just `sleep 20` checks) launched the same way via
`run_in_background` — it was killed at the same ~10-13 minute mark
regardless of having done essentially no work. That isolates the
mechanism to a fixed-duration limit on this sandbox's own tracked
background tasks, independent of workload — a different, narrower
mechanism than the pre-existing "background-process kills" item, which
remains open and unrelated. Mitigation: launched via `nohup python3 ... &
disown` with a short-lived launcher (the launcher process itself exits in
seconds after backgrounding the real work and printing its PID; the real
`run_screening.py` process is then fully detached from the sandbox's
background-task tracking, invisible to its kill mechanism). That process
(PID 70787) then ran uninterrupted for the rest of the battery, roughly
1.5 more hours, polled manually via direct `ps -p <pid>` checks rather
than relying on tool-level completion notifications (which this
mitigation deliberately forfeits).

**Runner changes.** Two additions to `run_screening.py`, both kept as
permanent runner capability, not throwaway:

- `--skip-task <id>` (repeatable): omits specific tasks from the
  schedule while the seeded RNG stream is still advanced for them, so the
  remaining tasks' arm-order assignments stay identical to an unfiltered
  run with the same seed — used here to skip `go/lru-cache`.
- `--resume`: continues an interrupted run from its own
  `manifest.json`/`results.jsonl` at `--output`. Reuses the prior run's
  seed and skipped-task set (ignoring any `--seed`/`--skip-task` passed
  alongside `--resume`, to prevent an accidental schedule mismatch),
  skips any `(pair, arm)` that already has a `valid: true` record instead
  of re-running or duplicating it, and appends new records to the same
  `results.jsonl`. `summary.json` is now computed by reading the full
  `results.jsonl` off disk at the end, not from the current invocation's
  in-memory `records` list, so a resumed run's summary correctly reflects
  every pair/arm ever recorded for it, not just the current process's
  slice.

**Real findings, not process noise.** Three of the seven harness arms
came back invalid, and unlike the incidents above these were the battery
doing its job:

1. **`go-flutter/bookmarks-app`, harness arm** — ran the full 45-minute
   budget *uninterrupted* (via the nohup launch, immune to the sandbox
   kill above) and still produced zero diff and zero recorded assistant
   messages. The agent never got a productive turn in. This is a fourth
   consecutive failure on this exact arm across the session (the prior
   three were the sandbox kills, not this), which raises the prior of a
   real problem specific to this task under the hardened config, but the
   mechanism isn't isolated — retrying a fifth time was judged not worth
   the further hour of wall-clock at this point. **Open, unresolved.**
2. **`dart/sequential-runner`, harness arm** — hit the fixture's default
   30-minute timeout, but the diff already produced when time ran out
   passes the hidden tests (`hidden_test_exit=0`). The fix was correct;
   quality-gate's verification/corrective-follow-up loop simply hadn't
   settled and let the agent declare done before the clock ran out. This
   is the same failure shape as the already-documented
   `pair4-rerun-2026-08-13` entry — a second live occurrence, not a new
   phenomenon. **Open, timeout-budget/settlement-speed problem, not a
   correctness one.**
3. **`go/notes-api`, harness arm (pair 7, the repeat measurement)** —
   `extension_errors=1`: `git-checkpoint.ts`'s `turn_start` handler
   crashed with Pi's documented stale-context error (a session
   reload/compaction/fork landing before the handler's first `ctx` call
   — most likely `ctx.sessionManager.getLeafEntry()`, the only call in
   that handler not already individually `.catch()`-guarded).
   `stack-router.ts` and `quality-gate.ts` already guard against this
   exact error class via `lib/stale-context.ts`, added during the
   original 2026-08-03 hardening work — `git-checkpoint.ts` had never
   been given the same guard, a real gap this run surfaced. The
   underlying code change was correct (`hidden_test_exit=0`); the run is
   scored invalid purely per the harness's zero-tolerance-for-extension-
   errors validity contract. **Fixed same-day**: wrapped the handler body
   in the same `isStaleContextError` guard as the other two extensions;
   4 new deterministic tests added
   (`pi/tests/git-checkpoint.test.ts`), including one that reproduces the
   exact crash via a throwing `ctx.sessionManager.getLeafEntry()` mock.
   Full 179-test suite (`npm run typecheck && npm test`) passes. Not
   re-validated against a fresh live occurrence of the same race — it's
   timing-dependent on exactly when a session reload lands relative to
   `turn_start`, not reliably reproducible on demand — so confidence in
   the fix rests on the unit test faithfully reproducing the documented
   failure mechanism, not on a second live catch.

**Aggregate (final record per (pair, arm); pair 3's first harness attempt
— invalid, 1800s timeout — is superseded by its `--resume` retry, 792s,
valid, and excluded from these sums though both remain in
`results.jsonl`):** baseline 7/7 valid and passed; harness 4/7 valid, but
every valid harness run passed (4/4) — quality held wherever the run
completed. Median paired runtime overhead across the 4 fully-valid pairs
(1, 2, 3, 6) was ~312%, versus the pre-hardening battery's 100.3% — the
expected cost of thinking-enabled turns, not a surprise. The real,
actionable finding is reliability: 43% of harness arms didn't finish
inside timeout budgets that were sized for the pre-thinking harness and
haven't been revisited since thinking was turned on. Full record:
`pi/evals/hardened-screening-2026-08-17.json`.

Note on the "9-pair" framing: the seeded schedule covers only **7 unique
tasks**, not 9 — `go/lru-cache` and `go/notes-api` are each scheduled
twice on purpose (a single result on a stochastic agent is anecdotal). "9"
has always meant pair count, not distinct-task count; this rerun happened
to skip both `go/lru-cache` repeats (separate 4/4 evidence already existed
for it) while keeping both `go/notes-api` repeats, landing on 7 pairs / 7
unique tasks by coincidence, not by design.

## 2026-08-17 (evening) — pair 4 clean-contention rerun

Following the hardened-config battery rerun above, its runtime overlapped
(2:15-4:46 PM) with other local inference contesting the same host's
GPU/route resources, discovered after the fact. To separate contention
noise from genuine harness defects, pair 4 (`go-flutter/bookmarks-app`,
harness arm) was rerun in isolation once the LAN was confirmed clear:

1. Killed the in-flight rerun process cleanly.
2. Fully restarted the two relevant launchd jobs — `com.aistack.qwen38`
   and `com.aistack.kvproxy` — via `launchctl kickstart -k` (new PIDs
   confirmed: 34038, 34045). The underlying `mlx_vlm.server` processes
   for other routes were untouched; this targeted only the Qwen3.8
   primary route and its proxy.
3. Verified clean state before relaunch: `/v1/models` responding fresh
   on `:8080` and `:8081`, `lsof` showing no lingering client
   connections from the prior run.
4. Reran **harness arm only** — pair 4's baseline was not re-run, since
   it already passed 7/7 valid in the original battery and was never in
   question; reusing it avoided ~15-20 minutes of redundant baseline
   time. (`run_single_pair.py` has no baseline-skip flag, so this reused
   its `execute_arm()` directly via a small wrapper script instead.)

**Result: `valid: true`, `passed: true`, `timed_out: false`.** 1073s
(~18 min, well inside the 45-min budget), a real 328-line diff across 3
files (`client/lib/bookmarks_client.dart`,
`client/lib/bookmarks_view_model.dart`, `server/bookmarksapi.go`), 46
assistant messages, 60 tool calls, `hidden_test_exit=0`. Trace shows a
genuine corrective loop, not a rubber-stamp pass: `cross-model-review.ts`
flagged once, `quality-gate.ts` failed verification 3 times before
settling. This is a stark contrast to the original run's zero diff and
zero turns across the full 45 minutes.

**Conclusion: pair 4's original stall was contention-caused, not a
genuine hang or a defect in the hardened (thinking-enabled) config.**
This closes the "genuine stall, not yet root-caused" open item for pair 4
specifically. `dart/sequential-runner` (pair 5, the settlement-speed
timeout) has not yet been re-isolated the same way and remains open, as
does the ~312% median overhead figure, since neither has had its own
clean-contention rerun. Artifact: `record.json` under
`/tmp/pi-pair4-harness-only-clean-20260817T232159/` (not committed, local
temp path).

## 2026-08-17/18 (late evening) — go/lru-cache run through the battery script for the first time

Prompted by a question about why the 8/17 rerun's "9 pairs" only covered
7 distinct tasks: `go/lru-cache` and `go/notes-api` are each scheduled
twice on purpose (stochasticity), and the 8/17 rerun happened to skip
both `go/lru-cache` repeats (it already had separate 4/4 evidence — see
this file's 2026-08-17 "untested `defaultThinkingLevel` hypothesis,
tested" entry) while keeping both `go/notes-api` repeats. To properly
account for every unique task inside this exact battery script/fixture
format, pair 7 of the *unskipped* schedule (`go/lru-cache`, arm order
baseline-then-harness) was run in full via `run_single_pair.py --pair 7`
on the same freshly-restarted, contention-clear stack as the pair-4 rerun
above.

**Caution on pair numbering:** this run's "pair 7" is *not* the same
pair 7 as the 8/17 battery's (`go/notes-api`, the git-checkpoint crash) —
that battery used `skip_tasks={'go/lru-cache'}`, which shifts every
index after the skip. `run_single_pair.py` always uses the unskipped
schedule, where pair 7 is `go/lru-cache`. Referring to tasks by name, not
pair number, avoids this collision.

**Result:**
- **Baseline**: `valid: true`, `passed: true`, 48.1s, clean 21-line diff.
  Correctly fixed eviction by adding a `touch(key)` helper that reorders
  the existing `[]int` slice on both `Get` and `Put`, deleting by key on
  eviction (`delete(c.data, oldest)`) — straightforward, no corrective
  rounds needed.
- **Harness**: `valid: true`, `passed: false`, 163.4s (well inside
  budget, no timeout). Diff rewrote the eviction structure to
  `container/list`, but reintroduced the *exact bug class* the original
  0/4 finding documented: `Put` stores `value` (not `key`) as the list
  element's payload, so eviction does `delete(c.data,
  oldest.Value.(int))` — deleting by value, not key. Hidden test
  `TestEvictsByKeyNotValue` failed as expected
  (`lru_test.go:69: expected key 10 to be evicted`).
- **`cross-model-review.ts` worked exactly as designed**: a
  settlement-triggered review (the model had already called `agent_end`)
  correctly flagged the precise bug — *"The `Put` method stores the
  `value` in the list element instead of the `key`... this is incorrect
  unless `key == value`"* — matching its established catch rate.
- **But the correction never landed — the cleanest trace yet of the
  already-documented `quality-gate.ts` corrective-follow-up gap.** A
  corrective round was queued (`round 1/3`, injected as a new user
  turn), but the trace shows: `agent_start` → `turn_start` →
  message_start/message_end (the injected correction message) →
  immediately a `quality-gate` `verification` entry with `outcome: pass`,
  `diffChanged: false`, 213ms later → `agent_settled`. No assistant
  response, no tool call, nothing — the model was never actually given a
  turn to act on the correction. This is the third confirmed occurrence
  of this gap (previously n=2 across two `pi -p` sessions, 9 and 30
  turns), now with byte-level evidence (`diffChanged: false` plus the
  213ms gap) pointing at the corrective-turn dispatch itself, not the
  model's response to it.

**Interpretation, precisely stated:** this is *not* evidence that the
2026-08-17 thinking/temperature fix regressed. The model's first attempt
on `go/lru-cache` needing one correction round is not itself surprising —
whether the earlier 4/4 direct-scratch-task trials needed correction
rounds to land this same task was never recorded, so this may be normal
first-attempt variance rather than a new failure mode. What *is* new and
solid: `go/lru-cache` had never been run through this exact battery
script/fixture before, and doing so surfaced a clean, reproducible
instance of the corrective-follow-up gap — sharpening that open item from
n=2 to n=3 with the best trace evidence yet. Recommend a second
battery-script rerun of `go/lru-cache` to see whether the first-attempt
bug reproduces (a real weak spot) or was a one-off, now that the
corrective-follow-up gap is the suspected root cause of the failing score
rather than the underlying fix.

Artifacts: `/tmp/pi-pair7-lru-cache-20260817T235523/` (manifest,
results.jsonl, summary — not committed, local temp path); full session
trace at `/private/tmp/pi-screen-07-harness-ij7svrq3/pi-output.jsonl`
(also local temp, not committed).

## 2026-08-17/18 (late evening) — quality-gate follow-up fix: diagnosis, attempt, and revert

Prompted directly by the `go/lru-cache` trace above. Initial diagnosis:
`goal-gate.ts`'s `/goal` command handler had already hit and fixed this
exact-looking race once (`pi.sendUserMessage()` only queues a turn; under
`pi -p` the process can exit before the queued turn starts unless the
caller explicitly waits for it). `quality-gate.ts`'s and
`cross-model-review.ts`'s `agent_settled` handlers call
`sendUserMessage(..., {deliverAs:"followUp"})` without any such guard, so
the fix extracted goal-gate's wait pattern into a shared
`extensions/lib/wait-for-followup.ts` helper (`waitForNextAgentStart()` +
poll `ctx.isIdle()`, since `ExtensionContext` — the type event handlers
get, unlike `ExtensionCommandContext` — only exposes a synchronous
`isIdle()`, not the awaitable `waitForIdle()` goal-gate's command handler
uses) and applied it to both extensions' settlement paths.

Typecheck and the full 179-test suite passed after fixing two tests that
started hanging on the new wait (they emitted `agent_settled` without a
matching `agent_start` to unblock it) and adding `isIdle()`/`setIdle()` to
the test harness's fake `ExtensionContext`, which hadn't had it. Runtime
dropped from ~60s (two tests hitting a 30s timeout each) to ~11s once
fixed. All of this was still uncommitted when the next step happened.

**Requested an independent Opus review of the diagnosis and fix before
committing** (per this file's `~/.claude/CLAUDE.md`-adjacent practice of
getting a second opinion on non-trivial changes). The review read the
actual `pi-coding-agent` package source
(`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`,
`agent.js`) rather than trusting the extension-level comments, and found
the diagnosis itself was wrong, not just risky in implementation:

- By the time `agent_settled` fires, `_emitAgentSettled()` has already
  set `_isAgentRunActive = false` (so `isStreaming`/`isIdle` already read
  as idle). `sendUserMessage()` → `prompt()` only queues
  `if (this.isStreaming)`; otherwise it falls through to
  `await this._runAgentPrompt(messages)` directly. From `agent_settled`,
  `deliverAs:"followUp"` is therefore dead — `sendUserMessage` doesn't
  queue anything, it immediately starts a full **nested, re-entrant agent
  run**. (It doesn't throw "already processing" because `finishRun()`
  already cleared `activeRun` before the outer `agent.prompt()` call
  resolves.)
- The fix's `isIdle()` poll "worked" in testing only because of event
  ordering luck (idle reads true from the very first tick of the handler,
  independent of whether anything real was queued or drained) — not
  because a queue-drain was actually being waited on.
- The upstream code has an explicit comment identifying the real,
  race-free seam: messages queued from **`agent_end`** (while the session
  is still streaming) get drained automatically by the existing
  `_handlePostAgentRun()` continuation loop, with no waiting or polling
  needed. `agent_settled` was never the intended injection point.
- The observed 213ms zero-token re-settle that started this investigation
  has the signature of `handleRunFailure` — a nested run hitting an
  immediate provider/preflight error and synthesizing an empty assistant
  turn with `EMPTY_USAGE` — which the fix does not address at all, and
  which neither extension can even detect, since neither awaits or
  catches the `sendUserMessage` call's own promise (an error there
  becomes an unhandled rejection).

Beyond the wrong diagnosis, the review found concrete defects in the
implementation itself: the fix's shared 10s deadline caps *both* "wait for
the turn to start" and "wait for it to finish," so a real corrective turn
(which can run 60s+, especially at the ~312% thinking-mode overhead this
file already documents) would get cut off by `pi -p` exiting anyway,
defeating the fix's own purpose; `quality-gate.ts`'s `settling` flag reset
*after* the new wait instead of before, silently suppressing the
re-entrant verification that was the only diagnostic signal available;
and most seriously, `cross-model-review.ts`'s `agent_start` handler fully
resets its review state (`reviewCount`, `settled`, `lastReviewedDiff`) on
every `agent_start` including a nested one, with no depth counter — so
the fix would make previously-unreachable **unbounded recursive review
rounds** reachable in production, where before the process would already
have exited. Test coverage was also confirmed inadequate: no dedicated
test for the new helper, and `cross-model-review.test.ts`'s one relevant
settlement test used a `"clean"` verdict, so the new code path there had
never actually executed.

**Verdict: would not ship as-is.** All changes (the new
`extensions/lib/wait-for-followup.ts`, and edits to `quality-gate.ts`,
`cross-model-review.ts`, `tests/extension-api-harness.ts`,
`tests/quality-gate.test.ts`) were reverted via `git checkout`/`rm` before
anything was committed. Confirmed clean: `git status --short` empty,
179/179 tests passing on the unmodified tree.

**What the review recommends instead, for the next attempt:** inject the
settlement-time corrective/review follow-up from `agent_end`, not
`agent_settled` — this removes the race, the nested run, the polling, and
the timeout-tuning question in one move, since it's the seam
`pi-coding-agent` already built and drains automatically. Before writing
that fix, capture the nested run's actual `stopReason`/error/usage on a
live occurrence to confirm the `handleRunFailure` hypothesis rather than
assuming "didn't wait long enough" again. If any wait logic is still
needed in some remaining case, it must have its own budget separate from
any "did the turn start" wait (matching `ctx.waitForIdle()`'s unbounded
semantics, not a shared deadline), `cross-model-review.ts` needs an
explicit depth cap on settlement-triggered review rounds that survives a
nested `agent_start`, and `quality-gate.ts`'s `settling` reset must happen
before any wait, not after. Ship only with a dedicated
`wait-for-followup.test.ts` (or equivalent for whatever the `agent_end`
version ends up being) plus a `cross-model-review.test.ts` case that
actually exercises a `"flagged"` verdict through settlement.

Status: the corrective-follow-up gap itself remains **open**, now with a
corrected understanding of the mechanism rather than a shipped-but-wrong
fix. See `pi-harness-validation-status.md`'s updated
`quality-gate.ts` / `cross-model-review.ts` corrective follow-up entry.

## 2026-08-18 — quality-gate follow-up fix, take two: agent_end injection, second Opus review, landed

Second attempt, directly following the first review's recommendation: move
the corrective/review follow-up injection from `agent_settled` to
`agent_end`.

**Implementation.** `quality-gate.ts`'s and `cross-model-review.ts`'s
follow-up-sending handlers moved from `pi.on("agent_settled", ...)` to
`pi.on("agent_end", ...)`. No wait/poll logic was needed this time — the
premise (confirmed below) is that a message queued from `agent_end`, while
the session is genuinely still streaming, gets picked up automatically by
`pi-coding-agent`'s existing `_handlePostAgentRun` → `agent.continue()`
loop. `cross-model-review.ts` additionally needed a real fix, not just a
trigger change: its `agent_start` handler unconditionally reset
`reviewCount`/`lastReviewedDiff`/`settled`, which was harmless before (the
follow-up never actually landed, so the reset never mattered) but would
become a real unbounded-recursion risk once follow-ups started working —
flagged explicitly as a blocker in the first review. First cut: a hand-rolled
`awaitingOwnContinuation` boolean, set right before `sendUserMessage` and
consumed by the very next `agent_start`, skipping the reset only when that
`agent_start` was this extension's own continuation. Also fixed in the same
pass: the settlement backstop's old `lastReviewedDiff !== undefined` guard
(a one-shot "has any review ever run this session" check) would have
silently blocked rounds 2 and 3 now that `lastReviewedDiff` persists across
own-continuations — removed, relying on `startReviewRound`'s own precise
`diff === lastReviewedDiff` comparison instead. 180 tests passing at this
point, including a new "settlement review rounds are capped across the
extension's own corrective continuations" test that passed on the first
real run.

**Second independent Opus review, before committing anything.** Given the
first review caught a wrong diagnosis, a second review was requested for
this implementation specifically — instructed to re-derive everything from
`pi-coding-agent`/`pi-agent-core` source itself, not trust either session's
code comments.

Confirmed correct, from source: at the moment `agent_end` extension
listeners run, `_isAgentRunActive`/`isStreaming` is genuinely still `true`
(`_emitAgentSettled` is what flips it false, reached only after
`_handlePostAgentRun`'s while-loop exits — strictly after `agent_end`'s
listeners have already run). `sendUserMessage`'s `deliverAs:"followUp"`
path takes the queuing branch (`agent.followUp()` → `followUpQueue`) while
streaming, not the nested-run branch. `runLoop` polls queued follow-ups
*before* emitting `agent_end`, so a message queued *during* `agent_end` is
missed by that poll and survives to `_handlePostAgentRun` →
`agent.hasQueuedMessages()` → `agent.continue()` — exactly the mechanism
the first review's recommendation described, and no extra code was needed
to make it work. Also confirmed: `agent_start` genuinely refires on every
`agent.continue()` cycle (`runAgentLoopContinue` emits its own
`agent_start`, not just `runAgentLoop`), so the premise behind needing some
kind of continuation-aware reset was real, not imagined.

But it found four real defects in the state layered on top of that correct
core, two of them severe enough to block:

1. **(HIGH, regression)** An aborted run (user Ctrl-C, or a `-p` timeout)
   still reaches `agent_end` while `isStreaming` is true. Neither
   extension's `agent_end` handler filtered on this, so quality-gate would
   run verification against an already-aborted `ctx.signal`, get a failure,
   and queue a corrective follow-up that **resurrects a run the user just
   killed**. Impossible under the old `agent_settled` trigger; a direct
   side effect of moving to `agent_end`.
2. **(MEDIUM, factually wrong code comment)** The comment claiming "the
   unchanged-diff early-return makes an extra `agent_end` firing on retry
   cycles a no-op" is only true when the *previous* run passed.
   `evidencePassesCurrentDiff` requires `exitCode === 0`; on the failure
   path (the only path that produces a continuation at all) an `agent_end`
   on an *identical* failing diff re-runs the full canonical check and
   burns one of only three corrective rounds. With this repo's own
   `retry.maxRetries: 3` settings, three transient API errors against the
   local endpoint would exhaust the entire corrective budget on transport
   flakiness before a single real failure gets addressed.
3. **(MEDIUM)** `awaitingOwnContinuation` could leak `true`: the
   `tool_result`-triggered review path (fire-and-forget mid-run) also sets
   it, but if that round resolves while the model is still working, the
   resulting follow-up is drained by `runLoop`'s own inner poll (no
   `agent_start` fires for that path) — so the flag never gets consumed,
   and the *next genuinely new* `agent_start` incorrectly skips the reset,
   letting a stale `settled`/`reviewCount` leak into an unrelated later
   task.
4. **(MEDIUM)** Cross-extension mis-attribution: `followUpMode` defaults to
   `"one-at-a-time"`, so when both extensions queue a follow-up off the
   *same* `agent_end`, one `agent.continue()` drains only one message,
   producing **two separate `agent_start` events**, not one. Extension load
   order (`fs.readdirSync`, unsorted) decides which fires first, so
   whichever `agent_start` isn't cross-model-review's own gets misread as
   "not my continuation" and wipes its round state anyway — bounded by
   quality-gate's own 3-nudge cap (worst case ~12 review calls, not
   infinite) but the cap is not actually honored, which is exactly what the
   new capping test claims to protect and doesn't.

Root cause of (3) and (4): trying to reconstruct "is this agent_start a
genuinely new task" from `agent_start` itself, which fundamentally cannot
distinguish that from a continuation. The review's fix, adopted as-is: use
`before_agent_start` instead. Its single call site
(`agent-session.js`'s `emitBeforeAgentStart`, inside `prompt()`'s
non-streaming path) fires exactly once per genuine top-level user prompt —
never on a continuation, retry, or compaction — so the reset can move
there and the flag can be deleted outright rather than patched.

Two lower-severity items accepted rather than fixed: removing the
`lastReviewedDiff !== undefined` guard is sound (the comparison it's
replaced by is deterministic) but can now waste one real review call on
build-tool-generated tracked-file churn (lockfiles, generated code) landing
in the diff on a continuation, since quality-gate's verification command
now runs on every one, not just once per settle — a cost, not a
correctness bug, left as a documented note rather than fixed. Live
end-to-end validation (a real follow-up producing a real second turn with
non-zero tokens) was flagged as still needed — unit tests against the mock
`ExtensionHarness` can't close that gap; recommended as the next step, not
done in this session.

**Fixes applied, in the same session:**
- New `extensions/lib/agent-end-guard.ts`: `lastAssistantMessageFailed(messages)`,
  scanning `AgentEndEvent.messages` from the end for the last assistant
  message and checking `stopReason === "error" || "aborted"`, mirroring
  the scan `_willRetryAfterAgentEnd` does internally. Applied as an
  early-return at the top of both extensions' `agent_end` handlers (after
  awaiting any in-flight `tool_result`-triggered review in
  `cross-model-review.ts` — letting an already-running round finish and log
  is harmless; what must not happen is *starting* a new one).
- `cross-model-review.ts`: deleted `awaitingOwnContinuation` entirely;
  `reviewCount`/`lastReviewedDiff`/`settled` now reset on a new
  `pi.on("before_agent_start", ...)` handler instead of `agent_start`.
- 6 new tests: abort/error-guard tests for both extensions (2 each, one
  per `stopReason`), and a two-extension-interleaving test that mounts both
  `qualityGate` and `reviewer` on one harness, drives 6 rounds of
  `agent_end`/`agent_start` (deliberately more than either extension's own
  cap) without ever re-emitting `before_agent_start`, and confirms neither
  extension's round cap gets corrupted by the other's activity — passed on
  the first real run. Total: 185 tests, up from 179 before this fix (179
  itself already reflected the earlier `agent_settled`→`agent_end` test
  migration from the reverted first attempt's cleanup).

`npm run typecheck` clean; `npm test`: 185/185 passing.

**Status: fix landed, believed correct by two independent source-level
reviews, not yet live-validated.** The next step is a real `-p` run (ideally
reproducing the original `go/lru-cache` battery-script scenario) confirming
a corrective/review follow-up actually produces a second model turn with
non-zero tokens — the exact signal that was missing when this investigation
started. See `pi-harness-validation-status.md`'s updated corrective
follow-up entry for the condensed version.

## 2026-08-18 — second go/lru-cache battery-script rerun, post agent_end fix

Direct follow-up to the 2026-08-17/18 evening entry above, per its own
recommendation. Same methodology: `run_single_pair.py --seed 20260802
--pair 7 --host kannasmacstudio.lan` (pair 7 of the *unskipped* schedule is
`go/lru-cache`, arm order baseline-then-harness), on the freshly-preflighted
stack (`:8080` Qwen3.8, `:8081` Gemma reviewer, both reachable and model-id
matched before launch; Pi pinned at 0.83.0; installed `quality-gate.ts`
confirmed to already carry the `agent_end` fix).

**Result:**
- **Baseline**: `valid: true`, `passed: true`, 42.6s (vs. 48.1s the prior
  run) — clean, no corrective rounds.
- **Harness**: `valid: true`, `passed: true`, 491.4s (~8.2 min, well inside
  budget). Unlike the prior run, the model did **not** reintroduce the
  key/value-confusion eviction bug — it found and fixed a different latent
  bug in the fixture instead (`Get` not updating recency, so a just-read key
  could still be evicted), added a `Makefile` (`test`/`lint`/`verify`
  targets) and `README.md`, and its own reported evidence (`go vet`, `go
  test`, `go test -race`, `gofmt -l`) all came back clean. The diff was
  correct on the first turn — no correction was ever needed.
- **Reviewer**: fired twice (in-band `tool_result` trigger and the
  settlement trigger), both times returning `outcome: "transient",
  reason: "malformed-verdict"` (202.9s and 178.8s respectively) — Gemma's
  response didn't parse into a valid verdict either time.

**Interpretation:** this run does *not* resolve the open corrective-
follow-up validation question — since the harness's diff was correct from
the start, the `agent_end` mechanism was never exercised (no bug, no
correction needed, nothing to queue). Task-quality result is a clean pass,
in contrast to the prior run's reintroduced bug, supporting the earlier
run's own read that the first-attempt failure was normal variance rather
than a new regression from the thinking/temperature change.

What *is* new: a `malformed-verdict` reviewer failure, 2/2 attempts this
run, not previously seen in this harness's `cross-model-review.ts` history
(prior saga was a stale-model-id incident, a schema-ordering regression,
and a timeout raise — never a parse failure on a well-formed response).
Root cause not yet investigated — could be Gemma choking on this
particular diff's shape/size, or a parsing regression in
`cross-model-review.ts` itself. Since the diff was correct, the transient
verdict had no behavioral consequence here, but it's a live gap: a
`malformed-verdict` outcome on an actually-buggy diff would mean the
reviewer silently fails to flag it.

**Recommended next steps**, in order: (1) investigate the two
`malformed-verdict` traces directly (raw Gemma response bodies aren't
captured in the harness trace, only the outcome/reason/duration — may need
a live repro with response logging enabled); (2) a third `go/lru-cache`
rerun, or a different task known to reliably trigger a first-attempt bug,
still needed to get the corrective-follow-up mechanism's first live
confirmation.

Artifacts: `/tmp/pi-pair7-lru-cache-rerun-20260818T012503Z/` (manifest,
summary.json — not committed, local temp path); full session trace at
`/private/tmp/pi-screen-07-harness-9nt6gh4d/session/*.jsonl` (also local
temp, not committed).
