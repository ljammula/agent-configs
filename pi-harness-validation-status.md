# pi harness — consolidated validation status

**Current as of 2026-08-04.** This file states only what's true right now,
extension by extension. The full dated investigation — what was tried, what
broke, what got fixed, live-run counts, superseded results — lives in
`pi-harness-history.md`; nothing here is understandable-only-with-history,
but that file is where the "why" and "how do we know" detail is if you want
it.

## Current configuration

Pi 0.83.0 has one resident inference route: `ThinkingCap-Qwen3.6-27B-MLX-8bit`
on `:8080` (host `kannasmacstudio.lan`). `cross-model-review.ts` disables
itself unless a distinct `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` are set;
same-primary review requires `AI_REVIEW_ALLOW_SELF=1` and is labeled
`blind-self-review`, never cross-model. The maintained Pi project typechecks
against pinned 0.83.0 public types and has 64 deterministic tests covering
loading, event ordering, retry caps, current-diff verification, shell-masked
exits, reviewer truthfulness, symlink escapes, external-effect policy,
installer scope, stack routing, extension interactions, nested verification
manifests, and stale-extension-context handling.

Three acceptance boundaries remain intentionally not adopted:

- No distinct resident reviewer is configured, so automatic review is
  disabled rather than mislabeled or promoted from historical Gemma
  evidence.
- Docker is unavailable on this Mac. The containment Dockerfile and
  launcher pass static shell/install checks, but the live escape matrix is
  not proven.
- `continuation-nudge.ts` and `co-change-suggest.ts` remain source-tested
  but are removed from the installed runtime until randomized paired
  evidence meets the current adoption threshold.

## Current battery result

A completed nine-pair randomized screen (seed `20260802`, stock Pi vs. the
installed harness, strictly sequential, hidden tests overlaid after Pi
exited) is the current operational-hardening evidence:

- Hidden-test success: baseline 7/9, harness 8/9. Harness matched or beat
  baseline; its one loss (pair 4, go-flutter/bookmarks-app) was a shared
  failure baseline also hit — a `go test -race` data race in a
  visit-counter HTTP handler, a genuine 27B-model concurrency-reasoning
  gap, not a harness defect (detail in `pi-harness-history.md`'s pair-4
  deep-dive).
- Zero extension errors and zero `quality-gate: unconfigured` outcomes
  across all eighteen runs.
- Median paired runtime overhead: 100.3% (prompt tokens +212.6%, completion
  tokens +39.8%), above the plan's 20% screening threshold. This is the
  honestly-measured cost of quality-gate actually running its
  nested-manifest verification and corrective-follow-up loop on every
  pair, not a bug-distorted number.

Full record: `pi/evals/full-screening-2026-08-03.json`. Runner:
`pi/evals/run_screening.py`.

## Extension-by-extension current status

| Extension | Status | Evidence |
|---|---|---|
| `protected-paths.ts` | Adopted, on by default | Tool guard on Pi `write`/`edit`, not `bash`, symlink escapes, or OS-level confinement. Deterministic tests + 1 live catch (corrected an absolute-path escape). |
| `format-on-edit.ts` | Adopted, on by default | Deterministic gofmt/dart-format/prettier-if-present pass, not a judgment call. |
| `rtk-rewrite.ts` | Adopted, on by default | Deterministic bash-output filter. |
| `git-checkpoint.ts` | Adopted, on by default | Deterministic per-turn snapshotting. |
| `git-safety.ts` | Adopted | Blocks destructive git commands (`reset --hard`, `push --force` w/o lease, `clean -f`, `branch -D`, `checkout/restore -- .`). 1 scratch-repo reproduction plus deterministic tests. |
| `quality-gate.ts` | Adopted, on by default | Binds passing evidence to the current diff hash, rejects truncated/shell-masked results, runs the repo's canonical check (including nested manifests) at settlement, caps corrective follow-ups at three. Proven in the completed nine-pair battery above. |
| `stack-router.ts` | Adopted, on by default | Routes Go, Python, Flutter, TypeScript/JavaScript, PostgreSQL, Kafka, Temporal, and GCP guidance from repository evidence. Deterministic tests for all routes; only Go/Dart routes have battery coverage (see battery result above), the rest are wired and unit-tested but not battery-proven. |
| `co-change-suggest.ts` | Default-disabled, source-tested | One real retrospective replay (ranked target file #1 of 8) does not meet the paired-adoption threshold. Live (non-retrospective) validation not run. |
| `continuation-nudge.ts` | Default-disabled, source-tested | Deterministic branch tests pass; the widened empty-content-stop trigger has zero real-trial field evidence. |
| `cross-model-review.ts` | Disabled unless explicitly and truthfully configured | Linked so it can report its resolved identity. No distinct reviewer route is currently resident, so it is never mislabeled as independent review. |
| Phase 4 (Aider-based failing-test retry) | Deliberately not built | Gated on Aider dispatch being in scope; it isn't (`~/.claude/CLAUDE.md`, benchmarked and removed). |

## Todo

- Restore genuine reviewer diversity or rename/disable the current
  reviewer, then rerun the seeded battery on the exact deployed route. Do
  not transfer the historical Gemma verdict to the same-Qwen configuration.
- Run TypeScript/JavaScript task fixtures through the battery — currently
  routed and unit-tested only, same status as Python/Postgres/Kafka/Temporal/GCP.
- Bind verification to the final tree/diff across all judgment-dependent
  extensions consistently — quality-gate does this; confirm the others do
  too.
- Move DayTrix-only skills out of the global Pi skill directory and into
  that project, leaving generic backend/full-stack guidance global.
- Use an OS/container boundary for unattended execution once Docker is
  available on this host — the protected-path guard is defense in depth,
  not filesystem confinement.
- `co-change-suggest.ts`'s live (non-retrospective) validation — "try it
  live on one new personal-assistant feature task" — has not been run.
- `continuation-nudge.ts`'s widened trigger has zero field validation.
  Needs real trials before its empty-content-stop path can be said to
  work, not just to type-check.
- Reduce quality-gate's runtime/token overhead below the plan's 20%
  threshold, or revise the threshold with evidence for why the current
  cost is acceptable.

Full investigation history — dated narrative, superseded partial results,
live-run-by-live-run detail — is in `pi-harness-history.md`.
