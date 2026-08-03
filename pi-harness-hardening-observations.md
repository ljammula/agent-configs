# Pi harness hardening observations

Date: 2026-08-03

This is the implementation record for
`plans/pi-harness-hardening-plan.md`. The real validation task was saved first
as `~/code/test-bed/app-x/VALIDATION-TASK.md`, then run with the installed Pi
0.83.0 harness against the resident ThinkingCap Qwen3.6-27B model.
The hardened runtime and deterministic suite are pinned by commit `151c122`.

## Outcome

Pi produced a coherent full-stack personal command center at app commit
`dc0769e`: editable browser voice capture, text logging, PostgreSQL JSONB
metadata, default and custom categories, timeline, holistic non-medical
feedback, migrations, seed data, and local documentation. After direct audit,
`make verify` passes TypeScript checks, 35 tests in five files, and a production
Vite build. Repeated migration/seed setup remains at four default categories
and five seed entries. Tests reset a separate `appx_test` schema and leave
`appx_dev` untouched. HTTP smoke checks passed for the frontend shell,
categories API, and daily summary API.

## Partial randomized screening battery (2026-08-02)

A planned nine-pair screen compared stock Pi (only the provider shim required
to reach the local model) with the installed harness. Task order and within-pair
arm order were randomized from seed `20260802`, runs were strictly sequential,
and hidden tests were overlaid only after Pi exited. Security controls were out
of scope. The run was stopped on request after four complete pairs; the fifth
pair was interrupted before producing a record and is excluded.

| Task | Baseline | Harness | Harness runtime overhead |
|---|---:|---:|---:|
| Go+Dart notes app | pass | fail | 47% |
| Go notes API | pass | pass | 43% |
| Dart task manager | pass | hidden tests pass; extension lifecycle error | 1,744% |
| Go+Dart bookmarks app | pass | pass | 69% |

Across the four completed pairs, baseline hidden-test success was 4/4 and
harness hidden-test success was 3/4. Clean operational success was 4/4 versus
2/4 after treating the task-manager extension exceptions as a harness failure.
There were three task-quality ties, one baseline win, and no harness win. The
median paired runtime overhead was 58.3%; harness prompt-token usage was 147%
higher and completion-token usage was 11.7% higher.

The screen exposed two concrete reliability gaps:

1. `quality-gate.ts` reported `unconfigured` on both nested Go+Dart fixtures.
   On the notes fixture, Pi stopped after one large tool call and missed the
   required `ArgumentError` behavior for two unknown-ID operations; hidden
   tests caught both failures.
2. On the Dart task-manager fixture, the generated implementation passed all
   hidden tests, but `stack-router.ts` and `quality-gate.ts` both raised Pi's
   stale-context error after session replacement or reload. This is a harness
   lifecycle failure, not an inference-service failure or a reason to retry the
   result away.

This partial result does not support an operational-hardening claim. It is not
the planned final verdict because five randomized pairs remain unrun. The
aggregate evidence is recorded in
`pi/evals/partial-screening-2026-08-02.json`; the reusable runner is
`pi/evals/run_screening.py`.

## Fixes for the two reliability gaps, and the completed nine-pair screen (2026-08-03)

Both gaps above were fixed directly:

1. `resolveVerificationCommand()` in `pi/extensions/lib/verification.ts` now
   falls back to a bounded breadth-first scan for nested `Makefile`/`go.mod`/
   `pyproject.toml`/`pubspec.yaml`/`Cargo.toml`/`package.json` directories
   when the repository root has none, building a combined
   `(cd 'dir' && cmd ) && (cd 'dir2' && cmd2 )` command instead of returning
   `unconfigured`.
2. `stack-router.ts`'s `before_agent_start` handler and `quality-gate.ts`'s
   `tool_result`/`agent_settled` handlers now catch Pi's documented
   stale-extension-context error (`isStaleContextError()` in
   `pi/extensions/lib/stale-context.ts`) and skip gracefully instead of
   crashing the turn. Pi throws this error when a captured `pi`/`ctx` is used
   after session replacement or reload -- confirmed via Pi's own
   `session_before_compact`/`session_compact` lifecycle events as the
   likely trigger (auto-compaction on a long run).

Both fixes have new deterministic tests (`pi/tests/verification.test.ts`,
`pi/tests/stack-router.test.ts`, `pi/tests/quality-gate.test.ts`); the full
suite is 64/64 passing and typecheck is clean.

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

