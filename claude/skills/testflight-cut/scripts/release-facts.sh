#!/usr/bin/env bash
# Print the ground truth a release note must be written from: what actually
# shipped since the last build tag, and which features are gated off by default.
# Usage: ./release-facts.sh [since_tag]     (default: last t* tag)
set -uo pipefail

root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not a git repo" >&2; exit 2; }
cd "$root" || exit 2

since="${1:-$(git tag -l 't*' --sort=-v:refname | head -1)}"
if [[ -z "$since" ]]; then
  echo "no t* tag found; using full history" >&2
  range="HEAD"
else
  range="$since..HEAD"
fi

echo "=== COMMITS SHIPPING IN THIS BUILD ($range)"
git log "$range" --no-merges --format='%h %s'
echo
echo "=== USER-FACING SURFACE TOUCHED"
git diff --name-only "$range" -- frontend/lib backend/internal | sed 's|/[^/]*$||' | sort -u
echo
echo "=== FEATURE GATE DEFAULTS (backend/internal/userfeatures/feature.go)"
echo "Anything listed below as NOT default is off for a fresh reviewer account."
echo "Do not describe it as available in the release notes."
if [[ -f backend/internal/userfeatures/feature.go ]]; then
  defaults=$(awk '/^var defaultFeatures/,/^}/' backend/internal/userfeatures/feature.go | grep -oE '"[a-z_]+"' | tr -d '"')
  compat=$(awk '/^var rolloutCompatibilityFeatures/,/^}/' backend/internal/userfeatures/feature.go | grep -oE 'Feature[A-Za-z]+' | grep -v '^Feature$')
  all=$(grep -oE 'Feature[A-Za-z]+ +=' backend/internal/userfeatures/feature.go | awk '{print $1}')
  for f in $all; do
    key=$(grep -E "^\s*$f = " backend/internal/userfeatures/feature.go | grep -oE '"[a-z_]+"' | tr -d '"')
    state="NOT default (admin grant required)"
    grep -qx "$key" <<<"$defaults" && state="default ON"
    grep -qx "$f" <<<"$compat" && state="default ON (rollout compatibility)"
    printf '  %-22s %s\n' "$key" "$state"
  done
else
  echo "  (feature.go not found -- verify gating manually)"
fi
