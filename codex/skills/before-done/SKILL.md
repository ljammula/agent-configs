---
name: before-done
description: >
  Run this gate before reporting any task complete — never say "done" without it.
  Trigger after: any code change, UI addition, feature implementation, bug fix, refactor.
  Trigger after: creating a PR, pushing, resolving review comments, claiming CI passed or failed.
  Trigger when user asks: "did it work?", "does it pass?", "created a PR?", "pushed?",
  "was it resolved?", "is CI passing?", or pastes a GitHub Actions or PR URL.
  The pattern this prevents: agent says "done" → user checks manually → user comes back
  with what was missed (lint failure, duplicate UI, spec gap, PR not created, thread still open).
---

# Before Done

Do not say "done", "complete", "all good", or "looks good" until every applicable check below passes. The bar is **100% confidence**.

---

## Phase 1 — Code Correctness (after any code change)

Run these before touching GitHub or reporting completion.

### 1. Lint
```bash
make lint          # both frontend and backend
# or scoped:
dart analyze       # frontend only
cd backend && golangci-lint run   # backend only
```
Do not skip because "it's a small change." Lint failures are the most common user follow-up.

### 2. Spec doc — lookup is deterministic, gap detection is AI judgment

```bash
ls docs/specs/ 2>/dev/null
```

If a spec file exists for the feature being changed, print it:
```bash
cat docs/specs/<feature>.md
```

Then identify any gap between spec and implementation. Do not try to recall the spec from memory — always run the bash steps first.

### 3. Redundant UI (for any UI change)
After adding a button, FAB, action, or link — scan the same screen/widget for other elements that do the same thing. Duplicate invite paths, copy-link buttons, and FABs on the same page have been caught by the user repeatedly.

### 4. Adjacent features
After any feature change, explicitly ask: could this have broken a nearby flow? Run the Flutter test suite or spot-check the affected widget/handler.

**Flutter tests — always use `--concurrency=2`** on this machine (4-core RPi, 8 GB RAM).
```bash
cd frontend && flutter test --concurrency=2
```

**Golden test failures** land in `test/**/failures/` directories. After any widget change:
```bash
cd frontend && flutter test --update-goldens test/features/<changed_feature>/
cd frontend && flutter test --concurrency=2
```

### 5. Local preview — Flutter UI changes only
```bash
make serve-local   # backend + build + SW + serve at http://localhost:3000

BASE_URL=http://localhost:3000 npx playwright test \
  --config=playwright.local.config.js e2e/local-preview.spec.js
```
Do not say "open http://localhost:3000" until Playwright confirms it passes.

---

## Phase 2 — External State (after GitHub/git actions)

### 5. Commits and worktree
```bash
rtk git log --oneline -3
rtk git status
rtk git log --remotes --oneline -3
```

### 6. PR creation
```bash
gh pr view <number> --repo <owner>/<repo>
```
Return the URL explicitly. Do not report "PR created" without showing it.

### 7. CI status
```bash
gh run list --repo ljammula/personal-assistant --limit 5
gh run view <run-id> --repo ljammula/personal-assistant --json status,conclusion,jobs
```
Poll until `"status":"completed"`. Do not describe what CI *should* show — fetch what it *does* show.

### 8. Review threads — check AND resolve

> **⚠️ REQUIRES EXPLICIT USER APPROVAL** — resolving threads switches GitHub auth accounts (`narsimha-j`). Do not execute the mutation below unless the user has asked you to resolve threads in this session.

```bash
gh api graphql -f query='
{
  repository(owner: "OWNER", name: "REPO") {
    pullRequest(number: NUMBER) {
      reviewThreads(first: 20) {
        nodes { id isResolved comments(first:1) { nodes { body path } } }
      }
    }
  }
}'
```

To resolve:
```bash
gh auth switch --user narsimha-j
gh api graphql -f query="mutation { resolveReviewThread(input: {threadId: \"THREAD_ID\"}) { thread { isResolved } } }"
gh auth switch --user ljammula
```

### 9. Rebase conflicts — branch already partially merged

> **⚠️ REQUIRES EXPLICIT USER APPROVAL** — this section ends with `git push origin HEAD --force`. Do not execute it autonomously. Describe the situation to the user and wait for confirmation before running any `--force` command.

```bash
git rebase --abort
git checkout -b <branch>-rebased origin/main
git cherry-pick <only-new-commit-sha>
git checkout <original-branch>
git reset --hard <branch>-rebased
git branch -D <branch>-rebased
git push origin HEAD --force
```

---

## Output Format

```
✓ Lint passes
✓ No spec doc found / Spec verified — implementation matches
✓ No redundant UI introduced
✓ Adjacent features unaffected (N/N tests, --concurrency=2)
✓ Local preview: 5/5 Playwright pass  ← Flutter UI changes only
✓ Commit abc1234 — "fix: correct message", worktree clean
✓ PR #N open — https://github.com/.../pull/N
✓ CI: run 12345678 — all jobs success
✓ Review threads: 0 unresolved
```

**If any item is `✗`, do not say "done."**