Hidden-test success was baseline 7/9, harness 8/9 -- the harness matched or
beat baseline, with its one loss (pair 4) a shared failure baseline also hit.
There were zero extension errors and zero `quality-gate: unconfigured`
outcomes across all eighteen runs; neither of the two defects above recurred.
Median paired runtime overhead was 100.3% (prompt tokens +212.6%, completion
tokens +39.8%) -- both worse than the partial screen's numbers and well above
the plan's 20% threshold, because the fixed quality-gate now actually runs its
nested-manifest verification and corrective-follow-up loop on every pair
instead of silently no-opping or crashing partway through. That earlier,
lower overhead number was an artifact of the safety net not doing its job.

Verdict: the two reliability defects are fixed and did not reproduce over a
full battery. Task correctness is at or above baseline. Overhead remains
substantially above the plan's adoption threshold and is not resolved by this
pass -- it is now an honestly-measured cost of the harness actually running
its verification, not a bug-distorted number. Full record:
`pi/evals/full-screening-2026-08-03.json`.

## What the run taught us

1. **Loading support modules as extensions is unsafe.** The first launch failed
   because top-level symlinks changed relative import resolution. Shared code
   now lives under the installed `extensions/lib/` directory, whose lack of an
   `index.ts` keeps it from being treated as an entry point. A load test covers
   every installed extension against the pinned public API.
2. **The settlement event matters.** An early quality-gate version listened to
   the wrong lifecycle boundary. In the live run, queued follow-ups continued
   after a later green check and the nominal three-attempt cap reached attempts
   four and five. The gate now runs on `agent_settled`, refuses work once the
   cap is reached, and has an explicit five-settlement regression test.
3. **Exit code alone is insufficient evidence.** The trace contained
   `npm test; echo EXIT=$?`, which can return zero even when the test fails.
   Verification evidence now rejects unquoted pipelines without pipefail,
   sequencing with later commands, `||`, negation, and background execution.
   The gate reruns the canonical repository command directly when evidence is
   missing, stale, truncated, or maskable.
4. **A green generated suite is not a product audit.** Pi's initial 33 tests
   missed a voice-source attribution bug, zero-count categories being described
   as tracked, a backend entry point that never started, migration/seed files
   that did nothing when invoked, test writes leaking into the development
   database, and a UTC/local-day boundary error. Direct audit added regression
   coverage and raised the suite to 35 tests.
5. **Generated claims must match configuration.** Pi said frontend tests ran,
   but the original Vitest include pattern excluded them. The root test config
   now includes frontend component tests and the canonical command also builds
   the production client.
6. **Routing can only use evidence present at prompt time.** The greenfield
   directory initially contained only the validation brief, so stack routing
   correctly returned no skills. Once manifests exist, deterministic tests show
   Go, Python, Flutter, PostgreSQL, Kafka, Temporal, and GCP signals route to the
   corresponding portable guidance. This is a known limitation for an empty
   repository, not a reason to inject every stack skill globally.
7. **Truthful disablement is better than false diversity.** The reviewer trace
   recorded `blocked: missing-configuration`. With only the primary Qwen route
   resident, no current evidence supports an independent-review label. A
   same-primary second pass is available only as explicit
   `blind-self-review`; it remains off by default.

## Evidence boundaries

- The main Pi session was manually interrupted after 2h34m because the original
  quality-gate loop was not truly capped. The resulting trace has 122 assistant
  messages, 120 tool calls, 158,408 input tokens, 26,378 output tokens,
  3,216,866 cached-read tokens, and seven stop errors. These are diagnostic
  facts, not a latency or cost win.
- A fresh no-session Pi audit completed after the lifecycle/cap correction,
  without the runaway behavior. The maintained deterministic suite is the
  repeatable proof for the exact cap branches.
- Docker is not installed on this host. `containment/Dockerfile.pi` and
  `run-contained.sh` implement a read-only root, dropped capabilities, no
  network, a writable workspace, and a separate named Pi home, but the planned
  host-read/write and credential escape matrix has not run.
- Browser automation was unavailable in this execution environment. Component
  tests and HTTP smoke checks validate behavior, but there is no screenshot or
  browser-driven visual acceptance record.
- The pinned Pi 0.83.0 test dependency resolves its nested `brace-expansion` to
  5.0.7, which npm reports as one high-severity denial-of-service advisory.
  `npm audit fix`, lock-only update, dedupe, and a compatible 5.0.9 override did
  not replace Pi's nested resolution. The omit-dev audit is zero, but the full
  development audit is not; this remains an upstream/pinning limitation.
- The later randomized screen completed only four of nine planned pairs. It is
  negative interim evidence, not a completed adoption battery or a basis for
  enabling a judgment-dependent default.

Machine-readable aggregates are in `pi/evals/app-x-2026-08-02.json`; the exact
post-fix deterministic baseline is `pi/evals/hardened-baseline-2026-08-03.json`.
