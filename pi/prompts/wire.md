---
description: Verify every step of a multi-point wiring pattern exists in code
argument-hint: "<feature or component name>"
---
Run the `wiring-verify` skill for the feature named above.

1. Find the project's documented checklist for this kind of feature — check
   `CLAUDE.md`, `AGENTS.md`, `ARCHITECTURE.md`, or the spec docs. Quote the
   checklist you found, with its file path. If there is no documented pattern,
   derive one from the most recent comparable feature in git history and say
   that is what you did.
2. For each step, grep for the concrete evidence it exists and report:
   `step -> file:line` when found, `step -> MISSING` when not.
3. List the missing steps as a numbered plan of the edits needed.

Report the found/missing table before writing any code.
