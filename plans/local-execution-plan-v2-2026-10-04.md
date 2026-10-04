# Local execution plan v2 — Claude plans, the Studio executes

**Date:** 2026-10-04. **Supersedes:**
[`sonnet-parity-deterministic-pipeline-plan-2026-10-03.md`](sonnet-parity-deterministic-pipeline-plan-2026-10-03.md)
(kept for history; its core ideas are folded in below, its heavier machinery
is deferred until real work shows it is needed).

## Goal

Use the Mac Studio (M3 Ultra, 96 GB) as the **arms and legs**: it executes
coding work unattended, slowly if necessary, but **correctly** — at the level
of a 6–12-month-old frontier model on the work it is given. Claude (kept as a
subscription) is the **brain**: it thinks with the user, writes specs and
plans, and breaks work into tickets the local stack can execute. Claude spends
tokens on judgement, never on mechanical execution; local tokens are free and
are spent on attempts and verification.

## Evidence this plan is built on (2026-10-03/04)

| Finding | Source |
|---|---|
| Qwen3.8-27B + pi solves the 7 bench tasks on every run (Sonnet reference 6/7) and passes ~70% of fair real tickets from the user's repos | phase-0 battery, `pi/evals/battery-results/2026-10-04-parity-phase0/` |
| **4 of 12 real tickets failed only because the spec omitted requirements** that lived in the tests | same, follow-ups F2/F3 |
| One ticket (~300-line change across git plumbing) timed out at 30 min in every run | same |
| Many remaining failures are run-to-run variance (same task P/F/T across reps) | same |
| **Hardened harness ties stock pi** on clean, fair runs (24/34 vs 23/33) while adding time, context and memory | `summarize_battery.py` |
| Thinking on was decisive where it mattered (`go/lru-cache` 0/4 → 4/4) | pi-harness-validation-status.md |
| Memory, not the model, caused false failures: prefill aborts when the whole machine (Qwen + Gemma + services + compressed pages) ran out of headroom | battery findings §3–4 |
| mtplx gives byte-identical output for a fixed seed | measured 2026-10-03 |
| Reviewer gemma-4-26b + Qwen verifier: 32/32 planted bugs, 2/32 false positives; voting adds nothing | ai-stack `bench/review_pipeline.py` |
| Flash-Next (125B MoE) does not fit usefully in 96 GB: no cache headroom, ≤32K cold prompts | ai-stack findings doc |

**Conclusion:** the binding constraints are **spec completeness, ticket size,
variance, and memory headroom** — not tokens/second, not model size, not
harness extensions.

## Operating model

```
You + Claude (chat / Claude Code)         Mac Studio (overnight)               You (morning)
───────────────────────────────           ─────────────────────────           ─────────────
spec → plan → ticket bundle      ──►      per ticket: lean pi, thinking on    read report,
  (requirements, ≤150-line                 ├ tests + race + lint + scope gate  review diffs,
   tickets, stubs, acceptance              ├ fail → repair round (test output) merge
   tests, verify command)                  ├ still fail → new seeded attempt
                                           │   (≤3 attempts; first green wins)
                                           ├ gemma review + Qwen verify → report
                                           └ exhausted → escalate bundle ──► Claude fixes the
                                                                              TICKET/TESTS, not code
```

### 1. The ticket bundle (Claude's output — the hand-off contract)

Handed to buildgate with
`factoryd submit -spec-file spec.md -plan-dir tickets/ <workspace>` (buildgate
#466/#467): no drafting or planning model call — the request goes straight to
**your** `spec_review`, then `plan_review`. Rejecting at either review makes
buildgate's *planning role* revise the document from your feedback, so the
planning role must be routed to Claude, not the local model. Per feature:
- `spec.md` — in **buildgate's spec skeleton** (the drafted spec's headings,
  in order, with numbered acceptance criteria), listing every behaviour the tests
  check (status codes, error texts, ordering, idempotency semantics, which
  fields a role may change). *The 4 unfair battery tickets are the checklist
  of what gets forgotten.*
