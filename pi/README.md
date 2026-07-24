# pi

Config for the [pi coding agent](https://pi.dev), installed by `../install.sh`
into `~/.pi/agent/`.

pi is deliberately minimal: four default tools (`read`, `write`, `edit`,
`bash`), plus optional read-only built-ins (`grep`, `find`, `ls`) that are off
by default, and no built-in MCP, subagents, permission prompts, plan mode,
todos, or web search (`README.md`, `docs/usage.md`). Everything here re-adds a
piece of that, chosen for one reason: this machine runs pi against **local
models** with an 85K context window, not a cloud model, so the harness has to
carry weight the model cannot.

## What's installed

| Path | Becomes | What |
|---|---|---|
| `AGENTS.md` | `~/.pi/agent/AGENTS.md` | Global instructions, read on every session |
| `skills/<name>/` | `~/.pi/agent/skills/<name>` | Same skills as Claude/Codex, pi-flavored |
| `prompts/<name>.md` | `~/.pi/agent/prompts/<name>.md` | `/<name>` slash commands |
| `extensions/*.ts`, `extensions/*/` | `~/.pi/agent/extensions/…` | Loaded unconditionally at startup |

### Extensions

Written here:

- **`ai-stack-local.ts`** — registers both ai-stack slots as providers:
  `ai-stack-local` (:8080, Qwen3.6-27B-4bit, "code") and `ai-stack-general`
  (:8081, Qwen3.6-35B-A3B-5bit, "general"). Both follow `AI_STACK_HOST`.
- **`karpathy-guardrail.ts`** — appends the karpathy-guidelines rules to the
  system prompt on every turn, since pi surfaces skills by relevance-matching
  rather than unconditionally.
- **`rtk-rewrite.ts`** — port of `claude/hooks/rtk-rewrite.sh`. Routes bash
  commands through `rtk rewrite` for 60-90% less output. Worth more here than
  under Claude Code: on an 85K window, output reduction is turns.
- **`format-on-edit.ts`** — port of `claude/hooks/format-on-edit.sh`. gofmt/dart
  format after every write/edit. Local models produce unformatted code far more
  often than cloud models, and `make verify` fails on it.
- **`searxng-search.ts`** — a `web_search` tool backed by ai-stack's SearXNG
  (:8888). Chosen over the published `pi-web-access` package, which requires a
  cloud search API key this machine has no reason to buy. Registered as a
  *tool* rather than left to the `local-search` skill because a 27B model
  reliably calls a tool in front of it and unreliably remembers a skill.
- **`continuation-nudge.ts`** — Phase 1 of
  `ai-stack/local-quality-next-steps-plan.md`: targets the plan-then-abandon
  failure mode (model announces an edit in prose, no tool call, turn ends with
  `stopReason: "stop"`) seen in the `local-model-bench` pi-local run. On a
  matching turn, with no verification command run yet this session, injects
  one follow-up nudge instead of letting the turn end. Fires at most once per
  agent run. Two rounds of validation runs turned out to be invalidated
  before this could even be exercised: a harness bug (wrong test-file layout,
  fixed), then a real extension bug caught by Codex review — `sendUserMessage`
  needs `deliverAs: "followUp"` while the agent is streaming, or Pi silently
  swallows the call and nothing is ever delivered (see commit `04d72d5`).
  Fixed; empirical validation against the plan's kill criterion in progress —
  see `ai-stack/local-quality-next-steps-status.md`.
- **`cross-model-review.ts`** — Phase 2 of the same plan: the
  previously-scoped-but-never-built blind-reviewer pass. On the first green
  run of the task's own verification command, diffs against the session's
  base SHA (so mid-session commits are included) and sends it + the task spec
  to `ai-stack-general` (:8081) with a review prompt that can't see the first
  model's own reasoning, feeding back a flagged issue as a fix-it turn once.
  Had the same `sendUserMessage` delivery bug as above, plus marked itself
  "reviewed" before confirming there was anything to review — both fixed.
  Not yet run against the plan's full kill criterion, which needs a
  seeded-wrong-fixture task battery this machine doesn't have.
- **`co-change-suggest.ts`** — Phase 3 of the same plan: ports
  `ai-stack/scripts/suggest_read_files.py`'s co-change ranking (git
  co-change count² ÷ total historical touch count) into pi. On the first
  prompt that actually has grep-matchable identifiers (a greeting first
  doesn't burn the attempt), on repos with ≥20 commits of history, ranks
  files that historically co-change with those identifiers and appends a
  suggested-reading list to the system prompt, minus the identifier-matched
  seed files themselves. No-op by construction on fixture-sized repos with no
  history to mine; git subprocess cost capped and `ctx.signal`/timeouts wired
  through. Not yet validated live against a real personal-assistant feature
  task (the plan's kill criterion).

Vendored from pi's `examples/extensions/`, with changes noted in each file:

- **`protected-paths.ts`** — blocks writes to sensitive/generated files, **and
  to anything outside the working directory**. The confinement is not
  theoretical: asked to write `main.go` in a temp dir, Qwen3.6-27B emitted an
  absolute path to an unrelated directory and pi's write tool obeyed. With the
  guard, the model gets a corrective message and retries correctly.
- **`plan-mode/`** — `/plan` or Ctrl+Alt+P for read-only exploration using
  PI's native inspection tools, with `/plan-todos` for the current plan steps.
- **`todo.ts`** — task list tool with persistent state.
- **`git-checkpoint.ts`** — git stash checkpoints so `/fork` can restore code.
- **`notify.ts`** — terminal notification when the agent finishes. Vendored
  change: gated on `hasUI`, since in `-p` mode the raw OSC escape would
  otherwise corrupt captured stdout.

### Prompt templates

`/review`, `/before-done`, `/wire`, `/l10n` — thin, explicit wrappers over the
matching skills. They spell out each step and demand pasted command output,
because a small model that is told "run the gate" will report success without
running anything.

## Settings this machine expects

`~/.pi/agent/settings.json` is **not** symlinked from this repo: pi rewrites it
itself (`/settings`, package installs, `lastChangelogVersion`), so a symlink
would mean pi editing tracked files behind your back. Set these by hand:

```json
{
  "defaultProvider": "ai-stack-local",
  "defaultModel": "/Users/kanna/code/ai-stack/models/Qwen3.6-27B-4bit",
  "defaultThinkingLevel": "off",
  "enabledModels": ["Qwen3.6-27B-4bit", "Qwen3.6-35B-A3B-5bit"],
  "compaction": { "enabled": true, "reserveTokens": 8192, "keepRecentTokens": 24000 }
}
```

- `defaultThinkingLevel: "off"` — both slots report `reasoning: false`.
- `enabledModels` gives Ctrl+P cycling between the code and general slots.
  Glob patterns (`*Qwen3.6*`) do **not** match these models; pi matches the
  path-style IDs by substring, so list the basenames exactly as above.
- Compaction reserve is lowered to 8192 (= the models' `maxTokens`) to leave
  more of the 85K window for actual work.

`AI_STACK_HOST` must be exported (it is, in `~/.zshrc`) — unset, every provider
points at `127.0.0.1:8080`, where nothing is listening on this Mac.

## Deliberately not installed

- **`pi-mcp-adapter`** — there are no MCP servers configured on this machine
  (`~/.claude.json` has none, globally or per-project). Install it when there
  is something to adapt, not before.
- **`pi-subagents`** — subagent fan-out multiplies context use, and 85K is
  already the binding constraint.
- **Aider-style delegation** — see `AGENTS.md`; benchmarked and rejected.
