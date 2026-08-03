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
- This was one full-stack task, not the randomized paired trial battery required
  to adopt judgment-dependent defaults. No new judgment-dependent extension is
  enabled on the strength of this run.

Machine-readable aggregates are in `pi/evals/app-x-2026-08-02.json`; the exact
post-fix deterministic baseline is `pi/evals/hardened-baseline-2026-08-03.json`.
