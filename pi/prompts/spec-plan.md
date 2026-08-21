---
description: Scaffold (if needed) a pilot dir, then draft a disambiguated spec plus ticket decomposition from a rough idea
argument-hint: "<rough-input-path> [pilot-dir, default: current directory]"
---

Start (or continue) a `ticket_runner.py` pilot from a rough idea. `$2`
is the pilot dir (default: current directory); `$1` is the rough input
-- a few paragraphs, a bullet list, or freeform prose. It does not need
to be precise. Your job is to make it precise, and to make every place
you had to guess visible rather than silently baked into downstream
tickets.

## 0. Scaffold the pilot dir, if it isn't one yet

**Before writing anything, check `$2` in this order and pick exactly one
branch -- do not proceed past this check on a guess:**

- **`$2/Makefile` already exists** -> skip this whole step. The pilot
  dir is already scaffolded (from a prior run of this command, or by
  hand); re-running the commands below would truncate an
  already-reviewed `spec/spec.md`'s sibling files. Go straight to
  section 1.
- **`$2` does not exist, or exists and is completely empty** -> safe.
  Run the commands below.
- **`$2` exists, is non-empty, and has no `Makefile`** -> **stop and do
  not run anything below.** This is not a pilot dir this command
  created -- writing into it risks silently overwriting an unrelated
  project's own `.gitignore`/`Makefile` (e.g. a mistyped path). Report
  exactly this and end the turn: "`$2` already exists, is non-empty, and
  has no `Makefile` -- refusing to scaffold into it. Point `$2` at an
  empty or new path, or confirm by hand that overwriting it is
  intended."

Nothing in the "safe" branch below is a judgment call: run every command
exactly as written, do not retype or reformat any of it, and report each
command's real output -- do not report a step done without having
actually run it.

```
mkdir -p "$2/spec/tickets" "$2/spec/acceptance" "$2/workspace"
```

```
cd "$2" && git init
```

This is the **pilot dir's own** git repo. Do not run `git init` or
commit anything inside `$2/workspace/` -- that gets its own separate
repo later, when ticket 001 runs (per `new-project-scaffold.ts`'s nudge
for a genuinely empty app repo). A pilot dir with a repo nested inside
another repo is intentional, not a mistake -- the `.gitignore` written
next is what keeps the pilot dir's repo from trying to track
`workspace/`'s contents.

Run this exact command as a single `bash` call, copied verbatim,
including the closing `EOF` line:

```
cat > "$2/.gitignore" <<'EOF'
workspace/
.ticket_runner.lock
EOF
```

Run this exact command as a single `bash` call, copied verbatim,
including the closing `EOF` line. The lines starting `$(RUNNER)` and
`@ls` each begin with one literal tab character inside this heredoc --
do not replace it with spaces, Make requires a literal tab there.

```
cat > "$2/Makefile" <<'EOF'
# Human entry point for the zero-human pipeline pilot. This Makefile
# belongs to the control dir (spec/, reports/) -- it is distinct from
# workspace/Makefile, which the agent owns and which holds verify /
# verify-full. See plans/zero-human-fullstack-pipeline-plan-2026-08-20.md
# Phase 2.

RUNNER := python3 $(HOME)/code/agent-configs/pi/scripts/ticket_runner.py

.PHONY: run status reports

# Start or resume the build -- same command either way. ticket_runner.py
# derives its position from the workspace's git log (first ticket with no
# `ticket(NNN):` commit), so there is no separate resume mode to remember.
run:
	$(RUNNER) --pilot-dir $(CURDIR)

# Read-only: current position, tickets remaining, last gate outcome.
status:
	$(RUNNER) --pilot-dir $(CURDIR) --status

# List archived per-ticket evidence (BUILD_REPORT.md + gate log), latest first.
reports:
	@ls -t reports 2>/dev/null | sed 's/^/reports\//' || echo "(no reports yet)"
EOF
```

```
cd "$2" && git add .gitignore Makefile && git commit -m "chore: scaffold pilot dir"
```

Confirm `$2/workspace/` exists, is empty, and has no `.git` yet -- if it
does, something above ran in the wrong place; stop and say so rather
than proceeding.

