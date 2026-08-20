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
control dir (agent never writes here): ~/code/test-bed/budget-pilot/
  spec/spec.md              # frozen product spec (the ONE human-approved input)
  spec/contract.md          # API contract: endpoints, JSON shapes, status codes
  spec/tickets/NNN-*.md     # ordered tracer-bullet tickets w/ dependency edges
  spec/acceptance/NNN/      # canonical acceptance tests, sliced per ticket
  reports/ticket-NNN/       # archived BUILD_REPORT.md + gate log per ticket
  Makefile                  # human entry point: run / status / reports
workspace (the app repo the agent builds): ~/code/test-bed/budget-pilot/workspace/
  acceptance/               # runner-staged copies of activated ticket slices
  ARCHITECTURE.md           # agent-maintained, updated every ticket
  PROGRESS.md               # agent-maintained ticket ledger (projection only)
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
2. **Acceptance tests, failing-first, staged per ticket** (revised
   2026-08-20 per Codex PR review — two P1s):
   - Go: black-box `httptest` suite hitting the real router; at least one
     raw-bytes JSON assertion per endpoint (gotcha #4); one
     persistence-across-restart test (todo-app in-memory regression).
   - Flutter: widget tests per screen keyed to spec scenarios; rendered-
     text assertions where strings mix literals and interpolation
     (gotcha #5).
   - **Staging, not bulk commit:** the full suite is generated up front
     but lives in the control dir, sliced as `spec/acceptance/NNN/` per
     ticket. `ticket_runner.py` copies ticket NNN's slice into
     `workspace/acceptance/` immediately before that ticket's build run.
     Committing the entire failing suite on day one would make ticket
     001's `make verify` unpassable by construction — `build_app.py`
     treats that command as its completion gate, so every early ticket
     would burn its whole round budget against tests for features that
     don't exist yet. `make verify` at any point runs only the slices
     activated so far.
   - **Oracle integrity:** the workspace copies are working copies the
     agent *can* touch (no harness change guards them — `protected-paths.ts`
     covers only `write`/`edit`, not bash, and adding config for this is
     out of scope). Trust comes from the runner instead: after each
     ticket's run settles, the gate byte-compares every staged acceptance
     file (all activated slices, not just this ticket's) against its
     canonical copy in the control dir; any drift — edit, deletion,
     skip-annotation — fails the gate exactly like a red test. A green
     suite only counts as evidence because the suite is provably the one
     the spec compiled to.
   - `make verify` = fmt + vet/analyze + unit + activated acceptance
     slices (fast, runs every corrective round). `make verify-full` =
     verify + boot Go server + `flutter test integration_test -d
     web-server` + curl smoke of every endpoint + restart-persistence
     check (slow, run once per ticket at the gate).
3. **Tickets:** decompose spec into `spec/tickets/NNN-<slug>.md`, ordered,
   tracer-bullet style (walking skeleton first: schema → domain → one
   endpoint → one screen wired end-to-end → then breadth). Each ticket:
   goal, files in scope, which acceptance tests it must turn green, its
   own "Required changes" list in `build_app.py`-spec format. Target 8–15
   tickets, each inside the proven ≤1-feature envelope.

### Phase 2 — `ticket_runner.py` (cloud writes it; ~200 lines, deterministic)

Thin outer loop, no new harness machinery:

- For each ticket in order: stage the ticket's acceptance slice (Phase 1),
  then a fresh `build_app.py` invocation (`--workspace <app> --spec
  spec/tickets/NNN.md --max-rounds 6 --timeout-minutes 60`). Fresh session
  per ticket — never one long `--continue`; on-disk state, not context,
  carries memory.
- Per-ticket prompt suffix (in the ticket file template): read
  `ARCHITECTURE.md` + `PROGRESS.md` + `spec/contract.md` first; update
  both state files before finishing. (The prompt also asks the model to
  run `make verify-full` itself so it can react to failures cheaply, but
  that is advisory — the gate below never relies on it.)
- **Gate between tickets — all machine-checked by the runner itself**
  (revised 2026-08-20 per Codex review: the prompt's pasted `verify-full`
  output is self-report and is trusted for nothing):
  1. `make verify` green (runner-invoked);
  2. **`make verify-full` green (runner-invoked)** — boot, curl smoke,
     restart persistence, web integration; without this a ticket could
     advance on unit-green while the running app is broken, the exact
     seam this tier exists to protect;
  3. oracle integrity: staged acceptance files byte-match canon (Phase 1);
  4. `BUILD_REPORT.md` says SUCCEEDED;
  5. the `ticket(NNN):` commit exists; state files touched.
  On any failure: stop the line (no skipping ahead past a red ticket),
  record the halt in `PROGRESS.md`, exit non-zero (Phase 3).
- **Evidence archival** (Codex P2: successive runs overwrite
  `<workspace>/BUILD_REPORT.md`): immediately after gating — pass or fail
  — the runner copies `BUILD_REPORT.md` and its own gate log to
  `reports/ticket-NNN/` in the control dir, so per-ticket round
  diagnostics survive the next run.
- Ledger: append per-ticket outcome (rounds used, review verdicts,
  wall-clock) to `PROGRESS.md` — the pilot's evidence trail.
- **Human entry point is a control-dir Makefile** (added 2026-08-20),
  distinct from the workspace Makefile (which belongs to the agent and
  holds `verify`/`verify-full`):
  - `make run` — start **or** resume the build (same command by design:
    the runner derives its position from `ticket(NNN):` commits, so there
    is no separate resume mode to remember). Wraps
    `python3 ~/code/agent-configs/pi/scripts/ticket_runner.py
    --pilot-dir $(CURDIR)`.
  - `make status` — read-only: current position from `git log` ticket
    commits, tickets remaining, last gate outcome.
  - `make reports` — list `reports/ticket-NNN/` archives (latest first).
  Day-to-day, the spec-compilation step generates this Makefile into each
  new app's control dir, so operating any pipeline app is: write spec →
  compile → `make run`.

**Work-tracking conventions (added 2026-08-20, borrowed from how Claude
Code and Copilot's coding agent track work — both externalize state into
artifacts with independent lifecycles, never model context):**

- **The git log is the transactional ledger.** Each completed ticket ends
  in exactly one commit whose message starts `ticket(NNN):`. The runner
  derives its position and resume point from `git log` alone (Copilot's
  branch-plus-draft-PR pattern, minus GitHub). `PROGRESS.md` is a
  human-readable *projection* the agent maintains; the runner checks it
  was touched but never trusts it for control flow — agent-written prose
  is self-report, the exact signal this harness refuses as evidence
  everywhere else.
- **Ticket status is verification artifacts only** (Copilot's PR-checks
  model, and `quality-gate.ts`'s evidence-not-claims rule promoted to the
  ticket level): done = named acceptance tests green + `make verify`
  green + the `ticket(NNN):` commit exists. Nothing the agent *says*
  changes a ticket's status.
- The spec-freeze checkpoint (Phase 0) is the analog of Claude Code's
  plan-mode approval: decomposition is only compiled from a human-frozen
  spec, never from a live conversation.

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

### Phase 5 — Local decomposition experiment (**post-pilot only**)

Goal: move step "compile the spec" from cloud to the local model, making
the day-to-day loop fully local. Deliberately sequenced *after* the pilot
verdict — running it during the pilot would make a failure unreadable
(bad ticket graph vs. bad implementation), and the cloud-compiled graph
is the controlled input the pilot's claim depends on.

- **Mechanism:** a pi prompt template (`/tickets <spec-path>`), not a
  skill (relevance-matching is unreliable on this model per `pi/README.md`)
  and not an extension (nothing per-turn to intercept). One deterministic
  invocation: spec in, `spec/tickets/NNN-*.md` out, same ticket-file
  template the cloud compiler uses. Decomposition only — contract and
  acceptance-test generation stay cloud-side initially; test generation is
  the highest-stakes output (a wrong oracle silently corrupts every
  downstream verdict), so it moves last, if ever.
- **Evaluation — diff against the cloud graph, same frozen spec:** run
  `/tickets` on the pilot's own spec and compare against the
  cloud-generated graph the pilot ran with, on: (1) requirement coverage
  — every spec §2/§3 behavior mapped to some ticket; (2) sizing — each
  ticket inside the ≤1-feature envelope; (3) ordering — walking skeleton
  first, dependencies respected; (4) acceptance mapping — each ticket
  names the right test slices. Cheap to judge because the cloud graph and
  the pilot's per-ticket outcomes already exist as ground truth (e.g. a
  ticket the local graph merges into an oversized unit is exactly the
  failure the pilot's ledger can price).
- **Adoption bar** (matching this repo's ~3-occurrence convention): 2
  further specs decomposed locally and run through the pipeline with no
  halt attributable to graph quality before local decomposition becomes
  the default. Until then the compile step stays cloud.

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
