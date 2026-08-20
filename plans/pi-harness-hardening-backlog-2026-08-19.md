# Pi harness hardening backlog — reaching solo-Sonnet-level reliability

Date: 2026-08-19
Audience: an agent picking this up cold, without this session's history
Repo: `agent-configs` (this repo); extensions live in `pi/extensions/`, tests in
`pi/tests/`, battery runners in `pi/evals/`, task fixtures in
`../local-model-bench/tasks/`

## Why this doc exists

`pi-harness-validation-status.md` establishes that the harness's *correctness*
gap to `claude-sonnet-5` is closed on the one task with matched-pair evidence
(0/4 → 4/4 on `go/lru-cache`, same regression test, once thinking +
temperature were fixed). That is narrower than "correctness is closed,
full stop," and this doc's framing shouldn't be read as claiming more than
the matched-pair evidence supports: `pi-harness-validation-status.md` lines
535-544 separately record a run that completed `go/lru-cache` cleanly
(`valid: true`, `timed_out: false`) while still leaving the eviction bug in
and failing the hidden test — a non-stall correctness failure the
recommendations below don't address, since the stall backstop (Rec. 1) only
triggers on `stall-timeout`, and a clean-looking settle with a wrong answer
is exactly the shape `quality-gate.ts`'s settlement check exists for, not
this file. Flagged during Codex PR review (PR #20); kept as an explicitly
open gap here rather than folded into a recommendation, since closing it is
`quality-gate.ts`/eval-battery scope, not `progress-stall-guard.ts` scope.
What remains in this doc's own scope is a **reliability and speed** gap:
Sonnet finishes `go/lru-cache` in 32.4s, one shot, 3/3 all-time; the harness
takes 2-10 minutes per turn with thinking on (100-312% median runtime
overhead vs. baseline) and has hit **five distinct stall/loop shapes** on
`dart/sequential-runner` alone, with **zero recoveries** — every fix so far
closes the shape that already happened, with no reason to believe a sixth
shape won't appear. This doc supersedes
`plans/pi-harness-hardening-backlog-2026-08-18.md`'s Tasks 2-8 framing (which
is still a valid source for detail — read it for the full problem
statements) with a re-prioritized plan informed by what the wider community
does for the same class of problem.

Ground rules are unchanged from the 2026-08-18 backlog: run
`npm run typecheck && npm test` inside `pi/` before considering any task
done; read each extension's own header comment before changing it; update
`pi-harness-validation-status.md` and append a dated entry to
`pi-harness-history.md` for anything completed, citing the specific
run/battery result; don't commit without being asked; live validation
requires `AI_STACK_HOST` to resolve to a reachable stack.

## What the community does for this exact problem class

Researched 2026-08-19 against OpenHands, general agent-harness watchdog
writeups, Qwen3.8-specific community reports, and pi.dev's own docs.

