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
│   │   └── rtk-rewrite.sh    # PreToolUse hook: rewrites Bash commands via rtk
│   └── skills/
│       ├── before-done/       # Completion gate: lint, spec, CI, review threads
│       ├── karpathy-guidelines/ # Coding discipline: surgical changes, simplicity
│       └── wiring-verify/    # N-step feature wiring completeness checker
│
├── codex/                     # OpenAI Codex CLI — ~/.codex/
│   ├── AGENTS.md              # Global instructions for Codex
│   ├── RTK.md                 # RTK token-killer reference for Codex
│   └── skills/
│       ├── before-done/
│       ├── karpathy-guidelines/
│       └── wiring-verify/
│
└── copilot/                   # GitHub Copilot CLI — ~/.copilot/ + ~/.github/
    ├── CLAUDE.md              # Karpathy + before-done guidelines loaded into Copilot
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
| `claude/skills/*/SKILL.md` | `~/.claude/skills/*/SKILL.md` |
| `codex/AGENTS.md` | `~/.codex/AGENTS.md` |
| `codex/RTK.md` | `~/.codex/RTK.md` |
| `codex/skills/*/SKILL.md` | `~/.codex/skills/*/SKILL.md` |
| `copilot/CLAUDE.md` | `~/.copilot/CLAUDE.md` |
| `copilot/copilot-instructions.md` | `~/.copilot-instructions.md` |
| `copilot/github-copilot-instructions.md` | `~/.github/copilot-instructions.md` |

## Skills

### before-done
Completion gate that runs before reporting any task done. Checks lint, spec docs, duplicate UI, test suite, CI status, and review threads.

### karpathy-guidelines
Coding discipline rules: think before coding, simplicity first, surgical changes, goal-driven execution with verifiable success criteria.

### wiring-verify
Verifies that every step in a documented N-step feature wiring pattern exists in code. Generates stubs for missing steps.

## RTK

[RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) is a CLI proxy that reduces token usage 60-90% by filtering/compressing command output. All agents are configured to prefix shell commands with `rtk`.
