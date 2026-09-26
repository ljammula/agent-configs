#!/bin/bash
# PreToolUse hook (Bash): block two command shapes that silently corrupt work.
# Exit 2 blocks the call and shows stderr to Claude.
#
# 1. Backticks in inline commit/PR text (`git commit -m "..."`, `gh pr create
#    --body "..."`): bash runs each backtick span as command substitution, so the
#    text is mangled with no error (seen 2026-09-11). A quoted heredoc
#    (<<'EOF') is safe and allowed.
# 2. run_in_background:true plus a trailing `&`: the tool reports "completed" at
#    once while the real process runs untracked (orphaned Temporal workflow and
#    containers, 2026-09-14).

input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
bg=$(jq -r '.tool_input.run_in_background // false' <<<"$input")
[ -n "$cmd" ] || exit 0

inline_text='(git commit|gh (pr|issue) (create|comment|review|edit)).*(-[a-zA-Z]*m|--message|--body|-b)[ =]'
if [[ "$cmd" == *'`'* ]] && grep -qE "$inline_text" <<<"$cmd" &&
  ! grep -qE "<<-?[[:space:]]*['\"]" <<<"$cmd"; then
  echo "Blocked: backticks in inline commit/PR text run as command substitution. Write the text to a file and use 'git commit -F <file>' or 'gh ... --body-file <file>'." >&2
  exit 2
fi

if [[ "$bg" == "true" ]] && grep -qE '(^|[^&])&[[:space:]]*$' <<<"$cmd"; then
  echo "Blocked: run_in_background already detaches the command. Drop the trailing '&' so the tool tracks the real process." >&2
  exit 2
fi

exit 0
