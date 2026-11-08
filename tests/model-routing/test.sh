#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
bin="$repo_root/claude/skills/model-routing/bin"
fixtures="$(dirname "$0")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

expect_usage() {
  local input=$1 expected=$2
  local actual
  actual=$(MODEL_ROUTING_USAGE_FILE="$input" "$bin/usage-check")
  [[ $actual == *"$expected"* ]] || {
    echo "expected '$expected' in: $actual" >&2
    return 1
  }
}

expect_usage "$fixtures/usage-fixture.txt" 'weekly 85% used, resets Nov 12 at 5pm (America/Chicago); conserve mode ON'
sed 's/Current week (all models): 85%/Current week (all models): 83%/' \
  "$fixtures/usage-fixture.txt" > "$tmp/usage-low.txt"
expect_usage "$tmp/usage-low.txt" 'weekly 83% used, resets Nov 12 at 5pm (America/Chicago); conserve mode OFF'
printf 'Current week (all models): \033[31m84%%\033[0m used · resets soon\n' > "$tmp/usage-ansi.txt"
expect_usage "$tmp/usage-ansi.txt" 'weekly 84% used'
printf 'not usage output\n' > "$tmp/usage-invalid.txt"
expect_usage "$tmp/usage-invalid.txt" 'usage unknown'

mkdir -p "$tmp/fake-bin" "$tmp/worktree" "$tmp/contracts"
cat > "$tmp/fake-bin/git" <<'GIT'
#!/usr/bin/env bash
if [[ " $* " == *" merge-base "* ]]; then
  printf 'base0000\n'
elif [[ " $* " == *" diff --name-only "* ]]; then
  exit 0
elif [[ " $* " == *" diff "* ]]; then
  printf 'tracked diff from origin/main\n'
elif [[ " $* " == *" ls-files "* ]]; then
  printf 'new file.txt\0binary.dat\0link\0'
  if [[ ${REVIEW_DIFF_SELF_TEST:-0} == 1 ]]; then printf 'self.diff\0'; fi
else
  exit 2
fi
GIT
cat > "$tmp/fake-bin/codex" <<'CODEX'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$CODEX_ARGS_FILE"
printf 'review result\n'
CODEX
chmod +x "$tmp/fake-bin/git" "$tmp/fake-bin/codex"
printf 'contract\n' > "$tmp/contracts/spec.md"
mkdir -p "$tmp/contracts/second"
printf 'second contract\n' > "$tmp/contracts/second/spec.md"
printf 'untracked payload for review\n' > "$tmp/worktree/new file.txt"
printf '\0binary payload\n' > "$tmp/worktree/binary.dat"
ln -s new-file-target "$tmp/worktree/link"
export CODEX_ARGS_FILE="$tmp/codex-args"
export PATH="$tmp/fake-bin:$PATH"

"$bin/codex-review" "$tmp/worktree" label "$tmp/contracts/spec.md" "$tmp/default.txt"
grep -Fq 'Review round 1 of 2' "$CODEX_ARGS_FILE"
grep -Fq 'untracked payload for review' "$tmp/default.txt.diff"
grep -Fq 'skipped: binary.dat (binary)' "$tmp/default.txt.diff"
grep -Fq 'skipped: link (symlink)' "$tmp/default.txt.diff"

"$bin/codex-review" "$tmp/worktree" label "$tmp/contracts/spec.md" "$tmp/round2.txt" --round 2
grep -Fq 'Review round 2 of 2' "$CODEX_ARGS_FILE"
grep -Fq 'untracked payload for review' "$tmp/round2.txt.diff"

# qwen-triage lock behavior: held PID and fresh PID-less locks refuse; dead PID is taken over.
mkdir -p "$tmp/qwen-tmp" "$tmp/fake-bin-qwen"
cat > "$tmp/fake-bin-qwen/curl" <<'CURL'
#!/usr/bin/env bash
case "$*" in
  *'/v1/models'*) printf '{"data":[{"id":"qwen-flash-next"}]}\n' ;;
  *'/v1/chat/completions'*) printf '{"choices":[{"message":{"content":"triaged"}}]}\n' ;;
  *) exit 3 ;;
esac
CURL
chmod +x "$tmp/fake-bin-qwen/curl"
printf 'log\n' > "$tmp/log.txt"
mkdir "$tmp/qwen-tmp/qwen-triage.lock"
printf '%s\n' "$$" > "$tmp/qwen-tmp/qwen-triage.lock/pid"
if TMPDIR="$tmp/qwen-tmp" PATH="$tmp/fake-bin-qwen:$PATH" "$bin/qwen-triage" "$tmp/log.txt" >"$tmp/qwen-live.out" 2>&1; then
  echo 'qwen-triage accepted a live-PID lock' >&2; exit 1
