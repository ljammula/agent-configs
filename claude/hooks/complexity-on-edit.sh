#!/bin/bash
# PostToolUse hook (Write|Edit): hold edited Go and Python functions to at most
# MAX decision points (cyclomatic complexity). Exit 2 shows stderr to Claude.
#
# A function is reported when it is over MAX and is new, or grew, since the
# file's HEAD version. A function that was already over and did not grow is
# left alone, so old code does not fail every edit of its file.
#
# Needs gocyclo (go install github.com/fzipp/gocyclo/cmd/gocyclo@v0.6.0) for
# Go and ruff for Python; a missing tool skips that language.

MAX=25

f=$(jq -r '.tool_response.filePath // .tool_input.file_path // empty')
[ -n "$f" ] && [ -f "$f" ] || exit 0

# Prints "<complexity> <function>" for each function over MAX in file $1.
over_limit() {
  case "$1" in
    *.go)
      "$GOCYCLO" -over "$MAX" "$1" 2>/dev/null | awk '{print $1, $3}'
      ;;
    *.py)
      ruff check --isolated --no-cache --quiet --select C901 \
        --config "lint.mccabe.max-complexity=$MAX" --output-format concise "$1" 2>/dev/null |
        sed -nE 's/.*C901 `([^`]+)` is too complex \(([0-9]+) > [0-9]+\).*/\2 \1/p'
      ;;
  esac
}

case "$f" in
  *.go)
    GOCYCLO=$(command -v gocyclo || echo "$(go env GOPATH 2>/dev/null)/bin/gocyclo")
    [ -x "$GOCYCLO" ] || exit 0
    head -5 "$f" | grep -q 'Code generated .* DO NOT EDIT' && exit 0
    ;;
  *.py)
    command -v ruff >/dev/null || exit 0
    ;;
  *)
    exit 0
    ;;
esac

now=$(over_limit "$f")
[ -n "$now" ] || exit 0

# The HEAD version, when the file is tracked, under the same extension.
old=""
dir=$(dirname "$f")
if rel=$(git -C "$dir" ls-files --full-name --error-unmatch "$f" 2>/dev/null); then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  if git -C "$dir" show "HEAD:$rel" >"$tmp/$(basename "$f")" 2>/dev/null; then
    old=$(over_limit "$tmp/$(basename "$f")")
  fi
fi

report=""
while read -r complexity name; do
  was=$(awk -v n="$name" '$2 == n {print $1}' <<<"$old" | head -1)
  if [ -z "$was" ]; then
    report+="  $name: $complexity decision points"$'\n'
  elif [ "$complexity" -gt "$was" ]; then
    report+="  $name: $complexity decision points (was $was at HEAD)"$'\n'
  fi
done <<<"$now"
[ -n "$report" ] || exit 0

{
  echo "Complexity limit: a function has at most $MAX decision points. In $f:"
  printf '%s' "$report"
  echo "Split each into smaller functions with one responsibility before reporting done."
} >&2
exit 2
