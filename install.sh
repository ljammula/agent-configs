#!/bin/bash
# Symlink this repo's configs/skills into the live locations each agent
# reads from (~/.claude, ~/.codex, ~/.copilot). Symlinking whole skill
# directories (not just SKILL.md) means scripts/ subdirs and future files
# stay live-synced automatically -- no separate copy step, ever.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORCE="${1:-}"

link() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [[ -L "$dst" && "$(readlink "$dst")" == "$src" ]]; then
    echo "ok (already linked): $dst"
    return
  fi
  if [[ -e "$dst" || -L "$dst" ]]; then
    if [[ "$FORCE" != "--force" ]]; then
      echo "skip (exists, not linked to this repo -- rerun with --force to replace): $dst" >&2
      return
    fi
    # Remove whatever is there first. `ln -sfn` cannot replace a non-empty
    # directory -- it nests the link inside it -- so an explicit rm is the
    # only way to force-replace a real dir (or a wrong/dangling symlink).
    rm -rf "$dst"
  fi
  ln -s "$src" "$dst"
  echo "linked: $dst -> $src"
}

# Claude Code
link "$REPO_ROOT/claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
link "$REPO_ROOT/claude/RTK.md" "$HOME/.claude/RTK.md"
link "$REPO_ROOT/claude/settings.json" "$HOME/.claude/settings.json"
link "$REPO_ROOT/claude/hooks/rtk-rewrite.sh" "$HOME/.claude/hooks/rtk-rewrite.sh"
link "$REPO_ROOT/claude/hooks/format-on-edit.sh" "$HOME/.claude/hooks/format-on-edit.sh"
for d in "$REPO_ROOT"/claude/skills/*/; do
  name="$(basename "$d")"
  link "$REPO_ROOT/claude/skills/$name" "$HOME/.claude/skills/$name"
done

# Codex
link "$REPO_ROOT/codex/AGENTS.md" "$HOME/.codex/AGENTS.md"
link "$REPO_ROOT/codex/RTK.md" "$HOME/.codex/RTK.md"
for d in "$REPO_ROOT"/codex/skills/*/; do
  name="$(basename "$d")"
  link "$REPO_ROOT/codex/skills/$name" "$HOME/.codex/skills/$name"
done

# Copilot
link "$REPO_ROOT/copilot/CLAUDE.md" "$HOME/.copilot/CLAUDE.md"
link "$REPO_ROOT/copilot/copilot-instructions.md" "$HOME/.copilot-instructions.md"
link "$REPO_ROOT/copilot/github-copilot-instructions.md" "$HOME/.github/copilot-instructions.md"

echo "done."
