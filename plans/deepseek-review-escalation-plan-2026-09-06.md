# Plan: hosted DeepSeek as hard-task handoff, replacing ad hoc Opus subagents

Status: **drafted, not started.** No changes made yet.

**Scope change (this revision):** originally scoped as an automated
pre-commit *review* escalation (Claude silently invokes DeepSeek for
design review, same as the old Opus-subagent habit). Broadened and
changed to a **manual hard-task handoff**: not just review, any task
Claude judges too hard to push through alone — drafted as explicit
instructions, shown to the user, and only run on the user's go-ahead.
See "Handoff mode" below.

## Context

- "Opus escalation" is not a config anywhere — it's a manual habit, visible
  throughout `pi-harness-history.md` and in subagent transcript names
  (`agent-aopus-reviewer`, `agent-aopus-plan-critique`, `agent-aopus-stall-review`,
  `agent-aopus-harness-review`, etc.): before landing a nontrivial pi-harness
  fix, spawn an independent Agent with `model: opus` to design-review the
  diff or plan, then land the fix.
- That habit has a real, documented track record: concrete bugs caught by
  an Opus review pass that the implementing (Sonnet) pass missed, including
  the F1–F8 series in `pi/extensions/progress-stall-guard.ts`, a
  stall-detector inversion, and an intercept-action design flaw.
- Driver for this change: **cost** — Opus subagent review passes are
  token-expensive; DeepSeek (hosted API) is much cheaper per review.
- `~/code/deepseek-harness` (`dsh`) already exists as a full second agent
  harness. It ships a one-shot non-interactive mode
  (`dsh --profile headless "<task>"`) and a built-in hosted-DeepSeek
  provider (`packages/llm/llm-deepseek`, base URL `https://api.deepseek.com`,
  reads `DEEPSEEK_API_KEY`), alongside the two local routes already
  configured in `~/.dsh/settings.yaml` (`local-gemma` — current global
  default — and `local-qwen`).
- No DeepSeek API key exists anywhere on this machine today: checked shell
  env, `~/.zshrc`/`~/.zprofile`, `~/.dsh/.credentials.yaml`, and
  `~/code/deepseek-harness/.env`. All empty/absent.
- `headless` reads one **shared** `agent-default-model` setting — there is
  no per-call `--provider`/`--model` flag on the CLI. So making review
  calls use hosted DeepSeek requires either repointing the global default
  (affects every `dsh` call) or adding a separate profile with its own
  `cordis.patch.yml` (affects only calls made under that profile).

## Decisions already made (by the user)

- Motivation: cost.
- Wiring: DeepSeek **hosted API**, not self-hosted on the ai-stack box.
- Rollout: **replace outright** — no parallel-run comparison against Opus
  before cutting it over (flagged once as a risk: the Opus track record
  above has no DeepSeek equivalent yet, since there's been no side-by-side
  validation).
- Scope: a **separate review-only profile** — `local-gemma` stays the
  global `dsh` default for everything else; only review/escalation calls
  route to hosted DeepSeek.
- **Handoff mode: Claude drafts and runs, user approves first.** When
  Claude judges a task hard enough to hand off, it writes the task
  instructions (the prompt that would go to `dsh --profile review`),
  shows them to the user, and waits for a go-ahead. On approval, Claude
  itself runs the `dsh` call (not the user pasting it in) and relays the
  result. No silent/automatic invocation, and no "user runs it themselves"
  either — this sits between the original fully-automated idea and a pure
  draft-only handoff.

## Steps

1. **Get a DeepSeek API key** (user, out of band) — platform.deepseek.com,
   generate a key. Not something Claude can do.
2. **Store it** in `~/.dsh/.credentials.yaml` (`chmod 600`) as
   `DEEPSEEK_API_KEY: sk-...`. Picked up automatically by `dsh` (resolution
   order: launch environment → credential file → project `.env` → home
   `.env`) — no shell export needed, never touches shell history.
