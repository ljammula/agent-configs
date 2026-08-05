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
`:8081` (reviewer, same host). `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` are now
set in `~/.zshrc`, so `cross-model-review.ts` resolves to genuine
`independent-review` rather than disabling itself; same-primary review still
requires `AI_REVIEW_ALLOW_SELF=1` and is labeled `blind-self-review`, never
cross-model, if it's ever pointed back at the same route. `AI_REVIEW_MODEL`
must be the exact id `GET :8081/v1/models` returns
(`/Users/kanna/code/ai-stack/models/gemma-4-26b-a4b-it-4bit`), not the short
`gemma-4-26b-a4b-it` form — see "Stale `AI_REVIEW_MODEL` silently disabled
the reviewer" in `pi-harness-history.md` for how this drifted and broke
silently once already. The maintained Pi
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

Two acceptance boundaries remain intentionally not adopted:

- Docker is unavailable on this Mac. The containment Dockerfile and
  launcher pass static shell/install checks, but the live escape matrix is
  not proven.
- `continuation-nudge.ts` and `co-change-suggest.ts` remain source-tested
  but are removed from the installed runtime until randomized paired
  evidence meets the current adoption threshold.

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
| `quality-gate.ts` | Adopted, on by default | Binds passing evidence to the current diff hash, rejects truncated/shell-masked results, runs the repo's canonical check (including nested manifests) at settlement, caps corrective follow-ups at three. Proven in the completed nine-pair battery above. |
| `stack-router.ts` | Adopted, on by default | Routes Go, Python, Flutter, TypeScript/JavaScript, PostgreSQL, Kafka, Temporal, and GCP guidance from repository evidence. Deterministic tests for all routes; only Go/Dart routes have battery coverage (see battery result above), the rest are wired and unit-tested but not battery-proven. |
| `co-change-suggest.ts` | Default-disabled, source-tested | One real retrospective replay (ranked target file #1 of 8) does not meet the paired-adoption threshold. Live (non-retrospective) validation not run. |
| `continuation-nudge.ts` | Default-disabled, source-tested | Deterministic branch tests pass; the widened empty-content-stop trigger has zero real-trial field evidence. |
| `cross-model-review.ts` | Adopted, resolves to genuine `independent-review`, but its trigger cannot fire on the current task suite | `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` set in `~/.zshrc` to `gemma-4-26b-a4b-it` on `:8081`, distinct from the `:8080` Qwen primary. Deterministic tests pass (74/74); live-checked 2026-08-04 that `resolveReviewerConfig()` resolves `independent-review` (not `disabled`/`blind-self-review`) and that `requestReview()` correctly flagged a deliberately planted bug against the real endpoint. A separate 2026-08-04 investigation against a third route (KAT-Coder, `:8083`, not the standing config) found and fixed a process-crashing stale-context bug in the `tool_result` catch handler and a structural gap where `pi -p` exited before any review round could finish; both fixed, tested, and now apply to whichever route is configured — see `pi-harness-history.md`'s "Trying a third reviewer route" section. `REVIEW_TIMEOUT_MS` raised from 120s to 240s (commit `83ca0cb`) after a real production-shaped review request against idle Gemma took 121.4s — 1.4s past the old timeout, which would have silently discarded a correct finding. A full end-to-end rerun (2026-08-04, standing Qwen+Gemma config, pair 4) confirmed the task itself passes cleanly (9/9 go -race, 17/17 dart) but the reviewer never fired: its `tool_result` trigger only reacts to the *model's own* successful broad-verification command, and `local-model-bench` hides real test files until after `pi` exits, so the model never has one to run — it wrote its own smoke test instead, and its one `dart test` call errored on "no test files," which the trigger explicitly excludes. No route, model, or timeout can fix this; it needs a design change (e.g. a settlement-time trigger like `quality-gate.ts`'s). Discovered 2026-08-05: after the `:8082`→`:8081` route move, `AI_REVIEW_MODEL` held the short id `gemma-4-26b-a4b-it` while the route now serves `/Users/kanna/code/ai-stack/models/gemma-4-26b-a4b-it-4bit`; every real request 400'd `model_mismatch`, which `requestReview()` silently downgrades to `{outcome: "transient"}` — the reviewer had been reviewing nothing since the move, with no error surfaced anywhere. Fixed by exporting the full served id. With the id corrected, a 15-trial reviewer-reliability battery (three planted bugs — `clampToRange` missing its upper-bound clamp, `divide` missing its zero-check, `add` implemented as subtraction — 5 trials each at `temperature: 0`, via the real `requestReview()` path) caught 15/15, deterministic across repeats (identical response length per bug on every trial). A 9-trial false-positive control (3 trials each of the correct implementation of the same three functions) returned `NO_ISSUES_FOUND` 9/9. See todo. |
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
- Use an OS/container boundary for unattended execution once Docker is
  available on this host — the protected-path guard is defense in depth,
  not filesystem confinement.
- `co-change-suggest.ts`'s live (non-retrospective) validation — "try it
  live on one new personal-assistant feature task" — has not been run.
- `continuation-nudge.ts`'s widened trigger has zero field validation.
  Needs real trials before its empty-content-stop path can be said to
  work, not just to type-check.
- Reduce quality-gate's runtime/token overhead below the plan's 20%
  threshold, or revise the threshold with evidence for why the current
  cost is acceptable.

Full investigation history — dated narrative, superseded partial results,
live-run-by-live-run detail — is in `pi-harness-history.md`.
