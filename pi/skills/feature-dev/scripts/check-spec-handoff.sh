#!/usr/bin/env bash
# Verify the minimum evidence structure for a DayTrix feature handoff.
# Usage: check-spec-handoff.sh --ready|--complete docs/specs/<feature>.md
set -euo pipefail

mode="${1:-}"
spec="${2:-}"
if [[ "$mode" != "--ready" && "$mode" != "--complete" ]] || [[ -z "$spec" ]]; then
  echo "usage: $0 --ready|--complete docs/specs/<feature>.md" >&2
  exit 2
fi
[[ -f "$spec" ]] || { echo "FAIL  spec not found: $spec"; exit 1; }

fail=0
pass() { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }

required_sections=(
  "Outcome"
  "Requirements"
  "Non-goals / unchanged behavior"
  "Decisions and open questions"
  "Scenarios and invariants"
  "Technical plan and contracts"
  "Tasks and verification"
  "Acceptance matrix"
)
for section in "${required_sections[@]}"; do
  if grep -Fqx "## $section" "$spec"; then
    pass "section: $section"
  else
    bad "missing section: $section"
  fi
done

requirements=$(awk '
  /^## Requirements$/ { in_requirements=1; next }
  /^## / { in_requirements=0 }
  in_requirements { print }
' "$spec" | grep -oE 'R-[1-9][0-9]*' | sort -u || true)
if [[ -z "$requirements" ]]; then
  bad "no numbered R-* requirements"
else
  pass "numbered requirements found"
fi

if [[ "$mode" == "--ready" ]]; then
  grep -Fqx "Status: ready" "$spec" && pass "status: ready" || bad "Status must be ready before implementation"
else
  grep -Fqx "Status: implemented" "$spec" && pass "status: implemented" || bad "Status must be implemented for completion evidence"
fi
grep -Fqx "Open questions that change behavior: 0" "$spec" && pass "behavior-changing open questions: 0" || bad "behavior-changing open questions must be 0"

while IFS= read -r requirement; do
  [[ -z "$requirement" ]] && continue
  row=$(grep -E "^[[:space:]]*\\|[[:space:]]*${requirement}[[:space:]]*\\|" "$spec" | head -1 || true)
  if [[ -z "$row" ]]; then
    bad "$requirement has no acceptance-matrix row"
    continue
  fi
  if [[ "$mode" == "--complete" ]]; then
    IFS='|' read -r _ id implementation automated manual status _ <<<"$row"
    if [[ -z "${implementation//[[:space:]]/}" || -z "${automated//[[:space:]]/}" || -z "${manual//[[:space:]]/}" ]]; then
      bad "$requirement is missing implementation or evidence"
    elif [[ "$implementation$automated$manual" == *'<'* || "$implementation$automated$manual" == *'>'* ]]; then
      bad "$requirement still has template placeholders"
    elif [[ "$status" =~ (✓|PASS) ]]; then
      pass "$requirement completion evidence"
    else
      bad "$requirement acceptance status is not PASS"
    fi
  else
    pass "$requirement acceptance-matrix row"
  fi
done <<<"$requirements"

exit "$fail"
