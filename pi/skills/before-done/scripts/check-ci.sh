#!/usr/bin/env bash
# Poll the latest CI run for a repo (optionally a branch) until it completes.
# Usage: ./check-ci.sh <owner/repo> [branch]
# Exits 0 if the run concluded success, non-zero otherwise.
set -euo pipefail

repo="${1:?Usage: $0 <owner/repo> [branch]}"
branch="${2:-}"

args=(--repo "$repo" --limit 1 --json databaseId,status,headBranch,displayTitle)
[[ -n "$branch" ]] && args+=(--branch "$branch")

run_id=$(gh run list "${args[@]}" --jq '.[0].databaseId')
if [[ -z "$run_id" || "$run_id" == "null" ]]; then
  echo "No CI runs found for $repo${branch:+ on $branch}"
  exit 1
fi

echo "Watching run $run_id..."
gh run watch "$run_id" --repo "$repo" --exit-status --interval 15
gh run view "$run_id" --repo "$repo" --json status,conclusion,jobs \
  --jq '{status, conclusion, jobs: [.jobs[] | {name, conclusion}]}'
