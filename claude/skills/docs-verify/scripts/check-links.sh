#!/usr/bin/env bash
# Extract all http(s) URLs from the given files and verify each responds.
# Usage: ./check-links.sh <file> [file...]
# Prints one line per URL: <status> <url>. Exits 1 if any URL is dead (>=400 or no response).
set -uo pipefail

[[ $# -ge 1 ]] || { echo "Usage: $0 <file> [file...]"; exit 2; }

urls=$(grep -hoE 'https?://[^ )>"'"'"'`<]+' "$@" | sed 's/[.,;:]*$//' | sort -u)
if [[ -z "$urls" ]]; then
  echo "No URLs found in: $*"
  exit 0
fi

fail=0
while IFS= read -r url; do
  code=$(curl -sL -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo "000")
  if [[ "$code" -ge 200 && "$code" -lt 400 ]]; then
    echo "OK   $code  $url"
  else
    echo "DEAD $code  $url"
    fail=1
  fi
done <<< "$urls"

exit $fail
