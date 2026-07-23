# agent-configs

Agent instructions and skills used on this machine, organized by agent.

## Install

```bash
./install.sh            # symlink everything into ~/.claude, ~/.codex, ~/.copilot
./install.sh --force     # also replace any existing file/dir at the target that isn't already linked here
```

Idempotent and safe to rerun anytime (e.g. after pulling new skills). Skill
directories are symlinked whole — not just `SKILL.md` — so a skill's
`scripts/` subdir and any future files in it are picked up automatically,
with no separate sync step. Without `--force`, an existing real file/dir at
a target path is left alone and reported as skipped, so it won't silently
clobber machine-specific customizations.

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
│       ├── backend-dev/       # Go discipline: red/green TDD, layering, contracts, fail-closed
│       ├── before-done/       # Completion gate: local review, lint, fmt, l10n, spec, CI, review threads (+ scripts/)
│       ├── dispatch-local/    # Delegate mechanical/bulk-generation tasks to a local model, machine-conditional
│       ├── docs-verify/       # Doc edits verified: link liveness, rename sweeps (+ scripts/)
│       ├── feature-dev/       # Spec-to-ship feature workflow: spec, branch, l10n, PR, roadmap
│       ├── frontend-dev/      # Flutter discipline: red/green TDD, list ordering, l10n, visual verify
│       ├── karpathy-guidelines/ # Coding discipline: surgical changes, simplicity
│       ├── local-search/      # Trivial lookups via local SearXNG instead of cloud WebSearch, machine-conditional
│       ├── local-summarize/   # Triage large logs via local model before reading into context, machine-conditional
│       ├── pr-remediate/      # Force-push rebase recovery (user-triggered only)
│       ├── release/           # Tag-driven deploy: verify, semver tag, watch CI, smoke prod
│       ├── self-review/       # Two-account PR review via narsimha-j + optional local second opinion, guaranteed switch-back
│       └── wiring-verify/    # N-step feature wiring completeness checker
│
├── codex/                     # OpenAI Codex CLI — ~/.codex/
│   ├── AGENTS.md              # Global instructions for Codex (+ local execution harness note)
│   ├── RTK.md                 # RTK token-killer reference for Codex
│   └── skills/
│       ├── backend-dev/
│       ├── before-done/       # + local review (Phase 0) + scripts/
│       ├── dispatch-local/    # Delegate mechanical/bulk-generation tasks to a local model, machine-conditional
│       ├── docs-verify/
│       ├── feature-dev/
│       ├── frontend-dev/
│       ├── karpathy-guidelines/
│       ├── local-search/      # Trivial lookups via local SearXNG instead of cloud search, machine-conditional
│       ├── local-summarize/   # Triage large logs via local model before reading into context, machine-conditional
│       ├── pr-remediate/
│       ├── release/
│       ├── self-review/       # + optional local second opinion
│       └── wiring-verify/
│
└── copilot/                   # GitHub Copilot CLI — ~/.copilot/ + ~/.github/
    ├── CLAUDE.md              # Karpathy + before-done + release + self-review guidelines (+ machine-conditional local second-opinion notes)
    ├── copilot-instructions.md         # ~/.copilot-instructions.md (global)
    └── github-copilot-instructions.md  # ~/.github/copilot-instructions.md
