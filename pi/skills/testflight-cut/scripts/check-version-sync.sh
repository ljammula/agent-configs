#!/usr/bin/env bash
# Verify a proposed iOS release version against every source of truth that
# App Store Connect will check *after* the upload -- pubspec, existing tags,
# and the version trains already used.
# Usage: ./check-version-sync.sh 0.1.5
# Prints one PASS/FAIL line per check. Exit 1 if any check failed.
set -uo pipefail

want="${1:-}"
if [[ -z "$want" ]]; then
  echo "usage: check-version-sync.sh <version>   e.g. 0.1.5" >&2
  exit 2
fi
want="${want#v}"; want="${want#t}"

root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not a git repo" >&2; exit 2; }
cd "$root" || exit 2

fail=0
pass() { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }

# --- 1. pubspec marketing version must equal the version being tagged.
pubspec="frontend/pubspec.yaml"
if [[ ! -f "$pubspec" ]]; then
  bad "pubspec not found at $pubspec"
else
  raw=$(awk '/^version:[[:space:]]/ {print $2; exit}' "$pubspec")
  pv="${raw%%+*}"
  if [[ "$pv" == "$want" ]]; then
    pass "pubspec version $pv matches requested $want"
  else
    bad "pubspec version is $pv but you are tagging $want -- edit $pubspec:version and commit before tagging"
  fi
fi

# --- 2. The t tag (what this script actually gates) must not already exist.
# v<want> is NOT checked here: house convention tags v and t at the same
# version on the same commit for a joint release, so v<want> existing
# already is the expected, normal case -- not a collision.
git fetch --tags --quiet origin 2>/dev/null || echo "NOTE  could not fetch tags from origin; local-only check"
if git rev-parse -q --verify "refs/tags/t$want" >/dev/null; then
  bad "tag t$want already exists -- pick a new version or a build suffix (t$want-2)"
else
  pass "tag t$want is free"
fi

# --- 3. Version must be strictly newer than the last t tag, and not a reuse of its train.
newest() { printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1; }
last_t=$(git tag -l 't*' --sort=-v:refname | head -1)
if [[ -z "$last_t" ]]; then
  pass "no prior t tag"
else
  base="${last_t#t}"; base="${base%%-*}"   # t0.1.1-2 -> 0.1.1
  if [[ "$base" == "$want" ]]; then
    bad "$want is the same train as $last_t -- App Store Connect closes a train once a build from it is submitted (ITMS-90186). Bump the patch instead."
  elif [[ "$(newest "$base" "$want")" == "$want" ]]; then
    pass "$want is newer than last t tag $last_t"
  else
    bad "$want is not newer than last t tag $last_t"
  fi
fi

# --- 4. Worktree must be clean, or the tag will point at code you did not verify.
if [[ -n "$(git status --porcelain)" ]]; then
  bad "worktree is dirty -- commit or stash before tagging"
else
  pass "worktree clean at $(git rev-parse --short HEAD)"
fi

exit $fail
