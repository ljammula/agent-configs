#!/bin/bash
# Query the local SearXNG instance directly instead of burning a cloud
# WebSearch call. Read-only, no local model in the loop -- Claude is the
# only judgment layer here, which is why this is safe even though the rest
# of the local stack self-corrects mechanical mistakes but not logic ones.
set -euo pipefail

# Host defaults to localhost but can point at a LAN-served stack via
# AI_STACK_HOST (e.g. 192.168.1.233). SEARXNG_URL still wins if set outright.
HOST="${AI_STACK_HOST:-127.0.0.1}"
SEARXNG_URL="${SEARXNG_URL:-http://$HOST:8888}"
QUERY="$*"

if [[ -z "$QUERY" ]]; then
  echo "usage: search.sh <query>" >&2
  exit 1
fi

if ! curl -sf --max-time 2 "$SEARXNG_URL/" >/dev/null 2>&1; then
  echo "error: SearXNG not reachable at $SEARXNG_URL -- fall back to WebSearch" >&2
  exit 1
fi

curl -sf --max-time 8 "$SEARXNG_URL/search" \
  --get --data-urlencode "q=$QUERY" --data-urlencode "format=json" \
  | python3 -c '
import json, sys

try:
    data = json.load(sys.stdin)
except json.JSONDecodeError:
    print("error: SearXNG did not return JSON -- is `formats: [json]` enabled in settings.yml? fall back to WebSearch", file=sys.stderr)
    sys.exit(1)

results = data.get("results", [])[:8]
if not results:
    print("error: no results found", file=sys.stderr)
    sys.exit(1)
for r in results:
    title = r.get("title", "")
    url = r.get("url", "")
    content = r.get("content", "")
    print(f"- {title} ({url}): {content}")
'
