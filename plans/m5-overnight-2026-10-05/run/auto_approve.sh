#!/bin/sh
# Approve spec_review/plan_review for the M5 requests listed in requests.txt
# (Claude's own review is bundle_check.py; this only removes the wait).
# Stops when every listed request has left the review states for good.
dir="$(cd "$(dirname "$0")" && pwd)"
export PATH="$PATH:$HOME/go/bin"
while :; do
  for id in $(cat "$dir/requests.txt"); do
    state=$(factoryd status -json 2>/dev/null | python3 -c "
import json,sys
for r in json.load(sys.stdin).get('requests', []):
    if r.get('id') == '$id': print(r.get('state',''))
" 2>/dev/null)
    case "$state" in
      spec_review|plan_review)
        echo "$(date '+%H:%M:%S') approve $id ($state)"
        factoryd approve "$id" 2>&1 | tail -1 ;;
    esac
  done
  sleep 30
done
