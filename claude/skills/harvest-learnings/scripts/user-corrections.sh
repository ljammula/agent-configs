#!/bin/bash
# Print the user's own typed messages from Claude Code transcripts that look
# like corrections, one per line, truncated. Tool results, system reminders,
# and command output are skipped.
#
# Usage: user-corrections.sh <transcript-dir> [max-chars]
set -euo pipefail

dir="${1:?usage: user-corrections.sh <transcript-dir> [max-chars]}"
max="${2:-300}"
pattern="\\b(no|don'?t|do not|stop|never|always|wrong|instead|why did|why are|i said|i asked|i prefer|i want|should have|not what|again)\\b"

for f in "$dir"/*.jsonl; do
  jq -r --argjson max "$max" '
    select(.type == "user" and (.message.content | type) == "string")
    | .message.content
    | select(test("^(<|Stop hook feedback|Another Claude session|\\[Subagent|Check run )") | not)
    | gsub("\\s+"; " ")
    | .[0:$max]' "$f" 2>/dev/null
done | grep -iE "$pattern" | awk '!seen[$0]++'
