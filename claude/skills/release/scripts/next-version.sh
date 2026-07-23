#!/usr/bin/env bash
# Compute the next semver tag from the commits since the last tag.
# Usage: ./next-version.sh
# Rule: patch by default, minor if any `feat:` commit landed since the last
# tag. Major is never automatic -- the user asks for it explicitly, and a
# user-named version overrides this script entirely.
# Prints: <next-tag> <bump-kind> <reason>. Exits 1 if there is nothing to release.
set -euo pipefail

last=$(git tag -l 'v*' --sort=-v:refname | head -1)
if [[ -z "$last" ]]; then
  echo "v0.1.0 minor no prior tag"
  exit 0
fi

commits=$(git log "$last..HEAD" --format=%s)
if [[ -z "$commits" ]]; then
  echo "error: no commits since $last -- nothing to release" >&2
  exit 1
fi

IFS=. read -r major minor patch <<< "${last#v}"
if grep -qE '^feat(\(.+\))?!?:' <<< "$commits"; then
  echo "v$major.$((minor + 1)).0 minor feat: commit(s) since $last"
else
  echo "v$major.$minor.$((patch + 1)) patch no feat: commits since $last"
fi
