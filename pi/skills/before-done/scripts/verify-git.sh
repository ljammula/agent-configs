#!/usr/bin/env bash
# Verify commit/worktree/push state after git operations.
# Usage: ./verify-git.sh
# Exits non-zero if the worktree is dirty or HEAD hasn't reached any remote.
set -euo pipefail

echo "== Last 3 commits =="
git log --oneline -3

echo "== Worktree =="
if [[ -n "$(git status --porcelain)" ]]; then
  git status --short
  echo "FAIL: worktree is dirty"
  exit 1
fi
echo "clean"

echo "== Push state =="
if git branch -r --contains HEAD | grep -q .; then
  echo "HEAD is on remote: $(git branch -r --contains HEAD | head -3 | tr -d ' ' | paste -sd, -)"
else
  echo "FAIL: HEAD not found on any remote (not pushed)"
  exit 1
fi
