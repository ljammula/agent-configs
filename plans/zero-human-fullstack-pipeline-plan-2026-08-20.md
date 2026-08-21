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
  spec/tickets/NNN.md --max-rounds 3 --timeout-minutes 60`). Fresh session
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

### Live pilot observation — 2026-08-20

The first ticket-001 attempt exposed an infrastructure failure before the
pilot could produce a verdict. The Qwen primary route returned repeated
`Connection error`s, followed by the harness's `stall-timeout`; the local
verification command itself passed. The builder was interrupted before it
could write `BUILD_REPORT.md`, so the runner correctly rejected the already
committed ticket during re-gating because the report evidence was missing.
This is a validation-infrastructure observation, not an application or
acceptance-test failure; the recovery procedure is to restore model-route
health, rerun the ticket builder, and then re-run the deterministic gate.

**Ticket 003 halt — stale process running pre-fix code (2026-08-20).**
`ticket_runner.py` was launched at 14:58, before PR #25 (merged 15:30:47,
`b6e4a99`) landed the `--review-base-sha` fix for the reviewer's diff-scope
bug. Ticket 003's `build_app.py` invocation (started 15:02:40, same OS
process for its full ~45 min run) never picked up the fix, so its reviewer
saw only each round's own diff instead of the whole ticket: rounds 1–2 hit
`unavailable (no-review-verdict)`, round 3 got a real verdict but flagged
the diff as missing the HTTP router/server implementation that had, in
fact, already been committed in round 1 (`a6d49fb`, real `api.go` with
CORS + the account endpoints, not a stub). Round budget exhausted, gate
failed, `ticket_runner.py` correctly halted per Phase 3 policy and required
a human rescue — that part worked as designed.

The gap: nothing surfaced that the running process was ~45 minutes stale
relative to a fix that had already merged. Diagnosing it required manually
cross-referencing PR merge time against per-round log timestamps rather
than the pilot reporting it directly. Follow-up (not yet implemented, low
risk/low effort, do before or during the next long unattended run):
- Have `ticket_runner.py` log the `agent-configs` git SHA (or at least
  `pi/scripts/*.py` mtimes) it's running under at process start, into
  `EXECUTION_LOG.md` or the gate evidence, so a stale-process halt like
  this one is diagnosable from the pilot's own records instead of log
  archaeology.
- Operating rule for any long unattended pilot run: restart
  `ticket_runner.py` after any `agent-configs` change lands, rather than
  leaving a process running across a code change — `make run` starts a
  fresh Python process each invocation, so this is a discipline gap, not
  a code one.
- Explicitly **not** recommended: teaching `ticket_runner.py` to
  auto-retry a flagged/exhausted ticket just because the code changed
  mid-run. That would blur the line between infra flakiness (retryable)
  and a genuine reviewer-flagged failure (stop-the-line by design) that
  the recent retry-bounding fixes (`e569c83`, `84a1d72`) exist to keep
  separate.

Rescue: `build_app.py` re-invoked by hand for ticket 003 with
`--review-base-sha 1e4d51d` (ticket 002's commit) now that the fix is
present, picking up the existing commit/uncommitted work as-is (`build_app.py`
never resets the workspace) rather than redoing it.

**`ticket_runner.py` concurrency bug found and fixed (2026-08-20).** Two
`ticket_runner.py` processes ended up running against the same pilot dir
at once (one launch's process outlived its wrapping shell — `nohup` +
`disown` inside a sandboxed backgrounded command doesn't survive the
wrapper exiting, contrary to expectation; a bare `run_in_background`
invocation of `make run` does). Both computed the same
`build_attempt=1` for ticket 004 and raced to write
`reports/ticket-004/build-attempt-01.log`; the loser crashed with an
uncaught `FileExistsError` (`write_once` uses exclusive-create by
design — that's correct evidence-integrity behavior, not the bug). The
winner's `BUILD_REPORT.md` was genuine, so no false evidence resulted,
but a crashed runner process is still a bug. Fixed in `agent-configs`
`af44d6b`: a non-blocking `flock` on `.ticket_runner.lock` in the pilot
dir, acquired after the `--status` early-return so read-only checks
stay lock-free; a losing second process now exits 1 with a clear
message instead of crashing mid-write.

**Ticket 004 halt — genuine implementation gap, human-rescued
(2026-08-20).** All 3 rounds hit `make verify` red with identical Dart
analyzer errors against the pre-staged oracle `test/onboarding_screen_test.dart`
(`undefined_function 'OnboardingScreen'`,
`non_type_as_type_argument` for `MonthlySummary`/`ImportResult`/etc.) —
the model's rounds never created the `lib/` files that test imports.
Across all 3 rounds `git status` showed no new `lib/` files at all —
the model made no forward progress on this ticket's actual scope.
Rescued by hand: implemented
`lib/models/models.dart`, `lib/api/budget_api_client.dart`
(`BudgetApiClient`/`HttpBudgetApiClient` on `package:http`, which
already sat in the local pub cache, so no network fetch was needed),
`lib/utils/money.dart`, `lib/screens/onboarding_screen.dart`, wired
`lib/main.dart`'s launch gate, and replaced the `flutter create`
counter scaffold test (which no longer compiled once `MyApp` required a
client) with a real launch-flow smoke test. `make verify` /
`make verify-full` both green; committed as `ticket(004): onboarding
screen`. Re-gating found one more gap in the rescue procedure itself:
a hand-implemented rescue that never re-invokes `build_app.py` leaves
the stale `DID NOT SUCCEED` `BUILD_REPORT.md` in place, and the gate's
"`BUILD_REPORT.md` SUCCEEDED" check (correctly) still fails on it —
`make verify`/`make verify-full` passing isn't sufficient, matching
ticket 003's precedent exactly. Fix is procedural, not code: after a
hand-rescue, re-invoke `build_app.py` itself (same `--review-base-sha`
the runner used) against the now-passing workspace so it produces a
fresh, genuine `SUCCEEDED` report — confirmed side-effect-free here (the
agent's single round made no code changes beyond appending the runner's
own halt-record note it's instructed to preserve).

**Ticket 005 halt — local model route unreachable mid-run
(2026-08-20).** All 3 rounds of the automated attempt produced zero
code changes; the session transcript
(`.pi-build-session/2026-08-21T00-43-02...jsonl`) shows every one of
the 12 assistant turns across all 3 rounds returned `"stopReason":
"error", "errorMessage": "Connection error.", totalTokens: 0` — the
model was never actually reached. `pi`'s CLI process still exits 0 in
this case (it isn't a crash or a client-side timeout), so
`build_app.py`'s `pi_failed` check (`timed_out or pi_returncode != 0`)
doesn't catch it, and the round budget burns against an outage instead
of surfacing it distinctly from a real implementation failure — same
failure class as the first ticket-001 observation above, just not
caught by the stall-timeout this time. Confirmed root cause live:
`curl http://kannasmacstudio.lan:8080/v1/models` → `no route to host`
while general internet egress from the same shell worked fine and DNS
resolved the hostname correctly — the ai-stack Mac Studio was
unreachable on the LAN, not a DNS or sandbox-network-policy issue.
This is a physical/environmental condition outside what either the
runner or an agent rescue can fix; recovery is restoring LAN
reachability, then relying on `ticket_runner.py`'s own per-ticket
build-attempt budget (3 separate `build_app.py` invocations, not just
3 rounds within one) to retry ticket 005 with no runner changes needed.
Follow-up: implemented in `agent-configs` `ad6b507` — `build_app.py` now
has `agent_turn_errors()` and a distinct `model route unreachable (N/N
assistant turns errored)` blocker, surfaced per round in
`BUILD_REPORT.md`. Round-budget accounting is unchanged by design (this
makes the failure class legible, it doesn't grant free retries).

**Root cause of the unreachability, and the actual fix (2026-08-20).**
`AI_STACK_HOST=kannasmacstudio.lan` had gone stale — `curl`/`nc`/`ping`
all failed with "no route to host" against it, but the box was reachable
the whole time via Tailscale MagicDNS at `kannas-mac-studio` (no `.lan`
suffix), confirmed with `curl http://kannas-mac-studio:8080/v1/models`
returning the model list. `~/.zshenv` already defaults `AI_STACK_HOST` to
`kannas-mac-studio`; the stale `.lan` value only won because it was
already exported earlier in the session. Resumed with
`AI_STACK_HOST=kannas-mac-studio make run` and the pipeline continued
through tickets 005-009 with no further rescues needed. Saved to
Claude's cross-session memory (`ai-stack-host-hostname.md`) so a future
session tries this fallback before concluding the box itself is down.
This correction belongs in `~/.claude/CLAUDE.md` too (it currently
documents `kannasmacstudio.lan` as *the* host) but that file is the
user's, not this repo's, to edit.

**Ticket 010 halt — oracle-integrity gate caught real drift, but the
drift was a correct fix to a buggy canonical oracle (2026-08-20).**
`build_app.py` reported `SUCCEEDED` and the ticket committed, but the
runner's own re-gate failed on `oracle integrity`: the committed
`app/test/dashboard_screen_test.dart` differed from
`spec/acceptance/010/`'s canonical copy by one character — the model
added an `r` prefix to `testWidgets('renders exact $X.YY ...', ...)`,
turning it into a raw string. Checked why: the *canonical* oracle (Phase
1's cloud-compiled acceptance suite) has a genuine bug — `$X` inside a
non-raw Dart string literal is interpolation syntax, and `X` isn't a
defined identifier, so `dart analyze` on the unmodified canonical file
fails with `Undefined name 'X'`. The model's one-character edit was
required for the file to compile at all; it wasn't gaming the test's
assertions. The gate is working exactly as designed here — it doesn't
(and shouldn't) distinguish "malicious tampering" from "correct fix to a
broken oracle," any drift fails identically — but it also means the
pilot's own frozen acceptance suite was never actually validated
end-to-end before being frozen. Fixed the canonical file directly
(`spec/acceptance/010/dashboard_screen_test.dart`, added the `r` prefix,
matching the model's fix exactly) and re-staged it into the workspace;
`make verify-full` now green. This is the same class of correction as
the Phase 1 P2 spec-contradiction fix already on record above, applied
to a syntax bug instead of a semantic one.

Also corrected in passing: the ticket 004 rescue (above) deliberately
left `app/test/onboarding_screen_test.dart` and `acceptance/` out of
that commit, reasoning from ticket 003's precedent — but ticket 003
predated any staged acceptance suite entirely, so that precedent didn't
actually generalize. Every ticket since (005 onward) commits its staged
oracle files normally (`acceptance/summary_test.go` in ticket 009,
`app/test/connect_account_screen_test.dart` in ticket 006, etc.), and
ticket 005's commit picked up `onboarding_screen_test.dart` again on its
own, so no gap remains — just a benign inconsistency in ticket 004's
commit contents specifically, not a design problem.

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
- **Temporal as runner infrastructure** (considered 2026-08-20). The
  durability Temporal would provide is already provided by the
  `ticket(NNN):` git ledger: any crash is recovered by re-running
  `make run`, which re-derives position from `git log` — zero
  infrastructure, and the recovery mechanism doubles as the evidence
  trail. Temporal also can't reach the failure class that actually hurt
  unattended runs historically (pi's client-side HTTP idle timeout dies
  *inside* what would be the activity; Temporal would retry the dead
  round, not prevent it — the wall-clock backstop and per-ticket timeout
  already bound that). **Revisit trigger:** this flips to worth doing if
  the pipeline becomes a build farm — multiple apps building
  concurrently, runs queued across machines, scheduled builds, or a
  human-in-the-loop signal for post-verdict rescue. At that point wrap
  `run_ticket` as an activity and the loop as a workflow, keeping the git
  ledger underneath unchanged. Separately, Temporal-as-*app-domain* (a
  second pilot spec including a Temporal worker, exercising the existing
  `temporal-go` stack skill) is a good post-pilot hardening test of the
  pipeline itself.
- Multi-app generalization before one pilot succeeds.

## Decisions log (all resolved 2026-08-20)

1. Pilot app: **rebuild `personal-budget-simplifier` from scratch**;
   existing repo held out as reference + acceptance-scenario source.
2. Spec: **cloud-written, user-approved scope**; frozen at
   `~/code/test-bed/budget-pilot/spec/spec.md`.
3. Cloud escalation: **none during the run** (`--sonnet-fallback` skipped;
   runner has no escalation path). Halt-and-report on any exhausted
   ticket; rescue only as an explicit post-verdict step.
