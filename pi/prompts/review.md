---
description: Review the working diff for correctness, scope, and simplicity
---
Review the current working diff. Do this in order and do not skip a step:

1. Run `rtk git status` and `rtk git diff` (add `--cached` if the tree is clean
   but staged changes exist). If both are empty, say so and stop.
2. For every changed file, read enough surrounding code to judge the change in
   context. A diff hunk alone is not enough context to call something correct.
3. Report findings grouped under these headings, most severe first:
   - **Correctness** — logic errors, unhandled errors, broken edge cases
   - **Scope** — lines that do not trace to the stated task (refactors,
     renames, drive-by cleanups)
   - **Simplicity** — code that could be materially shorter or flatter
   - **Conventions** — deviations from the surrounding file's existing style
4. For each finding give `file:line`, one sentence on the defect, and a
   concrete failure case (inputs → wrong behavior). Drop any finding you
   cannot state a failure case for; that is the test for whether it is real.
5. End with a verdict: `CLEAN` or `NEEDS WORK`, and nothing else on that line.

Do not modify any files. This is a read-only review.
