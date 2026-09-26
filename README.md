# agent-configs

Agent instructions and skills used on this machine, organized by agent.

**pi harness validation status** (what's adopted vs. not, and why): see
[pi-harness-validation-status.md](pi-harness-validation-status.md).

**Colleague-facing presentation** of the whole pi.dev harness project —
headline results, extension status, open items, and links to individual
deep-dive reports: [index.html](index.html), also live via GitHub Pages at
https://ljammula.github.io/agent-configs/ (public, since this repo is
public). Individual reports live under [`reports/`](reports/); the current
one is [reports/qwen38-pi-harness-report.html](reports/qwen38-pi-harness-report.html).
A dated [timeline.html](timeline.html) walks every milestone from the
project's start through the current state, each with its result and a link
to the underlying evidence.

**Qwen3.8-27B thinking/temperature tuning (2026-08-17):** the local
Qwen3.8 route was running with thinking disabled and undocumented greedy
decoding; fixing both (plus a developer-role regression found along the
way) flipped a replicated 0/4 result on a controlled task to a replicated
4/4.
Full research trail: [qwen38-agentic-coding-tuning-research.md](qwen38-agentic-coding-tuning-research.md).
Narrative entry: [pi-harness-history.md](pi-harness-history.md).

**Current-machine Pi audit (2026-08-03):** the hardening plan is implemented
locally. Pi 0.83.0 now has a pinned TypeScript contract suite, current-diff
quality gate, truthful reviewer configuration, project-scoped DayTrix overlay,
stack routing, external-effect guard, symlink-safe path checks, versioned trace
records, and a Docker containment profile. The same-model reviewer is disabled
by default because it has not earned independent-review status. Docker is not
installed on this host, so the containment profile is statically verified but
its escape matrix remains unproven. See
[pi-harness-validation-status.md](pi-harness-validation-status.md) for current
status, [pi-harness-history.md](pi-harness-history.md) for the full dated
investigation, and [`pi/evals/`](pi/evals/) for exact evidence.

The local inference routes used by the machine-conditional skills are recorded
in [local-ai-stack.md](local-ai-stack.md), including current model ids, runtime
versions, measured throughput, client rules, and the rollback validation
boundary.

## Install

