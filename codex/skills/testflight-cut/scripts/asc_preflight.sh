#!/usr/bin/env bash
# Compare the proposed Flutter build number with App Store Connect's actual
# highest build. ASC_APP_ID is explicit so this script never guesses an app.
# Usage: ASC_APP_ID=1234567890 ./asc_preflight.sh 0.1.5
set -uo pipefail

want="${1:-}"
if [[ -z "$want" ]]; then
  echo "usage: ASC_APP_ID=<Apple app id> $0 <version>   e.g. 0.1.5" >&2
  exit 2
fi
want="${want#v}"; want="${want#t}"

root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "FAIL  not a git repo" >&2; exit 2; }
cd "$root" || exit 2

fail() { printf 'FAIL  %s\n' "$1"; exit 1; }
pass() { printf 'PASS  %s\n' "$1"; }

if [[ -z "${ASC_APP_ID:-}" ]]; then
  fail "ASC_APP_ID is required (the numeric App Store Connect application ID)"
fi
if ! command -v app-store-connect >/dev/null 2>&1; then
  fail "app-store-connect CLI is not installed; install Codemagic CLI tools and configure App Store Connect API credentials"
fi
if ! command -v jq >/dev/null 2>&1; then
  fail "jq is required to parse the App Store Connect response"
fi

pubspec="frontend/pubspec.yaml"
[[ -f "$pubspec" ]] || fail "pubspec not found at $pubspec"
raw=$(awk '/^version:[[:space:]]/ {print $2; exit}' "$pubspec")
proposed_version="${raw%%+*}"
proposed_build="${raw#*+}"
[[ "$proposed_version" == "$want" ]] || fail "pubspec version is $proposed_version but requested version is $want"
[[ "$raw" == *+* && "$proposed_build" =~ ^[0-9]+$ ]] || fail "pubspec version must include a numeric build suffix (found $raw)"

# --all-versions prevents a lower-version hotfix from reusing a global build
# number. --include-version makes the PASS/FAIL output auditable.
if ! response=$(app-store-connect get-latest-app-store-build-number --all-versions --include-version --json "$ASC_APP_ID"); then
  fail "App Store Connect query failed; verify ASC_APP_ID and APP_STORE_CONNECT_{ISSUER_ID,KEY_IDENTIFIER,PRIVATE_KEY}"
fi

if [[ -z "$response" || "$response" == "null" ]]; then
  pass "ASC has no App Store builds; proposed $proposed_version+$proposed_build is the first"
  exit 0
fi

# CLI JSON has used camelCase fields; accept snake_case too to make a format
# change fail only when the required build/version facts are truly absent.
latest=$(jq -er '
  .. | objects |
  select((.buildNumber? // .build_number?) != null and (.version? // .versionString? // .version_string?) != null) |
  [(.version // .versionString // .version_string), (.buildNumber // .build_number)] | @tsv
' <<<"$response" 2>/dev/null | head -1) || fail "could not parse App Store Connect's latest build response"
IFS=$'\t' read -r latest_version latest_build <<<"$latest"
[[ "$latest_build" =~ ^[0-9]+$ ]] || fail "ASC returned a non-numeric latest build ($latest_build)"

# Avoid shell-integer overflow: compare normalized decimal strings by length,
# then lexicographically when equal length.
greater_build() {
  local candidate="$1" current="$2"
  while [[ "$candidate" == 0* && ${#candidate} -gt 1 ]]; do candidate="${candidate#0}"; done
  while [[ "$current" == 0* && ${#current} -gt 1 ]]; do current="${current#0}"; done
  [[ -n "$candidate" ]] || candidate=0
  [[ -n "$current" ]] || current=0
  (( ${#candidate} > ${#current} )) || { (( ${#candidate} == ${#current} )) && [[ "$candidate" > "$current" ]]; }
}

if greater_build "$proposed_build" "$latest_build"; then
  pass "ASC latest $latest_version+$latest_build; proposed $proposed_version+$proposed_build is strictly greater"
else
  fail "ASC latest $latest_version+$latest_build; proposed $proposed_version+$proposed_build must use a strictly greater build number"
fi
