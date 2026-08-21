# `goal-pilot` skill — plan

**Date:** 2026-08-21. **Status: plan only — nothing below is built yet.**
**Extends:** `zero-human-fullstack-pipeline-plan-2026-08-20.md` (all context,
evidence, and terminology below assumes that document; this file doesn't
re-derive it).

## What's being asked for

A Claude Code skill, `goal-pilot`, that takes a user's spec input (a rough
idea — prose, bullets, a doc, doesn't need to be precise) and drives the
*entire* pipeline end to end: draft spec → freeze → contract + acceptance
tests → tickets → `ticket_runner.py` build loop → verdict. One invocation
covers what the pilot did by hand across a day of human orchestration.

**Invocation shape (user decision, 2026-08-21): the two policy forks below
are explicit per-invocation parameters, each with a stated default.**
Every run states both up front — there is no silent default behavior to
be unaware of, but an unopinionated user isn't forced to specify either:

```
/goal-pilot <spec-input> [pilot-dir]
    --checkpoint=review|skip     (default: skip)
    --on-halt=report|auto-rescue (default: auto-rescue)
```

`goal-pilot` always echoes the effective value of both — whether the user
passed them or took the default — in its first response before doing
anything else, so the user always sees what mode this run is in. Passing
`--checkpoint=review` is how a user opts *into* the step-5 contract/ticket
review for a first-time or high-stakes spec; `--on-halt=report` is how a
user opts *into* the stricter no-silent-rescue behavior when they want to
review the fix themselves rather than let `goal-pilot` apply it.

The step-3 spec-freeze checkpoint is not part of either flag and has no
"skip" mode — see step 3.

This is a new thing, not a rerun of the pilot: the pilot's job was to
*measure* the local model with a human doing every judgment step by hand.
`goal-pilot`'s job is to make the pipeline *usable* — the human still owns
spec approval, but everything mechanical between "here's my idea" and "here's
your app, or here's exactly where it stopped" is one skill invocation.

## Where `goal-pilot` sits relative to existing pieces

| Piece | What it is | Who runs it |
|---|---|---|
| `/spec-plan`, `/contract-plan` | pi prompt templates — **local model** drafts spec/tickets/contract/tests, cloud reviews after | invoked inside a `pi` session |
| `ticket_runner.py` | outer loop, one `build_app.py` run per ticket | invoked from a shell (`make run`) |
| `build_app.py` | inner loop, local model implements one ticket | invoked by `ticket_runner.py` |
| **`goal-pilot`** | orchestrates all of the above from a Claude Code session, using **Claude itself** for the judgment steps | invoked as `/goal-pilot` in Claude Code |

**Key design choice: `goal-pilot` does not shell out to `/spec-plan` /
`/contract-plan`.** Those exist for the specific case of moving drafting
*off* cloud and onto the local model (Phase 5), with mandatory human/cloud
review afterward precisely because a local draft is unproven. `goal-pilot`
runs inside a cloud session already — having it invoke `pi` to produce a
local draft, then have itself (cloud) review that draft, is strictly worse
than just authoring the spec/contract/tickets/acceptance tests directly:
same cloud tokens spent, but with an extra indirection and no independence
gained. So `goal-pilot` reuses the **Phase 0/1 shape** (cloud authors
directly) that the pilot actually validated, not the Phase 5 shape. This
also preserves the oracle-independence property the whole design leans on
(`spec-plan.md`'s reasoning, contract-plan's item (1)): the acceptance
suite is authored by an actor that never touches implementation.

Implementation stays exactly where the pilot proved it: **local, via
`ticket_runner.py` → `build_app.py`, zero cloud tokens.** `goal-pilot` never
calls `pi` itself, never modifies `build_app.py`/`ticket_runner.py`
behavior, never adds a `--sonnet-fallback`-style escalation inside the
implementation loop.

## What `goal-pilot` actually does, phase by phase

### 1. Intake

User provides: a spec description (inline text, or a path to notes) and a
target pilot dir (default: prompt for one, e.g.
`~/code/pilots/<slug>/`). `goal-pilot` does **not** assume a tech stack
beyond what's proven: Go backend + Flutter web frontend, same
`Makefile verify`/`verify-full` contract as `budget-pilot`. If the user
wants a different stack, that's a separate, unproven experiment and out of
scope for this skill's first version (matches the parent plan's "multi-app
generalization before one pilot succeeds" exclusion).

