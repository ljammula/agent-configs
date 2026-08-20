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
5. **Zero-human ≠ zero-cloud.** Sonnet 3/3 vs local 0/4 pre-tuning on the
   same task; judgment work (spec, decomposition, review) is a handful of
   one-shot calls; implementation is thousands of local rounds. Spend
   cloud tokens on framing, local tokens on grinding.

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

### Phase 0 — Pilot app choice + human spec (human + cloud, ~30 min)

- App: small but real — 3-screen Flutter web frontend + Go/SQLite backend,
  CRUD plus one non-trivial behavior (so acceptance tests have teeth).
  Candidate: bookmarks/notes/habit tracker; user picks or approves default.
- User writes `spec/spec.md` from `pi/scripts/spec-template.md` (this is
  the "I want to write spec & hand it over" contract). Cloud model runs a
  grill pass (existing `grill` skill shape): every ambiguity becomes either
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
  On failure: stop the line (no skipping ahead past a red ticket), record,
  move to Phase 3 escalation.
- Ledger: append per-ticket outcome (rounds used, review verdicts,
  wall-clock) to `PROGRESS.md` — the pilot's evidence trail.

### Phase 3 — Escalation policy (bounded cloud spend, explicit)

- Ticket fails its round budget → one cloud corrective pass on that ticket
  only (existing `--sonnet-fallback` plumbing / or this session directly),
  then re-gate. Two consecutive cloud-rescued tickets → halt and report:
  that's the "local model can't carry this app" verdict, cheaply reached.
- Milestone review: after the walking-skeleton ticket and again at the
  end, one cloud review pass over the full diff (existing `self-review`
  shape, report-only) — findings become one remediation ticket, not churn.

### Phase 4 — Run the pilot, judge it (mostly unattended)

- Expected wall-clock: 8–15 tickets × 20–60 min ≈ a day of local grinding.
  Fine per user.
- **Success:** app boots, `make verify-full` green, every spec scenario has
  a passing acceptance test, ≤2 cloud-rescued tickets.
- **Honest failure:** the halt condition above, plus `PROGRESS.md` +
  per-ticket `BUILD_REPORT.md`s showing exactly which ticket shapes the
  local model can't do — a real answer, not another maybe.

## Explicitly out of scope

- New pi extensions, pi-subagents, containment work, overhead optimization,
  re-benchmarking anything already settled (incl. RTK).
- Multi-app generalization before one pilot succeeds.

## Open decisions for the user

1. Pilot app (default on offer: bookmarks manager — closest to the already-
   proven `go-flutter/bookmarks-app` fixture shape).
2. Who writes `spec/spec.md`: user (per stated goal) or cloud drafts +
   user approves.
3. Cloud-rescue budget per Phase 3 (default: 1 pass per ticket, halt at 2
   consecutive).
