# agent-configs

Agent instructions and skills used on this machine, organized by agent.

## Structure

```
agent-configs/
├── claude/                    # Claude Code (CLI) — ~/.claude/
│   ├── CLAUDE.md              # Global instructions (GitHub accounts, code quality rules)
│   ├── RTK.md                 # RTK token-killer reference for Claude
│   ├── settings.json          # Model, plugins, hook config
│   ├── hooks/
│   │   ├── rtk-rewrite.sh    # PreToolUse hook: rewrites Bash commands via rtk
│   │   └── format-on-edit.sh # PostToolUse hook: gofmt/dart format touched files
│   └── skills/
│       ├── before-done/       # Completion gate: lint, spec, CI, review threads (+ scripts/)
│       ├── docs-verify/       # Doc edits verified: link liveness, rename sweeps (+ scripts/)
│       ├── karpathy-guidelines/ # Coding discipline: surgical changes, simplicity
│       ├── pr-remediate/      # Force-push rebase recovery (user-triggered only)
│       ├── release/           # Tag-driven deploy: verify, semver tag, watch CI, smoke prod
│       ├── self-review/       # Two-account PR review via narsimha-j, guaranteed switch-back
│       └── wiring-verify/    # N-step feature wiring completeness checker
│
├── codex/                     # OpenAI Codex CLI — ~/.codex/
│   ├── AGENTS.md              # Global instructions for Codex
│   ├── RTK.md                 # RTK token-killer reference for Codex
│   └── skills/
│       ├── before-done/
│       ├── docs-verify/
│       ├── karpathy-guidelines/
│       ├── pr-remediate/
│       ├── release/
│       ├── self-review/
│       └── wiring-verify/
│
└── copilot/                   # GitHub Copilot CLI — ~/.copilot/ + ~/.github/
    ├── CLAUDE.md              # Karpathy + before-done + release + self-review guidelines
    ├── copilot-instructions.md         # ~/.copilot-instructions.md (global)
    └── github-copilot-instructions.md  # ~/.github/copilot-instructions.md
```

## Install locations

| File in repo | Symlink/copy target |
|---|---|
| `claude/CLAUDE.md` | `~/.claude/CLAUDE.md` |
| `claude/RTK.md` | `~/.claude/RTK.md` |
| `claude/settings.json` | `~/.claude/settings.json` |
| `claude/hooks/rtk-rewrite.sh` | `~/.claude/hooks/rtk-rewrite.sh` |
| `claude/hooks/format-on-edit.sh` | `~/.claude/hooks/format-on-edit.sh` |
| `claude/skills/*/SKILL.md` | `~/.claude/skills/*/SKILL.md` |
| `codex/AGENTS.md` | `~/.codex/AGENTS.md` |
| `codex/RTK.md` | `~/.codex/RTK.md` |
| `codex/skills/*/SKILL.md` | `~/.codex/skills/*/SKILL.md` |
| `copilot/CLAUDE.md` | `~/.copilot/CLAUDE.md` |
| `copilot/copilot-instructions.md` | `~/.copilot-instructions.md` |
| `copilot/github-copilot-instructions.md` | `~/.github/copilot-instructions.md` |

## Skills

### before-done
Completion gate that runs before reporting any task done. Checks lint, spec docs, duplicate UI, test suite, CI status, and review threads. Deterministic checks are bundled scripts (`verify-git.sh`, `check-ci.sh`, `check-threads.sh`); resolves fixed review threads via `narsimha-j`.

### docs-verify
Generate-and-verify for documentation changes: apply the edit, then prove it landed — `check-links.sh` verifies every URL responds, `check-stale-terms.sh` verifies terminology renames swept clean, plus a semantic consistency pass.

### karpathy-guidelines
Coding discipline rules: think before coding, simplicity first, surgical changes, goal-driven execution with verifiable success criteria.

### pr-remediate
Recovery runbook for a branch partially squash-merged to main; ends in a force push, so it is user-triggered only (`disable-model-invocation: true` in the Claude variant).

### release
End-to-end tag-driven deploy: preflight on a clean `main`, `make verify`, semver bump reasoned from commits since the last tag, push the tag, watch the deploy workflow, smoke-test production with `make test-e2e`. Deploy failures stop the flow without touching the tag.

### self-review
Two-account PR review flow: switch to `narsimha-j`, review the diff (correctness → surgical scope → simplicity → conventions), post inline findings as `COMMENT`, approve only when clean, and unconditionally switch back to `ljammula` on every exit path.

### wiring-verify
Verifies that every step in a documented N-step feature wiring pattern exists in code. Generates stubs for missing steps.

## RTK

[RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) is a CLI proxy that reduces token usage 60-90% by filtering/compressing command output. All agents are configured to prefix shell commands with `rtk`.