```bash
./install.sh            # symlink managed config into Claude, Codex, Copilot, and Pi homes
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
├── local-ai-stack.md         # Current local model routes, performance, and client rules
├── claude/                    # Claude Code (CLI) — ~/.claude/
│   ├── CLAUDE.md              # Global instructions (GitHub accounts, code quality rules)
│   ├── RTK.md                 # RTK token-killer reference for Claude
│   ├── settings.json          # Model, plugins, hook config
│   ├── hooks/
│   │   ├── rtk-rewrite.sh    # PreToolUse hook: rewrites Bash commands via rtk
│   │   ├── format-on-edit.sh # PostToolUse hook: gofmt/dart format touched files
│   │   └── bash-guard.sh     # PreToolUse hook: blocks backticks in inline commit/PR text, bg + trailing &
│   └── skills/
│       ├── agent-brief/       # Subagent briefs: model tier, foreground tests, shared resources, result checks
│       ├── backend-dev/       # Go discipline: red/green TDD, layering, contracts, fail-closed
│       ├── before-done/       # Completion gate: local review, lint, fmt, l10n, spec, CI, review threads (+ scripts/)
│       ├── docs-verify/       # Doc edits verified: link liveness, rename sweeps (+ scripts/)
│       ├── feature-dev/       # Spec-to-ship feature workflow: spec, branch, l10n, PR, roadmap
│       ├── frontend-dev/      # Flutter discipline: red/green TDD, list ordering, l10n, visual verify
│       ├── karpathy-guidelines/ # Coding discipline: surgical changes, simplicity
│       ├── local-search/      # Trivial lookups via local SearXNG instead of cloud WebSearch, machine-conditional
│       ├── live-validation/   # "Done" = a live end-to-end run passed; exit bars, oracles, dated records
│       ├── local-summarize/   # Triage large logs via local model before reading into context, machine-conditional
│       ├── pr-remediate/      # Force-push rebase recovery (user-triggered only)
│       ├── pre-pr-review/     # Self-review passes before a PR + 2-round post-PR review cap
│       ├── project-bootstrap/ # New-repo setup: AGENTS.md, verify/live-smoke, notes repo, templates (user-invoked)
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
    ├── AGENTS.md              # Global instructions, tuned for the local model (96K window)
    ├── settings.json          # Tracked reference; intentionally not linked into ~/.pi/agent/
    ├── extensions/            # pi ships no MCP/plan-mode/todos/web-search; these add them
    │   ├── ai-stack-local.ts       # Resident ai-stack provider (:8080 code + triage)
    │   ├── full-stack-dev.ts       # Generic autonomous plan/chunk/test/debug workflow
    │   ├── karpathy-guardrail.ts   # Appends karpathy rules to every system prompt
    │   ├── rtk-rewrite.ts          # Port of claude/hooks/rtk-rewrite.sh to tool_call
    │   ├── format-on-edit.ts       # Port of claude/hooks/format-on-edit.sh to tool_result
    │   ├── searxng-search.ts       # web_search tool via local SearXNG (no cloud API key)
    │   ├── protected-paths.ts      # write/edit guard with realpath/symlink containment
    │   ├── external-effects.ts     # blocks deploy/publish/prod mutation without opt-in
    │   ├── quality-gate.ts         # final-diff canonical verification, bounded correction
    │   ├── stack-router.ts         # names the matching stack skill(s) in an explicit nudge
    │   ├── stack-skill-overlay.ts  # loads only the matching stack skill(s), not all 8 globally
    │   ├── project-skill-overlay.ts # DayTrix workflows only for its exact Git remote
    │   ├── continuation-nudge.ts   # Evidence-gated source; not installed by default
    │   ├── cross-model-review.ts   # Explicit independent route or labeled self-review
    │   ├── lib/                     # Shared verification and trace support, not entry points
    │   ├── co-change-suggest.ts    # Evidence-gated source; not installed by default
    │   ├── git-safety.ts           # Blocks selected destructive git commands
    │   ├── plan-mode/              # Vendored: /plan read-only exploration
    │   ├── todo.ts                 # Vendored: task list with persistent state
    │   ├── git-checkpoint.ts       # Vendored: stash checkpoints for /fork restore
    │   └── notify.ts               # Vendored + hasUI gate: terminal notification on finish
    ├── containment/           # read-only-root Docker profile for unattended runs
    ├── tests/                 # pinned public-API extension contract tests
    ├── prompts/               # /review, /before-done, /wire, /l10n slash commands
    └── skills/                # portable cores, stack skills, and gated DayTrix overlays
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

`pi/settings.json` records the settings this machine expects, but
`~/.pi/agent/settings.json` is deliberately not linked — pi rewrites it itself.
See [pi/README.md](pi/README.md) for details.

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
- **Spec-driven-development skills** (`setup-matt-pocock-skills`, `to-spec`,
  `to-tickets`, `implement`, and the rest of the engineering/productivity set)
  come from the `mattpocock-skills@claude-plugins-official` Claude Code
  plugin (`claude plugins install mattpocock-skills` /
  `/plugin install mattpocock-skills`), not from this repo — do not vendor a
  copy here; that plugin already tracks upstream and updates itself.

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

The source tree retains the historical project-specific skill bodies while
ownership is migrated, but `install.sh` removes their managed global links for
Claude, Codex, and Pi. Pi exposes the DayTrix bodies only when
`project-skill-overlay.ts` verifies the exact `ljammula/personal-assistant`
Git remote. Unrelated repositories receive none of their descriptions or
bodies. Do not add further project-specific global links. Do not nest category
folders inside an agent's runtime `skills/` directory: `install.sh` discovers
only direct children, and each direct child must be one skill containing
`SKILL.md`.

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
Triage a large log/output/JSONL file through the resident local model before reading it into Claude's own context — flags line ranges worth a direct read rather than producing a trusted digest, since a hallucinated summary of a stack trace is worse than useless. Machine-conditional on the local model port being reachable.

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

## Documentation map

Three kinds of `.md` file live in this repo, and they're not redundant with
each other even where they cover the same extensions or the same runs --
each answers a different question:

- **Living status** — updated in place, always describes the current
  state. [pi-harness-validation-status.md](pi-harness-validation-status.md)
  (what's adopted vs. not, per extension, with real trial counts) and
  [local-ai-stack.md](local-ai-stack.md) (current local model routes,
  performance, client rules) are the two files to read for "is X actually
  working right now."
- **Plans** (`plans/*.md`, plus [pi/todo-app-hardening-plan.md](pi/todo-app-hardening-plan.md)) —
  an implementation contract written before or during a body of work, each
  carrying its own status line. Once a plan's status reads "implemented" or
  "complete," treat the living-status doc above as the current source of
  truth on whether it actually holds up, not the plan itself.
- **Dated snapshots** — a record of a specific investigation, review, or
  build run at the time it happened. Not append-only: several of these
  carry an in-place "Historical snapshot"/correction banner pointing at
  whichever living doc superseded their overall claims, but that doesn't
  mean the body text below the banner is frozen -- some (e.g.
  `history/claude-pi-quality-extensions-review-feedback.md`,
  `history/pi-real-task-report-personal-budget-simplifier.md`) later received
  their own in-place correction rounds when a specific finding turned out
  to be wrong, same-day or after. Read the banner for current status, but
  don't assume everything past it is untouched history.
  [pi-harness-history.md](pi-harness-history.md) is the main dated
  narrative (full investigation log, one entry per finding).
  `history/` holds standalone dated snapshots kept for provenance (see
  [history/README.md](history/README.md)):
  [history/fable-review-all-customizations.md](history/fable-review-all-customizations.md)
  and [history/claude-pi-quality-extensions-review-feedback.md](history/claude-pi-quality-extensions-review-feedback.md)
  are independent-review passes from 2026-07-24;
  [history/pi-real-task-report-daily-briefing-screen.md](history/pi-real-task-report-daily-briefing-screen.md)
  and [history/pi-real-task-report-personal-budget-simplifier.md](history/pi-real-task-report-personal-budget-simplifier.md)
  are transcript-sourced (not self-reported) observation reports from real
  delegated builds.
- **Presentations** — a standalone, non-technical writeup of a specific
  finding, meant to be opened directly in a browser and shared, not read
  as markdown. [pi-goal-gate-research.html](pi-goal-gate-research.html)
  covers the three live `/goal` trials documented in `pi-harness-history.md`'s
  `/goal` (`goal-gate.ts`) update entries.

If a claim in a dated snapshot and the living status doc ever disagree,
the living status doc wins -- it's the one that gets corrected when a
belief turns out to be wrong.
