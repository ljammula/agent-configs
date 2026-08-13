# pi harness — consolidated validation status

**Current as of 2026-08-12.** This file states only what's true right now,
extension by extension, kept deliberately short and high-level. The full
dated investigation — what was tried, what broke, what got fixed, live-run
counts, superseded results — lives in `pi-harness-history.md`; nothing here
is understandable-only-with-history, but that file is where the "why" and
"how do we know" detail is if you want it. Standalone task/review reports
(real builds, external reviews of this repo's customizations) live under
`history/`.

## Current configuration

Pi 0.83.0 has two resident inference routes: `ThinkingCap-Qwen3.6-27B-MLX-8bit`
on `:8080` (primary, host `kannasmacstudio.lan`) and `gemma-4-26b-a4b-it` on
`:8081` (reviewer, same host). `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL`/
`AI_STACK_HOST` live in `~/.zshenv` (sourced by every zsh invocation,
interactive or not — see `pi-harness-history.md` for why this moved out of
`~/.zshrc`), so `cross-model-review.ts` resolves to genuine
`independent-review`. `AI_REVIEW_MODEL` must be the exact id `GET
:8081/v1/models` returns, not a short form — a stale short id silently
disabled the reviewer once already (see history).

Same-primary review still requires `AI_REVIEW_ALLOW_SELF=1` and is labeled
`blind-self-review`, never cross-model, if ever pointed back at the same
route. Verification-command resolution (both `quality-gate.ts`'s settlement
check and `cross-model-review.ts`'s trigger) recognizes a Makefile `verify`,
`test`, or `check` target, in that priority order.

The maintained Pi project typechecks against pinned 0.83.0 public types and
has 156+ deterministic tests covering loading, event ordering, retry caps,
current-diff verification, shell-masked exits, reviewer truthfulness,
symlink escapes, external-effect policy, installer scope, stack routing,
extension interactions, nested verification manifests, stale-extension-
context handling, and the goal-gate/greenfield hardening extensions below.

One acceptance boundary remains intentionally not adopted:

- `continuation-nudge.ts` and `co-change-suggest.ts` remain source-tested
  but are removed from the installed runtime until randomized paired
  evidence meets the current adoption threshold.

Docker containment is live-proven on this host via Colima: image and
launcher build and run with Pi 0.83.0, the persistent agent volume is
writable by UID 10001, and `pi/containment/verify-live.sh` passes 17/17
checks (workspace-only writes, escape attempts, host credentials/socket
absence, network denial, `/tmp` noexec, capabilities, no-new-privileges).

## Current battery result

A completed nine-pair randomized screen (seed `20260802`, stock Pi vs. the
installed harness) is the current operational-hardening evidence: hidden-test
success baseline 7/9, harness 8/9 (its one loss was a shared baseline failure,
not a harness defect); zero extension errors across all eighteen runs; median
paired runtime overhead 100.3%, above the plan's 20% screening threshold —
the honestly-measured cost of quality-gate's nested-manifest verification and
corrective-follow-up loop running on every pair. Full record:
`pi/evals/full-screening-2026-08-03.json`; runner: `pi/evals/run_screening.py`.
Detail, including the pair-4 concurrency-bug deep-dive, in
`pi-harness-history.md`.

## Extension-by-extension current status

| Extension | Status | Evidence |
|---|---|---|
| `protected-paths.ts` | Adopted, on by default | Tool guard on Pi `write`/`edit`, not `bash`, symlink escapes, or OS-level confinement. Deterministic tests + 1 live catch. |
| `format-on-edit.ts` | Adopted, on by default | Deterministic gofmt/dart-format/prettier-if-present pass. |
| `rtk-rewrite.ts` | Adopted, on by default | Deterministic bash-output filter. |
| `git-checkpoint.ts` | Adopted, on by default | Deterministic per-turn snapshotting. |
| `git-safety.ts` | Adopted | Blocks destructive git commands. 1 scratch-repo reproduction plus deterministic tests. |
| `quality-gate.ts` | Adopted, on by default | Binds passing evidence to the current diff hash, rejects truncated/shell-masked results, runs the repo's canonical check at settlement, caps corrective follow-ups at three. Proven in the nine-pair battery. Corrective follow-up under `pi -p` is **still unresolved** — works in isolation, didn't fire in a real 9-turn-deep build session; see history. |
| `stack-router.ts` | Adopted, on by default | Routes Go, Python, Flutter, TypeScript/JavaScript, PostgreSQL, Kafka, Temporal, GCP guidance from repo evidence. Only Go/Dart routes have battery coverage; rest are unit-tested only. |
| `co-change-suggest.ts` | Default-disabled, source-tested | One real retrospective replay (ranked target #1 of 8) short of the adoption threshold. Live validation not run. |
| `continuation-nudge.ts` | Default-disabled, source-tested | Deterministic tests pass; widened trigger has zero real-trial field evidence. |
| Auto-compaction (`ai-stack-local.ts` `contextWindow`) | Fixed and live-confirmed | Was mis-set to a value above the route's real admission budget, so Pi's own auto-compaction never fired on overflow. Corrected + adapter-level follow-up fix; live rerun: reward 1.0. Detail in history. |
| `stack-skill-overlay.ts` | Fixed | Per-repo stack skills only load matching skill(s) instead of all 8 globally — real measured ~15% prompt-token reduction. |
| `codebase-memory-mcp` 0.9.0 | Default-disabled, trial-only | No efficiency win over plain repo tools in a paired Go trial; vendor's token-reduction claim not confirmed. Not globally wired. |
| `cross-model-review.ts` | Adopted, resolves to genuine `independent-review` | 15/15 planted-bug catch rate, 0/9 false positives on a checked-in battery (`pi/evals/reviewer-battery.ts`). Was structurally blind on all-untracked repos (fixed) and on suites whose verification command never runs inside the model's own session (mitigated via a new settlement-time trigger, source/unit-tested, live-fired once with a `model-rejected` outcome — not yet a clean confirmed round). Full saga (stale-model-id incident, schema-ordering regression, timeout raise) in history. |
| `new-project-scaffold.ts` | Adopted, on by default | Git-init + layered-architecture nudge for greenfield repos. Live-tested. |
| `makefile-scaffold-nudge.ts` | Adopted, on by default | Nudges toward a canonical Makefile target. Redesigned after a structural-blindness finding; revised design not yet live-tested. |
| `artifact-guard.ts` | Adopted, on by default | Flags oversized/binary build artifacts. `agent_settled` backstop path live-confirmed (caught real stray binaries); primary `tool_result` path still live-untested. |
| `error-leak-guard.ts` | Adopted, on by default | Flags raw error-string leaks. Same redesign as `artifact-guard.ts`; not yet live-tested. |
| `goal-gate.ts` (`/goal` command) | Adopted, on by default | Session-scoped `/goal <condition>` with a literal `GOAL COMPLETE: <evidence>` marker gated on the most recent broad verification passing against the *current* diff hash (diff-hash-bound, not self-report). Live-confirmed: kickoff race fixed, false-rejection-after-nudge fixed, stall-escalation fixed and live-confirmed (real stall → escalated nudge → recovery), `session_compact` mid-goal reminder shipped but not yet live-exercised. n=7 organic single-process runs, all converged at `rounds: 0` or `1` — "many nudge rounds" behavior not yet seen from this model, treated as a real (if provisional) negative finding, not a gap. Full account, including two real production runs against `personal-budget-simplifier`, in history. |
| `build_app.py` (zero-human build orchestrator) | New, smoke-tested | Drives bounded `pi -p` corrective rounds outside chat, always writes `BUILD_REPORT.md`. 2/2 live smoke runs on a Go task succeeded round 1. Multi-round corrective recovery, `--containment`, non-Go stacks unexercised. |
| `todo.ts` (built-in TUI tool) | Fixed | A malformed model tool-call (validator-rejected `todo` args) hit a missing `default:` case in `renderResult`, returning `undefined` into the TUI's render tree and crashing the interactive session. Root-caused from the actual crashed session log, deterministically reproduced standalone, fixed with an explicit default case. Universal bug class (any model that trips arg validation on `todo`), not local-model-specific. |
| Phase 4 (Aider-based failing-test retry) | Deliberately not built | Aider dispatch is out of scope (benchmarked and removed, see `~/.claude/CLAUDE.md`). |
| KAT-Coder-V2.5-Dev-OptiQ-4bit (`:8083`) | Ruled out, both roles | As primary: one win statistically indistinguishable from Qwen's own variance. As reviewer: structural failure (220s+, never completes), not a tunable timeout. |
| GLM-4.7-Flash-4bit (`:8081`) | Ruled out as reviewer | 0/3 planted-bug catches (shortcut response), vs. Gemma's 3/3 on identical prompts. |

## Open items

Condensed from the full todo list (`pi-harness-history.md` has the complete,
evidence-cited version of each):

- **Background-process kills** (two unattended `/goal` runs killed
  mid-round): root-caused as far as the mechanism class — a client-side
  network-idle timeout on the primary model path, same shape as an
  already-fixed reviewer-timeout bug — but the exact enforcing code isn't
  traced yet. `nohup ... & disown` fully-detached launch is a tested,
  working mitigation in the meantime, not a fix for the underlying cause.
- **`session_compact` mid-goal reminder**: shipped, unit-tested, still not
  live-exercised while a goal is active (every forced compaction so far
  landed after the goal had already completed).
- **"Many nudge rounds" endurance**: closed out as a negative finding for
  this model on tasks tried so far (n=7, all `rounds: 0` or `1`), not an
  open gap — but a harder task class or a different model might still
  produce a genuine many-round case, and multi-restart endurance (surviving
  an actual process kill, not just nudge rounds within one process) is
  separate and still untested.
- **`makefile-scaffold-nudge.ts` / `error-leak-guard.ts`**: revised designs
  not yet live-tested (only the superseded versions were).
- **`cross-model-review.ts` settlement trigger**: needs a live battery run
  against a task whose verification command never runs inside the model's
  own session (e.g. `local-model-bench`) to confirm a clean round, not just
  that it fires.
- **Reviewer-candidate batteries**: pair 4 (go-flutter/bookmarks-app) needs
  a full paired rerun, not just an isolated bug repro, before any
  candidate-model claim beyond n=1; TypeScript/JS task fixtures still need
  battery coverage (currently routed + unit-tested only).
- **`co-change-suggest.ts` / `continuation-nudge.ts`**: both still need live
  (non-retrospective) field validation before they clear the adoption bar.
- **`quality-gate.ts` overhead**: median 100.3% runtime cost is still above
  the plan's 20% screening threshold — needs either a reduction or an
  evidenced revision to the threshold itself.
- Misc smaller items (DayTrix skill placement, `findings[]` severity-aware
  retry prioritization, OS/container boundary for unattended runs): see
  history for detail.

Full investigation history — dated narrative, superseded partial results,
live-run-by-live-run detail — is in `pi-harness-history.md`.
