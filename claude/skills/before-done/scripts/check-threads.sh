#!/usr/bin/env bash
# List unresolved review threads on a PR.
# Usage: ./check-threads.sh <owner> <repo> <pr-number>
# Prints unresolved threads (id, path, first comment); exits 0 if none, 1 if any.
set -euo pipefail

owner="${1:?Usage: $0 <owner> <repo> <pr-number>}"
repo="${2:?Usage: $0 <owner> <repo> <pr-number>}"
pr="${3:?Usage: $0 <owner> <repo> <pr-number>}"

unresolved=$(gh api graphql -f query="
{
  repository(owner: \"$owner\", name: \"$repo\") {
    pullRequest(number: $pr) {
      reviewThreads(first: 50) {
        nodes { id isResolved comments(first: 1) { nodes { body path } } }
      }
    }
  }
}" --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)]')

count=$(echo "$unresolved" | jq 'length')
if [[ "$count" -eq 0 ]]; then
  echo "0 unresolved review threads"
  exit 0
fi

echo "$count unresolved thread(s):"
echo "$unresolved" | jq -r '.[] | "\(.id)\t\(.comments.nodes[0].path)\t\(.comments.nodes[0].body | split("\n")[0] | .[0:100])"'
exit 1