### 2. Draft spec (cloud, direct authoring)

Claude writes `spec/spec.md` itself, applying the parent plan's grill-pass
principle live and interactively: every ambiguity becomes either a spec
sentence or an explicit non-goal, resolved by asking the user rather than
guessing (this is a real advantage over `/spec-plan`'s written-guesses
approach — the user is available synchronously here). Output includes an
explicit non-goals section.

### 3. Human checkpoint — spec freeze (hard stop, mandatory)

This is the pipeline's plan-mode-approval analog and it does not get
automated away. Present the drafted spec; require explicit user approval
before writing anything else. No default "looks good, proceeding" — an
unanswered prompt halts here, it does not time out into approval.

### 4. Compile the spec (cloud, direct authoring)

Once frozen, mark `spec/spec.md`'s first line `STATUS: FROZEN -- reviewed
<date>` (same machine-readable marker `/contract-plan` already checks for
and refuses to run without — this also gives step 9's resume something
real to test on disk instead of inferring freeze from file existence).
Then:
- `spec/contract.md` — endpoints, exact JSON field names/casing, status
  codes, error shapes.
- Failing-first acceptance suite, staged per ticket
  (`spec/acceptance/NNN/`), same conventions as Phase 1: black-box Go
  `httptest` (raw-bytes JSON assertions, restart-persistence test), Flutter
  widget tests (rendered-text assertions for interpolated strings), plus
  the staging-compatibility rules `/contract-plan` §2 already encodes
  (`go.mod`/shared helpers live in the **first** Go slice only, one
  `MANIFEST.md` per slice, slice-number-prefixed basenames so two
  `handler_test.go`s across slices don't collide when staged flat).
- `spec/tickets/NNN-*.md`, tracer-bullet ordered, 8–15 tickets, each
  inside the proven ≤1-feature envelope, following the same mandatory
  ticket-file shape `/spec-plan` §2 encodes: the exact `## Commit`
  section and `ticket(NNN): <slug>` subject `commit_and_state_files_ok()`
  gates on, the instruction to update `ARCHITECTURE.md` +
  `PROGRESS.md` before finishing, and no references to acceptance-test
  filenames (they don't exist yet when tickets are decomposed).
- **Ticket 001 must scaffold the workspace verify surface itself** — the
  `Makefile` (`verify`/`verify-full` targets) and `scripts/verify.sh` /
  `scripts/verify-full.sh`, embedded verbatim in the ticket file the same
  way the real pilot's `001-workspace-scaffold.md` does. These three files
  are what `ticket_runner.py`'s `VERIFY_SURFACE_FILES` freezes after
  ticket 001 passes and every later gate depends on — without an authored
  ticket 001 that creates them, there is nothing for `make run` to gate
  against and the pilot cannot start.
- Pilot-dir scaffold (`Makefile`, `.gitignore`, `git init` + a
  `chore: scaffold pilot dir` commit in the **pilot dir's own** repo —
  never in `workspace/`, which gets its own separate repo only once
  ticket 001 runs) — reuse the exact heredocs already merged into
  `/spec-plan`'s step 0. **Not by copy-pasting that prose into the skill**
  (a second copy drifts) — extract the scaffold heredocs and the
  ticket/slice conventions above into one shared reference file both
  `/spec-plan`/`/contract-plan` and `goal-pilot` cite (e.g.
  `pi/pilot-conventions.md`), so there is exactly one source for
  model-agnostic rules like these.

**Self-check before freezing the acceptance suite** (closing the gap
tickets 010/012 found the hard way — both were genuine bugs in a
canonical oracle that shipped unvalidated): assemble Go acceptance slices
into a scratch module, `go vet`/`go build`; best-effort `dart analyze`
against a scratch Flutter project (`/contract-plan`'s existing, verified
mechanism). **Plus a step `/contract-plan` itself doesn't do, which the
parent plan's own verdict explicitly asked for and ticket 012 paid for
skipping:** dry-run the `verify-full` server-restart lifecycle once
against a stub server before freezing `scripts/verify-full.sh` — ticket
012's bug (a backgrounded server inheriting `go test`'s stdout pipe,
hanging the test's process wait well after its own assertions passed) is
invisible to static analysis and needs the lifecycle actually exercised
once.

### 5. Human checkpoint — contract/tickets review (lighter weight)

Summarize contract + ticket list + self-check results; ask for confirmation
before starting the build loop. Not a line-by-line spec-style review — a
"does this decomposition look right" gate. Controlled by `--checkpoint`
(default `skip`, see "Invocation shape" above): `--checkpoint=skip` moves
straight to step 6 once the self-check passes; `--checkpoint=review`
pauses here for explicit confirmation. The spec-freeze checkpoint in step 3
is separate from this parameter and is never skippable — it's the one
irreversible judgment call in the pipeline.

### 6. Run the build loop

`make run` in the pilot dir, launched via the harness's `run_in_background`
Bash flag specifically (not `nohup ... &; disown`) — the parent plan's own
ticket-003/011 observations found the latter fragile under a wrapping
shell/multiplexer and the former durable, and its output is redirected
deterministically (`logs/run-<UTC-timestamp>.log`, indexed in an
`EXECUTION_LOG.md` `goal-pilot` maintains alongside `PROGRESS.md`) rather
than left in harness scratch — real pilot dirs accumulated seven ad-hoc,
inconsistently-named log files this way, one of them silently empty, and
`goal-pilot`'s own actions (not just `ticket_runner.py`'s) are exactly the
part of that trail this plan cannot afford to leave informal (see step 7
point 3 and 4c-style provenance concerns). One long-running process; use
`Monitor` (not the nonexistent `ScheduleWakeup` tool) filtered on the
runner's stdout, with the filter covering failure text (`GATE FAILED`,
`build attempt limit`, `model route unreachable`) and not just success
text — silence must not be mistaken for success.

