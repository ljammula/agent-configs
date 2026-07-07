---
name: pr-remediate
description: >
  Recover a feature branch whose commits were already squash-merged to main —
  rebase hits conflicts on merged commits; recovery cherry-picks the genuinely new
  commits onto origin/main and ends in a force push. User-triggered only — invoke
  via /pr-remediate when a rebase hits already-merged-commit conflicts.
disable-model-invocation: true
---

# PR Remediate — Rebase recovery (branch partially squash-merged)

This runbook **mutates external state** (ends in `git push --force`). Never run it
as part of an automatic completion check — the user invokes this skill explicitly.

When a feature branch has commits that were squash-merged to main (common after PR #N
merges while you're still working), `git rebase origin/main` will hit conflicts on the
already-merged commits.

First decide which commits are genuinely new:
```bash
git log origin/main..HEAD
```

Only cherry-pick commits that are genuinely new (not already in main):
```bash
git rebase --abort
git checkout -b <branch>-rebased origin/main
git cherry-pick <only-new-commit-sha> [<only-new-commit-sha-2>]
git checkout <original-branch>
git reset --hard <branch>-rebased
git branch -D <branch>-rebased
git push origin HEAD --force
```

Confirm with the user before the `--force` push if there is any doubt about which
commits are new.