- `tickets/001.spec.md`, `002.spec.md`, … in dependency order, together
  covering every acceptance criterion, in **buildgate's ticket format**
  (`internal/ticketspec`): headers `Verify-Command`, `Allowed-Files`,
  `Required-Changed-Files`, `Required-Content`, `Tests-Required`; body Goal /
  Plan / Out of scope. One package, ≤150 changed lines, files pre-created as
  stubs, naming the tests this ticket must turn green.
- Acceptance tests written **before** implementation and committed in the
  workspace before `submit`; each ticket's `Verify-Command` runs the ones it
  must turn green (frozen, hash recorded).
- Bundle checks run automatically before execution (cheap, local):
  (a) tests fail on the stubs; (b) every requirement maps to ≥1 ticket and
  ≥1 test; (c) stubs build/type-check; (d) *test self-check* — tests pass on
  an independently generated local implementation (separate seed, never sees
  the tests) when one is produced; two independent implementations failing
  the same assertion flags the test, not the code.

### 2. The executor (local, deterministic in its decisions)

- **Lean pi**: provider shim + git-safety + protected-paths + thinking
  settings only; other extensions removed unless they earn their place on
  the regression suite.
- **Acceptance is decided by gates, never by the model's self-report**:
  ticket tests → full suite (`-race` for Go) → frozen-test hash → diff ⊆
  Allowed-Files → lint/analyzer.
- **Repair rounds** are new rounds fed by gate output (not in-session
  follow-ups, which the model can ignore).
- **Attempts**: up to 3 per ticket with recorded seeds (seed = f(ticket,
  attempt)); first attempt passing all gates wins. Free tokens buy variance
  reduction.
- **Review** (gemma-4-26b) + settlement verifier (Qwen) — reported, not
  blocking; confirmed findings feed one repair round.
- **Escalation**: attempts exhausted → bundle of spec, ticket, test output,
  best diff, review findings → Claude, which amends the ticket/tests (an
  explicit, recorded re-plan) and hands it back.
- **Morning report**: per ticket pass/fail/escalated, attempts used, time,
  confirmed review findings, diff links.

**Home: buildgate (`software-factory`, `factoryd`)** for autonomous runs
(D2, confirmed 2026-10-04). Reasons: every build runs in a Docker sandbox
with no network (model via `inference-relay`, packages via
`registry-proxy`) — required for unattended runs on real repos; it already
has model roles (planning → Claude, execution → local Qwen, review),
enforced ticket headers, diff-scope / full-suite / tests-added /
spec-conformity gates, Temporal resume and pinned evidence; and its human
checkpoints (spec, plan, PR review) match "Claude plans, you merge". pi stays
the inner harness (lean). The `pi-harness-hardening` `ticket_runner.py`
path is frozen as the fallback, not developed further.

Known risks to retire early (M4a): September proving-ground runs had 0/7
tickets accepted (agent left the diff uncommitted), oracle drafting failed
100% (timeouts) and spec-conformity was often "unavailable" — all on the
local planning/review roles that v2 moves to Claude or gates.

### 3. The machine (boring and reliable)

