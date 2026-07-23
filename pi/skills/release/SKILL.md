---
name: release
description: >
  Cut and deploy a DayTrix release end to end: preflight on main, make verify,
  semver tag, push, watch the deploy workflow, smoke-test production.
  Trigger on: "release", "cut a release", "ship it", "deploy to prod", "tag vX.Y.Z".
  User-triggered only — invoke via /release.
disable-model-invocation: true
---

# Release

This skill **pushes a tag and deploys to production**. Never fire it as a side effect
of another task — the user invokes it explicitly.

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

Deterministic — the bundled script reads the last tag and the commits since it, and
prints `<next-tag> <bump-kind> <reason>`:

```bash
~/.pi/agent/skills/release/scripts/next-version.sh
```

- If the user named a version, use theirs and ignore the script's suggestion.
- **major** is never automatic — only when the user explicitly asks.
- State the chosen version and the reasoning before tagging.

To review what is shipping:
```bash
git log $(git tag --sort=-v:refname | head -1)..HEAD --oneline
```

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
