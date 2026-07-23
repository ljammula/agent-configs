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

# --- 2. Tags must not already exist (locally or on origin).
git fetch --tags --quiet origin 2>/dev/null || echo "NOTE  could not fetch tags from origin; local-only check"
for t in "v$want" "t$want"; do
  if git rev-parse -q --verify "refs/tags/$t" >/dev/null; then
    bad "tag $t already exists -- pick a new version or a build suffix (t$want-2)"
  else
    pass "tag $t is free"
  fi
done

# --- 3. Version must be strictly newer than the last release tag and the last build tag.
newest() { printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1; }
last_v=$(git tag -l 'v*' --sort=-v:refname | head -1)
last_t=$(git tag -l 't*' --sort=-v:refname | head -1)
for pair in "v:$last_v" "t:$last_t"; do
  prefix="${pair%%:*}"; last="${pair#*:}"
  [[ -z "$last" ]] && { pass "no prior $prefix tag"; continue; }
  base="${last#"$prefix"}"; base="${base%%-*}"   # t0.1.1-2 -> 0.1.1
  if [[ "$base" == "$want" ]]; then
    bad "$want is the same train as $last -- App Store Connect closes a train once a build from it is submitted (ITMS-90186). Bump the patch instead."
  elif [[ "$(newest "$base" "$want")" == "$want" ]]; then
    pass "$want is newer than last $prefix tag $last"
  else
    bad "$want is not newer than last $prefix tag $last"
  fi
done

# --- 4. Worktree must be clean, or the tag will point at code you did not verify.
if [[ -n "$(git status --porcelain)" ]]; then
  bad "worktree is dirty -- commit or stash before tagging"
else
  pass "worktree clean at $(git rev-parse --short HEAD)"
fi

exit $fail