| Resource | Rule |
|---|---|
| RAM budget (96 GB, 90 GB wired) | Qwen ~40 GB (12 GB RAM session bank) + gemma ~16 GB + Colima VM ~6–8 GB + Temporal/factoryd ~1–2 GB + OS/apps ~8 GB + prefill headroom (~10 GB). If it does not fit, gemma is loaded only for review windows |
| Qwen session bank | **12 GB permanently** (`MTPLX_SESSION_BANK_MAX_BYTES`, `serve_mtplx.sh` default) — ~3.5 GB per 30K-token session |
| Proxy idle-clear | live-footprint measurement, 54 GB TTL / 60 GB hard ceiling (ai-stack `1bcb71b`) |
| Overnight runs | Colima **on** (buildgate's sandbox and builds run in its VM); Open WebUI/SearXNG containers and Whisper off; size the Colima VM for Go/Flutter builds (≥6–8 GB) and count it in the budget |
| 2 TB NVMe (Thunderbolt) | mtplx SSD session bank, rollback/cold models, Go/Flutter/Docker build caches — disk and wear relief, not RAM |
| Concurrency | 1 stream for quality runs; 2-stream aggregate throughput measured separately later |
| Throughput expectation | ~10–15 min per ticket → ~30–50 tickets per night |

## Milestones

| # | Milestone | Work | Done when |
|---|---|---|---|
| **M1** | Stable machine | 12 GB bank as default; on-demand services; memory budget check before overnight runs; 2 TB drive for caches/cold models | one full night with **zero memory aborts** |
| **M2** | Lean pi | strip extensions to the essentials; keep thinking on | regression suite pass rate ≥ today's, time per task lower |
| **M3** | Hand-off contract | Claude skill/prompt that emits ticket bundles; automatic bundle checks (fail-on-stub, coverage map, stub build) | bundles for the regression suite's tasks have **no spec gaps** |
| **M4a** | buildgate smoke on this Mac | one small real feature through buildgate: planning role → Claude, execution → local Qwen via pi, gates on, Colima sized per budget | completes end to end, tickets committed and accepted, **zero memory aborts** |
| **M4** | Executor loop in buildgate | per-ticket seeded attempts (≤3, first green wins), repair rounds from gate output (build_app rounds), gemma review + Qwen verify as a report, Claude escalation on exhaustion, morning report; overnight queue = requests submitted to the `factoryd worker` (Temporal; `queue-run` was removed in buildgate #447), lost steps park in `resume_review` for the morning | a queued feature runs unattended overnight end to end |
| **M5** | Proven on real work | 3 real features from the user's backlog (personal-assistant, budget app, …): Claude plans, the Studio builds | **≥80% of tickets pass gates and review with no human code edits, ≤1 re-plan per feature**; Claude tokens used recorded |

## Measurement

- **Regression suite** (~10 fair, discriminating tasks, from the phase-0
  battery): `sf-retry-stale-result`, `pa-habits-stable-order`,
  `go-flutter/bookmarks-app`, `sf-ticketspec-fenced-verify`, the 4 corrected
  tickets, plus `go/lru-cache` and `pbs-latency-histogram` as cheap canaries.
  Run after any harness/model/server change; overnight; `summarize_battery.py`
  reports raw and clean (memory-abort-free) pass rates.
- Easy always-pass tasks are dropped; over-large tickets become M3 inputs
  (split them) rather than battery tasks.
- The real exit criterion is M5, not a battery score.

## Decisions

- **D1 — Claude plans, local executes** (unchanged).
- **D2 — buildgate** (`software-factory`) is the home for autonomous runs,
  with lean pi as the inner harness; `ticket_runner` is the frozen fallback.
  (Briefly revised toward `ticket_runner` earlier on 2026-10-04, then
  confirmed back to buildgate by the user for containment.)
- **D3 — overnight batches** (unchanged).

## Deferred (from v1) until M5 shows they are needed

Mutation-score gate; byte-level replay beyond what buildgate already pins;
best-of-N selection by score (v2 uses first-green); context packs beyond Allowed-Files;
the full 20-task × 3 parity battery; harness ablation as a separate phase
(v2 strips to lean pi directly).

## Stop doing

Adding harness extensions; chasing tokens/second or bigger models on 96 GB;
large batteries on tasks that always pass.

## Risks

- A wrong-but-consistent spec passes every automatic check — Claude's
  planning quality is the ceiling; M5 measures it on real work.
- 30–50 tickets/night assumes ~10–15 min tickets; larger tickets must be
  split (M3).
- Memory rules must hold as other services evolve; the M1 budget check is
  the guard.
