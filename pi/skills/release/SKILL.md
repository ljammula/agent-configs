---
name: release
description: >
  Cut and deploy a DayTrix release end to end: preflight on main, make verify,
  semver tag, push, watch the deploy workflow, smoke-test production.
  Trigger on: "release", "cut a release", "ship it", "deploy to prod", "tag vX.Y.Z".
---

# Release

Deploy path: tag `vX.Y.Z` → GitHub Actions `deploy.yml` → Cloud Run `us-central1`.
Every step must pass before the next; any ✗ means the release is not done.

## 1. Preflight

```bash
git switch main && git pull
git status        # worktree must be clean — abort if dirty
make verify       # fmt + lint + tests — abort on failure
```

Do not release from a feature branch or with uncommitted changes.

## 2. Pick the version

```bash
git tag --sort=-v:refname | head -5
git log $(git tag --sort=-v:refname | head -1)..HEAD --oneline
```

- If the user named a version, use it.
- Otherwise: **patch** bump by default; **minor** if any `feat:` commit landed since the last tag; **major** only when the user explicitly asks.
- State the chosen version and the reasoning before tagging.

## 3. Tag and push (as ljammula)

```bash
gh auth status                  # active account must be ljammula
git tag vX.Y.Z
git push origin vX.Y.Z
```

## 4. Watch the deploy

```bash
gh run list --workflow=deploy.yml --limit 1   # find the run for this tag
gh run watch <run-id> --exit-status
```

If the deploy fails: do **not** delete or re-push the tag. Report the failing job with a log excerpt and stop — recovery is a user decision.

## 5. Smoke-test production

```bash
make test-e2e     # Playwright @smoke against the deployed URL
```

## 6. Report

```
✓ make verify passed on main @ <sha>
✓ Tagged vX.Y.Z (patch|minor: reason)
✓ Deploy run <url> — success
✓ Smoke: N/N @smoke tests pass against production
```
