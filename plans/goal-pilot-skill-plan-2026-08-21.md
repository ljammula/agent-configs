# `goal-pilot` — plan

**Date:** 2026-08-21 (rewritten same day after an architecture correction —
see "Architecture history" below). **Status: plan only — nothing below is
built yet.**
**Extends:** `zero-human-fullstack-pipeline-plan-2026-08-20.md` (all
context, evidence, and terminology below assumes that document; this file
doesn't re-derive it).

## What's being asked for

A `pi.dev`-native orchestrator, `goal_pilot.py`, that takes a user's spec
input (a rough idea — prose, bullets, a doc, doesn't need to be precise)
and drives the *entire* pipeline end to end: draft spec → freeze →
contract + acceptance tests → tickets → `ticket_runner.py` build loop →
verdict. One invocation covers what the pilot did by hand across a day of
human orchestration, and what Phase 5's `/spec-plan`/`/contract-plan` cover
only as individually-triggered steps.

This is not a rerun of the pilot: the pilot's job was to *measure* the
local model with a human doing every judgment step by hand. `goal_pilot.py`'s
job is to make the pipeline *usable* — the human still owns spec approval
(and, per `/contract-plan`'s own existing design, the acceptance-suite
review), but everything mechanical in between is one invocation.

## Architecture history (read this before the rest — it changed once)

The first draft of this plan had a Claude Code session (this agent)
author the spec/contract/tickets/acceptance-tests directly, treating
`/spec-plan`/`/contract-plan` as unused. **That was wrong and has been
reversed following direct user correction (2026-08-21).** `goal-pilot` is
`pi.dev` harness work: it belongs beside `ticket_runner.py` in
`pi/scripts/`, and it uses the **local model**, via `pi` itself, for the
judgment steps — exactly the Phase 5 mechanism
(`/spec-plan`/`/contract-plan`) the parent plan already built and this
plan should drive, not duplicate or bypass. The corrected design below is
also strictly better on its own terms, independent of who asked for the
correction: the original draft would have had to re-derive every
gate-matched convention `/spec-plan`/`/contract-plan` already encode
(exact `## Commit` sections, Go-slice staging rules, the scaffold safety
check, the `STATUS: FROZEN` marker) as parallel prose, which is a second
copy that drifts. Driving the existing prompts headlessly instead means
there is exactly one place those conventions live.

## Where `goal_pilot.py` sits relative to existing pieces

| Piece | What it is | Who runs it |
|---|---|---|
| `/spec-plan`, `/contract-plan` | pi prompt templates — **local model** drafts spec/tickets, then contract/tests | invoked inside a `pi` session, interactively or headlessly |
| `ticket_runner.py` | outer loop, one `build_app.py` run per ticket | invoked from a shell (`make run`) |
| `build_app.py` | inner loop, local model implements one ticket | invoked by `ticket_runner.py`, shells to `pi --print ...` |
| **`goal_pilot.py`** (new) | outermost loop — drives `/spec-plan`, a human checkpoint, `/contract-plan`, another checkpoint, then `ticket_runner.py`, then halt/rescue handling | invoked from a shell, same as `ticket_runner.py` |

`goal_pilot.py` is a **deterministic Python script**, not a pi skill and
not a Claude Code skill. That distinction already exists in this repo and
matters here: prompt templates (`/spec-plan`, `/contract-plan`) are
model-interpreted instructions, selected by the human typing a slash
command in a `pi` session; scripts (`ticket_runner.py`, `build_app.py`)
are plain Python control flow that shells out to `pi` for the parts that
need a model. `goal_pilot.py` is the latter, one level further out —
verified feasible directly against `build_app.py:pi_invocation()`, which
already shows the exact non-interactive form: `pi --print --mode json
--provider ai-stack-local --model <model> --session-dir <dir> "<prompt
text>"`. `goal_pilot.py` invokes `pi` the same way with `"/spec-plan
<input> <pilot-dir>"` and `"/contract-plan <pilot-dir>"` as the prompt
text.

**Consequence: no skill-installation question.** The earlier draft spent
real effort on where to register a Claude/pi skill and got the
`install.sh` list wrong in the process (caught by Opus review, see
history below). None of that applies to a script. `goal_pilot.py` lives at
`pi/scripts/goal_pilot.py`, is not symlinked by `install.sh` (`ticket_runner.py`
isn't either — both are referenced by absolute path, e.g. from a pilot
dir's `Makefile`, exactly like `ticket_runner.py` already is), and is
invoked directly: `python3 ~/code/agent-configs/pi/scripts/goal_pilot.py
--spec-input <path> --pilot-dir <dir> ...`.

Implementation stays exactly where the pilot proved it: **local, via
`ticket_runner.py` → `build_app.py`, zero cloud tokens**, unconditionally
(see step 7 — this holds even under the resolved rescue policy).
`goal_pilot.py` never modifies `build_app.py`/`ticket_runner.py` gate
logic and never adds a cloud-escalation path.

## Invocation (user decision, 2026-08-21: both policy forks are explicit
per-invocation parameters, each with a stated default)

```
python3 pi/scripts/goal_pilot.py --spec-input <path> --pilot-dir <dir>
    --checkpoint=review|skip     (default: skip)
    --on-halt=report|auto-rescue (default: auto-rescue)
```

`goal_pilot.py` always echoes the effective value of both — whether the
user passed them or took the default — before doing anything else, so a
resumed run and a fresh run both make the active mode explicit rather than
assumed. The spec-freeze checkpoint (step 3) and the post-ticket-001
checkpoint (step 5b) are outside both flags and are never skippable — see
those steps for why.

## What `goal_pilot.py` actually does, phase by phase

### 1. Intake

User provides: a spec description (inline text or a path to notes) and a
target pilot dir. Tech stack stays what's proven — Go backend + Flutter
web frontend, same `Makefile verify`/`verify-full` contract as
`budget-pilot`; a different stack is a separate, unproven experiment and
out of scope for v1 (matches the parent plan's "multi-app generalization
before one pilot succeeds" exclusion).

### 2. Draft spec + tickets (local model, via `/spec-plan`)

`goal_pilot.py` runs `pi` headlessly with `"/spec-plan <spec-input>
<pilot-dir>"`. This is the existing, already-built mechanism: scaffolds
the pilot dir if needed (`/spec-plan`'s own three-way safety check —
already-scaffolded / empty-or-missing / non-empty-no-Makefile — stays the
authority on this, `goal_pilot.py` doesn't reimplement it), drafts
`spec/spec.md` under `STATUS: DRAFT` with every resolved ambiguity
surfaced in its own "Assumptions & Interpretations" section, and drafts
`spec/tickets/NNN-*.md`.

### 3. Human checkpoint — spec freeze (hard stop, never skippable)

This is the pipeline's plan-mode-approval analog. `goal_pilot.py` prints
`spec/spec.md` (with Assumptions & Interpretations highlighted) to the
terminal and blocks on explicit approval — not a timeout, not a default
"looks fine." On approval, it rewrites the file's `STATUS: DRAFT` line to
`STATUS: FROZEN -- reviewed <UTC-timestamp>` (the same marker
`/contract-plan` already checks for and refuses to run without — this is
also what makes step 9's resume able to detect "already past this step"
from disk rather than re-asking). On rejection, `goal_pilot.py` exits with
instructions: edit `spec/spec.md` by hand (or re-run `/spec-plan` in an
interactive `pi` session against the same input for another draft), then
re-invoke `goal_pilot.py` against the same `--pilot-dir` to continue.

### 4. Compile the spec (local model, via `/contract-plan`)

Once frozen, `goal_pilot.py` runs `pi` headlessly with
`"/contract-plan <pilot-dir>"`. Existing, already-verified mechanism:
`spec/contract.md`, the failing-first acceptance suite staged per ticket
(`spec/acceptance/NNN/`, with the Go-slice staging conventions —
`go.mod`/shared helpers in the first slice only, `MANIFEST.md` per
slice — already encoded in the prompt, not re-derived here), and the
mechanical self-check (`go vet`/`go build` against a scratch module for
Go; best-effort `dart analyze` against a scratch Flutter project for
Dart, with an explicit flagged skip if that's not practical yet).

**Completion marker, not just file existence (Codex review, PR #36):** a
crash mid-`/contract-plan` — after `contract.md` and some acceptance
slices are written but before the self-check finishes — must not read
back as "step 4 done" on resume. `goal_pilot.py` writes its own
`spec/.compile-complete` marker (timestamp + a count of tickets that have
a staged acceptance slice) only after the self-check itself has run and
its output been captured, and step 9's resume checks for *that* marker,
not merely `contract.md`'s presence, before treating step 4/5 as finished
and advancing to 5b/6. On resume without the marker, `goal_pilot.py`
re-runs `/contract-plan` from the top rather than guessing which slices
are complete — `/contract-plan` regenerating an already-correct file is
harmless; skipping ahead on an unverified partial compile is not.

**Known residual gap, inherited from `/contract-plan` as-is, not fixed by
`goal_pilot.py`:** the self-check doesn't dry-run the `verify-full`
server-restart lifecycle, so a bug shaped like ticket 012's (a
backgrounded server inheriting `go test`'s stdout pipe, hanging the
process wait well after the test's own assertions pass) is still
invisible to it. This is exactly the gap the parent plan's own verdict
flagged as one of two cheap pre-run fixes and it remains open. Fixing it
belongs in `/contract-plan` itself (one shared place, per the
architecture-history reasoning above), as a small follow-up PR — not
duplicated as script logic inside `goal_pilot.py`. Noted here so it isn't
silently lost; not blocking this plan.

### 5. Human/cloud checkpoint — acceptance-suite review

`/contract-plan` already ends every run with a banner that must never
claim or imply cloud review happened — that design doesn't change.
`goal_pilot.py` preserves it exactly:
- **`--checkpoint=review`**: pauses here, prints the self-check's real
  output verbatim (the `go vet`/`go build` transcript; the `dart analyze`
  transcript or its flagged skip) plus the contract and ticket list, and
  tells the user directly: bring this to a separate cloud session
  yourself for review-and-correct, the same human-triggered step
  `/contract-plan`'s own header describes as the highest-stakes part of
  the whole pipeline. Blocks on confirmation that this happened (or an
  explicit "proceed anyway, self-check only" override, logged as such).
- **`--checkpoint=skip`**: proceeds straight to step 5b on local
  self-check evidence alone. `goal_pilot.py` still writes the same
  disclaimer into `EXECUTION_LOG.md` (step 6) so the run's evidence trail
  records that the highest-stakes artifact in the pipeline was never
  independently reviewed, rather than leaving that discoverable only by
  reading `/contract-plan`'s banner text after the fact.

### 5b. Checkpoint — after ticket 001 gates green (always on, not covered
by `--checkpoint`)

Once ticket 001 passes its gate — the workspace verify surface
(`Makefile`, `scripts/verify.sh`, `scripts/verify-full.sh`, embedded
verbatim by `/spec-plan`'s ticket-001 template the same way the real
pilot's `001-workspace-scaffold.md` does) is now frozen via
`ticket_runner.py`'s `VERIFY_SURFACE_FILES`, and the app has booted for
the first time — `goal_pilot.py` stops unconditionally and shows the
user `make verify-full`'s real output. This is the one checkpoint that
lands *after* code exists rather than only before, specifically because
tickets 010 and 012 were bugs in exactly this frozen surface that no
pre-run review could have caught (they only failed once the model
actually exercised them). Cheap — one pause, roughly 20–60 minutes into a
run that otherwise takes most of a day — and it's the last moment a human
can catch a bad verify surface before ten more tickets build on top of
it; after this point it's immutable except through `--amend-canon` (step
7, class 2).

### 6. Run the build loop

`goal_pilot.py` invokes `ticket_runner.py --pilot-dir <dir>
--review-policy advisory` as a subprocess, redirecting its output to a
deterministic log (`logs/run-<UTC-timestamp>.log`) and indexing it in an
`EXECUTION_LOG.md` `goal_pilot.py` maintains alongside `PROGRESS.md`. This
is a plain CLI script the user runs (foreground, `nohup`, `tmux`,
whatever they'd already use to run a long process) — no host-harness
concepts (background-task notifications, tool-specific monitoring) apply
here, since nothing about this step depends on being invoked from inside
a Claude Code session.

**Explicit, stated choice, not inherited silently:** `--review-policy
advisory` is the default because the actual pilot ran with an
effectively dead review layer for most of its tickets and the user has
separately decided not to pursue restoring the reviewer route. Stated in
the initial echo (alongside `--checkpoint`/`--on-halt`) and in the step 8
verdict.

`goal_pilot.py` treats a `.ticket_runner.lock` contention exit
(`refusing to race it`) as "a run is already in progress," reported as
such, not folded into halt-handling below.

### 7. On a halt

`ticket_runner.py` already stops the line and records the verdict —
nothing changes there. `goal_pilot.py`'s job is what happens *next*,
governed by `--on-halt` (default `auto-rescue`), and **the halt's class
changes what "auto" is allowed to mean** — a flat auto-rescue-or-not
switch is unsafe here for the same reason it was in the earlier draft:
`goal_pilot.py` is also the artifact's author (via `/spec-plan`/
`/contract-plan`), so an actor that can silently amend its own frozen
oracle removes the last independent check in a run that already defaults
to advisory-only review.

1. **Infrastructure halts** (stale/unreachable model route,
   `AI_STACK_HOST` staleness, a crashed process with recoverable
   attempt-retry state — tickets 003/005/011's class): under
   `auto-rescue`, handled without asking — e.g. retry the
   `kannas-mac-studio` MagicDNS fallback on a `model route unreachable`
   blocker, then relaunch. Under `--on-halt=report`, reported like any
   other halt.
2. **Frozen-artifact-canon drift** (a correct fix to a genuine bug in a
   frozen verify-surface file or canonical acceptance test — tickets
   010/012's class): **never auto-applied, regardless of `--on-halt`.**
   Always surfaced for explicit per-instance approval, applied through
   `ticket_runner.py --amend-canon <file> --reason "..."` when approved —
   never a direct hand-edit of the baseline/canon files.
3. **Genuine implementation gap** (the model made no forward progress —
   ticket 004's class): **resolved (user, 2026-08-21): under
   `auto-rescue`, widen and retry locally, unconditionally zero cloud
   tokens** — re-invoke `build_app.py` for that ticket with a larger
   round/timeout budget, a fresh session, **and `--thinking xhigh`**
   (`build_app.py` already exposes this via its `--thinking` flag,
   independent of the installed default). This may still fail the same
   way ticket 004 did — the local model made literally zero forward
   progress across 3 rounds at the installed default, not a
   budget-exhaustion case — so it is a bounded, single extra attempt
   (widen-once), not a loop: if the widened retry still doesn't gate
   green, `goal_pilot.py` stops and reports, it does not keep widening.
   Under `--on-halt=report`, reported immediately without a retry.

For any rescue actually applied (classes 1–3):
- **Logged unconditionally**, into the same `EXECUTION_LOG.md`/`logs/`
  trail step 6 sets up: what halted, which class, what changed (including
  the widened `--thinking`/round/timeout values for class 3), whether it
  was auto-applied or user-approved. The final verdict (step 8) always
  states the rescued count, by class, and which tickets — never
  presenting a rescued app as if the local model built it unassisted at
  default settings. This is the direct fix for the exact gap the parent
  plan's tickets-013–016 section documents (rescued/cloud-touched — or
  here, rescued/widened-local — work that left no trail and was later
  misread as something else); it matters more here than it did there,
  because under `auto-rescue` this is routine rather than rare.

### 8. Completion — verdict report

When all tickets are committed and gated green: read `PROGRESS.md` +
`reports/ticket-*/` + `goal_pilot.py`'s own `EXECUTION_LOG.md`, and write
a verdict summary (`VERDICT.md` in the pilot dir) in the same shape as
the parent plan's own "Pilot verdict" section — tickets unassisted vs.
rescued (by class, per step 7), wall-clock, halts and their cause,
`--review-policy`/`--checkpoint`/`--on-halt` actually used, and the
zero-cloud-implementation-tokens claim verified from the evidence trail,
not asserted (true unconditionally per this design — even class-3
rescues stay local, just at widened settings).

### 9. Resume

Re-invoking `goal_pilot.py` against an existing pilot dir picks up from
disk state, the same idempotent pattern `/spec-plan` already uses for its
own scaffold step: `spec/spec.md`'s `STATUS:` line says whether to resume
at step 2/3 or skip to step 4; `spec/.compile-complete` (step 4's
completion marker, written only after the self-check finishes — not mere
`spec/contract.md` existence, which a mid-compile crash can also produce)
plus step 5's recorded confirmation says whether to skip to step 5b/6;
`git log` in the workspace (already how `ticket_runner.py` derives its own
position) says where the build loop is. No separate resume mode or extra
state file
needed beyond what each step already writes.

## Open items — not yet resolved, flagged rather than assumed

- The `/contract-plan` verify-full-dry-run gap (step 4) is real and
  should get its own small follow-up PR against `/contract-plan` itself;
  not scoped into `goal_pilot.py`.
- Exact heuristics for classifying a halt into one of step 7's three
  classes from `ticket_runner.py`'s existing halt records (`PROGRESS.md`'s
  HALT block, `BUILD_REPORT.md`'s blocker text) need to be nailed down at
  implementation time — the classes themselves are settled, the string-
  matching isn't specified here.
- Whether `/spec-plan`'s existing three-way scaffold check and
  `STATUS: DRAFT`/`FROZEN` handling already behave correctly when
  re-invoked against a dir with an unapproved draft already on disk (step
  3's rejection path assumes re-running `/spec-plan` or hand-editing is
  safe) — worth confirming against the actual prompt text before
  implementation rather than assuming.

## What this explicitly does not change

- No changes to `build_app.py`'s or `ticket_runner.py`'s gate logic, or
  the parent plan's Phase 3 no-cloud-escalation-during-implementation
  rule — it holds unconditionally here too (step 7 class 3 stays local).
- No new pi extensions.
- Doesn't replace `/spec-plan`/`/contract-plan` — `goal_pilot.py` drives
  them, it doesn't reimplement what they do.

## Prior review (superseded by the architecture correction above)

An Opus review of the earlier "Claude authors directly" draft is on
record and was substantive — it correctly caught that draft's missing
verify-surface authorship, its duplicated-conventions risk, its
overly-blanket auto-rescue framing, and a couple of factual errors
(a nonexistent tool reference, an inverted `install.sh` list). All of
those specific findings are reflected in this rewrite (the duplication
risk is now moot by construction, per "Architecture history" above; the
rest carried forward as: verify-surface authorship in step 5b, halt-class-
aware rescue in step 7, the evidence trail in step 6). **This rewritten,
pi-native version has not itself been re-reviewed** — worth another Opus
pass before implementation, specifically on step 7's halt-classification
heuristics and whether the checkpoint-skip disclosure in step 5 is a
strong enough safeguard for a step `/contract-plan`'s own design calls
the highest-stakes in the pipeline.
