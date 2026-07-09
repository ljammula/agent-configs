#!/bin/bash
# PostToolUse hook (Write|Edit): auto-format Go and Dart files after Claude edits them.
# Reads the tool payload JSON on stdin, formats the touched file in place.

f=$(jq -r '.tool_response.filePath // .tool_input.file_path // empty')
[ -n "$f" ] && [ -f "$f" ] || exit 0

case "$f" in
  *.go)
    command -v gofmt >/dev/null && gofmt -w "$f"
    ;;
  *.dart)
    command -v dart >/dev/null && dart format "$f" >/dev/null
    ;;
esac
exit 0
