#!/usr/bin/env bash
# Print the ground truth a release note must be written from: what actually
# shipped since the last build tag, and which features are gated off by default.
# Usage: ./release-facts.sh [since_tag]     (default: last t* tag)
set -uo pipefail

root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not a git repo" >&2; exit 2; }
cd "$root" || exit 2

arg="${1:-}"
if [[ -n "$arg" ]] && ! git rev-parse -q --verify "${arg}^{commit}" >/dev/null; then
  echo "error: '$arg' is not a valid tag or rev" >&2
  exit 2
fi

since="${arg:-$(git tag -l 't*' --sort=-v:refname | head -1)}"
if [[ -z "$since" ]]; then
  echo "no t* tag found; using full history" >&2
  log_range="HEAD"
  diff_base=$(git hash-object -t tree /dev/null)   # empty tree: diffs all history, not the working tree
else
  log_range="$since..HEAD"
  diff_base="$since"
fi

echo "=== COMMITS SHIPPING IN THIS BUILD ($log_range)"
commits=$(git log "$log_range" --no-merges --format='%h %s') || { echo "ERROR: git log failed for $log_range" >&2; exit 1; }
if [[ -z "$commits" ]]; then
  echo "(no commits in this range)"
else
  echo "$commits"
fi
echo

echo "=== USER-FACING SURFACE TOUCHED"
surface=$(git diff --name-only "$diff_base" HEAD -- frontend/lib backend/internal) || { echo "ERROR: git diff failed" >&2; exit 1; }
if [[ -z "$surface" ]]; then
  echo "(no user-facing files touched)"
else
  sed 's|/[^/]*$||' <<< "$surface" | sort -u
fi
echo

echo "=== FEATURE GATE DEFAULTS (backend/internal/userfeatures/feature.go)"
echo "Anything listed below as NOT default is off for a fresh reviewer account."
echo "Do not describe it as available in the release notes."
feature_go="backend/internal/userfeatures/feature.go"
if [[ -f "$feature_go" ]]; then
  const_block=$(awk '/^const \(/,/^\)/' "$feature_go")
  defaults=$(awk '/^var defaultFeatures/,/^}/' "$feature_go" | grep -oE '"[a-z_]+"' | tr -d '"')
  compat=$(awk '/^var rolloutCompatibilityFeatures/,/^}/' "$feature_go" | grep -oE 'Feature[A-Za-z]+' | grep -v '^Feature$')
  all=$(grep -oE '^[[:space:]]*Feature[A-Za-z]+' <<< "$const_block" | grep -oE 'Feature[A-Za-z]+')
  for f in $all; do
    key=$(grep -E "^[[:space:]]*${f}[[:space:]]*=" <<< "$const_block" | grep -oE '"[a-z_]+"' | tr -d '"')
    if [[ -z "$key" ]]; then
      printf '  %-22s %s\n' "$f" "ERROR: could not extract key -- verify manually"
      continue
    fi
    state="NOT default (admin grant required)"
    grep -qx "$key" <<< "$defaults" && state="default ON"
    grep -qx "$f" <<< "$compat" && state="default ON (rollout compatibility)"
    printf '  %-22s %s\n' "$key" "$state"
  done
else
  echo "  (feature.go not found -- verify gating manually)"
fi