`goal-pilot` should also treat a `.ticket_runner.lock` contention exit
(`refusing to race it`) as "a run is already in progress," surfaced as
such, not folded into the halt-handling below as if it were a build
failure.

**Explicit, stated choice, not inherited silently:** `make run` always
invokes `ticket_runner.py` with the default `--review-policy advisory`
(the scaffolded Makefile has no flag to change this). Given the actual
pilot ran with an effectively dead review layer for most of its tickets
and the user has separately decided not to pursue restoring the reviewer
route, `advisory` is likely the right default here too — but `goal-pilot`
states this in its first-response echo (alongside `--checkpoint`/
`--on-halt`) and in the step 8 verdict, rather than leaving it implicit.

### 7. On a halt

`ticket_runner.py` already stops the line and records the verdict — nothing
new needed there. `goal-pilot`'s job is what happens *next*. **Resolved
(user decision, 2026-08-21): `goal-pilot` supports auto-rescue, controlled
by `--on-halt` (default `auto-rescue`).** Unlike the parent plan's pilot,
`goal-pilot`'s purpose is to get a working app, not to measure the local
model, so the Phase 3 human-triggered-rescue constraint doesn't carry over
unchanged.

**`auto-rescue` is not one behavior for every halt — the halt's class
changes what "auto" is allowed to mean, because `goal-pilot` occupies a
position the original pilot's human rescuer didn't: it is also the
oracle's author.** Opus's review flagged this specifically and it holds:
letting the same actor that wrote the acceptance suite also silently
approve edits to that suite removes the last independent check in a run
that, per the point above, already has advisory-only review. So `--on-halt`
governs three distinct halt classes differently, not uniformly:

