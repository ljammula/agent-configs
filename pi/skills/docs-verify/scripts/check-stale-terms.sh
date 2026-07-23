#!/usr/bin/env bash
# After a terminology rename, find every remaining occurrence of the old term.
# Usage: ./check-stale-terms.sh <old_term> [search_dir]
# Case-insensitive, searches docs and code text files. Exits 1 if any occurrence remains.
set -uo pipefail

old="${1:?Usage: $0 <old_term> [search_dir]}"
dir="${2:-.}"

matches=$(grep -rniI --exclude-dir={.git,node_modules,build,.dart_tool} \
  --include='*.md' --include='*.txt' --include='*.dart' --include='*.go' \
  --include='*.yaml' --include='*.yml' --include='*.json' --include='*.html' \
  "$old" "$dir" 2>/dev/null)

if [[ -z "$matches" ]]; then
  echo "0 occurrences of '$old' under $dir"
  exit 0
fi

count=$(echo "$matches" | wc -l | tr -d ' ')
echo "$count remaining occurrence(s) of '$old':"
echo "$matches"
exit 1
