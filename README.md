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
├── copilot/                   # GitHub Copilot CLI — ~/.copilot/ + ~/.github/
│   ├── CLAUDE.md              # Karpathy + before-done + release + self-review guidelines (+ machine-conditional local second-opinion notes)
│   ├── copilot-instructions.md         # ~/.copilot-instructions.md (global)
│   └── github-copilot-instructions.md  # ~/.github/copilot-instructions.md
│
└── pi/                        # pi coding agent — ~/.pi/agent/  (see pi/README.md)
    ├── AGENTS.md              # Global instructions, tuned for local models (85K window)
    ├── extensions/            # pi ships no MCP/plan-mode/todos/web-search; these add them
    │   ├── ai-stack-local.ts       # Both ai-stack slots as providers (:8080 code, :8081 general)
    │   ├── karpathy-guardrail.ts   # Appends karpathy rules to every system prompt
    │   ├── rtk-rewrite.ts          # Port of claude/hooks/rtk-rewrite.sh to tool_call
    │   ├── format-on-edit.ts       # Port of claude/hooks/format-on-edit.sh to tool_result
    │   ├── searxng-search.ts       # web_search tool via local SearXNG (no cloud API key)
    │   ├── protected-paths.ts      # Vendored + cwd confinement (local models write outside cwd)
    │   ├── plan-mode/              # Vendored: /plan read-only exploration
    │   ├── todo.ts                 # Vendored: task list with persistent state
    │   ├── git-checkpoint.ts       # Vendored: stash checkpoints for /fork restore
    │   └── notify.ts               # Vendored + hasUI gate: terminal notification on finish
    ├── prompts/               # /review, /before-done, /wire, /l10n slash commands
    └── skills/                # Same skills as claude/codex, pi-flavored
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
| `pi/AGENTS.md` | `~/.pi/agent/AGENTS.md` |
| `pi/extensions/<name>.ts`, `pi/extensions/<name>/` | `~/.pi/agent/extensions/<name>` |
| `pi/prompts/<name>.md` | `~/.pi/agent/prompts/<name>.md` |
| `pi/skills/<name>/` (whole dir) | `~/.pi/agent/skills/<name>` |

`~/.pi/agent/settings.json` is deliberately not linked — pi rewrites it itself.
See [pi/README.md](pi/README.md) for the settings this machine expects.

## Skills

### Scope and portability

Skills are intentionally not all generic. Their location should follow their
scope:

- **Portable skills:** `karpathy-guidelines`, `local-search`, and
  `local-summarize` are useful across projects. `docs-verify` is also broadly
  applicable, though its helper-script path is installation-specific. Keep
  these in this machine-config repository and install them globally.
- **Portable workflow cores with project overlays:** `before-done` and
  `wiring-verify` express useful general workflows. A shared core should keep
  generic checks (diff review, formatting, linting, tests, worktree/CI checks),
  while each project supplies its own commands and wiring patterns.
- **personal-assistant-specific skills:** `backend-dev`, `frontend-dev`, `feature-dev`,
  `pr-remediate`, `release`, and `self-review` deliberately encode the DayTrix app's
  architecture and operations—Go/Flutter layout, Firebase conventions,
  localization files, deployment, and GitHub accounts. These belong in the
  `personal-assistant` repository, not in a global skill installation.

The intended ownership is:

```
~/code/agent-configs/
  <agent>/skills/                 # globally installed, portable skills
    karpathy-guidelines/
    local-search/
    local-summarize/
    docs-verify/

~/code/personal-assistant/
  <project agent configuration>/  # versioned with the application
    skills/
      backend-dev/
      frontend-dev/
      feature-dev/
      before-done/
      wiring-verify/
      pr-remediate/
      release/
      self-review/
```

The current agent directories still contain both groups while the
project-local installation path is migrated and tested for each supported
agent. Do not add further personal-assistant-specific skills here; add them
to `~/code/personal-assistant` instead. Do not nest category folders inside
an agent's runtime `skills/` directory: `install.sh` discovers only direct
children, and each direct child must be one skill containing `SKILL.md`.

