# pi harness — consolidated validation status

**Current as of 2026-08-16.** This file states only what's true right now,
extension by extension, kept deliberately short and high-level. The full
dated investigation — what was tried, what broke, what got fixed, live-run
counts, superseded results — lives in `pi-harness-history.md`; nothing here
is understandable-only-with-history, but that file is where the "why" and
"how do we know" detail is if you want it. Standalone task/review reports
(real builds, external reviews of this repo's customizations) live under
`history/`.

## Current configuration

Pi 0.83.0 has two resident inference routes: `Qwen3.8-27B-8bit`
on `:8080` (primary, host `kannasmacstudio.lan`) and `gemma-4-26b-a4b-it` on
`:8081` (reviewer, same host). `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL`/
`AI_STACK_HOST` live in `~/.zshenv` (sourced by every zsh invocation,
interactive or not — see `pi-harness-history.md` for why this moved out of
`~/.zshrc`), so `cross-model-review.ts` resolves to genuine
`independent-review`. `AI_REVIEW_MODEL` must be the exact id `GET
:8081/v1/models` returns, not a short form — a stale short id silently
disabled the reviewer once already (see history).

The Qwen3.8 migration was live-validated on 2026-08-16. Before the active
provider and Pi settings were updated, a default `pi -p` request reached the
LAN proxy but failed with HTTP 400 `model_mismatch` because it still sent the
Qwen3.6 path. With the exact Qwen3.8 id installed, a fresh default-provider
request completed successfully. A committed scratch Go task then exercised
the full read/edit/test loop: Pi reproduced three failing assertions, made the
minimal `strings.Fields` fix, and reached 4/4 passing tests. The settlement
quality gate independently reran the canonical check and recorded `pass` (so
the model's earlier shell-masked test command was not accepted as evidence),
and the distinct Gemma reviewer recorded `clean`. The maintained harness also
typechecked and passed all 159 deterministic tests in the same validation run.

**Post-migration claude-sonnet-5 comparison, 4 live trials (2026-08-16):**
`claude-sonnet-5` (this session's own CLI) passed `go/lru-cache` clean in
32.4s, one shot — 3/3 all-time on this exact task per `local-model-bench`'s
history. `pi-local` (Qwen3.8) went **0/4** across four repeated live trials,
producing the identical bug every time (a key/value-confusion in eviction),
and `cross-model-review.ts` independently caught that same bug 4/4 times
without the model ever acting on the diagnosis. Along the way: a real gap
in the task's own hidden tests was found and fixed (every eviction test
used `key == value`, so this exact bug scored a false "pass"); two real
bugs were found and fixed live in the two new extensions built in response
(`progress-stall-guard.ts`, `wall-clock-budget-nudge.ts` — see their table
rows below); a third extension gap was found and left honestly
unfixed (the stall guard's repeated-failure fingerprint is too strict
against varied scratch-test content); and the dominant early contention
turned out to be self-inflicted (leftover processes from earlier trials,
not fully killed, still contending for the shared local-model route).
Evidence points to `defaultThinkingLevel: "off"` as a likely contributing
factor — across all four trials the model produced exactly one turn of
narrated reasoning text out of 265 tool calls — untested as a fix.
Full account, trial-by-trial: `pi-harness-history.md`'s "Post-Qwen3.8-
migration claude-sonnet-5 comparison" entry (2026-08-16). Task-suite
detail: `local-model-bench/SPEC.md`'s 2026-08-16 report, indexed in its
`STATUS.md`.

**That hypothesis is no longer untested (2026-08-17).** `ai-stack-local.ts`
now sets `reasoning: true` (`compat.thinkingFormat: "qwen"`,
`supportsDeveloperRole: false` — see below) and `defaultThinkingLevel` is
`"medium"`, not `"off"`, in both `pi/settings.json` and the live
`~/.pi/agent/settings.json`. A `before_provider_request` hook also now
injects `temperature: 0.6` — mlx-vlm defaults to greedy (`0.0`) when
unset, and `pi-coding-agent` has no `--temperature` flag or settings field
of its own to override that. Enabling thinking alone caused a real
regression first (`supportsDeveloperRole` defaults true for reasoning
models on generic OpenAI-compatible endpoints; this route's tokenizer
rejects the resulting `"developer"`-role message with a 503 on every
turn, producing a zero-diff run worse than the 0/4 baseline), fixed by
forcing that compat flag off. With both fixes in place: **3/3 on
`go/lru-cache`** (trials 6-8), correct key-based fix, 100% coverage,
matching the exact regression test (`TestEvictsByKeyNotValue`) added
because of this file's own 0/4 finding — not yet the ~4-repeat bar this
file's own prior finding needed before being called replicated, more
trials in progress. Full trail: `qwen38-agentic-coding-tuning-research.md`
(repo root) and `pi-harness-history.md`'s "untested `defaultThinkingLevel`
hypothesis, tested" entry (2026-08-17).

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
| `quality-gate.ts` | Adopted, on by default | Binds passing evidence to the current diff hash, rejects truncated/shell-masked results, runs the repo's canonical check at settlement, caps corrective follow-ups at three. Proven in the nine-pair battery. Corrective follow-up under `pi -p` is a **confirmed real gap, not just a suspicion**: fires in a small isolated repro (n=1) but silently doesn't in two independent deep sessions (9 turns real, 30 turns deliberate repro) — queues the follow-up correctly, then the process exits with no second turn. Mechanism not yet isolated; see history. |
| `stack-router.ts` | Adopted, on by default | Routes Go, Python, Flutter, TypeScript/JavaScript, PostgreSQL, Kafka, Temporal, GCP guidance from repo evidence. Only Go/Dart routes have battery coverage; rest are unit-tested only. |
| `co-change-suggest.ts` | Default-disabled, source-tested | One real retrospective replay (ranked target #1 of 8) short of the adoption threshold. Live validation not run. |
| `continuation-nudge.ts` | Default-disabled, source-tested | Deterministic tests pass; widened trigger has zero real-trial field evidence. |
| Auto-compaction (`ai-stack-local.ts` `contextWindow`) | Fixed and live-confirmed | Was mis-set to a value above the route's real admission budget, so Pi's own auto-compaction never fired on overflow. Corrected + adapter-level follow-up fix; live rerun: reward 1.0. Detail in history. |
| `stack-skill-overlay.ts` | Fixed | Per-repo stack skills only load matching skill(s) instead of all 8 globally — real measured ~15% prompt-token reduction. |
| `codebase-memory-mcp` 0.9.0 | Default-disabled, trial-only | No efficiency win over plain repo tools in a paired Go trial; vendor's token-reduction claim not confirmed. Not globally wired. |
| `cross-model-review.ts` | Adopted, resolves to genuine `independent-review` | 15/15 planted-bug catch rate, 0/9 false positives on a checked-in battery (`pi/evals/reviewer-battery.ts`). Was structurally blind on all-untracked repos (fixed) and on suites whose verification command never runs inside the model's own session (mitigated via a settlement-time trigger). That trigger is now live-confirmed with a clean round: a task that only ran `go build`/`go vet` (no `go test`, no Makefile) still got a real settlement-triggered review with a genuine `outcome:"flagged"` finding, not the earlier `model-rejected` transport failure. Full saga (stale-model-id incident, schema-ordering regression, timeout raise) in history. |
| `new-project-scaffold.ts` | Adopted, on by default | Git-init + layered-architecture nudge for greenfield repos. Live-tested. |
| `makefile-scaffold-nudge.ts` | Adopted, on by default | Nudges toward a canonical Makefile target. Redesigned `tool_result`/`turn_end` backstop live-confirmed: armed by a `go mod init` bash call, nudged at the next turn boundary, model acted on it. |
| `artifact-guard.ts` | Adopted, on by default | Flags oversized/binary build artifacts. Both paths live-confirmed: `agent_settled` backstop (caught real stray binaries) and primary `tool_result` path (fired in-band on a `go build -o` command before any commit could hide the artifact). |
| `error-leak-guard.ts` | Adopted, on by default | Flags raw error-string leaks. Redesigned `tool_result` write-scan live-confirmed (fired instantly on a planted `http.Error(w, err.Error(), ...)` leak); `agent_settled` backstop also confirmed in the same run. |
| `goal-gate.ts` (`/goal` command) | Adopted, on by default | Session-scoped `/goal <condition>` with a literal `GOAL COMPLETE: <evidence>` marker gated on the most recent broad verification passing against the *current* diff hash (diff-hash-bound, not self-report). Live-confirmed: kickoff race fixed, false-rejection-after-nudge fixed, stall-escalation fixed and live-confirmed (real stall → escalated nudge → recovery), `session_compact` mid-goal reminder shipped but not yet live-exercised. n=7 organic single-process runs, all converged at `rounds: 0` or `1` — "many nudge rounds" behavior not yet seen from this model, treated as a real (if provisional) negative finding, not a gap. Full account, including two real production runs against `personal-budget-simplifier`, in history. |
| `build_app.py` (zero-human build orchestrator) | Live-tested | Drives bounded `pi -p` corrective rounds outside chat, always writes `BUILD_REPORT.md`. `--containment` confirmed refusing exactly as documented (exit 1, no report, no round attempted). Multi-round corrective recovery: 5/5 single-round successes across every attempt so far, including three deliberate traps (a hidden runtime-only behavioral contract, a concurrency-bug class this model class sometimes misses unaided) — same shape as `goal-gate.ts`'s n=7 negative finding, not a testing gap; the `--continue` loop itself is unit-tested but still never exercised against a real failure. Non-Go stacks unexercised. |
| `progress-stall-guard.ts` | Trace-only, two live-found bugs fixed, one live-found gap open | Detects repeated tool calls (re-running a self-written test) with no source edit and an unchanged failure fingerprint. Two real bugs found and fixed across trials 3-4 (2026-08-16): missing `make (?:verify\|test\|check)` pattern, and `agent_start` resetting state on every internal auto-retry instead of only the true first start. Both confirmed fixed live in trial 4 (single `agent_start`, correct trace behavior throughout a real 30-minute run). Open gap, found live, not yet fixed: the repeated-failure fingerprint is too strict against varied scratch-test content written outside the `write`/`edit` tool path (e.g. `bash cat > /tmp/x_test.go <<EOF`) — trial 4 reached 61 stall rounds (~26 min, zero source edits) without ever firing. 9 deterministic tests. Nudge (`PI_STALL_GUARD_NUDGE=1`) still not enabled by default, pending resolution of the fingerprint gap. Full account: `pi-harness-history.md`'s 2026-08-16 entry. |
| `wall-clock-budget-nudge.ts` | Adopted, on by default, live-confirmed | Warns once near 75% of an externally-supplied `PI_HARNESS_TIMEOUT_MINUTES` deadline ("land your diagnosed fix now"). Inert unless that env var is set; `local-model-bench`'s runner sets it from each task's `harness_timeout_minutes`. One bug found and fixed live (2026-08-16): `agent_start` resetting `startedAt` on every internal auto-retry, so a retried run's deadline never accumulated real elapsed time; fixed to anchor on only the true first `agent_start`. Confirmed live in trial 4: fired exactly once, at the correct point (23 of 30 minutes), zero false resets across a real run. 5 deterministic tests. |
| `todo.ts` (built-in TUI tool) | Fixed | A malformed model tool-call (validator-rejected `todo` args) hit a missing `default:` case in `renderResult`, returning `undefined` into the TUI's render tree and crashing the interactive session. Root-caused from the actual crashed session log, deterministically reproduced standalone, fixed with an explicit default case. Universal bug class (any model that trips arg validation on `todo`), not local-model-specific. |
| Phase 4 (Aider-based failing-test retry) | Deliberately not built | Aider dispatch is out of scope (benchmarked and removed, see `~/.claude/CLAUDE.md`). |
| KAT-Coder-V2.5-Dev-OptiQ-4bit (`:8083`) | Ruled out, both roles | As primary: one win statistically indistinguishable from Qwen's own variance. As reviewer: structural failure (220s+, never completes), not a tunable timeout. |
| GLM-4.7-Flash-4bit (`:8081`) | Ruled out as reviewer | 0/3 planted-bug catches (shortcut response), vs. Gemma's 3/3 on identical prompts. |

## Open items

Condensed from the full todo list (`pi-harness-history.md` has the complete,
evidence-cited version of each):

- **Background-process kills** (now four unattended `/goal` runs killed
  mid-round, the latest two on 2026-08-12): root-caused as far as the
  mechanism class — a client-side network-idle timeout on the primary
  model path, same shape as an already-fixed reviewer-timeout bug — but
  the exact enforcing code isn't traced yet. `nohup ... & disown`
  fully-detached launch is a tested, working mitigation in the meantime,
  not a fix for the underlying cause. New unconfirmed lead: the latest two
  kills both happened under a deliberately aggressive compaction setting
  (forcing frequent, longer prefills) — 2/2 correlation, not yet a
  confirmed trigger; see `pi-harness-history.md`'s 2026-08-12 live-testing
  entry.
- **`session_compact` mid-goal reminder**: shipped, unit-tested, still not
  live-exercised while a goal is active. Two dedicated attempts on
  2026-08-12 (forcing compaction via an aggressive threshold) both hit the
  background-kill bug above before producing a result — still open, now
  with a specific repro lead to chase for the kill bug itself.
- **"Many nudge rounds" / multi-round corrective recovery endurance**:
  closed out as a negative finding for this model on tasks tried so far —
  `goal-gate.ts` n=7 (all `rounds: 0` or `1`) and now `build_app.py` n=5
  (all single-round successes, including three deliberate traps) — not an
  open gap in the mechanisms themselves, both of which remain unit-tested
  and logically sound but never exercised end-to-end against a real
  multi-round failure. A harder task class or a different (weaker) model
  might still produce a genuine many-round case, and multi-restart
  endurance (surviving an actual process kill, not just corrective rounds
  within one process) is separate and still untested.
- **Pair 4 (go-flutter/bookmarks-app) reviewer mechanism check**: scope
  narrowed on 2026-08-13 (Opus-reviewed) from a candidate-model capability
  claim — dropped as infeasible at any affordable n, since the base rate
  it would compare against (2/5) has a 5-85% CI — to a pre-registered,
  n=1-decisive check of whether `cross-model-review.ts`'s settlement
  trigger fires on this task under real battery methodology. Run, but
  **invalid per its own pre-registration**: the harness arm hit the
  fixture's 45-minute timeout mid-corrective-loop (code had already
  reached a passing state; `pi` itself hadn't declared done). The
  reviewer trace that did fire before the kill is deliberately not
  counted. Mechanism question still open. See `pi/evals/
  pair4-rerun-2026-08-13.json` and `plans/pair4-reviewer-mechanism-check-
  plan.md`.
- TypeScript/JS task fixtures still need battery coverage (currently
  routed + unit-tested only).
- **`co-change-suggest.ts` / `continuation-nudge.ts`**: both still need live
  (non-retrospective) field validation before they clear the adoption bar.
- **`quality-gate.ts` overhead**: median 100.3% runtime cost is still above
  the plan's 20% screening threshold — needs either a reduction or an
  evidenced revision to the threshold itself.
- **`quality-gate.ts` corrective follow-up under `pi -p`**: confirmed (n=2,
  9 and 30 turns) that the follow-up gets queued correctly but the process
  exits before a second turn runs it — a real fix is needed, not just more
  observation. The one working case so far is a small, few-turn scratch
  repo; what specifically differs at depth isn't isolated yet.
- Misc smaller items (DayTrix skill placement, `findings[]` severity-aware
  retry prioritization, OS/container boundary for unattended runs): see
  history for detail.

Full investigation history — dated narrative, superseded partial results,
live-run-by-live-run detail — is in `pi-harness-history.md`.