fi
grep -Fq 'another local inference holds lock' "$tmp/qwen-live.out"
rm -rf "$tmp/qwen-tmp/qwen-triage.lock"
mkdir "$tmp/qwen-tmp/qwen-triage.lock"
printf '99999999\n' > "$tmp/qwen-tmp/qwen-triage.lock/pid"
TMPDIR="$tmp/qwen-tmp" PATH="$tmp/fake-bin-qwen:$PATH" "$bin/qwen-triage" "$tmp/log.txt" >"$tmp/qwen-dead.out" 2>&1
grep -Fq 'took over stale lock' "$tmp/qwen-dead.out"
grep -Fq 'triaged' "$tmp/qwen-dead.out"
[[ ! -e $tmp/qwen-tmp/qwen-triage.lock ]]
TMPDIR="$tmp/qwen-tmp" "$bin/qwen-triage" --lock-only bash -c "test -f \"\$1/qwen-triage.lock/pid\"" _ "$tmp/qwen-tmp"
[[ ! -e $tmp/qwen-tmp/qwen-triage.lock ]]
mkdir "$tmp/qwen-tmp/qwen-triage.lock"
if TMPDIR="$tmp/qwen-tmp" PATH="$tmp/fake-bin-qwen:$PATH" "$bin/qwen-triage" "$tmp/log.txt" >"$tmp/qwen-pidless.out" 2>&1; then
  echo 'qwen-triage accepted a fresh PID-less lock' >&2; exit 1
fi
grep -Fq 'another local inference holds lock' "$tmp/qwen-pidless.out"
[[ ! -e $tmp/qwen-tmp/qwen-triage.lock/pid ]]

# claude-review uses only the API key and provides diff and contract directories to Sonnet.
mkdir -p "$tmp/home" "$tmp/fake-bin-claude"
cat > "$tmp/fake-bin-claude/claude" <<'CLAUDE'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$CLAUDE_ARGS_FILE"
CLAUDE
chmod +x "$tmp/fake-bin-claude/claude"
export CLAUDE_ARGS_FILE="$tmp/claude-args"
if HOME="$tmp/home" PATH="$tmp/fake-bin-claude:$PATH" "$bin/claude-review" "$tmp/worktree" label "$tmp/contracts/spec.md" "$tmp/contracts/second/spec.md" "$tmp/claude.out" >"$tmp/claude-no-key.out" 2>&1; then
  echo 'claude-review ran without the key file' >&2; exit 1
fi
grep -Fq 'missing ' "$tmp/claude-no-key.out"
mkdir -p "$tmp/home/.config/anthropic"
printf 'test-api-key\n' > "$tmp/home/.config/anthropic/api_key"
HOME="$tmp/home" PATH="$tmp/fake-bin-claude:$PATH" "$bin/claude-review" "$tmp/worktree" label "$tmp/contracts/spec.md" "$tmp/contracts/second/spec.md" "$tmp/claude.out"
grep -Fxq sonnet "$tmp/claude-args"
[[ $(grep -Fxc -- '--add-dir' "$tmp/claude-args") -eq 3 ]]
grep -Fqx "$(dirname "$tmp/claude.out.diff")" "$tmp/claude-args"
grep -Fqx "$tmp/contracts" "$tmp/claude-args"
grep -Fqx "$tmp/contracts/second" "$tmp/claude-args"

python3 - "$repo_root/claude/settings.json" <<'PY'
import json, sys
settings = json.load(open(sys.argv[1], encoding="utf-8"))
entries = settings["hooks"]["SessionStart"]
assert {entry["matcher"] for entry in entries} == {"startup", "resume", "clear", "compact"}
assert all(entry["hooks"][0]["timeout"] == 30 for entry in entries)
PY

cat > "$tmp/fake-bin-claude/claude" <<'CLAUDE'
#!/usr/bin/env bash
touch "$CLAUDE_CALLED"
exit 99
CLAUDE
chmod +x "$tmp/fake-bin-claude/claude"
export CLAUDE_CALLED="$tmp/claude-called"
usage_output=$(MODEL_ROUTING_USAGE_CHECK=1 PATH="$tmp/fake-bin-claude:$PATH" "$bin/usage-check")
[[ -z $usage_output && ! -e $CLAUDE_CALLED ]]

printf 'self should not appear\n' > "$tmp/worktree/self.diff"
REVIEW_DIFF_SELF_TEST=1 "$bin/review-diff" "$tmp/worktree" "$tmp/worktree/self.diff"
if grep -Fq 'self should not appear' "$tmp/worktree/self.diff"; then
  echo 'review-diff included its own output file' >&2; exit 1
fi
grep -Fq 'skipped: binary.dat (binary)' "$tmp/worktree/self.diff"
grep -Fq 'skipped: link (symlink)' "$tmp/worktree/self.diff"