The deciding question is: “Would this skill remain correct in an unrelated
repository?” If yes, it is global; if it depends on this app's architecture,
commands, deployment, or accounts, it belongs with `personal-assistant`.

### backend-dev
Background discipline, not a runnable command (`user-invocable: false`). Go backend discipline: red/green table-driven TDD, handler→service→repository layering with sentinel errors, the private→household→share fallback chain, API-contract sync with Flutter models, and fail-closed security defaults (secrets, SSRF, CORS, auth).

### before-done
Completion gate that runs before reporting any task done. Optionally opens with a local-model second opinion on the diff (`local-review.sh`, machine-conditional, evidence to triage not trust), then checks lint, format cleanliness (`make fmt`), l10n key parity across all `.arb` files, spec docs, duplicate UI, test suite, CI status, and review threads. Deterministic checks are bundled scripts (`verify-git.sh`, `check-ci.sh`, `check-threads.sh`, `check-l10n.sh`); resolves fixed review threads via `narsimha-j`.

### local-search
Route trivial, low-stakes lookups (API signatures, error messages, version/changelog checks) to a local SearXNG instance instead of cloud WebSearch. No local model in the loop — Claude reads and judges raw search results directly, so there's no logic-bug risk to weigh. Machine-conditional on the SearXNG port being reachable.

### local-summarize
Triage a large log/output/JSONL file through the local general-slot model before reading it into Claude's own context — flags line ranges worth a direct read rather than producing a trusted digest, since a hallucinated summary of a stack trace is worse than useless. Machine-conditional on the local model port being reachable.

### docs-verify
Generate-and-verify for documentation changes: apply the edit, then prove it landed — `check-links.sh` verifies every URL responds, `check-stale-terms.sh` verifies terminology renames swept clean, plus a semantic consistency pass.

### feature-dev
Spec-to-ship feature workflow codified from project history: read the spec/roadmap before coding, branch, implement surgically, localization sweep, `make verify`, PR, self-review, and mark the roadmap item shipped after merge.

### frontend-dev
Background discipline, not a runnable command (`user-invocable: false`). Flutter discipline: red/green TDD with bloc and widget tests, correct state-management choice (BLoC vs ChangeNotifier), list-ordering and item-identity tests, golden refresh, l10n completeness, and visual verification via local-preview screenshots.

### karpathy-guidelines
Coding discipline rules: think before coding, simplicity first, surgical changes, goal-driven execution with verifiable success criteria.

### pr-remediate
Recovery runbook for a branch partially squash-merged to main; ends in a force push, so it is user-triggered only (`disable-model-invocation: true` in the Claude variant).

### release
End-to-end tag-driven deploy; pushes a tag and deploys to production, so it is user-triggered only (`disable-model-invocation: true` in the Claude variant). Preflight on a clean `main`, `make verify`, semver bump computed by `next-version.sh` from the commits since the last tag, push the tag, watch the deploy workflow, smoke-test production with `make test-e2e`. Deploy failures stop the flow without touching the tag.

### self-review
Two-account PR review flow; posts public comments and switches the machine-wide `gh` account, so it is user-triggered only (`disable-model-invocation: true` in the Claude variant). Switch to `narsimha-j`, optionally get a local-model second opinion on the diff first (machine-conditional, candidates to verify not confirmed findings), review the diff (correctness → surgical scope → simplicity → conventions), post inline findings as `COMMENT`, approve only when clean, and unconditionally switch back to `ljammula` on every exit path.

### wiring-verify
Verifies that every step in a documented N-step feature wiring pattern exists in code. Generates stubs for missing steps.

## RTK

[RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) is a CLI proxy that reduces token usage 60-90% by filtering/compressing command output. All agents are configured to prefix shell commands with `rtk`.