3. **Add a `review` profile** under the Harness home (`~/.dsh`): stacks
   `dsh-base` + `dsh-headless` (same bundles as the shipped `headless`
   profile) but with its own `cordis.patch.yml` pinning
   `agent-default-model` to the hosted `deepseek` provider. Leaves the
   shipped `headless` profile and the global default (`local-gemma`)
   untouched. Invoked as `dsh --profile review "<task>"`.
4. **Wrap it in a script**, mirroring the existing `local-search` /
   `local-summarize` skill pattern in `agent-configs`:
   `~/code/agent-configs/claude/skills/deepseek-handoff/scripts/handoff.sh`,
   taking a task-instructions file (a review prompt, a plan critique
   request, or any other hard-task writeup Claude drafted) and calling
   `dsh --profile review "$(cat ...)"`, printing the result. Paired with a
   `SKILL.md` that:
   - describes trigger conditions broadly — "task Claude judges too hard
     to push through alone," not only pre-commit review;
   - states the approval gate explicitly: draft the instructions, show
     them to the user, wait for a go-ahead, *then* run the script — never
     invoke it unprompted;
   - includes a reachability/key-present check with a clear fallback
     message (same shape as the SearXNG skill's check).
   Symlinked into `~/.claude/skills/` the way other `agent-configs` skills
   are.
5. **Retire the "spawn Opus subagent" habit going forward.** Nothing to
   edit in `AGENTS.md` (the habit was never codified there) — instead
   record it as a `feedback`-type memory: for a hard task, draft
   instructions for DeepSeek, show them to the user, and only run
   `deepseek-handoff` on approval — instead of silently spawning
   `Agent({model:"opus"})`. Linked from `MEMORY.md`.
6. **Standing risk flag** (already raised once, not re-litigated): no
   side-by-side data yet on whether DeepSeek catches what Opus caught in
   the historical record above. Worth revisiting if review quality feels
   weaker in practice.

## Why the handoff goes through `dsh`, not Claude Code pointed at DeepSeek

Considered and rejected: proxying Claude Code itself at DeepSeek models
(via a local proxy at `ANTHROPIC_BASE_URL` translating Claude Code's
Anthropic-shaped requests to DeepSeek's OpenAI-compatible API), instead of
handing off to the separate `dsh` harness.

- Claude Code has no native non-Anthropic backend switch — this only works
  through a translation proxy reshaping tool_use blocks, system-prompt
  conventions, and extended-thinking format between the two APIs on every
  turn.
- The real risk is tool-calling fidelity, not raw model quality: a lossy
  translation layer is a known source of malformed tool args, dropped
  calls, and retry loops the harness's permission/hook machinery wasn't
  built to absorb. None of the skills/hooks/subagent machinery here were
  validated against that path.
- `dsh` is DeepSeek's own harness, built and tuned by DeepSeek for DeepSeek
  models — correct tool schemas and system-prompt conventions natively, no
  translation layer. Proxying Claude Code at DeepSeek would recreate what
  `dsh` already does, only worse.
- The only upside of a Claude-Code-on-DeepSeek proxy is ergonomic (same CLI
  muscle memory) — not architectural. That's thin against the reliability
  cost, and fragile besides: Anthropic has no reason to keep Claude Code's
  request/response shape stable for a non-Anthropic backend, so any Claude
  Code update could silently break the proxy.
- Conclusion: two purpose-built harnesses, not one harness wearing another's
  model. Claude Code (Claude models) drafts the hard-task instructions;
  `dsh` (DeepSeek models) executes them, native tool-calling intact on both
  sides. This is why the plan's handoff step (4) shells out to `dsh
  --profile review` rather than trying to repoint Claude Code's own model.

## What's blocked vs. ready

- Steps 1–2 require the user (API key acquisition + storage).
- Steps 3–5 are ready to execute once the key is in place.

## Open follow-ups (not decided yet)

- Exact `deepseek` model id to pin in the review profile (e.g.
  `deepseek-chat` vs `deepseek-reasoner`) — not yet looked up against
  current DeepSeek API docs/pricing.
- Whether the `deepseek-review` skill should also accept a plain PR/branch
  target (like `/code-review`) or only take diff/plan files directly.