```

## Install locations

`install.sh` is the source of truth for these; the table is a reference.

| File/dir in repo | Symlink target |
|---|---|
| `claude/CLAUDE.md` | `~/.claude/CLAUDE.md` |
| `claude/RTK.md` | `~/.claude/RTK.md` |
| `claude/settings.json` | `~/.claude/settings.json` |
| `claude/hooks/rtk-rewrite.sh` | `~/.claude/hooks/rtk-rewrite.sh` |
| `claude/hooks/format-on-edit.sh` | `~/.claude/hooks/format-on-edit.sh` |
| `claude/skills/<name>/` (whole dir) | `~/.claude/skills/<name>` |
| `codex/AGENTS.md` | `~/.codex/AGENTS.md` |
| `codex/RTK.md` | `~/.codex/RTK.md` |
| `codex/skills/<name>/` (whole dir) | `~/.codex/skills/<name>` |
| `copilot/CLAUDE.md` | `~/.copilot/CLAUDE.md` |
| `copilot/copilot-instructions.md` | `~/.copilot-instructions.md` |
| `copilot/github-copilot-instructions.md` | `~/.github/copilot-instructions.md` |

## Skills

### backend-dev
Go backend discipline: red/green table-driven TDD, handler→service→repository layering with sentinel errors, the private→household→share fallback chain, API-contract sync with Flutter models, and fail-closed security defaults (secrets, SSRF, CORS, auth).

### before-done
Completion gate that runs before reporting any task done. Optionally opens with a local-model second opinion on the diff (`local-review.sh`, machine-conditional, evidence to triage not trust), then checks lint, format cleanliness (`make fmt`), l10n key parity across all `.arb` files, spec docs, duplicate UI, test suite, CI status, and review threads. Deterministic checks are bundled scripts (`verify-git.sh`, `check-ci.sh`, `check-threads.sh`); resolves fixed review threads via `narsimha-j`.

### dispatch-local
Delegate mechanical, well-specified coding tasks — or high-volume, low-judgment generation (fixtures, mock data, repetitive test cases) — to a locally-served model via Aider, then review the diff. Machine-conditional — only applies where a local model-serving stack (e.g. `ai-stack`) and its `dispatch_local.sh` script are present; checks for that before running.

### local-search
Route trivial, low-stakes lookups (API signatures, error messages, version/changelog checks) to a local SearXNG instance instead of cloud WebSearch. No local model in the loop — Claude reads and judges raw search results directly, so there's no logic-bug risk to weigh. Machine-conditional on the SearXNG port being reachable.

### local-summarize
Triage a large log/output/JSONL file through the local general-slot model before reading it into Claude's own context — flags line ranges worth a direct read rather than producing a trusted digest, since a hallucinated summary of a stack trace is worse than useless. Machine-conditional on the local model port being reachable.

### docs-verify
Generate-and-verify for documentation changes: apply the edit, then prove it landed — `check-links.sh` verifies every URL responds, `check-stale-terms.sh` verifies terminology renames swept clean, plus a semantic consistency pass.

### feature-dev
Spec-to-ship feature workflow codified from project history: read the spec/roadmap before coding, branch, implement surgically, localization sweep, `make verify`, PR, self-review, and mark the roadmap item shipped after merge.

### frontend-dev
Flutter discipline: red/green TDD with bloc and widget tests, correct state-management choice (BLoC vs ChangeNotifier), list-ordering and item-identity tests, golden refresh, l10n completeness, and visual verification via local-preview screenshots.

### karpathy-guidelines
Coding discipline rules: think before coding, simplicity first, surgical changes, goal-driven execution with verifiable success criteria.

### pr-remediate
Recovery runbook for a branch partially squash-merged to main; ends in a force push, so it is user-triggered only (`disable-model-invocation: true` in the Claude variant).

### release
End-to-end tag-driven deploy: preflight on a clean `main`, `make verify`, semver bump reasoned from commits since the last tag, push the tag, watch the deploy workflow, smoke-test production with `make test-e2e`. Deploy failures stop the flow without touching the tag.

### self-review
Two-account PR review flow: switch to `narsimha-j`, optionally get a local-model second opinion on the diff first (machine-conditional, candidates to verify not confirmed findings), review the diff (correctness → surgical scope → simplicity → conventions), post inline findings as `COMMENT`, approve only when clean, and unconditionally switch back to `ljammula` on every exit path.

### wiring-verify
Verifies that every step in a documented N-step feature wiring pattern exists in code. Generates stubs for missing steps.

## RTK

[RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) is a CLI proxy that reduces token usage 60-90% by filtering/compressing command output. All agents are configured to prefix shell commands with `rtk`.