- **OpenHands' `Stuck Detector`** (the closest published analog to
  `progress-stall-guard.ts`) is enabled by default and pattern-matches
  several concrete shapes: repeating action→error cycles (3+ repeats),
  agent monologues with no meaningful progress (3+), and alternating
  between two actions (6+ cycles) — the same "detect known shapes" strategy
  this repo already uses, at similar thresholds. It **halts on detection**;
  it does not try to correct the model in-band. That's consistent with this
  repo's own 2026-08-19 decision to strip `sendUserMessage`-based correction
  out of `quality-gate.ts`/`cross-model-review.ts` (detect → stop/report,
  don't try to steer a model mid-loop) — worth noting as corroboration, not
  claimed as independent convergence, since the relative timing and whether
  anyone here had seen OpenHands' design aren't established.
  OpenHands' own issue tracker also documents the known failure mode of
  shape-based detection: false positives on legitimate long-running
  polling, and hardcoded, non-configurable thresholds — the same brittleness
  this repo has hit from the other direction (five real shapes, no
  generalized catch-all).
- **General agent-harness guidance** (multiple independent 2026 writeups on
  agent timeout/circuit-breaker patterns) converges on layering, not
  choosing one mechanism: behavioral pattern detection for the common cases,
  **plus an unconditional wall-clock/step ceiling enforced by the runner as
  a backstop that does not depend on recognizing the shape**. One pattern
  specifically named: "no file write in N minutes" as a cheap, shape-agnostic
  progress signal, functionally identical to what Task 2 has been trying to
  get right by pattern-matching diagnostic commands instead.
- **Qwen3.8-specific**: independent of this repo's own findings, community
  guidance recommends capping the reasoning budget itself (~5,000 reasoning
  tokens) in addition to `reasoning_effort: medium`, as a second lever on
  overthinking/looping latency that this harness has not tried — currently
  only `defaultThinkingLevel` is tuned, not a token ceiling on the reasoning
  span itself.
- **Escalation-on-difficulty is a named pattern**, not this repo's
  invention: route cheap/simple work to the local model, escalate to a
  frontier model when a cheap *structural* signal fires (retry count, files
  touched, a test still red after N corrective rounds) rather than having
  the model self-assess difficulty. This directly matches the gap-closing
  goal stated by the user: if the local model reliably fails at task X, the
  harness matching Sonnet doesn't require the local model to succeed at
  X — it requires the *harness* to succeed, which a bounded fallback to
  Sonnet can do for exactly the stuck cases pattern-matching can't reach.
- **pi.dev's own docs** confirm `compat.supportsDeveloperRole: false` as the
  documented fix for exactly the 503 regression this repo hit and already
  fixed (independent confirmation, not a new finding) — no action needed,
  logged for completeness. Docs also note smaller local models "frequently
  lose track of what they're doing in longer agent sessions" as an
  acknowledged, not harness-specific, limitation, and recommend larger
  model tiers (e.g. an 80B-MoE class) for reliability parity with frontier
  models where VRAM allows — relevant to Task 5 below as an alternative,
  not-yet-considered lever.

**Net effect on prioritization**: community practice does not suggest
continuing to chase individual stall shapes is the highest-leverage next
step — it validates that this repo's existing shape-detection work is
sound as a first layer (on par with OpenHands' approach) but says the
missing piece is the **generic, shape-agnostic backstop**, which this repo
has not built. That reframes Task 1 below as higher-priority than further
fingerprint-widening work.

## User priority note (2026-08-19, added after initial draft)

The user's actual goal, stated directly: **correctness without significant
overhead** — not just "eventually get reliable, speed can wait
indefinitely." That sharpens Recommendation 4 (overhead attribution +
reasoning-token-budget cap) from "do last" to "don't treat as an afterthought
once 1-3 land": the 100-312% overhead figure is itself a form of not
meeting Sonnet parity (Sonnet's 32.4s vs. the harness's multi-minute turns
is exactly the overhead this recommendation targets), not a separate,
lesser concern. Practically: Recommendation 4's investigation phase (the
profiling breakdown, no code risk) should start in parallel with
Recommendation 1, not wait — only the actual overhead-reducing code change
(if the profiling justifies one) should wait behind the reliability work,
since a faster harness that still fails outright on a meaningful fraction
of runs isn't the win either. The reasoning-token-budget cap in particular
is worth prioritizing over deeper `quality-gate.ts` overhead surgery: it's
a config change (no extension code risk) directly targeting the
thinking-mode latency that's the dominant, already-measured cost driver
(312% vs. 100% once thinking was enabled), where the settlement-check
overhead itself was separately measured as small (842ms-2,398ms against
110-270s totals) — i.e. the cheapest lever is also the one aimed at the
biggest known cost, so it shouldn't sit behind three other tasks in
practice even though it's still sequenced last below for the
reliability-first reasoning already laid out.

## Codex implementation-review comments (2026-08-19, post-PR #21)

These are the only findings from this pass that materially affect the stated
solo-Sonnet-level goal. They supersede the sequencing below where they
conflict with it; the existing stall work remains useful, but Recommendation
1 is now implemented rather than the largest open risk.

### P0. Reset the wall-clock stall episode at each real top-level prompt — resolved

The review reproduced a second prompt inheriting the first prompt's wall
clock and aborting on its first tool result. `progress-stall-guard.ts` now
resets the complete stall episode on `before_agent_start`, Pi's true
top-level-prompt boundary, while retry/compaction `agent_start` events still
preserve evidence. A two-fully-settled-prompts regression covers the exact
failure.

### P0. Make the unattended production path run the harness that was actually validated — resolved

`build_app.py` now inherits installed thinking settings by default instead
of forcing `--thinking off`; `--thinking` remains an explicit experiment
override. Its new `resolve-verification.ts` bridge calls the same
`lib/verification.ts` resolver as `quality-gate.ts`, including nested
manifests and Flutter-vs-Dart detection. A two-component integration fixture
proves that breaking either component prevents acceptance.

### P0. Escalation must consume correctness signals, not only stall signals — resolved

