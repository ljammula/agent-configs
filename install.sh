#!/bin/bash
# Symlink this repo's configs/skills into the live locations each agent
# reads from (~/.claude, ~/.codex, ~/.copilot). Symlinking whole skill
# directories (not just SKILL.md) means scripts/ subdirs and future files
# stay live-synced automatically -- no separate copy step, ever.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORCE="${1:-}"

PORTABLE_SKILLS=(karpathy-guidelines local-search local-summarize docs-verify)
PI_STACK_SKILLS=(go-service python-service flutter-app typescript-service postgres-change kafka-processing temporal-go gcp-deploy)
PROJECT_SKILLS=(backend-dev frontend-dev feature-dev pr-remediate release self-review testflight-cut)
DISABLED_PI_EXTENSIONS=(co-change-suggest.ts continuation-nudge.ts)

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

link_skills() {
  local source_root="$1" target_root="$2"
  shift 2
  for name in "$@"; do
    [[ -d "$source_root/$name" ]] || continue
    link "$source_root/$name" "$target_root/$name"
  done
}

unlink_managed_project_skills() {
  local target_root="$1" source_root="$2"
  for name in "${PROJECT_SKILLS[@]}"; do
    local target="$target_root/$name"
    if [[ -L "$target" && "$(readlink "$target")" == "$source_root/$name" ]]; then
      rm "$target"
      echo "unlinked project-specific global skill: $target"
    fi
  done
}

unlink_legacy_core_skill() {
  local target="$1" legacy_source="$2"
  if [[ -L "$target" && "$(readlink "$target")" == "$legacy_source" ]]; then
    rm "$target"
    echo "unlinked legacy core skill: $target"
  fi
}

# Claude Code
link "$REPO_ROOT/claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
link "$REPO_ROOT/claude/RTK.md" "$HOME/.claude/RTK.md"
link "$REPO_ROOT/claude/settings.json" "$HOME/.claude/settings.json"
link "$REPO_ROOT/claude/hooks/rtk-rewrite.sh" "$HOME/.claude/hooks/rtk-rewrite.sh"
link "$REPO_ROOT/claude/hooks/format-on-edit.sh" "$HOME/.claude/hooks/format-on-edit.sh"
unlink_managed_project_skills "$HOME/.claude/skills" "$REPO_ROOT/claude/skills"
link_skills "$REPO_ROOT/claude/skills" "$HOME/.claude/skills" "${PORTABLE_SKILLS[@]}"
unlink_legacy_core_skill "$HOME/.claude/skills/before-done" "$REPO_ROOT/claude/skills/before-done"
unlink_legacy_core_skill "$HOME/.claude/skills/wiring-verify" "$REPO_ROOT/claude/skills/wiring-verify"
link "$REPO_ROOT/pi/skills/before-done" "$HOME/.claude/skills/before-done"
link "$REPO_ROOT/pi/skills/wiring-verify" "$HOME/.claude/skills/wiring-verify"

# Codex
link "$REPO_ROOT/codex/AGENTS.md" "$HOME/.codex/AGENTS.md"
link "$REPO_ROOT/codex/RTK.md" "$HOME/.codex/RTK.md"
unlink_managed_project_skills "$HOME/.codex/skills" "$REPO_ROOT/codex/skills"
link_skills "$REPO_ROOT/codex/skills" "$HOME/.codex/skills" "${PORTABLE_SKILLS[@]}"
unlink_legacy_core_skill "$HOME/.codex/skills/before-done" "$REPO_ROOT/codex/skills/before-done"
unlink_legacy_core_skill "$HOME/.codex/skills/wiring-verify" "$REPO_ROOT/codex/skills/wiring-verify"
link "$REPO_ROOT/pi/skills/before-done" "$HOME/.codex/skills/before-done"
link "$REPO_ROOT/pi/skills/wiring-verify" "$HOME/.codex/skills/wiring-verify"

# Pi (skills auto-discover from ~/.pi/agent/skills/<name>/SKILL.md; extensions
# from ~/.pi/agent/extensions/<name>.ts or <name>/index.ts load unconditionally
# at startup, no project trust required; global instructions from
# ~/.pi/agent/AGENTS.md; prompt templates from ~/.pi/agent/prompts/<name>.md
# become /<name> slash commands)
#
# ~/.pi/agent/settings.json is deliberately NOT linked: pi rewrites it itself
# (/settings, package installs, lastChangelogVersion), so a symlink into this
# repo would mean pi editing tracked files behind your back. See pi/README.md
# for the settings this machine expects.
link "$REPO_ROOT/pi/AGENTS.md" "$HOME/.pi/agent/AGENTS.md"
unlink_managed_project_skills "$HOME/.pi/agent/skills" "$REPO_ROOT/pi/skills"
link_skills "$REPO_ROOT/pi/skills" "$HOME/.pi/agent/skills" "${PORTABLE_SKILLS[@]}" "${PI_STACK_SKILLS[@]}"
link "$REPO_ROOT/pi/skills/before-done" "$HOME/.pi/agent/skills/before-done"
link "$REPO_ROOT/pi/skills/wiring-verify" "$HOME/.pi/agent/skills/wiring-verify"
for f in "$REPO_ROOT"/pi/extensions/*.ts; do
  name="$(basename "$f")"
  if [[ " ${DISABLED_PI_EXTENSIONS[*]} " == *" $name "* ]]; then
    target="$HOME/.pi/agent/extensions/$name"
    if [[ -L "$target" && "$(readlink "$target")" == "$f" ]]; then
      rm "$target"
      echo "unlinked evidence-gated Pi extension: $target"
    fi
    continue
  fi
  link "$REPO_ROOT/pi/extensions/$name" "$HOME/.pi/agent/extensions/$name"
done
for d in "$REPO_ROOT"/pi/extensions/*/; do
  name="$(basename "$d")"
  link "$REPO_ROOT/pi/extensions/$name" "$HOME/.pi/agent/extensions/$name"
done
for f in "$REPO_ROOT"/pi/prompts/*.md; do
  name="$(basename "$f")"
  link "$REPO_ROOT/pi/prompts/$name" "$HOME/.pi/agent/prompts/$name"
done

# Copilot
link "$REPO_ROOT/copilot/CLAUDE.md" "$HOME/.copilot/CLAUDE.md"
link "$REPO_ROOT/copilot/copilot-instructions.md" "$HOME/.copilot-instructions.md"
link "$REPO_ROOT/copilot/github-copilot-instructions.md" "$HOME/.github/copilot-instructions.md"

echo "done."
