#!/usr/bin/env bash
# Verify localization coverage for the current branch's changes.
# Usage: ./check-l10n.sh [base_ref]   (default: main)
#   1. Every key added to app_en.arb exists in all sibling app_*.arb files.
#   2. No hardcoded user-facing string literals in changed Dart files.
# Exits 1 if either check fails, 0 if clean or the project has no l10n dir.
# The locale list is derived from the files on disk -- adding a language
# needs no edit here. Shared by before-done, feature-dev and frontend-dev;
# referenced from all three by absolute path.
set -uo pipefail

base="${1:-main}"
root=$(git rev-parse --show-toplevel) || exit 2
l10n="$root/frontend/lib/l10n"
template="$l10n/app_en.arb"

if [[ ! -f "$template" ]]; then
  echo "no $template -- l10n check does not apply to this project"
  exit 0
fi

fail=0

new_keys=$(git diff "$base" -- "$template" | grep '^+ *"' | grep -v '^+ *"@' | cut -d'"' -f2)
if [[ -z "$new_keys" ]]; then
  echo "OK   no new keys in app_en.arb"
else
  missing=0
  for f in "$l10n"/app_*.arb; do
    [[ "$f" == "$template" ]] && continue
    for key in $new_keys; do
      grep -q "\"$key\"" "$f" || { echo "MISSING $(basename "$f"): $key"; missing=1; }
    done
  done
  if [[ $missing -eq 1 ]]; then
    fail=1
  else
    echo "OK   $(echo "$new_keys" | wc -w | tr -d ' ') new key(s) present in every locale"
  fi
fi

hardcoded=$(git diff "$base" -- "$root/frontend/lib" \
  | grep -E "^\+.*(Text|content|label|title|hintText)[[:space:]]*[:(][[:space:]]*'")
if [[ -n "$hardcoded" ]]; then
  echo "HARDCODED user-facing string(s) in changed Dart -- use l10n keys:"
  echo "$hardcoded"
  fail=1
else
  echo "OK   no hardcoded user-facing strings in changed Dart"
fi

exit $fail