The outer loop now consumes canonical verification failures, reviewer
flags/unavailability, Pi failures/timeouts, and `stall-timeout` as blocking
signals and carries concrete evidence into the next bounded corrective round.
Clean independent review is required by default; an explicit
`--review-policy degraded` allows labeled success only when review is
unavailable, never when it is flagged. After local rounds, the result says
`escalation required`; `--sonnet-fallback` explicitly authorizes one billed,
bounded `claude-sonnet-5` corrective pass. No cloud spend occurs by default.

### P1. Define and run the parity gate before claiming Sonnet level

The latest nine-task battery is harness-only (7/9 at reasoning off, with
reasoning-on follow-ups for the two failures); the only current matched
Sonnet evidence called out here is `go/lru-cache`. That is useful causal
evidence, but it cannot establish suite-level Sonnet parity or the requested
"without significant overhead" condition. Run the current production path
and solo Sonnet on the same task versions, hidden tests, timeout policy, and
recorded schedule, with repeated trials for stochastic tasks. Predeclare the
acceptance metrics: valid-and-correct completion rate is primary; wall time,
model calls/tokens, stall/escalation rate, and degraded-review outcomes are
secondary. Do not promote the harness as Sonnet-level from a single matched
task or from follow-up reruns selected after failures.

### Revised order from this review

1. ~~Fix the cross-prompt backstop reset and add the two-prompt regression.~~ Done.
2. ~~Align `build_app.py` with the validated thinking and canonical-verification
   policies.~~ Done.
3. ~~Wire verification/reviewer/stall outcomes into the bounded corrective and
   escalation loop.~~ Done; live validation remains.
4. Run the predeclared matched Sonnet parity battery.
5. Tune latency/reasoning cost only after the parity gate identifies the
   remaining dominant gap.

## Prioritized recommendations

### 1. Add a generic, shape-agnostic stall backstop with a two-stage response — implemented and live-validated

**Current status.** Implemented, PR-reviewed, and live-validated as recorded in
`pi-harness-validation-status.md`. The cross-prompt lifecycle regression found
in the Codex review above is also fixed and deterministically covered. The
original rationale and acceptance evidence are retained below as history.

**What.** In `progress-stall-guard.ts`, add a check that does not depend on
recognizing *any* command pattern: track wall-clock time since the last
`write`/`edit` tool call touching a non-test source file. This must run
**unconditionally on every `tool_result` event, not gated behind
`matchesDiagnosticExecution`** — every existing check in the file (line
444-446) only evaluates inside the `bash` + diagnostic-command branch,
which is exactly why the file's own documented gap exists ("a stall built
entirely of `ls`/`git ls-files`-style re-inspection is structurally
invisible to every detector in this file"). A time-since-last-source-edit
check gated the same way would inherit that identical blind spot and not
actually be shape-agnostic — it must be evaluated regardless of tool name
or command shape to close that gap. Two thresholds, not one: at the first
(proposed starting point: 10 minutes, tunable per the same env-var pattern
as `PI_STALL_GUARD_INTERCEPT`) fire the existing synchronous intercept
action (attempt recovery, matching `ACTION_SAME_FAILURE_THRESHOLDS`'
existing two-stage shape); at the second (e.g. 2x the first, zero source
edits since) force a clean abort and record a `stall-timeout` outcome
distinct from a plain `timed_out` outcome, so a human/downstream consumer
can tell "ran out of budget on real work" from "the harness gave up on a
confirmed stall" without reading the trace — no more manual
watch-the-JSONL-and-SIGTERM, as the fourth pair-5 rerun required. This is
one implementation task with two thresholds, not two separate ones — the
earlier draft of this plan described the hard ceiling as a separate
"Recommendation 3"; on review the two are the same mechanism at two
thresholds and belong together.

**Why highest leverage.** Every fix to date (heredoc-shape widening, key
generalization, pipe-masking reuse, cycle detection) has closed exactly the
shape already observed and none other. Five shapes, zero recoveries is
strong evidence the shape space is larger than the fix budget. A
time-since-last-source-edit trigger is invariant to shape by construction —
it would have caught all five prior incidents on turn one of the backstop
window, including the one (argument-echoed-into-output alternation) that
specifically defeated the output-hash fingerprint, and (once made
unconditional per above) the read-only-inspection shape no detector in
this file currently sees at all.

