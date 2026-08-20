# Zero-human full-stack pipeline — pilot plan

**Date:** 2026-08-20. **Status: plan only — nothing below is built yet.**
**Framing:** last attempt before moving on. The goal is not more harness
hardening; it is one real Go+Flutter app built end-to-end from a spec with
no human in the loop, using the existing `pi` harness for the grind and a
cloud model for the judgment steps. Speed is explicitly not a constraint
(user's call, 2026-08-20); reliability of "does what the spec says" is the
only optimization target.

## Why this shape (evidence, not opinion)

Everything here follows from what's already measured in
`pi-harness-validation-status.md`:

1. **The mid-layer is done.** Diff-hash-bound verification
   (`quality-gate.ts`), independent review at 15/15 planted-bug catches
   (`cross-model-review.ts`), wall-clock stall abort, bounded orchestration
   with `BUILD_REPORT.md` (`build_app.py`). No further extension work is in
   scope for this plan.
2. **The proven envelope is one-feature-sized runs.** All green evidence is
   ≤75-minute fixtures (`go-flutter/bookmarks-app`: 328-line diff, clean in
   18 min). A whole app is 30–100 such units. One monolithic spec through
   `--continue` rounds on a 96K context is outside anything ever validated.
   → decompose into tickets, fresh session per ticket.
3. **The only signal the local model reliably bends to is a failing
   verification command.** Fourth lru-cache rerun: reviewer flagged the bug
   twice, model shipped it anyway, the *hidden test* caught it. → the spec
   must be compiled into failing acceptance tests before the build starts;
   "make the suite green" is the task shape Qwen is 4/4 on post-tuning.
4. **Unit tests don't defend the Go↔Flutter seam or the running app.**
   AGENTS.md gotcha #4 (wire-format mismatch invisible to round-trip
   decode) and the todo-app's silently-forced in-memory DB both passed all
   static checks. → contract file + black-box HTTP tests + a boot-the-app
   verification tier.
5. **Cloud for framing only; the implementation loop is pure local.**
   Judgment work (spec, decomposition, acceptance-test generation,
   milestone review) is a handful of cloud one-shot calls; implementation
   is thousands of local rounds with **no cloud escalation of any kind**
   (decision 2026-08-20, see Phase 3). The pilot's claim must stay exact:
   *given a cloud-compiled spec, the local harness implemented the entire
   app unassisted* — or halted at a precisely identified ticket. A
   Sonnet-rescued success would be ambiguous evidence for the
   keep-or-abandon decision this pilot exists to inform.

## Deliverables (all new; nothing existing is modified)

```
agent-configs/pi/scripts/
  ticket_runner.py          # NEW: outer loop — one build_app.py run per ticket
pilot workspace (new repo):  ~/code/test-bed/<app>/
  spec/spec.md              # human-written product spec (the ONE human input)
  spec/contract.md          # API contract: endpoints, JSON shapes, status codes
  spec/tickets/NNN-*.md     # ordered tracer-bullet tickets w/ dependency edges
  acceptance/               # failing-first acceptance tests, wired into make verify
  ARCHITECTURE.md           # agent-maintained, updated every ticket
  PROGRESS.md               # agent-maintained ticket ledger
  Makefile                  # verify (fast) + verify-full (boot app, e2e)
```

## Phases

### Phase 0 — Pilot app choice + spec (**resolved 2026-08-20**)

- App: **rebuild `~/code/personal-budget-simplifier` from scratch** in
  `~/code/test-bed/budget-pilot/workspace/`. Chosen because the existing
  repo — built through this same harness *with* human supervision — serves
  as a held-out reference implementation for judging, and its known bug
  history (CSV sign convention, restart persistence, keyword shadowing,
  wire-format casing) becomes the acceptance-test scenarios. The local
  model never sees the existing repo.
- Spec written by cloud at contractor-level detail, user-approved scope:
  `~/code/test-bed/budget-pilot/spec/spec.md` (frozen 2026-08-20). Core:
  onboarding, CSV import + auto-categorization, budgets with 3-cap/402
  upgrade prompt, monthly dashboard, category correction. Trends, export,
  metrics, non-web targets: non-goals.
- Grill-pass principle retained for future apps: every ambiguity becomes either
  a spec sentence or an explicit non-goal. Output: frozen spec.

### Phase 1 — Compile the spec (cloud, one-shot each; ~1 hour)

1. **Contract:** `spec/contract.md` — every endpoint, exact JSON field
   names/casing, status codes, error shape. Single source of truth for
   both sides.
