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
| `continuation-nudge.ts` | Default-disabled, source-tested | Deterministic branch tests pass. **2026-08-07 update**: no longer zero real-trial field evidence — `local-model-bench`'s Go/Flutter harness-isolation matrix (see its `STATUS.md`) hit the exact empty-content-stop failure mode live and reproducibly: `pi-local` lost `group-invite-atomic-rotation` (a real DayTrix bug-fix task) after two rounds of normal exploration ended in an empty final assistant turn with no edit attempted, reproduced twice with a byte-identical trace at temperature 0. The same model (Qwen3.6-27B) solved the other three tasks in the same matrix, including ones of comparable/greater difficulty, so this reads as a harness-level stop-condition gap, not a capability gap. Still default-disabled pending a decision, but the "zero field evidence" framing is now stale — this is the first real data point and it argues for re-evaluating adoption, not for leaving it as-is by default. |
| `codebase-memory-mcp` 0.9.0 | Default-disabled, trial-only; not globally wired | Disposable Go repo indexed successfully (10,658 nodes/48,988 edges). Go follow-up: three tasks with memory-directed/repo-tools/no-tools arms; memory and repo-tools each scored 8/12, no-tools 0/12. Across the two completed pairs, memory used 2.88% more comparison tokens, took 7.91% longer, 75% more turns, and 59.09% more tool calls. Both tool-enabled MCP-gate arms hit the frozen eight-minute cap without final answers. Blinded Gemma 4 agreed with all completed deterministic scores. Vendor 99.2% token-reduction claim not confirmed; no global wiring. |
| `cross-model-review.ts` | Adopted, resolves to genuine `independent-review`, confirmed firing and completing real review rounds under `pi -p` on tasks with a committed base and a genuine broad verification command; was structurally blind on all-untracked repos (fixed 2026-08-05, see below) and still structurally blind on task suites whose verification command never runs (e.g. `local-model-bench`, see below) | `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` moved to `~/.zshenv` 2026-08-05 (was `~/.zshrc`, interactive-shell-only — see `pi-harness-history.md`'s env-propagation entries) set to `gemma-4-26b-a4b-it` on `:8081`, distinct from the `:8080` Qwen primary. Deterministic tests pass (74/74); live-checked 2026-08-04 that `resolveReviewerConfig()` resolves `independent-review` (not `disabled`/`blind-self-review`) and that `requestReview()` correctly flagged a deliberately planted bug against the real endpoint. A separate 2026-08-04 investigation against a third route (KAT-Coder, `:8083`, not the standing config) found and fixed a process-crashing stale-context bug in the `tool_result` catch handler and a structural gap where `pi -p` exited before any review round could finish; both fixed, tested, and now apply to whichever route is configured — see `pi-harness-history.md`'s "Trying a third reviewer route" section. `REVIEW_TIMEOUT_MS` raised from 120s to 240s (commit `83ca0cb`) after a real production-shaped review request against idle Gemma took 121.4s — 1.4s past the old timeout, which would have silently discarded a correct finding. A full end-to-end rerun (2026-08-04, standing Qwen+Gemma config, pair 4) confirmed the task itself passes cleanly (9/9 go -race, 17/17 dart) but the reviewer never fired on that suite specifically: its `tool_result` trigger only reacts to the *model's own* successful broad-verification command, and `local-model-bench` hides real test files until after `pi` exits, so the model never has one to run there — it wrote its own smoke test instead, and its one `dart test` call errored on "no test files," which the trigger explicitly excludes. Discovered 2026-08-05: after the `:8082`→`:8081` route move, `AI_REVIEW_MODEL` held the short id `gemma-4-26b-a4b-it` while the route now serves `/Users/kanna/code/ai-stack/models/gemma-4-26b-a4b-it-4bit`; every real request 400'd `model_mismatch`, which `requestReview()` silently downgrades to `{outcome: "transient"}` — the reviewer had been reviewing nothing since the move, with no error surfaced anywhere. Fixed by exporting the full served id. With the id corrected, a 15-trial reviewer-reliability battery (three planted bugs — `clampToRange` missing its upper-bound clamp, `divide` missing its zero-check, `add` implemented as subtraction — 5 trials each at `temperature: 0`, via the real `requestReview()` path) caught 15/15, deterministic across repeats (identical response length per bug on every trial). A 9-trial false-positive control (3 trials each of the correct implementation of the same three functions) returned `NO_ISSUES_FOUND` 9/9. Same day, on the personal-budget-simplifier build: `session_start`/`tool_result` confirmed firing via instrumented diagnostics, but zero `review` traces appeared in any of the build's 7 real sessions (checked directly in `~/.pi/agent/sessions/`, not just `--mode json` stdout) — root cause was a bare `git diff`, which never shows untracked content, against a repo with exactly one commit made at the very end, so every diff during the whole build was empty. **Fixed**: `cross-model-review.ts` now uses a new `buildReviewDiff()` (in `lib/verification.ts`) that synthesizes diff blocks for untracked files the same way `quality-gate.ts`'s `snapshotDiff` already accounts for them; a `review`/`blocked` trace now fires on the previously-silent early-return paths too. `npm test`: 123/123. Live-verified against the exact original bug shape (fresh repo, zero commits, one untracked file) — reviewer now fires and completes a round there. See todo and `pi-harness-history.md`'s "Correction of the correction" entry for the full account, including an earlier same-day retraction of this finding that was itself wrong and has been superseded. **2026-08-05, later the same day**: the 15/9 battery above had never been a checked-in, reproducible test — it existed only as an ad-hoc invocation, and the marker-matching verdict parser (`NO_ISSUES_FOUND` on the last non-empty line) meant any trailing commentary from Gemma flipped a clean review to flagged, an unaudited failure mode of exactly the same shape as the `AI_REVIEW_MODEL` incident above. Fixed in two commits. First (`c94fa60`): split the single `transient` outcome into a `ReviewUnavailableReason` (`not-configured`/`model-rejected`/`empty-response`/`request-failed`, plus `review-pipeline-error`) that reaches the harness trace with the HTTP status attached, so "did the reviewer actually run, and if not why" is now greppable instead of silent; and checked in `evals/reviewer-battery.ts`, reproducing the 15/9 numbers live (confirmed 15/15, 0/9). Second (`125f2b2`): replaced the marker parser with a `response_format` JSON Schema verdict (`{analysis, verdict, findings[]}`) — verified live that `:8081` honors `response_format` correctly, and a parse failure is now `malformed-verdict`, not `clean`, so unreviewed code can never read as reviewed. The first cut of the schema put `verdict` before `analysis` and the battery caught a real regression before it shipped: 10/15, missing the planted `divide` zero-check bug 5/5 deterministically at `temperature: 0`, because constrained decoding emits properties in schema order and a verdict-first schema forces the model to commit before it has reasoned — the same constraint-tax effect reported for small models on structured output generally. An isolation probe (schema × prompt-wording, 4-way) confirmed the schema was the cause, not the reworded prompt. Putting `analysis` first in the schema restored 15/15, 0/9. **Constraint discovered in passing**: `:8080` rejects `response_format` outright when serving with speculative decoding (`"Structured response_format is not supported with speculative decoding"`), so the reviewer route must never be moved onto an MTP/draft launcher — doing so would silently fail every request as `model-rejected`. Gemma is not run with `GEMMA_MTP=1` and this is a deliberate constraint, not an oversight; see `local-ai-stack.md`. |
| `new-project-scaffold.ts` | Adopted, on by default | Git-init nudge plus layered-architecture (`cmd/`/`internal/domain`/`internal/handler`-shaped) nudge for greenfield repos. Live-tested 2026-08-05 against a fresh Go+SQLite todo-app task: both nudges fired and worked exactly as designed (repo initialized, real commit made, the requested layered structure created). Deterministic tests pass. |
| `makefile-scaffold-nudge.ts` | Adopted, on by default | Nudges toward a canonical `verify`/`test`/`check` Makefile target. The original `before_agent_start`-only precondition check was found structurally blind on greenfield repos by the 2026-08-05 live test above — it evaluated once, before any files existed, and was never re-checked after `go mod init` created a manifest mid-session. Redesigned to arm a `tool_result` flag when a manifest file appears and nudge once at the next `turn_end`. Deterministic tests pass (123/123); the revised design has not itself been live-tested — only the superseded version was. |
| `artifact-guard.ts` | Adopted, on by default | Flags oversized/binary build artifacts. Same live test found the original `agent_settled`-only design structurally blind: in `-p` mode `agent_settled` fires once, *after* `agent_end`, by which point the model had already committed, leaving diff-since-`baseSha` empty. Redesigned: primary detection moved to `tool_result` on build-shaped bash commands, `agent_settled` kept only as a cwd-keyed backstop with an empty-tree fallback for the greenfield case (a follow-up review pass also fixed a case where that fallback was permanently dead when the first commit happened mid-session). Deterministic tests pass; revised design not yet live-tested. |
| `error-leak-guard.ts` | Adopted, on by default | Flags raw error-string leaks (e.g. `err.Error()` written straight into an HTTP response). Same structural blind spot and same fix as `artifact-guard.ts`: primary detection moved to a `tool_result` content scan on write/edit, `agent_settled` kept as a per-cwd, empty-tree-fallback backstop, sharing a dedup map with the `tool_result` path so a committed finding isn't re-flagged every subsequent build command. Deterministic tests pass; revised design not yet live-tested. |
| Phase 4 (Aider-based failing-test retry) | Deliberately not built | Gated on Aider dispatch being in scope; it isn't (`~/.claude/CLAUDE.md`, benchmarked and removed). |
| KAT-Coder-V2.5-Dev-OptiQ-4bit (`:8083`) | Ruled out, both roles | **As primary model**: spot-checked 2026-08-04 against pair 4 (go-flutter/bookmarks-app) — fixed the `go test -race` bug that stumped Qwen, but introduced 3 new Dart test failures and the task still failed overall; independent review found this is not real signal, since Qwen itself already fixes this same race in 2/5 runs on its own (see `pi-harness-history.md`'s prior five-run investigation), so a single win is statistically indistinguishable from Qwen's known variance. **As reviewer**: ruled out for a structural reason, not a tunable one — a real production-shaped review request (task spec + diff, 22,784 chars, no `max_tokens` cap) against a confirmed-idle `:8083` route ran 220+ seconds and never completed successfully (`upstream_errors` incremented rather than `completed`). Unlike Gemma's near-miss on the timeout, this wasn't close: the route errored out rather than merely running long, so raising `REVIEW_TIMEOUT_MS` would not fix it. Full detail in `pi-harness-history.md`'s "KAT-Coder ruled out" section. |
| GLM-4.7-Flash-4bit (`:8081`) | Ruled out as reviewer | 0/3 planted-bug catches at default invocation (5-token `NO_ISSUES_FOUND` shortcut every time, no reasoning content) vs. Gemma's 3/3 on the identical prompts. Retried with `chat_template_kwargs: {"enable_thinking": true}` since GLM is hybrid-reasoning and thinking is opt-in per request on most local serving stacks — this unlocked real reasoning exactly once across 10 trials (1/10), reverting to the same shortcut on repeats of the same prompt at `temperature: 0`. Unlike KAT-Coder's reviewer rule-out (a structural request failure), this route responds fine and fast, it just doesn't reliably do the review task on this checkpoint at 4-bit. Community reports corroborate both a Flash-tier reasoning-depth tradeoff and a known 4-bit-quantization weakness on agentic/structured-judgment tasks for this checkpoint. `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` remain pointed at Gemma. Full detail in `pi-harness-history.md`'s "GLM-4.7-Flash-4bit ruled out as reviewer candidate" section. |

## Todo

- Live-test the revised (`tool_result`/`turn_end`-based) designs of
  `makefile-scaffold-nudge.ts`, `artifact-guard.ts`, and
  `error-leak-guard.ts` — the 2026-08-05 live test that motivated their
  redesign only ran the original, now-superseded versions. See
  `pi-harness-history.md`'s "Live end-to-end test finds three of four new
  hardening extensions structurally blind" entry.
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
- `continuation-nudge.ts`: the 2026-08-07 field evidence (see its table
  entry above) shows the failure mode it targets is real, but the nudge
  itself hasn't been *re-enabled and retested* against the same
  `group-invite-atomic-rotation` scenario to confirm it actually recovers
  the empty-content-stop rather than just delaying it. That's the next
  concrete step, not further passive waiting for field evidence.
- Reduce quality-gate's runtime/token overhead below the plan's 20%
  threshold, or revise the threshold with evidence for why the current
  cost is acceptable.

Full investigation history — dated narrative, superseded partial results,
live-run-by-live-run detail — is in `pi-harness-history.md`.
