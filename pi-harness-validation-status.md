# pi harness — consolidated validation status

**Current as of 2026-08-05.** This file states only what's true right now,
extension by extension. The full dated investigation — what was tried, what
broke, what got fixed, live-run counts, superseded results — lives in
`pi-harness-history.md`; nothing here is understandable-only-with-history,
but that file is where the "why" and "how do we know" detail is if you want
it.

## Current configuration

Pi 0.83.0 has two resident inference routes: `ThinkingCap-Qwen3.6-27B-MLX-8bit`
on `:8080` (primary, host `kannasmacstudio.lan`) and `gemma-4-26b-a4b-it` on
`:8081` (reviewer, same host). `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL`/
`AI_STACK_HOST` are now in `~/.zshenv` with `${VAR:-default}` defaulting
(moved from `~/.zshrc` on 2026-08-05 — `.zshenv` is sourced by *every* zsh
invocation, interactive or not, unlike `.zshrc`; verified against a fully
isolated `env -i` non-interactive shell resolving correctly, an inline
override still winning over the default, and PATH's idempotent-prepend not
duplicating across nested shells), so `cross-model-review.ts` resolves to
genuine `independent-review` — this part of a same-day retraction held up.

**A second, same-day correction reopened the reviewer finding.** The first
retraction (below, in `pi-harness-history.md`) wrongly cleared
`cross-model-review.ts` entirely, based only on a redirected `--mode json`
stdout log. An independent Opus review of that retraction, checking it
against `appendHarnessTrace`'s actual implementation (`pi.appendEntry(...)`,
which persists to pi's own session JSONL files — not stdout, and not
losable to a killed process's stdout buffer the way the retraction claimed)
and against those session files directly, found **the reviewer produced a
`startup` trace but zero `review` traces across all 7 real
personal-budget-simplifier build sessions**, including two that ran after
config was already correct. Root cause, confirmed against source: the
extension built its diff with a bare `git diff`, which never shows
untracked file content; the build had exactly one commit (at the very end),
so every chunk ran against an all-untracked tree and every diff was empty.
Silent by construction — no trace on that path, which is also now fixed.
**Fixed for real**: `cross-model-review.ts` now shares `quality-gate.ts`'s
untracked-file handling via a new `buildReviewDiff()` helper; a trace now
fires on the previously-silent early-return paths too. `npm test`: 123/123.
Live-verified against the exact original bug condition (fresh repo, zero
commits, one untracked file) — the reviewer now fires and completes a real
review round there. Full account in `pi-harness-history.md`'s "Correction of
the correction" entry — read that one, not the "Corrected: two false
harness-bug findings" entry immediately before it, which is itself
superseded on this point.

Same-primary review still requires `AI_REVIEW_ALLOW_SELF=1` and is labeled
`blind-self-review`, never cross-model, if it's ever pointed back at the same
route. `AI_REVIEW_MODEL`
must be the exact id `GET :8081/v1/models` returns
(`/Users/kanna/code/ai-stack/models/gemma-4-26b-a4b-it-4bit`), not the short
`gemma-4-26b-a4b-it` form — see "Stale `AI_REVIEW_MODEL` silently disabled
the reviewer" in `pi-harness-history.md` for how this drifted and broke
silently once already; chunks 1–4 of the personal-budget-simplifier build
also ran against this exact stale pair, compounding the untracked-diff gap.