**Evidence it worked.** Re-run the existing five recorded stall
reproductions (or the closest live equivalent — `dart/sequential-runner`
under `run_single_arm.py`) with the backstop enabled and confirm the
intercept fires within the threshold window regardless of which loop shape
appears, and that a stall which doesn't recover reaches the second
threshold and produces a `stall-timeout` outcome with no manual
intervention. A live trial deliberately using the argument-echoed-into-output
shape (the one that defeated the fingerprint) is the sharpest test since
it's the known hardest case; if feasible, a synthetic read-only-inspection
(`ls`/`git ls-files` loop) trial specifically exercises the
previously-undetectable gap.

**Sequencing.** Independent of Recommendations 2-4 below; can start
immediately. Compose with, don't replace, existing shape detection — shape
detection still gives earlier, more specific reporting when it does match;
the backstop is the guaranteed floor.

### 2. Validate the intercept-action recovery rate (was open item, testable now — does not need to wait on Recommendation 1)

**What.** `PI_STALL_GUARD_INTERCEPT` exists and is opt-in, but every live
pair-5 rerun to date failed to reach `ACTION_SAME_FAILURE_THRESHOLDS`' [8, 25]
firing threshold before timing out (`sameFailure` has peaked at 4) — so the
intercept's actual recovery effectiveness has never been observed. This
does not require Recommendation 1 to land first: the existing mechanism can
be exercised today by temporarily lowering the thresholds (e.g. to [3, 6])
for one live trial, forcing a fire without needing the backstop's timer
infrastructure. (Once Recommendation 1 lands it becomes an even easier way
to force a fire, but it isn't a hard dependency — don't block this on 1.)

**Why.** This is the single biggest unanswered question blocking a
"solidified" claim: does telling the model what's wrong via the synchronous
`tool_result`-append channel actually get it unstuck, or does it need a
harder intervention (forced abort + fresh continuation, or escalation per
Recommendation 4)?

**Evidence.** Live trial: with the intercept firing (via lowered thresholds
or, later, Recommendation 1's backstop), does the *next* turn show a
source-file edit (not just a different diagnostic probe)? Track this
explicitly — a stall that changes shape after the intercept but still
doesn't touch source is a different verdict (intercept fires but doesn't
recover) than one that reaches a real edit and the diff settling.

**Sequencing.** No hard dependency on Recommendation 1 — can run in
parallel or even first, since it's cheaper to trigger via threshold-lowering
than by waiting on new infrastructure.

### 3. Escalate failed local outcomes to Sonnet as a bounded fallback — implemented, live validation pending

**Current status.** Implemented in `build_app.py`, opt-in via
`--sonnet-fallback` so billing is never implicit. The trigger was broadened
beyond `stall-timeout`: exhausted canonical-verification failures, reviewer
flags/unavailability, Pi failures/timeouts, and confirmed stalls all reach the
same escalation boundary. Deterministic tests prove signal parsing, corrective
rounding, and exactly one fallback pass; no billed live fallback was run in
this change.

**What.** When Recommendation 1's `stall-timeout` outcome fires (a
confirmed, backstop-triggered, intercept-attempted-and-failed stall), hand
the current diff + failing verification evidence to `claude-sonnet-5` for a
single bounded corrective pass, rather than reporting a bare failure. This
is the "escalate on a cheap structural signal, not self-assessed
difficulty" pattern from the community research — the structural signal
here is exactly Recommendation 1's `stall-timeout` outcome.
Placement is resolved in favor of `build_app.py`, the existing out-of-band
orchestrator. The extension remains responsible for producing truthful
signals; the orchestrator owns corrective rounds, policy, and the optional
cloud-model invocation.

**Why highest-leverage for the user's actual ask.** The user's goal is the
*harness* matching Sonnet-level outcomes, not the local model doing so
unaided. For the specific cases pattern-matching and backstops can detect
but not fix, a bounded Sonnet fallback closes the gap directly instead of
continuing to chase local-model reliability asymptotically. This also
reframes the "312% overhead" finding: overhead on the ~90%+ of runs that
converge cleanly is a separate, lower-stakes problem (Recommendation 4)
from the runs that currently fail outright.

**Evidence.** A trial where a task previously failed via confirmed stall
(e.g. `dart/sequential-runner`) is rerun with escalation enabled and passes
via the Sonnet fallback pass, with the fallback's own cost/latency recorded
so the tradeoff (bounded Sonnet cost on the minority of runs that stall) is
visible, not hidden.

