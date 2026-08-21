---
description: Scaffold a fresh ticket_runner.py pilot dir (control dir + empty workspace)
argument-hint: "<pilot-dir-path>"
---

Create a fresh, empty pilot dir at `$1` for the `ticket_runner.py`
pipeline (see `plans/zero-human-fullstack-pipeline-plan-2026-08-20.md`'s
`## Deliverables` for the layout this reproduces). This step only
creates the skeleton -- it does not write a spec (`/spec-plan` does that
next) and does not build the app. Nothing below is a judgment call: run
every command exactly as written, do not retype or reformat any of it,
and report each command's real output -- do not report a step done
without having actually run it.

### Step 1 -- directories

```
mkdir -p "$1/spec/tickets" "$1/spec/acceptance" "$1/workspace"
```

### Step 2 -- the control dir's own git repo

```
cd "$1" && git init
```

This is the **control dir's** repo. Do not run `git init` or commit
anything inside `$1/workspace/` -- that gets its own separate repo
later, when ticket 001 runs (per `new-project-scaffold.ts`'s nudge for a
genuinely empty app repo). A pilot dir with a repo nested inside another
repo is intentional, not a mistake -- the `.gitignore` written next is
what keeps the control dir's repo from trying to track `workspace/`'s
contents.

### Step 3 -- `.gitignore`

Run this exact command as a single `bash` call, copied verbatim,
including the closing `EOF` line:

```
cat > "$1/.gitignore" <<'EOF'
workspace/
.ticket_runner.lock
EOF
```

### Step 4 -- `Makefile`

Run this exact command as a single `bash` call, copied verbatim,
including the closing `EOF` line. The lines starting `$(RUNNER)` and
`@ls` each begin with one literal tab character inside this heredoc --
do not replace it with spaces, Make requires a literal tab there.

```
cat > "$1/Makefile" <<'EOF'
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

### Step 5 -- initial commit

```
cd "$1" && git add .gitignore Makefile && git commit -m "chore: scaffold pilot dir"
```

### Step 6 -- verify and report

Run `find "$1" -not -path '*/workspace/*'` (or equivalent) and paste the
output. Confirm `$1/workspace/` exists, is empty, and has no `.git` yet
-- if it does, something above ran in the wrong place; stop and say so
rather than proceeding.

Then end with this exact block, with `$1` replaced by the real path:

```
Scaffold done at $1. Next:
1. Draft the spec: /spec-plan <rough-input-path> $1
   -- or write $1/spec/spec.md by hand if you already have a frozen one.
   Either way, review it before treating it as frozen.
2. Compile the API contract and acceptance-test suite. This stays a
   cloud/human step, not local tooling -- see Phase 1 of the plan.
3. If /spec-plan didn't already produce spec/tickets/NNN-*.md, decompose
   the frozen spec into tickets now.
4. cd $1 && make run
```
