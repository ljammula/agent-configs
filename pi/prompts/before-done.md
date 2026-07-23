---
description: Completion gate — prove the work is actually done before saying so
---
Run the `before-done` skill against the current change. Do not report the task
complete until every check below has actually run and you have pasted its real
output.

1. `rtk git status` — confirm what changed, and that nothing unintended did.
2. Format: `make fmt` if defined, else `gofmt -l .` / `dart format --output=none
   --set-exit-if-changed .` for the languages present. Must be clean.
3. Tests: `make verify` if defined, else the project's test command. Must pass.
4. Lint/analyze if the project defines one.
5. If a PR exists, check CI status and open review threads.

Then report, in this format:

```
ran:      <command>  -> <pass/fail, key output line>
ran:      <command>  -> <pass/fail, key output line>
skipped:  <command>  -> <why>
verdict:  DONE | NOT DONE
```

A check you did not run is `skipped`, never `pass`. If anything failed, the
verdict is `NOT DONE` — fix it and rerun rather than reporting the failure as
finished work.