## 1. `spec/spec.md`

This is the one step in this pipeline explicitly allowed to resolve
ambiguity rather than refuse to guess -- but every guess must be written
down as its own reviewable line, never absorbed silently into a ticket's
"Required changes" list where a human would have to reverse-engineer it
later. If you can't tell whether a real ambiguity exists or you're just
being cautious, resolve it and write down why; a resolved-and-flagged
assumption is useful, an unresolved question is not.

Write the detailed spec, in this order:

- **Scope**: what the app does, restated precisely enough that two
  different engineers would build the same thing from it.
- **Assumptions & Interpretations**: one bullet per place the input was
  vague, stating the interpretation you chose and why. This section is
  the actual deliverable of this step -- a human reviews this list line
  by line before anything here counts as frozen. Do not skip a genuine
  ambiguity because resolving it was easy; if you had to decide instead
  of transcribe, it goes here.
- **Non-goals**: anything intentionally out of scope, stated explicitly
  rather than left to be inferred from silence.
- **Open questions for the contract step**: do not invent API-contract
  detail here -- exact endpoint shapes, JSON field names/casing, status
  codes. If the input implies an API surface, name what needs deciding
  and leave the deciding to the contract-writing step (still cloud/human
  -- not this template, and not automated anywhere yet). Guessing at
  contract detail here duplicates work that step already owns and risks
  disagreeing with it.

Put a status line at the very top of the file:
`STATUS: DRAFT -- pending human review of Assumptions & Interpretations`.

## 2. `spec/tickets/NNN-<slug>.md`

Decompose `spec/spec.md` into ordered tickets, tracer-bullet style:
walking skeleton first (schema -> domain -> one endpoint -> one screen
wired end to end), then breadth. Sized to a single feature (the proven
envelope is a ~75-minute unit; if a ticket looks bigger than that, split
it). Do not reference acceptance-test file names -- none exist yet; that
stays the contract/test-generation step's job, same as it always has
been in this pipeline.

**Every ticket file must contain all five of these sections, in this
order, matching the template every hand-written ticket in this pipeline
already uses** -- `ticket_runner.py` passes the ticket file to
`build_app.py` as the model's entire spec, and its gate deterministically
rejects a ticket that skips any of this (`commit_and_state_files_ok()`
requires the commit to touch both state files and match the exact
`ticket(NNN):` prefix; a ticket that never says so gives the model no way
to know):

1. **Context line** (every ticket after 001): "This is an existing repo.
   Read `ARCHITECTURE.md`, `PROGRESS.md`, and `spec/contract.md` before
   changing anything, and preserve all existing functionality and
   passing tests -- this is an extension, not a rewrite."
2. **`## Goal`** -- one paragraph.
3. **`## Required changes`** -- a numbered list, files in scope, ending
   with the line: "Update `ARCHITECTURE.md` and append a `PROGRESS.md`
   entry before finishing." (verbatim -- this is the state-file update
   the gate checks for).
4. **`## Verification`** -- at minimum: "`make verify` must pass" and
   "Confirm `make verify-full` still passes."
5. **`## Commit`** -- "Commit once both pass. Commit message must be
   exactly: `ticket(NNN): <slug>`" with the ticket's actual number and
   slug filled in -- this exact string is what
   `commit_and_state_files_ok()` matches against.

## 3. Report

Print, in this order:
- The tree scaffolded in step 0, if it ran (`find $2 -not -path
  '*/workspace/*'` or similar) -- omit this if step 0 was skipped.
- The full Assumptions & Interpretations list (even though it's also in
  the file -- this is what actually gets reviewed).
- The full Non-goals list.
- Ticket count and one line per ticket: number, slug, one-sentence goal.

Then this exact banner, and stop:

```
HUMAN REVIEW REQUIRED before this is a frozen spec.
Read spec/spec.md's Assumptions & Interpretations section and approve or
correct each line. Do not run ticket_runner.py against this output, and
do not run /contract-plan, until that review has happened -- this step
is allowed to guess; nothing downstream is.
```
