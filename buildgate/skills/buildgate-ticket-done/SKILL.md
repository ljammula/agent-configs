---
name: buildgate-ticket-done
description: Use in every buildgate build or corrective round, before ending the turn. The ticket's header lines (Verify-Command, Allowed-Files, Required-Changed-Files, Tests-Required) and its acceptance criteria define done; this checks the work meets them.
---

# Ticket done (buildgate)

The build system, not you, decides whether this round passed. After your turn it runs the ticket's `Verify-Command`, checks which files changed, and may run a reference oracle and reviewers. Any miss comes back as a corrective round, so ending the turn early costs a round.

Before ending the turn:

1. **Verify.** Run the ticket's `Verify-Command` exactly as written in its header. Read the whole output and the exit status. If it fails, fix the cause and run it again. If it cannot run in this sandbox (no network, a missing tool), say so in one line; do not change the command or substitute another.
2. **Files.** Every path in `Required-Changed-Files` is changed. Nothing outside `Allowed-Files` is changed (check `git status` and `git diff --name-only`).
3. **Tests.** Unless the ticket says `Tests-Required: no`, a test you added or changed exercises the new behaviour, in a file listed in `Allowed-Files`.
4. **Criteria.** For each acceptance criterion the ticket covers, name the test or the code that shows it holds. A criterion with no evidence is not done.
5. **Oracles.** Never edit reference or oracle tests the round mounts read-only (for example under `.oracle/` or `.buildgate/`). When one fails, fix the code it tests.
6. **Git.** Do not commit, branch, push or write commit messages; the build system owns them.

In a corrective round, the prompt names the failing signal: the canonical command's output, the oracle's output, or reviewer findings. Fix that signal with the smallest change, then repeat this checklist.