1. **Infrastructure halts** (stale/unreachable model route,
   `AI_STACK_HOST` staleness, a crashed process with recoverable
   attempt-retry state — tickets 003/005/011's class in the parent plan):
   **auto-handled under `auto-rescue`, no per-halt approval needed.**
   These touch no app code and no oracle — e.g. retry the `kannas-mac-studio`
   MagicDNS fallback on a `model route unreachable` blocker (already in
   Claude's cross-session memory), then relaunch. Under `--on-halt=report`,
   these still just get reported like any other halt, since the user
   explicitly opted out of any unattended action.
2. **Frozen-artifact-canon drift** (the model correctly fixed a genuine bug
   in a frozen verify-surface file or a canonical acceptance test —
   tickets 010/012's class): **never auto-applied, regardless of
   `--on-halt`.** Always surfaced for per-instance approval, and when
   approved, applied through `ticket_runner.py --amend-canon <file>
   --reason "..."` (the sanctioned path built for exactly this) rather than
   hand-editing the baseline/canon files directly.
3. **Genuine implementation gaps** (the model made no forward progress —
   ticket 004's class): under `--on-halt=auto-rescue`, `goal-pilot` may
   write the fix itself; under `--on-halt=report`, it stops and reports.
   Either way this is the class most likely to actually touch
   implementation code, so it's the class step 8's
   zero-cloud-implementation-tokens accounting most needs to get right.

For classes 2 and 3, once a rescue is approved/performed:
- Reads the full diagnosis first (ticket id, rounds spent, failing checks,
  reviewer findings, `BUILD_REPORT.md` excerpt) — same evidence a human
  rescuer would read.
- Writes the fix, re-invokes `build_app.py` with the correct
  `--review-base-sha` (per the parent plan's documented rescue procedure),
  confirms `make verify`/`verify-full` green, commits
  `ticket(NNN): ... [rescued]`, then resumes `make run`.
- **Every rescue — all three classes — is logged unconditionally**, into
  the same `EXECUTION_LOG.md`/`logs/` trail step 6 sets up, not left to be
  inferred from commit messages: what halted, which class, what changed,
  whether it was auto-applied or user-approved. The final verdict (step 8)
  always states the rescued count, by class, and which tickets — never
  presenting a rescued app as if the local model built it unassisted.
  This is the direct fix for the exact gap the parent plan's
  tickets-013–016 section documents (rescued/cloud-touched work that left
  no trail and was later misread as hand-written); it matters more here
  than it did there, because under `auto-rescue` this is routine rather
  than rare.
- A rescue attempt has its own bounded retry (1 attempt per halted ticket)
  — if the rescue itself fails or the re-gate still doesn't pass,
  `goal-pilot` stops and reports rather than looping on one ticket.

### 8. Completion — verdict report

When all tickets are committed and gated green: read `PROGRESS.md` +
`reports/ticket-*/`, produce a verdict summary in the same shape as the
parent plan's own "Pilot verdict" section (tickets unassisted vs. rescued,
wall-clock, halts and their cause, zero-cloud-implementation-tokens claim
verified from the evidence trail — not asserted). Offer to publish it.

### 9. Resume

Re-invoking `goal-pilot` against an existing pilot dir with a frozen spec
skips straight to step 6/7 — `ticket_runner.py` already derives position
from `git log`, `goal-pilot` doesn't need its own resume state.

## Design forks — resolved

1. **Step 5's checkpoint: mandatory every run, or skippable for full
   unattended operation?** **Resolved (user, 2026-08-21): skippable** via
   an explicit flag; on by default. See step 5.
2. **Halt handling: strict report-only, or should `goal-pilot` support an
   auto-rescue mode?** **Resolved (user, 2026-08-21): yes, auto-rescue.**
   See step 7 — every rescue is still logged unconditionally and disclosed
   in the final verdict, so the app's provenance stays honest even though
   the human-approval gate on each individual rescue is gone.
3. **Where does `goal-pilot` live?** `claude/skills/goal-pilot/SKILL.md`.
   **Correction (Opus review):** the plan originally said "installed like
   `PROJECT_SKILLS`" to mean globally reusable — backwards. Checked against
   `install.sh`: `PROJECT_SKILLS` are deliberately *un-linked* from the
   global dirs (project-scoped by design); `PORTABLE_SKILLS` is the list
   that gets a global symlink. `goal-pilot`'s intent (reusable across any
   pilot dir, like `/spec-plan`) maps to `PORTABLE_SKILLS` — but
   `install.sh` explicitly warns against calling something "portable" when
   no `codex/skills`/`pi/skills` counterpart exists (`link_skills` would
   silently no-op on those two roots). Since `goal-pilot` genuinely has no
   Codex or pi counterpart by design (it needs multi-file authoring,
   background-process monitoring, and long-session judgment calls none of
   those tools' models support), it needs its own small list or a bare
   `link` line in `install.sh`, not a slot in either existing list.
4. **Scope of "runs the full pipeline"**: does a first version need to
   handle a from-scratch app only (matching the one proven pilot shape), or
   also "add a feature to an existing pipeline-built app" (spec →
   follow-up tickets, the shape tickets 013–016 actually were)? The parent
   plan's tickets 013–016 section is evidence this second shape already
   happened once, informally. Recommendation: v1 targets from-scratch only;
   the follow-up-ticket shape is a natural v2 once the evidence-trail gap
   that section flags (013–016 left no `reports/` trail) is fixed in
   `ticket_runner.py` itself — no point building on top of a known gap.

## What this explicitly does not change

- No changes to `build_app.py`, `ticket_runner.py`'s gate logic, or the
  Phase 3 no-cloud-escalation-during-implementation rule.
- No new pi extensions or prompt templates.
- Doesn't retry or replace `/spec-plan`/`/contract-plan` — those stay as
  they are, for the local-decomposition experiment they were built for.

## Opus review — verdict and what's incorporated

Opus reviewed the pre-parameterization version of this plan and verified
its factual claims directly against `pi/prompts/spec-plan.md`,
`pi/prompts/contract-plan.md`, `pi/scripts/ticket_runner.py`,
`install.sh`, and the real `budget-pilot` dir (not just read the plan's
prose). Its verdict: **needs-revision-then-ready** — sound architecture
and layering, but as originally written it "produces a pilot dir that
cannot run, because step 4 does not create the files every gate depends
on." Its single highest-priority fix (authoring the verify surface in
ticket 001 + a `verify-full` lifecycle dry-run) and every other
must-change item are now folded into steps 4/6/7 and the design-forks
section above:

- **Architectural call (cloud authors directly) — confirmed right**, but
  the original framing understated the cost: `/spec-plan`/`/contract-plan`
  aren't just "local model drafts it," they're the only written record of
  several gate-matched conventions (verbatim `## Commit` sections,
  Go-slice staging rules, the scaffold safety check, the `STATUS:
  FROZEN` marker). Fix, now in step 4: extract those into one shared
  reference file the pi prompts and `goal-pilot` both cite, instead of
  `goal-pilot` re-deriving or silently missing them.
- **Halt policy — the single `--on-halt` flag stays** (matches the user's
  explicit parameterization decision), but "auto-rescue" is now
  halt-class-aware rather than monolithic — see step 7. Opus's specific
  concern (an oracle its own author can silently amend mid-run is a
  negotiable oracle, and with `--review-policy advisory` as the stated
  default, the frozen-artifact-canon gate is the last independent check in
  a `goal-pilot` run) is addressed by carving out class 2
  (frozen-artifact-canon drift) as never-auto regardless of `--on-halt`,
  not by reopening the flag itself.
- **Evidence trail — real gap, now addressed**: step 6/7 add a
  deterministic `logs/`+`EXECUTION_LOG.md` trail `goal-pilot` owns, so its
  own interventions (not just `ticket_runner.py`'s) don't repeat the
  013–016 reporting gap the parent plan documents.
- **Verify-surface authorship + `verify-full` dry-run** — the biggest
  functional hole, now in step 4.
- **Tool-name error** (`ScheduleWakeup` doesn't exist) — fixed to `Monitor`
  in step 6.
- **Install-location error** (`PROJECT_SKILLS` vs. `PORTABLE_SKILLS` had
  it backwards) — fixed in fork #3.
- **Checkpoint calibration** (spec review is heavy, oracle review is
  light, inverted from where the pilot's real risk sat; checkpoint 5 was
  also self-report of Claude's own summary) — **not yet folded in**, flagged
  below as still open.

**Still open — not yet incorporated, needs another look before
implementation:**
- Opus's suggested third checkpoint (freeze-and-eyeball once ticket 001
  gates green, before ten more tickets build on an unreviewed verify
  surface) — real value, not yet reconciled with the user's
  `--checkpoint=skip` default.
- Checkpoint 5, when `--checkpoint=review` is used, should present the
  self-check's actual `go vet`/`dart analyze` transcript (or a flagged
  skip), not a Claude-written summary of it — same evidence-not-self-report
  principle the parent plan applies everywhere else.
- Minor items Opus flagged as nice-to-have: pilot-dir `git init` +
  scaffold commit conventions spelled out explicitly in step 4 (partially
  done above), `.ticket_runner.lock` contention surfaced distinctly from a
  build halt (done, step 6).
