#!/bin/bash
# Symlink this repo's configs/skills into the live locations each agent
# reads from (~/.claude, ~/.codex, ~/.copilot). Symlinking whole skill
# directories (not just SKILL.md) means scripts/ subdirs and future files
# stay live-synced automatically -- no separate copy step, ever.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORCE="${1:-}"

PORTABLE_SKILLS=(karpathy-guidelines local-search local-summarize docs-verify pre-pr-review live-validation project-bootstrap)
# Pi-only global skills: no claude/skills or codex/skills counterpart exists,
# so these aren't in PORTABLE_SKILLS (link_skills silently skips a name whose
# source dir is missing, but calling them "portable" when they're not would
# be misleading). Adapted from https://github.com/mattpocock/skills for pi's
# single-agent, no-subagent, small-context constraints -- see
# pi/skills/<name>/SKILL.md for what didn't port (code-review's parallel
# sub-agents, research's background agent).
PI_ONLY_PORTABLE_SKILLS=(tdd diagnosing-bugs resolving-merge-conflicts grill)
# PI_STACK_SKILLS is intentionally gone as a global link list: these used to
# ship into every session's system prompt regardless of repo (~1,790 of the
# harness's measured ~7,036-token startup tax, pi-harness-validation-status.md).
# stack-skill-overlay.ts now loads only the ones a repo's own evidence
# matches, same pattern as PROJECT_SKILLS below. The names stay here as the
# canonical list this script un-links on upgrade from machines still holding
# the old global symlinks.
PI_STACK_SKILLS=(go-service python-service flutter-app typescript-service postgres-change kafka-processing temporal-go gcp-deploy)
# karpathy-guidelines is in PORTABLE_SKILLS above for Claude/Codex, whose
# Skill tool is the only enforcement mechanism they have for it. Pi has no
# Skill tool -- karpathy-guardrail.ts's before_agent_start hook already
# appends the guidance unconditionally every session instead -- so linking
# the skill into ~/.pi/agent/skills/ as well is pure redundant tax: its
# name+description get advertised for pi's own relevance-matching on top of
# the guardrail's already-unconditional coverage, for guidance the session
# already has. PI_PORTABLE_SKILLS is PORTABLE_SKILLS minus that one skill,
# same pattern as PI_STACK_SKILLS's global-unlink list above.
PI_PORTABLE_SKILLS=(local-search local-summarize docs-verify pre-pr-review live-validation)
# Claude-only global skills: agent-brief (Copilot has its own adapted copy)
# and harvest-learnings (reads Claude Code's transcript format).
CLAUDE_ONLY_SKILLS=(agent-brief harvest-learnings)
COPILOT_SKILLS=(pre-pr-review agent-brief)
COPILOT_SHARED_SKILLS=(live-validation project-bootstrap)
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

unlink_managed_skills() {
  local target_root="$1" source_root="$2"
  shift 2
  for name in "$@"; do
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
link "$REPO_ROOT/claude/hooks/bash-guard.sh" "$HOME/.claude/hooks/bash-guard.sh"
link "$REPO_ROOT/claude/hooks/complexity-on-edit.sh" "$HOME/.claude/hooks/complexity-on-edit.sh"
unlink_managed_skills "$HOME/.claude/skills" "$REPO_ROOT/claude/skills" "${PROJECT_SKILLS[@]}"
link_skills "$REPO_ROOT/claude/skills" "$HOME/.claude/skills" "${PORTABLE_SKILLS[@]}" "${CLAUDE_ONLY_SKILLS[@]}"
unlink_legacy_core_skill "$HOME/.claude/skills/before-done" "$REPO_ROOT/claude/skills/before-done"
unlink_legacy_core_skill "$HOME/.claude/skills/wiring-verify" "$REPO_ROOT/claude/skills/wiring-verify"
link "$REPO_ROOT/pi/skills/before-done" "$HOME/.claude/skills/before-done"
link "$REPO_ROOT/pi/skills/wiring-verify" "$HOME/.claude/skills/wiring-verify"

# Codex
link "$REPO_ROOT/codex/AGENTS.md" "$HOME/.codex/AGENTS.md"
link "$REPO_ROOT/codex/RTK.md" "$HOME/.codex/RTK.md"
unlink_managed_skills "$HOME/.codex/skills" "$REPO_ROOT/codex/skills" "${PROJECT_SKILLS[@]}"
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
unlink_managed_skills "$HOME/.pi/agent/skills" "$REPO_ROOT/pi/skills" "${PROJECT_SKILLS[@]}" "${PI_STACK_SKILLS[@]}" karpathy-guidelines
link_skills "$REPO_ROOT/pi/skills" "$HOME/.pi/agent/skills" "${PI_PORTABLE_SKILLS[@]}" "${PI_ONLY_PORTABLE_SKILLS[@]}"
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
# Copilot CLI reads ~/.copilot/skills/<name>/SKILL.md. pre-pr-review and
# agent-brief are adapted to Copilot's own commands (/review, /rubber-duck,
# fleet subagents); live-validation and project-bootstrap reuse the
# agent-neutral Codex copies rather than keeping a third copy.
link_skills "$REPO_ROOT/copilot/skills" "$HOME/.copilot/skills" "${COPILOT_SKILLS[@]}"
link_skills "$REPO_ROOT/codex/skills" "$HOME/.copilot/skills" "${COPILOT_SHARED_SKILLS[@]}"

# pi-harness-hardening is now the authoritative source for everything
# pi-specific that's portable (no hardcoded machine paths or accounts). Most
# of pi/skills and pi/extensions above are themselves symlinks into that
# repo now, so the loops above already resolve through it. This machine's
# own private config -- ai-stack-local.ts's real provider registration,
# self-review's real account names, settings.json, project-skill-overlay.ts
# + its daytrix-*/testflight-cut skills, evals/, this AGENTS.md -- stays
# real (not symlinked) right here, deliberately never in pi-harness-hardening
# itself: that repo is meant to be publicly redistributable (see its own
# README's "Global vs. local"), and a symlink or a commit there would hand
# this machine's real config to anyone who clones or `pi install`s it.

echo "done."