**Sequencing.** Implementation is complete. Live validation remains gated on
an explicit invocation with `--sonnet-fallback`, which is the cost sign-off;
without the flag the builder stops nonzero at `escalation required`.

### 4. Attribute and reduce the 100-312% runtime overhead (carried over from 2026-08-18 Task 3, still unstarted)

**What.** Unchanged from the prior backlog: profile where wall-clock cost
actually goes (settlement verification, nested-manifest resolution,
reviewer round-trips) using the existing battery JSONs
(`full-screening-2026-08-03.json`, `hardened-screening-2026-08-17.json`)
plus the three current-code phase-timing samples already in
`pi-harness-validation-status.md` (842ms/643ms/2,398ms gate cost against
110s/270s/120s totals — gate cost itself is not the dominant overhead in
any of the three). One new lever from the community research not
previously considered: capping the reasoning token budget itself
(~5,000 reasoning tokens, distinct from `defaultThinkingLevel`) as a second
tuning axis, since `medium` thinking-level alone doesn't bound the *length*
of a given reasoning span, only its qualitative depth.

**Why lower priority than 1-3.** This is a real, measured cost, but it's a
cost on runs that already succeed — it doesn't block reaching
Sonnet-parity *outcomes* the way unrecovered stalls do. Worth doing, but
after the reliability gap (1-3) is addressed, since a faster harness that
still fails 1 in 5 runs doesn't read as "solidified."

**Evidence.** A live before/after battery subset with a reasoning-token
cap applied, reporting the same median-overhead metric already tracked.

**Sequencing.** Independent of 1-3; can run in parallel any time, but rank
it after them for attention.

## Carried-over open items, unchanged priority

These remain open exactly as documented in
`plans/pi-harness-hardening-backlog-2026-08-18.md` and
`pi-harness-validation-status.md`; not re-stated in full here:

- **Background-process-kill root cause (prior Task 5)**: mechanism
  identified (`DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300000` in
  `pi-coding-agent`'s `http-dispatcher.js`), `httpIdleTimeoutMs: 0` shows
  2/2 clean survival in partial live testing — needs a larger-n live
  confirmation, not a new mechanism search.
- **`session_compact` mid-goal reminder (prior Task 8)**: still blocked on
  a task that genuinely needs multiple corrective rounds to observe;
  sequence after Recommendation 3 above, since an escalation-worthy stall
  is exactly the kind of multi-round scenario likely to also trigger
  compaction.
- **`co-change-suggest.ts` / `continuation-nudge.ts`**: resolved
  2026-08-19 per `pi-harness-validation-status.md` — no action needed.
- **TypeScript/JS battery coverage**: resolved 2026-08-19 per
  `pi-harness-validation-status.md` — no action needed.

## Suggested sequencing summary

1. Generic stall backstop with its two-stage response (Recommendation 1) —
   implemented, live-validated, and cross-prompt reset fixed.
2. Intercept recovery-rate validation (Recommendation 2) — no hard
   dependency on 1; can start in parallel or first via temporarily lowered
   thresholds.
3. Sonnet escalation fallback (Recommendation 3) — implemented in
   `build_app.py`; one billed pass is opt-in via `--sonnet-fallback`. Live
   validation remains.
4. Overhead attribution + reasoning-token-budget cap (Recommendation 4) —
   independent, lower priority; parallel-safe with any of the above.
5. Background-kill large-n confirmation and `session_compact` live
   exercise — carried over, sequence after 3 as noted above.

## Review note

This plan was self-reviewed critically (2026-08-19, in lieu of a
non-responsive Opus review subagent) before being finalized. What changed
as a result: the original draft's Recommendations 1 and 3 (backstop timer
and hard ceiling) were separate items describing the same underlying
mechanism at two thresholds — merged into one. Recommendation 2's
sequencing after the backstop was an unjustified dependency — the existing
intercept mechanism can be exercised today via threshold-lowering, with no
need to wait. Recommendation 1's "shape-agnostic" framing didn't originally
specify that the check must run unconditionally, not gated behind the same
diagnostic-command matching every other detector in the file uses — without
that, it would silently inherit the file's own documented blind spot rather
than closing it. The Sonnet-escalation recommendation didn't originally
address where it would live architecturally; the later implementation
resolved that question in favor of `build_app.py`'s orchestrator layer,
keeping outbound model calls out of `progress-stall-guard.ts`. The "independent
convergence" claim about OpenHands' `Stuck Detector` was softened to
"consistent with," since the relative timing isn't established.
