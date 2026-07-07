---
name: before-done
description: >
  Run this gate before reporting any task complete — never say "done" without it.
  Trigger after: any code change, UI addition, feature implementation, bug fix, refactor.
  Trigger after: creating a PR, pushing, resolving review comments, claiming CI passed or failed.
  Trigger when user asks: "did it work?", "does it pass?", "created a PR?", "pushed?",
  "was it resolved?", "is CI passing?", or pastes a GitHub Actions or PR URL.
  The pattern this prevents: Claude says "done" → user checks manually → user comes back
  with what was missed (lint failure, duplicate UI, spec gap, PR not created, thread still open).
---

# Before Done

Do not say "done", "complete", "all good", or "looks good" until every applicable check below passes. The bar is **100% confidence** — the user's explicit standard from session history.

---

## Phase 1 — Code Correctness (after any code change)

Run these before touching GitHub or reporting completion. These are the checks Claude most commonly skips.

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
After any feature change, explicitly ask: could this have broken a nearby flow? Run the Flutter test suite or spot-check the affected widget/handler. The user has asked "did you double check other features?" as a correction multiple times.

**Flutter tests — always use `--concurrency=2`** on this machine (4-core RPi, 8 GB RAM). `--concurrency=4` risks OOM; the default is also too high.
```bash
cd frontend && flutter test --concurrency=2
```

**Golden test failures** land in `test/**/failures/` directories (gitignored). After any widget change, run `--update-goldens` on affected test dirs, then re-run the full suite to confirm clean:
```bash
cd frontend && flutter test --update-goldens test/features/<changed_feature>/
cd frontend && flutter test --concurrency=2
```

**Time-dependent tests**: any test that schedules events at fixed clock times (e.g. `DateTime(now.year, now.month, now.day, 9)`) will fail once that time passes. Use relative times (`DateTime.now().add(Duration(...))`) instead.

### 5. Local preview — Flutter UI changes only
After any change to `frontend/lib/` (widgets, screens, navigation), rebuild the local preview and run the Playwright smoke suite before sharing the URL with the user.

```bash
# Rebuild Flutter web with current code (takes ~2 min on Pi)
make serve-local   # backend + build + SW + serve at http://localhost:3000

# Verify — must be 5/5 pass, zero auth errors
BASE_URL=http://localhost:3000 npx playwright test \
  --config=playwright.local.config.js e2e/local-preview.spec.js
```

Do not say "open http://localhost:3000" until Playwright confirms it passes.
Screenshots land in `test-results/preview-*.png` — read them to verify the UI looks right before showing the user.

---

## Phase 2 — External State (after GitHub/git actions)

Run these after any git or GitHub operation.

### 5. Commits and worktree

Deterministic — run the bundled script (checks last commits, dirty worktree, push reached remote):
```bash
~/.claude/skills/before-done/scripts/verify-git.sh
```
Non-zero exit = not done; the output says which check failed.

### 6. PR creation
```bash
gh pr view <number> --repo <owner>/<repo>
```
Return the URL explicitly. Do not report "PR created" without showing it.

### 7. CI status

Deterministic — the bundled script finds the latest run, watches it to completion, and prints the conclusion per job (do not use `gh pr checks` — it often shows "no checks" while a run is in flight):
```bash
~/.claude/skills/before-done/scripts/check-ci.sh ljammula/personal-assistant [branch]
```
Exit 0 = CI passes. Do not describe what CI *should* show — report what the script printed.

### 8. Review threads — check AND resolve

Deterministic — the bundled script lists unresolved threads (read-only):
```bash
~/.claude/skills/before-done/scripts/check-threads.sh OWNER REPO NUMBER
```

**After fixing issues from a review thread, resolve it** — do not just comment. Use `narsimha-j` to resolve (same account used for reviews), then switch back:
```bash
gh auth switch --user narsimha-j
gh api graphql -f query="mutation { resolveReviewThread(input: {threadId: \"THREAD_ID\"}) { thread { isResolved } } }"
gh auth switch --user ljammula
```

Only resolve threads whose issues you actually fixed in this session. Re-run the check script after — zero unresolved = done. Any unresolved = not done.

### 9. Rebase conflicts — branch already partially merged

If `git rebase origin/main` hits conflicts on commits that were already squash-merged, do not attempt recovery here — it ends in a force push. Report the situation and point the user to `/pr-remediate` (Runbook 2).

---

## Output Format

Report checks in this order — Phase 1 first, Phase 2 second:

```
✓ Lint passes
✓ No spec doc found / Spec verified — implementation matches
✓ No redundant UI introduced
✓ Adjacent features unaffected (959/959 tests, --concurrency=2)
✓ Local preview: 5/5 Playwright pass, screenshots verified  ← Flutter UI changes only
✓ Commit abc1234 — "fix: correct message", worktree clean
✓ PR #92 open — https://github.com/.../pull/92
✓ CI: run 12345678 — all jobs success
✓ Review threads: 0 unresolved (resolved via narsimha-j)
```

**If any item is `✗`, do not say "done."** Fix the `✗` item or explicitly surface it to the user with a reason why it's acceptable to leave open. A response with an unaddressed `✗` is not a completion report — it's a status update.

---

## Required Tools

| Tool | Used for |
|---|---|
| `Bash` + `make lint` / `dart analyze` | Phase 1 lint check |
| `Read` + `ls docs/specs/` | Phase 1 spec verification |
| `Bash` + `flutter test --concurrency=2` | Phase 1 full test suite (RPi safe) |
| `Bash` + `flutter test --update-goldens` | Phase 1 golden image refresh |
| `Bash` + `scripts/verify-git.sh` | Phase 2 commit and push confirmation |
| `Bash` + `scripts/check-ci.sh` | Phase 2 CI status (prefer over `gh pr checks`) |
| `Bash` + `scripts/check-threads.sh` | Phase 2 unresolved-thread check |
| `Bash` + `gh api graphql resolveReviewThread` | Phase 2 thread resolution via narsimha-j |
| `WebFetch` | Fallback when `gh` CLI lacks access or user pastes a raw URL |
| `Bash` + `make serve-local` + `playwright test` | Phase 1 local preview check for Flutter UI changes |
