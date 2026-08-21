---
description: Draft a detailed, disambiguated spec plus ticket decomposition from a rough idea
argument-hint: "<rough-input-path> [pilot-dir, default: current directory]"
---

Draft `spec/spec.md` and `spec/tickets/NNN-*.md` for the pilot dir at `$2`
(default: current directory) from the rough input at `$1`. `$1` may be a
few paragraphs, a bullet list, or freeform prose -- it does not need to be
precise. Your job is to make it precise, and to make every place you had
to guess visible rather than silently baked into downstream tickets.

This is the one step in this pipeline explicitly allowed to resolve
ambiguity rather than refuse to guess -- but every guess must be written
down as its own reviewable line, never absorbed silently into a ticket's
"Required changes" list where a human would have to reverse-engineer it
later. If you can't tell whether a real ambiguity exists or you're just
being cautious, resolve it and write down why; a resolved-and-flagged
assumption is useful, an unresolved question is not.

## 1. `spec/spec.md`

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
  and leave the deciding to the contract-writing step. Guessing at
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
- The full Assumptions & Interpretations list (even though it's also in
  the file -- this is what actually gets reviewed).
- The full Non-goals list.
- Ticket count and one line per ticket: number, slug, one-sentence goal.

Then this exact banner, and stop:

```
HUMAN REVIEW REQUIRED before this is a frozen spec.
Read spec/spec.md's Assumptions & Interpretations section and approve or
correct each line. Do not run ticket_runner.py against this output, and
do not proceed to contract/test generation, until that review has
happened -- this step is allowed to guess; nothing downstream is.
```
