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
| **M6** | Proven at scale and worth it | One night of 20–30 backlog tickets (mixed repos, incl. at least one cross-cutting ticket near 150 lines). Reference implementation only for tickets with judgement calls (D5); Codex conformity review stays required (D4) | **≥80% accepted with no human code edits, 0 memory aborts, and Claude planning time per ticket clearly below the time to write the ticket's code**; record per ticket: plan minutes, reference yes/no, build rounds, review findings |

## Status (updated 2026-10-05)

| # | State | Notes |
|---|---|---|
| M1 | **done** (NVMe moves complete) | 12G session bank is the `serve_mtplx.sh` default, override removed (ai-stack `169c40d`). `memory_preflight.py` + `services.sh` + `overnight_run.sh` + `memory_sampler.py`/`summarize_memory.py` (ai-stack `d7d7bf4`, `e154eef`): refuses runs that don't fit, stops unneeded services, dumps memory for post-run review. **Overnight regression run: 0 memory aborts / 30, 29/30 passed** ([results](../pi/evals/battery-results/2026-10-04-m1-regression/README.md)). Margin: available dips to ~7 GiB at Qwen's in-task peak (56 GiB) — fine for Qwen alone, no room for gemma + Colima overnight. **2 TB NVMe attached and in use (2026-10-04 22:20):** Samsung 990 PRO, APFS volume `Narsimha-x-ssd`, Thunderbolt 80 Gb/s, benchmarked ~6.1 GB/s read / 6.7 GB/s write uncached (internal: 5.1 / 6.5). Moved: mtplx session bank (96 GB, `--ssd-session-cache-dir` in `serve_mtplx.sh`, waits up to 60 s for the mount then falls back to the internal default), six cold/rollback models as symlinks in `ai-stack/models/` (~211 GB), Go caches (`go env -w GOCACHE/GOMODCACHE` → `~/.cache/go-active/{build,mod}` symlinks that `ssd_watchdog.sh` flips between `/Volumes/Narsimha-x-ssd/go/` and the internal caches, so Go builds fall back to internal while the drive is away), Colima data disk (`~/.colima/_lima/_disks` → symlink to `/Volumes/Narsimha-x-ssd/colima/_disks`; byte-compared before swap). `memory_preflight.py` refuses a run if the volume is not mounted (`EXTERNAL_SSD_MOUNT` overrides). `ssd_watchdog.sh` (launchd `com.aistack.ssd-watchdog`, every 30 s) cleanly stops Colima after 2 consecutive missing-mount checks and never auto-restarts it; Colima and the cold models deliberately have no internal fallback. Do **not** rename the volume. Internal originals (`~/.mtplx/session-bank`, `~/.colima/_lima/_disks.internal-backup`, Go caches) kept until the user approves deleting them. Moving Colima while an overnight run was live caused a stale copy once — stop Colima with nothing running before touching it |
| M2 | **done (by evidence)** | Not run as a separate phase. Stock pi (no extensions) passed **29/30** on the M1 overnight regression run with 0 memory aborts, and buildgate already runs pi in its sandbox without any ai-stack extensions (M4a accepted on it). Lean pi = stock pi + factoryd `extra_json` sampling/thinking settings; no extension is re-added unless the regression suite shows it earns its place |
| M3 | **done** (skill; validated by M5) | Skill `buildgate-bundle` (`claude/skills/buildgate-bundle/`: `SKILL.md`, `bundle_check.py`, `check-frozen.sh`). Decisions: **(D-M3a) stage gates** -- each ticket's acceptance tests are committed up front but dormant (`//go:build bundle_tNNN` / `raise unittest.SkipTest("bundle: ...")`); ticket NNN's step 1 deletes that line, so every ticket's full verify passes on its predecessors (resolves the §1 contradiction without changing buildgate). **(D-M3b) frozen tests** -- buildgate does not freeze test files (editing one even satisfies `tests_added`), so `.bundle/check-frozen.sh` (sha256 of each test minus gate/blank lines) is prepended to the verify command. **(D-M3c) one git worktree per feature** (`~/buildgate/ws/<repo>-<feature>`) as the buildgate workspace: ticket 1 builds from the workspace HEAD, so it must stay on the bundle commit all night, and the user's checkouts stay untouched. **(D-M3d)** `bundle_check.py check` = spec skeleton, `factoryd check-ticket`, Verify-Command identity, criterion -> ticket -> test coverage map, gate lines, verify passes on the bundle commit, each ticket's tests fail on the stubs, and a Claude reference chain (one commit per ticket, never submitted) passes verify per ticket, stays inside Allowed-Files, <=150 lines, and adds every `Required-Content` literal. The last check caught two real bundle bugs before submit (a `Required-Content` literal already present in the stub would have quarantined a correct build) |
| M4a | **done** | `PATCH /transactions/{id}` (personal-budget-simplifier) went through buildgate end to end: spec + ticket handed over with `-spec-file/-plan-dir`, build on local Qwen via pi, all gates on, **accepted** after one automatic corrective round (Codex conformity review caught a real spec/test gap: trailing data after valid JSON). 0 memory aborts; Colima peaked 5.8/8 GiB, factoryd 0.05/2. Planning + review on gpt-5.6-luna (Codex) by user decision. Not pushed. [Findings](m4a-buildgate-smoke-2026-10-04/README.md) |
| M5 | **done** | 3 real features, 8 tickets, bundled with the M3 skill and built overnight by buildgate on local Qwen (worker under `overnight_run.sh`, `-open-pull-request=false`, `max_parallel_jobs: 1`): **8/8 tickets accepted with no human code edits** (6 first round, 2 after buildgate's automatic conformity round), re-plans **1 / 0 / 0** (merchant-rules / note-tags / habit-status-counts), **0 memory aborts** (128/128 Qwen requests completed; lowest available 19.2 GiB). 98 min wall for 12 build rounds (~8 min/round). Claude verified every accepted ticket (`bundle_check.py verify-run`: diff in Allowed-Files, tests unchanged except the gate line, verify + `-race` in a clean checkout) and probed both HTTP features live. All three conformity failures were gaps in Claude's tickets (prescribed SQL contradicting the spec; top-level `null` body; out-of-range integer id), caught by Codex review, not the tests; step 3 fixed the skill, buildgate needed no change. Not pushed, no PRs. [Results](m5-overnight-2026-10-05/README.md) |

### Findings so far (feed M3/M4)

- **M5: the planning ceiling is real.** Every quarantine in M5 traced to Claude's ticket, not to Qwen: prescribed implementation steps that contradict the spec, and malformed-input variants missing from the tests (top-level `null`, out-of-range ids). Codex's conformity review is the safety net that caught all three; keep `-conformity-policy required`. The skill's checklist now carries these.
- **Re-planning within buildgate goes to its planning role (Codex)**; Claude re-plans by `cancel` → amend bundle → `bundle_check.py check` → `submit` (about 5 min).
- **Hand-over requests still need `approve` at spec_review/plan_review** and queue for a job slot; overnight use `m5-overnight-2026-10-05/run/auto_approve.sh` (approves only the listed request ids).
- personal-assistant `origin/main` has a pre-existing data race in `internal/service` tests (agentic_search/group); `-race` on that package fails before any change.

- **buildgate cannot reach Claude on a subscription**: credential modes are `static` (API key, billed), `github-copilot`, `chatgpt-codex`. "Planning → Claude" needs an Anthropic API key route (marked not live-tested) or Claude doing planning outside buildgate (which `-spec-file/-plan-dir` already makes the normal path: planning is only called when a review is rejected).
- **§1 contradiction**: the plan says each ticket's `Verify-Command` runs only the tests that ticket turns green; buildgate requires every ticket's `Verify-Command` to equal the request's verify command and runs it per ticket. Pre-committed acceptance tests for ticket N therefore fail tickets 1..N-1. Options for M3: commit each ticket's acceptance tests in that ticket's own stub commit chain (not all up front), or add per-ticket test selection to buildgate.
- **Sandboxed pi has no provider shim**: buildgate's pi runs without `ai-stack-local.ts`, so Qwen's sampling preset / `thinkingFormat: qwen` / `supportsDeveloperRole: false` must be set in the factoryd model's `extra_json` (done in `~/.config/factoryd/config.yml`).
- The relay cannot use `127.0.0.1:8080` (it runs in a container) or hostnames for plaintext upstreams; use colima's host IP `192.168.5.2`.
- The installed `factoryd` predated `-spec-file/-plan-dir` (built Oct 3); rebuild with `make install` after pulling.
- Colima was 4 GiB (plan: ≥6–8); `services.sh start colima` resizes to `COLIMA_MEMORY_GB` (8). Starting colima brings back `hermes-agent` (calls Qwen on a schedule), `openwebui`, `searxng` (`restart: unless-stopped`); `services.sh` stops them.

### Assessment after M5 (2026-10-05)

**Solid as an executor of fully specified tickets; not yet proven to save
effort at scale.**

| Established by M5 | Not established |
|---|---|
| Qwen executes well-specified tickets reliably: 8/8 accepted, every failure traced to Claude's tickets | Scale: 8 tickets vs the 30–50/night target |
| Unattended machinery works: sandbox, gates, corrective rounds, ticket chaining, frozen tests, memory (0 aborts) | Large or cross-cutting tickets (M5: 1–3 files, 1–137 lines each) |
| Code was mergeable and followed repo conventions (2 of 3 features merged) | Vaguer tickets; Flutter/frontend work |
| | Net effort: bundling took Claude ~2 h for 98 min of build, partly because Claude wrote a reference implementation of every ticket |

Caveats that shape what comes next:

1. **Tickets were near pseudo-code** (stubs, named helpers, exact error
   strings, pre-written tests). That is why execution was reliable, and also
   why M5 says little about Qwen on looser tickets.
2. **The tests were not the safety net; Codex review was.** It caught all
   three spec gaps the tests missed. The pre-PR review caught a fourth bug
   (concurrent duplicate → 500). "Local model" in practice means local
   execution plus cloud review.
3. **The reference-implementation step doubles Claude's work.** It is the
   only proof that the tests are fair, so it must become selective (D5), not
   be dropped.

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
- **D4 — Codex conformity review stays `required`** (2026-10-05, from M5):
  it caught every spec gap the acceptance tests missed. Never run
  unattended with `-conformity-policy advisory`.
- **D5 — reference implementations are selective** (2026-10-05, for M6):
  write one only for tickets with judgement calls (validation order, error
  precedence, concurrency, time zones, normalisation); pure wiring and
  mechanical tickets go out with stubs + tests + the fail-on-stub check only.
  M6 measures whether acceptance holds without them.

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
  planning quality is the ceiling. M5 confirmed it: every quarantine was a
  Claude ticket gap, caught only by Codex review.
- **Dependence on Codex review**: the Codex budget is shared and often
  exhausted. Before M6, confirm what buildgate does when the review is
  unavailable under `required` (#471 added a "review unavailable" state);
  an overnight batch must halt, not accept unreviewed work.
- **Planning cost can exceed the savings**: if Claude's minutes per ticket
  approach the time to write the code, the pipeline does not pay. M6
  measures it.
- 30–50 tickets/night assumes ~10–15 min tickets; larger tickets must be
  split (M3).
- Memory rules must hold as other services evolve; the M1 budget check is
  the guard.