2. **Acceptance tests, failing-first, committed before any app code:**
   - Go: black-box `httptest` suite hitting the real router; at least one
     raw-bytes JSON assertion per endpoint (gotcha #4); one
     persistence-across-restart test (todo-app in-memory regression).
   - Flutter: widget tests per screen keyed to spec scenarios; rendered-
     text assertions where strings mix literals and interpolation
     (gotcha #5).
   - `make verify` = fmt + vet/analyze + unit + acceptance (fast, runs
     every corrective round). `make verify-full` = verify + boot Go server
     + `flutter test integration_test -d web-server` + curl smoke of every
     endpoint + restart-persistence check (slow, runs once per ticket at
     settlement).
3. **Tickets:** decompose spec into `spec/tickets/NNN-<slug>.md`, ordered,
   tracer-bullet style (walking skeleton first: schema → domain → one
   endpoint → one screen wired end-to-end → then breadth). Each ticket:
   goal, files in scope, which acceptance tests it must turn green, its
   own "Required changes" list in `build_app.py`-spec format. Target 8–15
   tickets, each inside the proven ≤1-feature envelope.

### Phase 2 — `ticket_runner.py` (cloud writes it; ~200 lines, deterministic)

Thin outer loop, no new harness machinery:

- For each ticket in order: fresh `build_app.py` invocation
  (`--workspace <app> --spec spec/tickets/NNN.md --max-rounds 6
  --timeout-minutes 60`). Fresh session per ticket — never one long
  `--continue`; on-disk state, not context, carries memory.
- Per-ticket prompt suffix (in the ticket file template): read
  `ARCHITECTURE.md` + `PROGRESS.md` + `spec/contract.md` first; update
  both state files before finishing; run `make verify-full` once and paste
  its output.
- Gate between tickets: `make verify` green + ticket's named acceptance
  tests green + `BUILD_REPORT.md` says SUCCEEDED + state files touched.
  On failure: stop the line (no skipping ahead past a red ticket), record
  the halt in `PROGRESS.md`, exit non-zero (Phase 3).
- Ledger: append per-ticket outcome (rounds used, review verdicts,
  wall-clock) to `PROGRESS.md` — the pilot's evidence trail.

### Phase 3 — Halt policy: no cloud escalation (**decision 2026-08-20**)

- **`--sonnet-fallback` is not used and `ticket_runner.py` has no
  escalation path at all.** A ticket that exhausts its `--max-rounds`
  budget halts the whole line: the runner records the verdict (ticket id,
  rounds spent, failing checks, reviewer findings) in `PROGRESS.md` and
  exits non-zero. That exit *is* the pilot's measurement — recorded before
  any cloud token touches implementation. Rationale: a Sonnet-rescued
  success can't distinguish "the pipeline works" from "the cloud model
  bailed it out," which makes it useless for the keep-or-abandon decision;
  and the fallback path itself has never been live-spent, so wiring it
  into the decisive run adds an unexercised failure surface.
- **Rescue exists only as a separate, explicit, post-verdict step.** Per-
  ticket structure makes a halt cheap: tickets 1..N-1 stay committed and
  green. If the finished app is still wanted after the verdict is
  recorded, a human-invoked resume (fix the halted ticket in a normal
  cloud session, then rerun the runner from that ticket) continues the
  build — the measurement and the deliverable never compete.
- Milestone review stays (it's judgment, not rescue): after the
  walking-skeleton ticket and again at the end, one cloud review pass over
  the full diff, **report-only** — findings become at most one remediation
  ticket appended to the queue, and that ticket is still implemented
  locally under the same rules.

### Phase 4 — Run the pilot, judge it (mostly unattended)

- Expected wall-clock: 8–15 tickets × 20–60 min ≈ a day of local grinding.
  Fine per user.
- **Success:** app boots, `make verify-full` green, every spec scenario has
  a passing acceptance test, **zero cloud tokens spent on implementation**.
- **Honest failure:** a Phase 3 halt, plus `PROGRESS.md` + per-ticket
  `BUILD_REPORT.md`s showing exactly which ticket shape the local model
  can't do — a real answer, not another maybe. (An optional post-verdict
  rescue can still finish the app afterward; it doesn't change the
  recorded verdict.)

## Explicitly out of scope

- New pi extensions, pi-subagents, containment work, overhead optimization,
  re-benchmarking anything already settled (incl. RTK).
- Multi-app generalization before one pilot succeeds.

## Decisions log (all resolved 2026-08-20)

1. Pilot app: **rebuild `personal-budget-simplifier` from scratch**;
   existing repo held out as reference + acceptance-scenario source.
2. Spec: **cloud-written, user-approved scope**; frozen at
   `~/code/test-bed/budget-pilot/spec/spec.md`.
3. Cloud escalation: **none during the run** (`--sonnet-fallback` skipped;
   runner has no escalation path). Halt-and-report on any exhausted
   ticket; rescue only as an explicit post-verdict step.