`quality-gate.ts`'s corrective-follow-up loop under `pi -p` is **unresolved,
not confirmed either way** — an isolated single-file test showed a second
`agent_settled` firing after a `sendUserMessage` follow-up; the actual
chunk-3 build session (nine assistant turns deep by the time it failed)
shows no follow-up message and no second turn at all. The difference isn't
explained; don't cite this as either working or broken until a repro closer
to a real multi-turn chunk's shape is run. The maintained Pi
project typechecks
against pinned 0.83.0 public types and has 123 deterministic tests covering
loading, event ordering, retry caps, current-diff verification, shell-masked
exits, reviewer truthfulness, symlink escapes, external-effect policy,
installer scope, stack routing, extension interactions, nested verification
manifests, stale-extension-context handling, and the greenfield-project
hardening extensions below. Verification-command
resolution (both `quality-gate.ts`'s settlement check and
`cross-model-review.ts`'s trigger) recognizes a Makefile `verify`, `test`,
or `check` target, in that priority order, not just `verify` — see
`pi-harness-history.md`'s "make test/make check recognized" entry.

One acceptance boundary remains intentionally not adopted:

- `continuation-nudge.ts` and `co-change-suggest.ts` remain source-tested
  but are removed from the installed runtime until randomized paired
  evidence meets the current adoption threshold.

Docker containment is now live-proven on this host via Colima: the image and
launcher build and run with Pi 0.83.0, the persistent agent volume is writable
by UID 10001, and `pi/containment/verify-live.sh` passes 17/17 checks covering
workspace-only writes, escape attempts, host credentials/socket absence,
network denial, `/tmp` noexec, capabilities, and no-new-privileges.

## Current battery result

A completed nine-pair randomized screen (seed `20260802`, stock Pi vs. the
installed harness, strictly sequential, hidden tests overlaid after Pi
exited) is the current operational-hardening evidence:

- Hidden-test success: baseline 7/9, harness 8/9. Harness matched or beat
  baseline; its one loss (pair 4, go-flutter/bookmarks-app) was a shared
  failure baseline also hit — a `go test -race` data race in a
  visit-counter HTTP handler, a genuine 27B-model concurrency-reasoning
  gap, not a harness defect (detail in `pi-harness-history.md`'s pair-4
  deep-dive). An isolated spot-check (2026-08-03, not a paired battery run)
  reproduced the exact bug in a standalone repro package and gave it to
  `gemma-4-26b-a4b-it` with only the `go test -race` failure output as
  context: it correctly diagnosed the pointer-outside-lock cause and
  applied the same snapshot-under-lock fix `pi-harness-history.md`'s
  root-cause note recommends; `go vet` and `go test -race` passed clean
  against a control that reproduced the original failure. This is n=1
  evidence Gemma may not share Qwen's concurrency-reasoning gap, not proof
  it clears the paired-battery bar — see todo below.
- Zero extension errors and zero `quality-gate: unconfigured` outcomes
  across all eighteen runs.
- Median paired runtime overhead: 100.3% (prompt tokens +212.6%, completion
  tokens +39.8%), above the plan's 20% screening threshold. This is the
  honestly-measured cost of quality-gate actually running its
  nested-manifest verification and corrective-follow-up loop on every
  pair, not a bug-distorted number.

Full record: `pi/evals/full-screening-2026-08-03.json`. Runner:
`pi/evals/run_screening.py`.

## Extension-by-extension current status

| Extension | Status | Evidence |
|---|---|---|
| `protected-paths.ts` | Adopted, on by default | Tool guard on Pi `write`/`edit`, not `bash`, symlink escapes, or OS-level confinement. Deterministic tests + 1 live catch (corrected an absolute-path escape). |
| `format-on-edit.ts` | Adopted, on by default | Deterministic gofmt/dart-format/prettier-if-present pass, not a judgment call. |
| `rtk-rewrite.ts` | Adopted, on by default | Deterministic bash-output filter. |
| `git-checkpoint.ts` | Adopted, on by default | Deterministic per-turn snapshotting. |
| `git-safety.ts` | Adopted | Blocks destructive git commands (`reset --hard`, `push --force` w/o lease, `clean -f`, `branch -D`, `checkout/restore -- .`). 1 scratch-repo reproduction plus deterministic tests. |
| `quality-gate.ts` | Adopted, on by default | Binds passing evidence to the current diff hash, rejects truncated/shell-masked results, runs the repo's canonical check (including nested manifests) at settlement, caps corrective follow-ups at three. Proven in the completed nine-pair battery above. Corrective follow-up under `pi -p` is **unresolved as of 2026-08-05**, not confirmed either way: an isolated single-file forced-failure test showed `sendUserMessage(..., {deliverAs: "followUp"})` producing a genuine second `agent_settled` turn a minute later, but the real personal-budget-simplifier chunk-3 build session (nine assistant turns deep when it failed) shows zero follow-up message and zero second turn for the identical mechanism. Difference unexplained — do not cite as working or broken pending a repro closer to a real multi-turn chunk's shape. See `pi-harness-history.md`'s "Correction of the correction" entry. |
| `stack-router.ts` | Adopted, on by default | Routes Go, Python, Flutter, TypeScript/JavaScript, PostgreSQL, Kafka, Temporal, and GCP guidance from repository evidence. Deterministic tests for all routes; only Go/Dart routes have battery coverage (see battery result above), the rest are wired and unit-tested but not battery-proven. |
| `co-change-suggest.ts` | Default-disabled, source-tested | One real retrospective replay (ranked target file #1 of 8) does not meet the paired-adoption threshold. Live (non-retrospective) validation not run. |
| `continuation-nudge.ts` | Default-disabled, source-tested | Deterministic branch tests pass; the widened empty-content-stop trigger has zero real-trial field evidence. **Correction**: this entry briefly (same-day, 2026-08-07) claimed real field evidence from `local-model-bench`'s Go/Flutter matrix — wrong. That task's `content: []` final turn was a rendering artifact of a genuine `stopReason: "error"` (a context-budget rejection, not an empty-content stop by choice); re-checked against the raw session JSONL's `errorMessage` field, not just `content`. See `context-budget-awareness` entry below for the corrected, actionable finding from that run. |
| Auto-compaction (built into Pi core, not a repo extension) — `ai-stack-local.ts` `contextWindow` | **Fixed and live-confirmed 2026-08-07/08** | Root cause of `group-invite-atomic-rotation`'s loss (`local-model-bench`'s 2026-08-07 Go/Flutter matrix): not a missing capability — Pi's own auto-compaction is enabled (`~/.pi/agent/settings.json`: `compaction.enabled: true`) and explicitly exists to handle this ("context overflow errors are NOT retryable, handled by compaction instead" — `compaction.md`). It never fired because `pi/extensions/ai-stack-local.ts` declared `contextWindow: 96000` for the Qwen route, an ungrounded guess. The route's real admission budget, enforced by `kv_concurrency_proxy.py` on `kannasmacstudio.lan`, is 49152 (`--max-kv-size 65536` minus `maxTokens 16384`, confirmed both by the live 400's error message and by `proxy_config.py`). With `contextWindow: 96000`, Pi's trigger (`contextTokens > contextWindow - reserveTokens`, `reserveTokens: 16384`) sat at 79,616 tokens — the session hit the proxy's real ~46,694-49,152 rejection line at 55,339 tokens, well before Pi ever thought it needed to compact. Also identified in passing: `pi-local`'s own system-prompt/`AGENTS.md`/skills/extensions overhead costs ~7,036 prompt tokens on the very first request, before any task content — a fixed tax `terminus-2` (the lean reference agent used as control in that matrix) doesn't pay, and part of why `pi-local` reaches the ceiling sooner on identical tasks. **Fix**: `contextWindow` corrected to `49152`, giving compaction a 13,926-token margin under the proxy's real rejection threshold (commit `8531917`). `npm test`: 125/125. That alone wasn't sufficient: `local-model-bench/harbor_agents/pi_harness.py`'s `PiHarness` needed a second fix, since Pi's auto-compaction only runs *reactively*, at end-of-session, after `agent_end` fires on the erroring turn — under `--print` (one-shot) mode nothing resumes the same invocation afterward on its own. Two bugs found building the adapter-level bounded follow-up (`--continue` re-invocation on a real `context_length_budget_exceeded`-shaped end): (1) using `self.resume()` dispatches virtually back to the override's own `run()`, letting each follow-up spawn up to `MAX_COMPACTION_FOLLOWUPS` more of its own instead of respecting the global cap — fixed by calling `Pi.run()` directly with `_resume` set/reset manually; (2) the trigger fired on *any* `agent_end` → incidental compaction, including a clean `stopReason: "stop"` finish that happened to cross the token threshold during ordinary bookkeeping — fixed by requiring the last assistant turn's `stopReason` to actually be `"error"`. Both fixes verified against 4 synthetic-fixture cases before the live rerun (commit `dfe4620`, `local-model-bench`). **Final live result**: reward 1.0, 3 total invocations (1 original + 2 bounded follow-ups, cap respected, no runaway recursion), 1 compaction, 47m34s — versus the pre-fix run's non-attempt (empty/errored turn, 3m29s, reward 0.0) and the interim buggy-adapter run's 1h52m57s (extra unneeded rounds from both bugs above). The model's own attempt quality also improved qualitatively along the way: an intermediate run (before the adapter bugs were fixed) got past the original non-attempt failure into a real implementation with a wrong method signature (a normal compile-error failure, not an abandonment) — evidence the underlying `contextWindow` fix was already doing real work before the adapter-level bugs were resolved too. |
| `stack-skill-overlay.ts` (new, addresses the ~7,036-token startup tax noted above) | **Fixed 2026-08-07** | The 8 stack skills (`go-service`, `python-service`, `flutter-app`, `typescript-service`, `postgres-change`, `kafka-processing`, `temporal-go`, `gcp-deploy`) were global links in every machine's `~/.pi/agent/skills/` (`install.sh`'s `PI_STACK_SKILLS`), so Pi advertised all 8 names+descriptions in the system prompt every session regardless of repo — most of a repo only ever matches one or two. Root-caused via word-count decomposition of the ~7,036-token baseline: skill frontmatter alone was ~1,790 of it. **Fix**: `PI_STACK_SKILLS` dropped from the global `link_skills` call; `stack-skill-overlay.ts` (new, mirrors `project-skill-overlay.ts`'s DayTrix-remote pattern) uses the `resources_discover` hook plus `stack-router.ts`'s existing `routeStackSkills()` evidence detection to return `skillPaths` for only the matching stack(s). `install.sh` now unlinks any pre-existing global stack-skill symlinks on upgrade. Also folded in: deduped `AGENTS.md`'s working-rules list against `karpathy-guardrail.ts`'s system-prompt injection (both stated the same surgical-changes/minimum-code/surface-assumptions/verifiable-criterion guidance; `AGENTS.md` now keeps only what the guardrail doesn't cover and points to it instead), and added 4 new pi-flavored skills (`tdd`, `diagnosing-bugs`, `resolving-merge-conflicts`, `grill`, adapted from https://github.com/mattpocock/skills for pi's no-subagent, small-context constraints — dropped `code-review`'s parallel-sub-agent requirement, `research`'s background-agent requirement, and the issue-tracker-heavy skills as not portable) to `PI_ONLY_PORTABLE_SKILLS`. Net effect measured live (not estimated): a fresh empty repo, first `pi -p "Say OK." --mode json` request, same methodology as the original ~7,036 baseline, now reports `usage.input: 5981` — a real 1,055-token (~15%) reduction. `npm test`: 128/128. `tsc --noEmit`: clean. |
| `codebase-memory-mcp` 0.9.0 | Default-disabled, trial-only; not globally wired | Disposable Go repo indexed successfully (10,658 nodes/48,988 edges). Go follow-up: three tasks with memory-directed/repo-tools/no-tools arms; memory and repo-tools each scored 8/12, no-tools 0/12. Across the two completed pairs, memory used 2.88% more comparison tokens, took 7.91% longer, 75% more turns, and 59.09% more tool calls. Both tool-enabled MCP-gate arms hit the frozen eight-minute cap without final answers. Blinded Gemma 4 agreed with all completed deterministic scores. Vendor 99.2% token-reduction claim not confirmed; no global wiring. |
| `cross-model-review.ts` | Adopted, resolves to genuine `independent-review`, confirmed firing and completing real review rounds under `pi -p` on tasks with a committed base and a genuine broad verification command; was structurally blind on all-untracked repos (fixed 2026-08-05, see below) and still structurally blind on task suites whose verification command never runs (e.g. `local-model-bench`, see below) | `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` moved to `~/.zshenv` 2026-08-05 (was `~/.zshrc`, interactive-shell-only — see `pi-harness-history.md`'s env-propagation entries) set to `gemma-4-26b-a4b-it` on `:8081`, distinct from the `:8080` Qwen primary. Deterministic tests pass (74/74); live-checked 2026-08-04 that `resolveReviewerConfig()` resolves `independent-review` (not `disabled`/`blind-self-review`) and that `requestReview()` correctly flagged a deliberately planted bug against the real endpoint. A separate 2026-08-04 investigation against a third route (KAT-Coder, `:8083`, not the standing config) found and fixed a process-crashing stale-context bug in the `tool_result` catch handler and a structural gap where `pi -p` exited before any review round could finish; both fixed, tested, and now apply to whichever route is configured — see `pi-harness-history.md`'s "Trying a third reviewer route" section. `REVIEW_TIMEOUT_MS` raised from 120s to 240s (commit `83ca0cb`) after a real production-shaped review request against idle Gemma took 121.4s — 1.4s past the old timeout, which would have silently discarded a correct finding. A full end-to-end rerun (2026-08-04, standing Qwen+Gemma config, pair 4) confirmed the task itself passes cleanly (9/9 go -race, 17/17 dart) but the reviewer never fired on that suite specifically: its `tool_result` trigger only reacts to the *model's own* successful broad-verification command, and `local-model-bench` hides real test files until after `pi` exits, so the model never has one to run there — it wrote its own smoke test instead, and its one `dart test` call errored on "no test files," which the trigger explicitly excludes. Discovered 2026-08-05: after the `:8082`→`:8081` route move, `AI_REVIEW_MODEL` held the short id `gemma-4-26b-a4b-it` while the route now serves `/Users/kanna/code/ai-stack/models/gemma-4-26b-a4b-it-4bit`; every real request 400'd `model_mismatch`, which `requestReview()` silently downgrades to `{outcome: "transient"}` — the reviewer had been reviewing nothing since the move, with no error surfaced anywhere. Fixed by exporting the full served id. With the id corrected, a 15-trial reviewer-reliability battery (three planted bugs — `clampToRange` missing its upper-bound clamp, `divide` missing its zero-check, `add` implemented as subtraction — 5 trials each at `temperature: 0`, via the real `requestReview()` path) caught 15/15, deterministic across repeats (identical response length per bug on every trial). A 9-trial false-positive control (3 trials each of the correct implementation of the same three functions) returned `NO_ISSUES_FOUND` 9/9. Same day, on the personal-budget-simplifier build: `session_start`/`tool_result` confirmed firing via instrumented diagnostics, but zero `review` traces appeared in any of the build's 7 real sessions (checked directly in `~/.pi/agent/sessions/`, not just `--mode json` stdout) — root cause was a bare `git diff`, which never shows untracked content, against a repo with exactly one commit made at the very end, so every diff during the whole build was empty. **Fixed**: `cross-model-review.ts` now uses a new `buildReviewDiff()` (in `lib/verification.ts`) that synthesizes diff blocks for untracked files the same way `quality-gate.ts`'s `snapshotDiff` already accounts for them; a `review`/`blocked` trace now fires on the previously-silent early-return paths too. `npm test`: 123/123. Live-verified against the exact original bug shape (fresh repo, zero commits, one untracked file) — reviewer now fires and completes a round there. See todo and `pi-harness-history.md`'s "Correction of the correction" entry for the full account, including an earlier same-day retraction of this finding that was itself wrong and has been superseded. **2026-08-05, later the same day**: the 15/9 battery above had never been a checked-in, reproducible test — it existed only as an ad-hoc invocation, and the marker-matching verdict parser (`NO_ISSUES_FOUND` on the last non-empty line) meant any trailing commentary from Gemma flipped a clean review to flagged, an unaudited failure mode of exactly the same shape as the `AI_REVIEW_MODEL` incident above. Fixed in two commits. First (`c94fa60`): split the single `transient` outcome into a `ReviewUnavailableReason` (`not-configured`/`model-rejected`/`empty-response`/`request-failed`, plus `review-pipeline-error`) that reaches the harness trace with the HTTP status attached, so "did the reviewer actually run, and if not why" is now greppable instead of silent; and checked in `evals/reviewer-battery.ts`, reproducing the 15/9 numbers live (confirmed 15/15, 0/9). Second (`125f2b2`): replaced the marker parser with a `response_format` JSON Schema verdict (`{analysis, verdict, findings[]}`) — verified live that `:8081` honors `response_format` correctly, and a parse failure is now `malformed-verdict`, not `clean`, so unreviewed code can never read as reviewed. The first cut of the schema put `verdict` before `analysis` and the battery caught a real regression before it shipped: 10/15, missing the planted `divide` zero-check bug 5/5 deterministically at `temperature: 0`, because constrained decoding emits properties in schema order and a verdict-first schema forces the model to commit before it has reasoned — the same constraint-tax effect reported for small models on structured output generally. An isolation probe (schema × prompt-wording, 4-way) confirmed the schema was the cause, not the reworded prompt. Putting `analysis` first in the schema restored 15/15, 0/9. **Constraint discovered in passing**: `:8080` rejects `response_format` outright when serving with speculative decoding (`"Structured response_format is not supported with speculative decoding"`), so the reviewer route must never be moved onto an MTP/draft launcher — doing so would silently fail every request as `model-rejected`. Gemma is not run with `GEMMA_MTP=1` and this is a deliberate constraint, not an oversight; see `local-ai-stack.md`. |
| `new-project-scaffold.ts` | Adopted, on by default | Git-init nudge plus layered-architecture (`cmd/`/`internal/domain`/`internal/handler`-shaped) nudge for greenfield repos. Live-tested 2026-08-05 against a fresh Go+SQLite todo-app task: both nudges fired and worked exactly as designed (repo initialized, real commit made, the requested layered structure created). Deterministic tests pass. |
| `makefile-scaffold-nudge.ts` | Adopted, on by default | Nudges toward a canonical `verify`/`test`/`check` Makefile target. The original `before_agent_start`-only precondition check was found structurally blind on greenfield repos by the 2026-08-05 live test above — it evaluated once, before any files existed, and was never re-checked after `go mod init` created a manifest mid-session. Redesigned to arm a `tool_result` flag when a manifest file appears and nudge once at the next `turn_end`. Deterministic tests pass (123/123); the revised design has not itself been live-tested — only the superseded version was. |
| `artifact-guard.ts` | Adopted, on by default | Flags oversized/binary build artifacts. Same live test found the original `agent_settled`-only design structurally blind: in `-p` mode `agent_settled` fires once, *after* `agent_end`, by which point the model had already committed, leaving diff-since-`baseSha` empty. Redesigned: primary detection moved to `tool_result` on build-shaped bash commands, `agent_settled` kept only as a cwd-keyed backstop with an empty-tree fallback for the greenfield case (a follow-up review pass also fixed a case where that fallback was permanently dead when the first commit happened mid-session). Deterministic tests pass. **Backstop path (`agent_settled`) live-confirmed 2026-08-09/10**: the Python `/goal` smoke test below caught real Mach-O binaries left in `.venv/` at settlement time and correctly nudged a cleanup turn that resolved it. The primary `tool_result` path (detection during the build itself, not just at settlement) remains live-untested. |
| `error-leak-guard.ts` | Adopted, on by default | Flags raw error-string leaks (e.g. `err.Error()` written straight into an HTTP response). Same structural blind spot and same fix as `artifact-guard.ts`: primary detection moved to a `tool_result` content scan on write/edit, `agent_settled` kept as a per-cwd, empty-tree-fallback backstop, sharing a dedup map with the `tool_result` path so a committed finding isn't re-flagged every subsequent build command. Deterministic tests pass; revised design not yet live-tested. |
| Phase 4 (Aider-based failing-test retry) | Deliberately not built | Gated on Aider dispatch being in scope; it isn't (`~/.claude/CLAUDE.md`, benchmarked and removed). |
| KAT-Coder-V2.5-Dev-OptiQ-4bit (`:8083`) | Ruled out, both roles | **As primary model**: spot-checked 2026-08-04 against pair 4 (go-flutter/bookmarks-app) — fixed the `go test -race` bug that stumped Qwen, but introduced 3 new Dart test failures and the task still failed overall; independent review found this is not real signal, since Qwen itself already fixes this same race in 2/5 runs on its own (see `pi-harness-history.md`'s prior five-run investigation), so a single win is statistically indistinguishable from Qwen's known variance. **As reviewer**: ruled out for a structural reason, not a tunable one — a real production-shaped review request (task spec + diff, 22,784 chars, no `max_tokens` cap) against a confirmed-idle `:8083` route ran 220+ seconds and never completed successfully (`upstream_errors` incremented rather than `completed`). Unlike Gemma's near-miss on the timeout, this wasn't close: the route errored out rather than merely running long, so raising `REVIEW_TIMEOUT_MS` would not fix it. Full detail in `pi-harness-history.md`'s "KAT-Coder ruled out" section. |
| GLM-4.7-Flash-4bit (`:8081`) | Ruled out as reviewer | 0/3 planted-bug catches at default invocation (5-token `NO_ISSUES_FOUND` shortcut every time, no reasoning content) vs. Gemma's 3/3 on the identical prompts. Retried with `chat_template_kwargs: {"enable_thinking": true}` since GLM is hybrid-reasoning and thinking is opt-in per request on most local serving stacks — this unlocked real reasoning exactly once across 10 trials (1/10), reverting to the same shortcut on repeats of the same prompt at `temperature: 0`. Unlike KAT-Coder's reviewer rule-out (a structural request failure), this route responds fine and fast, it just doesn't reliably do the review task on this checkpoint at 4-bit. Community reports corroborate both a Flash-tier reasoning-depth tradeoff and a known 4-bit-quantization weakness on agentic/structured-judgment tasks for this checkpoint. `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` remain pointed at Gemma. Full detail in `pi-harness-history.md`'s "GLM-4.7-Flash-4bit ruled out as reviewer candidate" section. |

## Update 2026-08-09: cross-model-review settlement-time trigger added

Todo item "Give `cross-model-review.ts` a settlement-time trigger" is done.
`agent_settled` now falls back to firing a review round directly (gated on
`snapshotDiff(...).material`, so an empty/no-op turn doesn't spend one) when
no `tool_result`-triggered round ever completed this session —  covers
exactly the `local-model-bench`-shaped gap described in the original todo
(hidden tests don't exist yet during the model's own session, so the
reactive trigger structurally can't fire). Both triggers now share one
`startReviewRound()` path and tag their trace `metadata.trigger` as
`tool_result` or `settlement` so which one fired is greppable. Same caveat
as quality-gate's corrective follow-up applies and is stated in the code
comment: whether a `sendUserMessage(..., {deliverAs: "followUp"})` sent
this late in the turn reliably produces a second turn under `pi -p` is
still the open question tracked below, not newly resolved by this change —
firing at all, even without a guaranteed follow-up turn, is still strictly
better than the previous zero-fire outcome, since the review trace/verdict
itself is real signal. `npm test`: 131/131 (2 new tests: fires on a
material diff with no prior tool_result round; does not spend a round on
an empty diff). Live battery re-run against `local-model-bench` still
pending — this is source/unit-tested only so far, same evidentiary status
the rest of this doc uses that phrase for elsewhere.

## Update 2026-08-09: zero-human full-stack build orchestrator

`pi/scripts/build_app.py` (new) — drives `pi -p` through however many
corrective rounds it takes to get real verification evidence passing, with
no chat interaction and no assumption that quality-gate's in-session
follow-up loop works under `-p` (it's independently unresolved, see above).
The orchestrator runs its own verification command after each `pi -p`
round and starts a fresh `--continue` round with the failure as the prompt
if it didn't pass, capped at `--max-rounds`. Optional `--containment` runs
each round through the live-proven Docker sandbox. Always writes
`BUILD_REPORT.md` (rounds, verify results, extension traces, review
verdicts) as the durable zero-human record. Full detail and known gaps in
`pi/scripts/README.md`.

Live-smoke-tested twice 2026-08-09 (Go/net-http health-endpoint task, host
direct, no `--containment`): both runs succeeded on round 1 —
`stack-router` routed, `quality-gate` verified twice, `cross-model-review`
fired via its `tool_result` trigger and returned `clean`, real commit made,
`go vet`/`go test` independently re-confirmed passing outside the harness.
Second run also confirmed the orchestrator's own `.pi-build-session/` and
`BUILD_REPORT.md` stay out of the app's git history (a real leak the first
run hit and the second run's `.gitignore` seeding fixed). This is two
confirming repros on one task/stack, not a battery — multi-round corrective
recovery, `--containment`, and non-Go stacks are unexercised; see the
todo below and `pi/scripts/README.md`'s "Known gaps" section.

## Update 2026-08-09: `/goal` command (goal-gate.ts)

New: `pi/extensions/goal-gate.ts` — a Claude-Code-style `/goal <condition>`
command (registered via `pi.registerCommand`, not a prompt template, since
it needs persistent cross-turn state and a stop-time gate). Sets a
session-scoped goal, kicks off a follow-up turn immediately, and on every
`stopReason: "stop"` turn checks for a literal `GOAL COMPLETE: <evidence>`
line backed by the most recent broad verification command actually having
passed; nudges to continue otherwise, capped at `PI_GOAL_MAX_ROUNDS`
(default 15). Deliberately does not add an LLM-judged completion check —
see the file's own header for why a same-model judge would carry the same
self-report bias this doc already documents elsewhere. `npm test`:
143/143 (12 new deterministic tests, `pi/tests/goal-gate.test.ts`); `tsc
--noEmit`: clean.

**Live-tested 2026-08-09 against a fresh empty repo under `pi -p`
(`/goal say hello and stop`, "hello" Go program task) — two real bugs
found and fixed, both confirmed by the fix's own rerun, not assumed:**

1. **The kickoff never ran at all.** First live attempt: `pi -p "/goal ..."`
   exited immediately (exit 0, one `session` line, zero `agent_start` —
   not even a turn attempted) whether run in `--mode json` or plain text.
   Root cause, confirmed by reading `agent-session.js`:
   `ctx.waitForIdle()` returns instantly if the agent is idle *right now*
   (`if (this.isIdle) return`), and `pi.sendUserMessage()` only queues a
   turn -- it returns void, not a promise, and the queued turn hasn't
   started by the time the command handler's next line runs. Calling
   `waitForIdle()` right after `sendUserMessage()` raced the not-yet-started
   turn and returned immediately, so the `-p` process exited before the
   kicked-off turn ever began. **Fixed**: the command handler now waits for
   a real `agent_start` event (bounded by `PI_GOAL_KICKOFF_TIMEOUT_MS`,
   default 10s) before calling `waitForIdle()`. Confirmed live after the
   fix: a real `agent_start`/turn sequence now runs under `-p`.
2. **A genuine pass kept getting rejected as unverified.** With bug 1 fixed,
   the same task ran for 74+ turns and 15 nudge rounds without ever
   accepting a `GOAL COMPLETE` claim, despite `quality-gate.ts`'s own trace
   log showing the exact same verification command passing repeatedly.
   Root cause: `lastVerification` was reset to `"none"` after *every*
   nudge, but `stopReason: "stop"` fires on ordinary mid-task narrative
   with no tool call too (`"Now I'll run the tests:"` with nothing
   attached) -- exactly what `continuation-nudge.ts` calls an abandoned
   turn -- not only on genuine stopping points. Each such narrative turn
   wiped out a real pass long before the model's next actual completion
   attempt. **Fixed**: only reset `lastVerification` when a `GOAL COMPLETE`
   claim is specifically rejected, not on every nudge; documented as a
   known, accepted gap that this signal isn't diff-hash-bound the way
   `quality-gate.ts`'s is. **Confirmed live after both fixes**: rerun of
   the identical task (fresh empty repo, same prompt) accepted
   `GOAL COMPLETE` on the model's *first* claim (`pi-goal-trace` entry:
   `{event: "complete", rounds: 0}`), finishing in 11 turns instead of 74+.
   Verified independently, outside the harness: `make verify` passes,
   `go run .` prints `hello`. 15 new/updated deterministic tests
   (`pi/tests/goal-gate.test.ts`, 15 total for this file); `npm test`:
   146/146; `tsc --noEmit`: clean.

Not yet run: the actual planned target task (multi-round, open-ended
feature work against `personal-budget-simplifier`) -- both fixes above
were found and confirmed on a small single-round smoke task, which is
enough to trust the mechanism's basic wiring but not its behavior across
many genuine nudge rounds on a large existing codebase. See todo below.

**Update, same day: the real target task was run.** `/goal enrich this
app's features and make it a true, usable full-stack app` against
`personal-budget-simplifier` (existing Go+Flutter repo, not a fresh
empty one). Real, verified outcome: 3 clean commits landed on `main`
(new backend endpoints -- trends/delete/export/rename, all with Go test
coverage; the trends Flutter UI wired into the dashboard;
`category_name` wired through the API responses and Flutter models),
`make verify` fully green, pushed to `origin/main`. This is genuine
incremental progress, not the full "true usable full-stack app" scope
(delete/export/rename aren't in the UI yet) -- the run did not
self-report completion; it was stopped deliberately partway.

Two things worth recording plainly rather than glossing over:

1. **The background `pi -p` process was killed twice, unexplained,
   mid-round** (host/orchestration-level, not something in `goal-gate.ts`
   itself asked for or logged) -- each time it left a real, partially-
   applied diff in the workspace, once with a broken build. This is an
   operational reliability gap for any unattended multi-round `/goal`
   session on this machine: something outside pi's own process can end it
   mid-edit with no warning, and the only recovery path right now is a
   human noticing and manually resuming with `--continue`. Worth
   root-causing before treating long unattended `/goal` runs as safe to
   walk away from.
2. **The round-to-round loop in practice was `pi --continue` with a
   plain human-written follow-up prompt, not a live `/goal` nudge
   surviving across those kills.** `goal-gate.ts`'s own state is
   documented as session-scoped/in-memory (see its file header) -- a
   killed-and-restarted process is a new extension instance with no
   active goal, so each recovery here was effectively a manual
   `build_app.py`-style outer round, not the `/goal` mechanism itself
   proving multi-hour endurance. The single-process, single-`/goal`-
   invocation case (the personal-budget-simplifier round that ran
   uninterrupted) did behave correctly and did produce the second
   verified commit + fix without manual intervention.

**Update 2026-08-09/10: second confirming smoke run, fresh empty repo,
different stack.** `/goal write a small Python calculator module (add,
subtract, multiply, divide with zero-division handling) in calc.py with
pytest tests in test_calc.py covering each function including the
divide-by-zero case; run pytest and only report done once it passes`
against a brand-new empty git repo (no prior `/goal` usage in that repo).
Single uninterrupted `pi -p` process, full JSON event log captured and
hand-traced line-by-line rather than trusted from the model's own summary:

- **Kickoff fix held**: `agent_start` fired immediately after the
  `session` event, no race, no empty exit.
- **Genuine pass correctly accepted on first claim** -- but, per review
  correction, this does NOT confirm the false-rejection fix specifically.
  The model hit real environment friction first (no venv, `pytest` not
  installed, two failed verification attempts logged by `quality-gate.ts`
  as genuine `fail`s) and only declared `GOAL COMPLETE` once `pytest`
  actually passed, accepted immediately (`pi-goal-trace`: `{event:
  "complete", rounds: 0}`). **Correction**: this entry originally claimed
  that as a second confirmation the false-rejection fix "held." Wrong --
  the bug that fix closed only fires after at least one nudge round resets
  `lastVerification`, and this run's `GOAL COMPLETE` claim was the model's
  *first* stop turn with no preceding nudge, so the buggy pre-fix code
  would have accepted this exact claim too. This run confirms genuine
  environment friction doesn't cause a false accept, which is real but
  weaker evidence -- it does not exercise the reset-on-nudge path at all.
  That path is still unconfirmed; see the Todo entry.
- **Independently reverified, not just trusted from the log**: ran
  `pytest` myself outside the harness afterward against the same
  `calc.py`/`test_calc.py` the agent wrote -- 5/5 passed, matching the
  agent's claim exactly.
- **A second, unrelated mechanism also fired correctly and is worth
  noting**: after goal-gate cleared the (now-met) goal, `artifact-guard.ts`
  independently caught real Mach-O binaries left in `.venv/` at
  settlement time and nudged a cleanup turn. The model's cleanup turn also
  ended with a `GOAL COMPLETE` line in its text, but by then `goal-gate.ts`'s
  own state was already `undefined` (cleared on the first acceptance), so
  its `turn_end` handler's early-return (`if (!goal) return`) means that
  second marker was inert text, not a second accepted completion --
  confirmed by only one `pi-goal-trace` `complete` entry existing in the
  whole log. Good defense-in-depth evidence: two independent settlement
  mechanisms (goal-gate's own gate, artifact-guard's separate check) each
  did their own job without interfering with each other.

This is the second stack (Python, vs. the first smoke test's Go and the
target run's Go+Flutter) and a second confirmation that the kickoff fix
holds. The false-rejection fix's own reset-on-nudge path is still only
confirmed by the original Go smoke test's before/after rerun (74+ turns
pre-fix vs. 11 turns post-fix), not by this run -- see correction above.
Still not covered by any run so far: many nudge rounds within one
uninterrupted process on a task that doesn't converge on the first genuine
attempt (every confirming run to date -- this one and the original Go
smoke test -- happened to reach `rounds: 0` on its `GOAL COMPLETE` claim),
and the fully-unattended multi-restart endurance case flagged above.

**Update 2026-08-10: real remaining scope on personal-budget-simplifier,
run foreground (not backgrounded) to sidestep the unexplained-kill gap.**
`/goal wire delete, export, and rename into the Flutter UI (backend
endpoints for these already exist and are tested) so a user can actually
invoke them from the dashboard, not just via the API; keep make verify
green after every change` -- the exact leftover scope the prior
personal-budget-simplifier run didn't finish. Single uninterrupted `pi -p`
process (foreground; the harness auto-moved it to background tracking
after its 10-minute cap, but it kept running as the same process -- no
kill this time), full event log hand-traced:

- **goal-gate itself again converged on `rounds: 0`** -- the model's first
  `GOAL COMPLETE` claim was backed by a real passing `make verify` and was
  accepted immediately. Third straight run (after the Go and Python smoke
  tests) that didn't reach the nudge-and-reject path; that gap is still open.
- **New, real evidence though: `cross-model-review.ts`'s independent
  reviewer caught a genuine crash bug post-completion and drove its own
  fix loop.** After goal-gate accepted completion, the reviewer flagged
  `dashboard_screen.dart`'s long-press rename handler using `.first` on a
  `.where(...)`-filtered list -- throws if the category was renamed/deleted
  server-side between load and long-press. Round 1: model fixed it
  (`.firstOrNull` + null guard), reran `make verify`, passed. Round 2: the
  reviewer re-flagged the *same, already-fixed* line (a real staleness/dedup
  gap in the reviewer's own re-check, not a fresh bug) -- the model
  correctly recognized it as already-fixed rather than blindly re-editing.
  Round 3: reviewer confirmed clean. **Correction**: this entry originally
  called this the settlement-time trigger firing -- wrong, re-checked
  against the raw trace and every one of these rounds carries
  `trigger: "tool_result"`, the same already-live-confirmed path documented
  above, not the newer `settlement` path. What this run *does* newly
  confirm is the `tool_result` reviewer catching and driving a real fix for
  a bug goal-gate's own pass/fail signal couldn't see (it only knows
  whether the verification *command* passed, not whether a reviewer would
  flag the diff) -- and, separately, that the reviewer's own re-check can
  itself go stale (round 2 re-flagged an already-fixed line). The
  settlement-time trigger specifically remains source/unit-tested only; see
  the Todo entry, unchanged by this run.
- **Independently reverified, not trusted from the log**: ran `make verify`
  myself afterward -- backend tests, `go vet`, `flutter analyze`, and all 20
  Flutter tests (up from the pre-run count, confirming new tests were
  actually added) genuinely pass. Read the fixed code directly: the
  `.firstOrNull` + null-guard fix is real and correctly addresses the race.
- **Gap worth flagging, not a goal-gate bug**: unlike the earlier
  personal-budget-simplifier run (which self-committed 3 times and pushed),
  this run made zero `git commit`s -- `make verify`-passing work sat
  uncommitted in the working tree at `agent_end`. The goal text didn't
  explicitly ask for commits either time, so this looks like model-level
  variance rather than a harness regression, but it means "goal-gate
  accepted completion" does not imply "work is committed" -- worth adding
  explicit commit/push language to `/goal` prompts until this is either
  confirmed reliable or goal-gate grows its own opinion on it.

**Update, same day**: committed and pushed by hand (`4fee1fa`,
`personal-budget-simplifier` main) after independently re-verifying
`make verify` passed and reading the `.firstOrNull` fix directly --
resolving the "gap worth flagging" above for this specific run. Doesn't
change the underlying finding: goal-gate accepting a `/goal` still
doesn't commit on its own, so this same gap will recur on the next run
unless the prompt explicitly asks for a commit or goal-gate grows its own
opinion on it.

## Update 2026-08-12: goal-gate's verification signal is now diff-hash-bound

Closes the gap named in the 2026-08-09 entry above ("known, accepted gap
that this signal isn't diff-hash-bound the way `quality-gate.ts`'s is"):
`goal-gate.ts` tracked verification as a bare `"pass" | "fail" | "none"`
flag with no tie to *which* diff it verified, so a real pass followed by
further unverified edits and an immediate `GOAL COMPLETE` claim could slip
through. `evidence` is now the same `VerificationEvidence` shape and
`evidencePassesCurrentDiff()` check `quality-gate.ts` already uses (shared
via `lib/verification.ts`): a completion claim only passes if the most
recent broad verification's diff hash matches the diff as it stands at the
moment of the claim. `agent_start` now also captures `baseSha` the same
way `quality-gate.ts` does, and both the `tool_result` and `turn_end`
handlers wrap their new `snapshotDiff()` calls in the same
`isStaleContextError` guard `quality-gate.ts` uses, since a goal-gate run
can span a mid-session compaction (real, live example: the personal-
budget-simplifier OTEL-metrics run recorded above hit a 2026-08-10
compaction event mid-goal).

Not live-tested yet -- this closes a known code-level gap named in an
earlier real run's writeup, but the fix itself hasn't been exercised
against a live run where an unverified edit actually lands between a pass
and a completion claim. `npm test`: 149/149 (1 new regression test added,
`pi/tests/goal-gate.test.ts`, "a pass followed by a further unverified
edit does not back an immediate completion claim"); `tsc --noEmit`: clean.

## Update 2026-08-12: goal-gate hardened against non-Claude models never using the marker

Live finding, not a hypothetical: re-read the personal-budget-simplifier
OTEL-metrics `/goal` session recorded above (2026-08-10/11-12, local
`ai-stack-local` route, `ThinkingCap-Qwen3.6-27B-MLX-8bit`) directly from
its session log. Grepping the full ~330KB transcript for `GOAL COMPLETE`
(case-insensitive) returns exactly one hit -- the kickoff instruction
itself. Across 7 recorded nudge rounds the model never once attempted the
marker; it kept ending turns with its own habitual `before-done`-style
phrasing ("done?", "Everything is... complete") instead, which the gate's
regex doesn't recognize, so every round fell into the generic `"Goal not
yet met... Keep working"` branch. The last two of those rounds made zero
new edits (`quality-gate` trace `diffHash` identical across both) -- the
model was re-running `make verify` and re-declaring victory in prose, not
iterating. The session file ends mid-round-7-of-15 with no `pi-goal-trace`
complete/cap-hit entry -- abandoned, not resolved. Notably, every
single-process run confirmed earlier in this doc (Go smoke test, Python
calc smoke test, personal-budget-simplifier delete/export/rename UI run)
used the standard Claude route and converged on `rounds: 0` -- this is the
first case of the marker itself never landing, and it's specific to the
weaker local route.

Three code-level mitigations, all in `goal-gate.ts`:

1. The plain `"not yet met"` nudge previously said nothing about the
   marker format beyond the one-time kickoff message. It now restates the
   exact required line every round, so recalling it doesn't depend on a
   single early instruction surviving in context.
2. New `session_compact` handler: re-sends that same reminder immediately
   once a goal-bearing session gets compacted (skipped when `willRetry` is
   true -- that's mid-turn overflow recovery, not a between-turns landing
   spot). A compaction summary is a paraphrase, not a transcript; nothing
   guaranteed it would preserve a literal string requirement, and the
   2026-08-10 compaction event on this exact session is a real instance of
   that risk.
3. New stall tracking: if the working diff's hash is unchanged across
   `STALL_ROUNDS_BEFORE_ESCALATION` (2) consecutive plain nudges, the
   message escalates from the generic prompt to naming the stall
   explicitly, with a `pi-goal-trace` `"stalled"` entry for visibility --
   directly targets the zero-progress round-6/7 pattern seen in this run.

**Not live-tested yet.** These are code-level fixes for a failure mode
diagnosed from a real log, not something re-run against the local route to
confirm the marker now lands. `npm test`: 156/156 (8 new tests in
`pi/tests/goal-gate.test.ts` covering the marker-reminder text, stall
escalation with both a static and a changing diff, and the three
`session_compact` cases); `tsc --noEmit`: clean. Next step: re-run the
same OTEL-metrics-shaped task against the local route and confirm it
either reaches `GOAL COMPLETE` or the stall escalation visibly changes the
model's behavior instead of silently spinning to the round cap again.

## Update 2026-08-12 (same day): live-retested against the local route

Set up a fresh scratch git repo (`/private/tmp/.../goal-gate-live-test-2`,
gitignoring `__pycache__`/`.pytest_cache`) and ran `pi -p '/goal add a
multiply(a, b) function to app.py with a passing pytest test for it'`
against the local `ai-stack-local` route (same model as the OTEL-metrics
run that surfaced the original gap). Result: the model implemented the
function, added a test, ran `pytest`, and its first stop turn ended with
`GOAL COMPLETE: pytest reports 2 passed...` — accepted immediately
(`pi-goal-trace`: `{event: "complete", rounds: 0}`). Independently
verified, not trusted from the log: re-ran `pytest` myself afterward (2
passed) and read `app.py` directly — the `multiply` function is real and
correct. This confirms the marker convention itself still works cleanly on
this route when the model gets it right on the first try; it does not by
itself exercise the harder repeated-nudge path the fix targets, since the
task converged before any nudge fired.

**A first attempt at this immediately surfaced a real methodology bug, not
a goal-gate bug.** The first run redirected `pi -p ... --mode json`'s own
growing stdout (`run.jsonl`) into the *same repo* the model was working
in and that goal-gate diffs against. Every quality-gate verification round
in that run recorded a different `diffHash` (16 checks, 16 distinct
hashes) purely because the ever-growing log file counted as untracked
material in `git status`, not because of any real code churn — so no
completion claim could ever have passed evidence-binding in that run,
independent of anything the model did. That run did, incidentally, still
show the model attempting `GOAL COMPLETE` repeatedly across 9+ rounds
(never observed at all in the original bad session) before being killed
once the contamination was identified — consistent with, but not clean
confirmation of, the marker-reminder-every-round fix. Lesson for any
future live goal-gate test on this harness: never let the harness's own
process output land inside the repo it's diffing.

**Still not live-exercised**: the stall-escalation path (needs a task the
model can complete but initially fumbles the verification loop on) and the
`session_compact` reminder path (needs an actual mid-goal compaction,
hard to force deliberately on a small task). Both remain unit-test-only
confirmed.

## Update 2026-08-12 (later): live multi-round confirmation, background-kill investigation, Claude Code /goal comparison

Four items from that day's todo list, worked in one session. Evidence and
explicit non-coverage below — nothing in this section is inferred from the
model's own self-report; every claim is either a grep against the raw
session JSONL or an independently-rerun command.

**1. First live confirmation of the nudge-and-reject loop actually
rejecting a claim and looping (`rounds: 1`), not converging at round 0.**
Methodology fix applied first: the 2026-08-12 same-day contamination bug
(harness stdout landing inside the diffed repo) was avoided this time by
launching via `nohup pi -p '...' --mode json > <scratchpad>/log.jsonl 2>&1
< /dev/null &` with the `--mode json` log written *outside* the scratch
git repo entirely (a sibling directory, not a subdirectory of it) —
confirmed afterward the scratch repo's working tree contains only
`inventory.py`/`test_inventory.py`/`.venv/`, no log file, so `git status`
inside it was never contaminated. Task: a fresh scratch repo (git-inited,
one commit), local Qwen route (`ai-stack-local`, same weaker route the
2026-08-12 hardening targeted), goal condition asking for an
atomic-write inventory module with pytest coverage including a
`monkeypatch`ed-`os.replace`-failure test — chosen because "does a
partial write leave the original file corrupted" is the kind of subtlety
a first attempt plausibly gets wrong. Full JSON event log
(`goal-gate-live-test-3.jsonl`, 25 turns, ~5m56s wall clock) hand-checked,
not trusted from a summary:

- `pi-goal-trace`: `{event: "complete", rounds: 1}` — the model's first
  stop turn got a genuine plain `"Goal not yet met..."` nudge (grepped
  directly: `Goal not yet met: "build inventory.py..."` appears in the
  log), and its *second* stop turn's `GOAL COMPLETE` claim was accepted.
  This is the first real, live exercise of the round-increment path with
  `rounds > 0` across every confirming run to date (Go smoke test, Python
  calc smoke test, personal-budget-simplifier delete/export/rename —
  all `rounds: 0`) — n=4 now, 1 of 4 with a real nudge.
- **Independently reverified, not trusted from the log**: ran `pytest`
  myself against the agent's own `inventory.py`/`test_inventory.py`
  afterward — 9/9 passed. Read `inventory.py` directly: `_save()` writes
  to a `tempfile.mkstemp`-created temp file, `os.replace`s it onto the
  real path, and cleans up the temp file on any exception; `remove()`
  raises `ValueError` for both the unknown-sku and insufficient-stock
  cases before calling `_save()` at all (file genuinely untouched on
  those paths, not just claimed).
- **Still not exercised even by this run**: the stall-escalation branch
  (needs `STALL_ROUNDS_BEFORE_ESCALATION` = 2 *consecutive unchanged-diff*
  plain nudges; this run only produced one nudge total, so escalation
  logic never got a chance to trigger) and the `session_compact` reminder
  path (compaction was deliberately forced by temporarily editing
  `~/.pi/agent/settings.json`'s `compaction.reserveTokens` from `16384` to
  `47500` for the duration of this one run only, reverted immediately
  after — `session_compact` count in the log: **0**. The task finished in
  25 turns without the running context ever crossing even that aggressive
  threshold, so this specific forcing attempt didn't work either; the
  path remains genuinely untested, not just under-tested). Both need a
  dedicated follow-up run, not assumed covered by this one.
- **Bonus, unplanned finding**: after goal-gate cleared, `cross-model-
  review.ts`'s *settlement*-trigger fired for real for the first time
  (`trigger: "settlement"` in the trace) — previously source/unit-tested
  only (see the 2026-08-09 entry above and the matching todo item below).
  Outcome was `model-rejected`/HTTP 400, i.e. the same `AI_REVIEW_MODEL`-
  drift failure mode documented earlier in this file for the reactive
  trigger — not re-diagnosed further here since it's off this task's
  critical path, but worth noting the settlement trigger's *wiring* is now
  live-confirmed even though this particular invocation didn't get a clean
  review round out of it.

**2. Background-process-kill root cause: could not be established
retroactively; diagnostic channel checked and found unusable for this
process class, not just for this incident.** `log show` (macOS unified
log) queried for `process == "pi"` and `process == "node"` over a full
7-day sanity-check window (not just the original 2026-08-09/10 incident
window) returned zero matching entries in both cases — `pi` is a plain
Node.js CLI script that does not emit unified-log (os_log/ASL) entries
during normal operation on this host, so this channel was never going to
surface a plain external `SIGKILL`/`SIGTERM`/`SIGHUP`, independent of log
retention. No crash reports in `~/Library/Logs/DiagnosticReports/` for
that window either — consistent with an external signal rather than a
crash (a crash normally does generate a report). `last reboot` confirms
no host restart in that window. **Conclusion: the specific 2026-08-09/10
kills cannot be root-caused after the fact from this machine's forensic
data** — say so plainly rather than assume it's now understood.
**Actionable mitigation, tested live in this session rather than just
proposed**: launched this run's `pi -p` process via
`nohup ... < /dev/null > log 2>&1 & disown` and confirmed via
`ps -p <pid> -o ppid,stat` that it reparented to PID 1 (init/launchd) with
state `SN` — i.e., fully detached from the invoking shell/session, unlike
an ordinary backgrounded child that stays in the parent's process group
and would receive a `SIGHUP` if that parent shell/session ended. This
run's process was never killed (I terminated it myself with `SIGTERM`
after confirming `agent_settled` and no further pending work — a
deliberate, logged shutdown, not an unexplained one). This is one clean
run with the detached-launch mitigation, not a repro of the original
failure mode with and without the fix — it demonstrates the mitigation
doesn't break anything, not that it was the actual cause of the original
kills. **Recommendation**: any future unattended `/goal`/`build_app.py`
run on this machine should use this exact launch pattern
(`nohup ... < /dev/null > logfile 2>&1 & disown`, log path outside the
diffed repo) until/unless the original incident is independently
reproduced and diagnosed with better tooling in place beforehand (e.g.
wrapping the launch in a small supervisor that logs its own exit signal).

**3. Multi-round survival within one uninterrupted process: now
confirmed for `rounds: 1`, still not confirmed for "many."** Item 1 above
is the first live case where the nudge fired and the model's next attempt
was accepted, all within a single process — genuine, if modest,
progress on this open item. It is *not* evidence of surviving "many"
rounds; one round is not the multi-hour/many-nudge endurance case the
original todo names, and the stall-escalation path specifically (which
only engages after 2 *consecutive* unchanged-diff nudges) still has zero
live rounds. Treat this as n=1 for `rounds > 0`, not as closing the item.

**4. Claude Code's own `/goal` compared directly, not just guessed at.**
Fetched Anthropic's own docs (`https://code.claude.com/docs/en/goal.md`)
and cross-checked against this very session's own live Stop hook, which
is a real `/goal` instance I directly observed rather than inferred:
its condition was stated in free natural language and never asked me for
a literal marker string, consistent with the docs below.

- **Mechanism**: Claude Code sends `{condition, conversation-so-far}` to a
  *separate* small/fast evaluator model (defaults to Haiku) after every
  turn; the evaluator answers yes/no with a short reason. This is genuinely
  a different model than the one doing the work, not a self-report — but
  per the same docs, "it doesn't run commands or read files independently,"
  i.e. it judges the transcript, not ground truth.
- **No literal marker required** — the evaluator tolerates phrasing
  variance by design, judging semantically against what the working model
  "surfaced in the conversation."
- **Round cap is opt-in per-goal** (write "...or stop after N turns" into
  the condition text yourself), not a global default the way pi's
  `PI_GOAL_MAX_ROUNDS` (15) is.
- **Not documented anywhere findable**: whether the condition/reminder is
  resent to the evaluator after context compaction. Flagging this as "not
  documented," not "doesn't happen" — absence of a public doc section on
  it isn't proof either way.

**Structural gaps named, not just bugs:**

1. *No fallback for near-marker phrasing.* This is the exact 2026-08-12
   local-route failure mode (model said "done?"/"Everything is complete,"
   the literal-regex gate never recognized it) — Claude Code's design
   structurally cannot hit this specific failure, because completion isn't
   gated on the working model reproducing an exact string at all.
2. *The self-report-bias tradeoff is inverted, not equivalent, between the
   two designs.* Claude Code accepts transcript-only judgment (some
   self-report-adjacent risk, since the evaluator never independently
   verifies) in exchange for phrasing robustness. `goal-gate.ts` accepts
   phrasing brittleness in exchange for eliminating self-report risk
   entirely — its only evidence is a real command's exit code bound to the
   current diff hash, never any model's opinion, echoing this doc's
   own prior finding elsewhere that self-report checks are unreliable.
   Adding an LLM-judged fallback on pi's side to close gap #1 the way
   Claude Code does it would reopen exactly the bias problem
   `goal-gate.ts`'s docstring already warns against — it would just move
   the self-report from "the marker" to "the evaluator's read of a
   transcript it cannot independently verify," which Claude Code's own
   docs concede is a real limitation of their design, not a solved
   problem to imitate uncritically. **Not implemented as part of this
   session** — recorded as a designed-but-not-shipped recommendation
   (a small fixed allow-list of equivalent completion phrasings, accepted
   *only* when they still co-occur with the same
   `evidencePassesCurrentDiff` check the literal marker already requires,
   so the evidence binding never weakens) pending explicit sign-off, per
   the goal directive's "don't silently implement" instruction.
3. *Compaction handling*: `goal-gate.ts`'s `session_compact` reminder is a
   direct, shipped answer to a problem Claude Code's public docs don't
   even confirm they've addressed — a case where pi's design is ahead on
   this one dimension, not behind, though (per item 1 above) the
   `session_compact` path itself remains live-unexercised here.
4. *Round-cap default*: pi's global default caps every goal even if the
   condition text says nothing about it; Claude Code's is safer *only if*
   the user remembers to opt in per-goal, and silently uncapped otherwise.

## Update 2026-08-12 (later still): a real live compaction, n=2 on rounds>0, and a corrected root-cause writeup

Follow-up work in the same session, pushed further after review feedback
that the prior update's "not yet tested"/"could not be established"
callouts, while honest, hadn't actually exhausted what was live-testable.
Three more live runs and one source-level trace, all against the real
local Qwen route (never simulated), all evidence below is either a raw
grep against a session JSONL or an independently rerun command.

**Second `rounds: 1` confirmation (n=2 now).** A second scratch task
(`goal-gate-live-test-5`, a `kv.py` key-value store with the same
atomic-write/pytest-coverage shape as the first, launched the same
contamination-safe way — log outside the diffed repo) also produced a
real plain nudge followed by an accepted claim: `{event: "complete",
rounds: 1}`. Independently reverified: `pytest` 8/8 against the agent's
own `kv.py`/`test_kv.py`. Two independent live runs now show `rounds > 0`
(n=2 of 5 total confirming runs across this file's history) — still not
"many," but no longer a single data point either.

**A real compaction was captured live, for the first time — but it
exposed both a wrong assumption and an unexplained gap, reported
plainly rather than smoothed over.** Getting here took two failed
attempts, kept below rather than deleted, because the failure mode is
itself informative:

- *Attempt 1* (the `session_compact` test in the prior update, and a
  repeat here with `contextWindow` temporarily patched in
  `ai-stack-local.ts` from `49152` to `8000`, `reserveTokens` left at
  default `16384`): produced **zero** compaction events across two live
  runs, despite `shouldCompact(contextTokens, contextWindow, settings)`
  in the installed package
  (`pi-coding-agent/dist/core/agent-session.js`) reading, by inspection,
  as trivially satisfied (`contextWindow - reserveTokens` went negative).
  Traced the actual reason by reading the installed package source, not
  by guessing: `_checkCompaction`'s threshold branch feeding
  `shouldCompact` is a *distinct* code path from `prepareCompaction`,
  which decides *what's actually left to cut* using `keepRecentTokens`
  against the message-history-only token estimate (excluding the system
  prompt) — with `keepRecentTokens` still at its default `24000` and a
  short task's real message history well under that, `prepareCompaction`
  correctly found nothing to summarize regardless of the threshold check
  passing. **Correction to the prior update's framing**: forcing
  compaction needs both a shrunk `contextWindow` (to trip the threshold)
  *and* a shrunk `keepRecentTokens` (to leave something for
  `prepareCompaction` to actually cut) — the prior write-up only
  identified the first knob.
- *Attempt 2* (`keepRecentTokens` additionally dropped to `500` in
  `~/.pi/agent/settings.json`, same `contextWindow: 8000` override, task:
  the `kv.py` run above): **a real compaction fired** —
  `compaction_start` → `compaction_end` in the raw event log, with an
  actual generated summary (`"## Goal\nBuild a small key-value store
  module..."`, `tokensBefore: 10760`, `estimatedTokensAfter: 1475`). This
  is the first live-captured Pi auto-compaction event in this file's
  entire history, not just a source-level description of the mechanism.
  **But it fired with `reason: "overflow"` (Case 1, a genuine
  context-length rejection triggering compact-and-retry), not
  `reason: "threshold"` (Case 2, the proactive path both settings were
  meant to force) — and it landed *after* `goal-gate`'s own `{event:
  "complete"}` trace, i.e. after `goal` was already `undefined`.** Two
  consequences, stated precisely rather than rounded up to "confirmed":
  1. `goal-gate.ts`'s `session_compact` handler has an explicit
     `if (!goal || event.willRetry) return;` guard — with no active goal
     at compaction time, this run structurally could not have exercised
     the reminder-resend behavior even if the event reached the handler.
  2. Separately, and left unresolved rather than hand-waved:
     **`grep -c '"type":"session_compact"'` on this run's log returns
     `0`**, even though `compaction_end` fired and the installed source
     (`agent-session.js`, the code directly above where `compaction_end`
     is emitted) shows a `session_compact` extension-event emission
     gated only on `this._extensionRunner && savedCompactionEntry` being
     truthy — both of which should hold here. Did not root-cause this
     gap in the time available; flagging it as a genuine open question
     (bug in the installed package, a lookup-key mismatch, or a
     misreading of the source) rather than assuming either "it's fine"
     or "it's broken."
  - All temporary overrides (`ai-stack-local.ts`'s `contextWindow`,
    `~/.pi/agent/settings.json`'s `compaction` block) were reverted
    immediately after; `git status` on `pi/` is clean and `npm test` is
    156/156 with zero source changes to `goal-gate.ts` itself.
  - **Net honest status on item 1**: a real compaction is now live-
    confirmed to be reachable with the right settings (a first), but the
    specific `goal-gate.ts` code path this was meant to test (the
    `session_compact` handler re-sending `MARKER_REMINDER` *while a goal
    is still active*) remains unexercised — both because this occurrence
    landed post-completion and because the raw `session_compact` event
    itself didn't appear in the trace for a reason not yet understood.
    Needs a task long/heavy enough to cross the compaction threshold
    *before* its first `GOAL COMPLETE` attempt, not after.

**Root-cause investigation redone with a testable hypothesis instead of
a purely negative result.** The prior update's mitigation story (`nohup
... & disown` prevents the kind of kill that hit the original run) was
checked directly rather than left as an assumption: started a plain
`sleep 240 &` with **no** `nohup` at all, inspected it with
`ps -o pid,ppid,stat`, and found it had *already* reparented to PID 1 —
standard Unix orphan-reparenting, which happens on a background job
regardless of `nohup` (`nohup` only matters if the parent shell itself
receives `SIGHUP`, a different event from a Bash-tool call's transient
shell simply finishing normally). **Correction: the specific mechanism
proposed for the original kills does not hold up under its own test.**
Also checked and came back empty: `~/.zsh_history` (no `pi -p`/
`personal-budget-simplifier` entries — commands run through an agent's
non-interactive Bash tool don't get written there at all, so no local
trail of the original launch command exists to inspect) and
`pi/scripts/build_app.py`'s `subprocess.run` calls (no
`start_new_session=True`, so *if* that orchestrator had launched the
killed process it would be vulnerable to a group-wide signal — but the
doc's own account says this run used manual `pi --continue`, not
`build_app.py`, so this is a related, real, fixable gap and not confirmed
as the cause of this specific incident). **Final status, unchanged in
substance but now backed by a disproved hypothesis instead of an
untested one**: root cause remains genuinely unknown given the tools
available on this machine three days after the fact. The actionable
recommendation is process-external supervision that captures the exit
signal to a file on the *next* occurrence, not a specific launch flag,
since the specific flag hypothesized didn't survive its own test.

## Todo

- Live-exercise the stall-escalation path specifically (needs 3
  *consecutive* unchanged-diff plain nudges in one run, per
  `STALL_ROUNDS_BEFORE_ESCALATION = 2` and the off-by-one in how
  `staleRounds` is checked before it's incremented — traced in source,
  not yet hit live; both live attempts to date produced only one nudge
  total, not three consecutive stalled ones). The `session_compact`-
  reminder path specifically *while a goal is still active* also remains
  untested, but for a now-understood reason, not an unknown one: the
  2026-08-12 later-still update above got a real compaction to fire live
  (a first) by shrinking both `contextWindow` *and* `keepRecentTokens`
  together (shrinking `contextWindow` alone, as the first attempt did,
  satisfies the threshold check but leaves `prepareCompaction` nothing to
  cut) — but that compaction landed with `reason: "overflow"` after the
  goal had already completed, so `goal-gate.ts`'s own `if (!goal ...)
  return` guard means the reminder-resend logic still didn't get
  exercised. Also newly open: that same run's `session_compact` extension
  event never appeared in the trace despite `compaction_end` firing and
  the emission-gating condition in the installed package appearing to be
  satisfied — unexplained, not yet root-caused. Next attempt needs a task
  heavy enough to cross the (now-understood) compaction threshold
  *before* the model's first `GOAL COMPLETE` attempt, not after.
- The two unexplained background-process kills from the
  `personal-budget-simplifier` `/goal` run remain **not root-caused** —
  macOS unified log and crash-report checks came back empty for the
  incident window and (as a sanity check) for a full 7-day window
  generally, meaning `pi`/`node` processes don't appear to emit forensic
  data this way on this host at all, not just that the old window expired.
  The leading mitigation hypothesis from the first pass (`nohup ... &
  disown` prevents the kind of kill that hit the original run) was then
  tested directly and **did not hold up**: a plain `sleep 240 &` with no
  `nohup` at all was found already reparented to PID 1 via standard Unix
  orphan-reparenting, so parent-shell-exit-without-nohup isn't a
  convincing mechanism for the original incident either. Treat this as
  closed-out-as-unknowable via every method tried so far, not solved —
  the actionable path forward is process-external exit-signal capture on
  the next occurrence, not a specific launch-flag fix.
- Confirm `/goal` survives *many* nudge rounds within one uninterrupted
  process, not just one. **Now n=6 confirming single-process runs total,
  2 of 6 with `rounds > 0`** (the inventory.py and kv.py runs above, both
  `rounds: 1`) — real, now-doubled progress on this item, but "many
  rounds" and the stall-escalation path specifically (needs 3 consecutive
  stalled rounds, not just 1 nudge) are still unconfirmed; the
  multi-hour/multi-restart endurance case (surviving actual process
  restarts, not just nudge rounds within one process) is separately still
  open too, since every restart seen so far was a manual `--continue`
  recovery, not live goal
  state surviving a restart.
- Live-test `/goal` (`goal-gate.ts`) against a real repo with an
  open-ended, multi-round condition (e.g.
  `/Users/kanna/code/personal-budget-simplifier`, "enrich features and make
  it a true usable full-stack app") — confirm the kickoff follow-up turn
  actually fires under interactive `pi`, the nudge loop survives multiple
  rounds, and a `GOAL COMPLETE` claim only sticks once backed by a real
  passing verification run. **Partially done** (see update above): kickoff
  and single-process nudging both confirmed live; the fully-unattended,
  many-rounds-through-restarts case is still open, per the two items above.
- Battery-test `pi/scripts/build_app.py` across more stacks (Python,
  TypeScript, Flutter), with `--containment` on, and on a task deliberately
  seeded to fail its first verification round so the corrective-round path
  (not just the succeed-on-round-1 path both smoke runs hit) gets real
  coverage.
- Live-battery-confirm the new cross-model-review settlement trigger
  against a real `local-model-bench` task (or any task whose verification
  command never runs inside the model's own session) — so far it's
  source/unit-tested only, not live-run-confirmed the way the tool_result
  path already is.
- Live-test the revised (`tool_result`/`turn_end`-based) designs of
  `makefile-scaffold-nudge.ts` and `error-leak-guard.ts`, and the
  `tool_result` primary-detection path specifically for `artifact-guard.ts`
  (its `agent_settled` backstop path is now live-confirmed, see the status
  table above and the 2026-08-09/10 update below) — the 2026-08-05 live
  test that motivated their redesign only ran the original, now-superseded
  versions. See `pi-harness-history.md`'s "Live end-to-end test finds three
  of four new hardening extensions structurally blind" entry.
- Rerun the personal-budget-simplifier-shaped scenario (or any greenfield,
  no-commits-yet project) now that `buildReviewDiff()` handles untracked
  files, to get a real paired before/after adoption data point — everything
  so far is a single confirming repro, not a battery.
- Give `cross-model-review.ts` a settlement-time trigger (mirroring
  `quality-gate.ts`'s `agent_settled` hook) so it can fire against
  `local-model-bench` tasks at all — its current purely reactive
  `tool_result` trigger structurally cannot activate on this suite, since
  hidden tests don't exist yet during the model's own session (see
  `pi-harness-history.md`'s 2026-08-04 pair-4 rerun). Without this, the
  existing goal of rerunning the seeded battery with the reviewer live can
  produce a full run of green trace data with zero actual review rounds,
  and look like adoption evidence when it isn't.
- Rerun pair 4 (go-flutter/bookmarks-app) specifically as a full paired
  battery task, not just the isolated bug repro, to see whether Gemma's
  spot-check win on the visit-counter race generalizes to the actual task
  end-to-end (harness loop, quality-gate corrective retries, other tests
  in the suite) before drawing any conclusion beyond n=1. Any future
  candidate-model claim on this task (Gemma, KAT-Coder, or otherwise) needs
  roughly 8-10 paired runs to be distinguishable from Qwen's own ~40%
  (2/5) base rate at fixing this race on its own — a single win is not
  evidence.
- Run TypeScript/JavaScript task fixtures through the battery — currently
  routed and unit-tested only, same status as Python/Postgres/Kafka/Temporal/GCP.
- Bind verification to the final tree/diff across all judgment-dependent
  extensions consistently — quality-gate does this; confirm the others do
  too.
- Move DayTrix-only skills out of the global Pi skill directory and into
  that project, leaving generic backend/full-stack guidance global.
- `cross-model-review.ts` now gets a structured `findings[]` array
  (file/severity/issue) from the reviewer but only ever renders it into one
  flat follow-up string for the 3-round loop, same as the old marker-parsed
  prose was. Consider having the loop read `severity` directly (e.g. skip a
  round or downweight retry priority for `nit`-only findings) now that the
  structure exists to do so.
- Use an OS/container boundary for unattended execution once Docker is
  available on this host — the protected-path guard is defense in depth,
  not filesystem confinement.
- `co-change-suggest.ts`'s live (non-retrospective) validation — "try it
  live on one new personal-assistant feature task" — has not been run.
- `continuation-nudge.ts`'s widened trigger has zero field validation.
  Needs real trials before its empty-content-stop path can be said to
  work, not just to type-check.
- `group-invite-atomic-rotation` (`pi-local`) re-run **done, confirmed
  2026-08-07/08**: reward 1.0, both the contextWindow fix and the
  adapter-level bounded-follow-up mechanism work as designed. See the
  table entry above for the full account, including two adapter bugs
  found and fixed along the way.
- Re-verify `terminus-2`'s own harness overhead vs. `pi-local`'s
  (~7,036-token baseline tax, see the table entry above) isn't hiding a
  similar contextWindow mismatch on the control side, since that
  comparison assumed `terminus-2`'s own request sizing is correctly
  configured against the same proxy budget and was never explicitly
  checked. Still open.
- The `PiHarness.run()` follow-up mechanism (`local-model-bench/
  harbor_agents/pi_harness.py`, commits `8531917`/`dfe4620`) has only been
  live-tested on this one task/failure shape. It's a generically-scoped
  fix (any `context_length_budget_exceeded`-shaped ending on any task,
  any provider using `ai-stack-local.ts`), but the only real-world
  confirmation so far is this single repeated case. Worth a broader check
  next time a different task naturally hits this wall, rather than
  assuming full coverage from one confirmed instance.
- Reduce quality-gate's runtime/token overhead below the plan's 20%
  threshold, or revise the threshold with evidence for why the current
  cost is acceptable.

Full investigation history — dated narrative, superseded partial results,
live-run-by-live-run detail — is in `pi-harness-history.md`.
