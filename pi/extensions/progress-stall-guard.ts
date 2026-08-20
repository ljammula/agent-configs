/**
 * Progress-stall-guard extension.
 *
 * Targets a failure mode `continuation-nudge.ts` cannot see: the model keeps
 * making tool calls -- writing and running its own scratch tests -- while
 * never editing the source file the bug it already diagnosed lives in.
 * `continuation-nudge.ts` bails the instant a turn makes any tool call
 * (`if (event.toolResults.length > 0) return;`), so a turn spent running a
 * debug test looks identical to productive work to that extension. This one
 * detects the opposite signature: activity without progress. Deliberately a
 * separate extension, not a third widening of `continuation-nudge.ts` -- the
 * two trigger on disjoint tool-call presence and carry incompatible state
 * (one turn's classification vs. a rolling multi-turn window), so merging
 * them would make either harder to reason about alone.
 *
 * Live-observed 2026-08-16 (`local-model-bench`, `go/lru-cache`, Qwen3.8 via
 * `pi-local`): the model wrote its own `TestEvictionWithDistinctKeysAndValues`,
 * ran it, got a real, correct failure (`key 10 should have been evicted`),
 * and then repeated variations of the same write-run-observe cycle against
 * the same unedited `lru.go` for the next ~24 minutes until killed past the
 * suite's 30-minute timeout -- despite having already found the real bug.
 * Full account: `local-model-bench/SPEC.md`'s 2026-08-16 report,
 * `pi-harness-validation-status.md`'s "First live claude-sonnet-5
 * comparison" entry.
 *
 * Heuristic is a conjunction, not any single signal:
 *   (a) no edit/write tool call touching a non-test source file across
 *       STALL_ROUNDS_THRESHOLD consecutive turns that ran a diagnostic command, AND
 *   (b) the diagnostic signature (command shape plus failure category) hasn't
 *       changed across SAME_FAILURE_THRESHOLD consecutive failing runs. The
 *       command shape ignores scratch heredoc contents, because a probe can
 *       vary while still reproving the same source bug.
 * Neither alone is safe: (a) alone flags legitimate read-only exploration;
 * (b) alone flags a flaky test genuinely being re-run to check reproducibility.
 * Together they describe "diagnosed and reproduced, but never acted on."
 *
 * Known false-positive case, accepted deliberately: a model correctly
 * bisecting an unfamiliar bug via a sequence of small probe tests, without
 * touching source until it has localized the fault, produces a
 * tool-call trace this heuristic cannot distinguish from the stall above --
 * that distinction lives in the model's reasoning, not the tool stream. The
 * cost asymmetry justifies recording anyway: a false positive costs one
 * trace event; a false negative costs a killed multi-minute run, as it
 * did here.
 *
 * Shape-specific detection remains trace-only by default. A separate,
 * shape-agnostic wall-clock backstop is always evaluated on tool results:
 * after the soft threshold it appends a synchronous recovery fact, and after
 * twice that threshold it aborts the run with a distinguishable
 * `stall-timeout` trace outcome.
 *
 * Two bugs found live 2026-08-16 re-running this exact scenario (see
 * pi-harness-validation-status.md):
 *
 * 1. TEST_EXECUTION_PATTERNS didn't match `make verify`/`make test`/
 *    `make check`. A live run had the model build its own Makefile mid-task
 *    and switch to running `make verify` -- invisible to this list even
 *    though `lib/verification.ts`'s BROAD_VERIFICATION_PATTERNS already
 *    covers exactly that case. Added below, mirroring that coverage.
 * 2. `agent_start` fires on every internal auto-retry (transient provider
 *    error), not once per invocation -- a run with 16 retries under real
 *    proxy contention wiped sourcelessRounds/sameFailure 16 times, making
 *    real evidence of repeated inaction invisible. Fixed the same way as
 *    `wall-clock-budget-nudge.ts`: only the first `agent_start` resets state.
 *
 * Two more bugs found live 2026-08-19, both from the same `dart/sequential-
 * runner` (pair 5) clean-isolation rerun, reproducing the stall a second
 * time with a different shape than the first (see pi-harness-history.md's
 * "post-backlog pair-5 rerun" entry):
 *
 * 3. **The same-failure signal was keyed on command shape plus failure
 *    category, and command shape was too strict.** The model settled into
 *    alternating between ~15 near-identical `dart test --help | grep
 *    '<term>'` probes (different search terms, different -A/-B context
 *    sizes) hunting for an explanation of `dart test`'s exit 79 ("No tests
 *    were found" -- the fixture's test/ dir is legitimately empty from the
 *    agent's side). Two of those variants alone accounted for ~2,000 of the
 *    session's 2,375 tool calls. Every non-matching grep produced the exact
 *    same empty output -- `failureCategory()` was already identical across
 *    all of them -- but the combined shape+category key kept resetting
 *    `sameFailure` on every alternation between variants, since the command
 *    text (not just a heredoc body) genuinely differed. Command shape's
 *    original purpose (Task 2, above) was to stop heredoc-body variation
 *    from masking a repeated failure; it was never meant to require the
 *    whole command to match. Fixed by dropping shape from the key entirely
 *    -- `sameFailure` now tracks `failureCategory()` alone, which was
 *    already invariant to exactly this kind of surface variation.
 * 4. **A `!event.isError` diagnostic result unconditionally reset the
 *    counters, even when the pipeline could be masking a real failure.**
 *    This is the exact class Task 4's *first* pair-5 rerun hit (127 calls
 *    piped through `head`, every one reporting `isError: false` because
 *    `head`'s exit code -- not `dart test`'s -- is what the shell actually
 *    returns without `pipefail`), already root-caused there but left
 *    unfixed pending this revisit. `quality-gate.ts` has carried the fix for
 *    its own settlement check since before this file existed
 *    (`verificationPipelineCanMaskFailure`); this file just never called it.
 *    Reused directly (generalized to take a patterns list, since this file's
 *    TEST_EXECUTION_PATTERNS is deliberately broader than quality-gate's
 *    BROAD_VERIFICATION_PATTERNS) rather than reimplemented. A maskable
 *    exit-0 result is now treated as inconclusive -- neither a trustworthy
 *    "this worked" (no reset) nor forced evidence of a specific failure
 *    (still fingerprinted from its own output, so genuinely new output still
 *    breaks the streak).
 *
 * Both fixes are detection-only and preserve the file's central invariant:
 * still zero calls to `sendUserMessage`, ever. See ACTION below for the one
 * new thing that changed on the response side.
 *
 * A third live pair-5 rerun (2026-08-19, same day, with both fixes above
 * plus the intercept action already live) found a *third* loop shape neither
 * fix generalizes to: the model alternated between two `dart test ... |
 * head` commands whose literal filter arguments (e.g. `'x'`/`'y'` vs.
 * `'ok'`/`'zzz'`) get echoed into the output text itself. `failureCategory()`
 * falls through to `fingerprintFailure()`'s output hash for output that
 * doesn't match a recognized go-test/panic/error shape, so genuinely
 * different echoed text produces a genuinely different fingerprint on every
 * alternation -- `sameFailure` peaked at 4 and reset each time it flipped
 * back, never sustaining a streak long enough to reach either the trace
 * threshold's spirit or the action thresholds. This is not a fingerprinting
 * bug like items 3-4 above (the fingerprints are honestly different, each
 * one individually); it's that *consecutive-match* streak tracking is the
 * wrong shape of detector for *alternation* between a small, non-growing set
 * of distinct attempts.
 *
 * CYCLE DETECTION (new, trace-only like the base heuristic): a trailing
 * window of the last `CYCLE_WINDOW` diagnostic fingerprints is kept
 * alongside `sameFailure`. It fires only on genuine alternation: the window
 * must be full, hold at most `CYCLE_DISTINCT_THRESHOLD` (2) distinct
 * fingerprints, AND every one of those distinct fingerprints must appear at
 * least twice. That last requirement is deliberate, added after an Opus
 * design review of the first version caught a real inversion: a bare
 * low-cardinality check (distinct count alone) fires on `A,A,A,A,A,B` --
 * five identical results plus one novel one -- at call 6, while six
 * genuinely identical results (`A` x6, stronger evidence of a stall) don't
 * intercept at all until `ACTION_SAME_FAILURE_THRESHOLDS`' first entry (9
 * consecutive). Adding a single novel result to an otherwise-uniform window
 * should not fire *more* readily than the uniform window itself; requiring
 * every distinct value to repeat is what actually captures "cycling
 * between a small closed set," not "mostly the same, plus noise." At
 * `CYCLE_DISTINCT_THRESHOLD = 2` this catches 2-state alternation (A, B, A,
 * B, A, B) -- the exact shape of the third live pair-5 rerun -- but NOT
 * 3-state rotations (A, B, C, A, B, C, which has 3 distinct values and so
 * never satisfies the threshold): a known, explicit gap, not a claimed
 * capability. Widening the threshold to cover rotations would also widen
 * how little repetition each distinct value needs, so it isn't a free
 * change; left for a future revisit if a live 3+-state rotation is ever
 * observed. Reusing `failureCategory()`'s own fingerprints (nothing new to
 * get wrong) and sharing every reset point with `sameFailure` (source edit,
 * trustworthy success, new input, true agent restart) are both unchanged
 * from the first version. When `interceptEnabled`, a detected cycle fires
 * the same synchronous `tool_result`-content-append action
 * `ACTION_SAME_FAILURE_THRESHOLDS` fires for a consecutive streak, but
 * independently, and at most once per stall *episode* (reset at the same
 * four points as `sameFailure` above, not just at session start -- unlike
 * `intercepts`, which really is a per-session budget). Two back-to-back
 * episodes with an edit in between can each fire their own cycle intercept;
 * that's intentional, not the "at most once, period" `intercepts` gets.
 *
 * REASON-CARRYING INTERCEPT TEXT (new): both intercept texts above stated
 * only "this repeated" -- never *why* a maskable exit-0 result (see item 4)
 * looked clean in the first place, even though `quality-gate.ts`'s shared
 * `lib/verification.ts` has known the exact mechanism the whole time (which
 * pattern -- an unguarded pipe, a `||` fallback, a leading `!`, a trailing
 * command, a background job -- made the exit code untrustworthy). Scoped
 * from a design discussion about whether `quality-gate.ts`'s now-decoupled
 * settlement rejection should ever redirect the model in-band again: the
 * conclusion was no, not via `followUp` (the exact delivery mode already
 * proven undeliverable to a model that keeps calling tools, which is why
 * quality-gate was decoupled from it in the first place), but the
 * *diagnosis* it already computes can still reach the model through this
 * file's already-approved synchronous channel. `explainVerificationMasking`
 * (the reason-carrying sibling of `verificationPipelineCanMaskFailure`, both
 * in `lib/verification.ts`) is called once per diagnostic `tool_result`
 * instead of the boolean-only form, and its `reason` -- when the trigger was
 * a masked pipeline, not a genuine failure -- is folded into whichever
 * intercept fires. Still states a fact only (the mechanism `explain...`
 * detected with certainty), never a suggested fix, preserving the file's
 * "never guess at intent" invariant; a genuinely unmasked failure carries no
 * reason and the text is unchanged from before this addition.
 *
 * ACTION (new 2026-08-19, opt-in): trace-only detection means a correctly
 * diagnosed stall still runs out the wall-clock timeout with nothing able to
 * act on it -- exactly what happened in both pair-5 reruns even after this
 * file's fingerprint work. `sendUserMessage(..., {deliverAs: "followUp"})`
 * still can't help (see the file-level nudge-removal note below); it
 * structurally cannot interrupt a model that keeps calling tools, which is
 * the precise shape of this failure. But `tool_result` can append content to
 * the model's *own, currently in-flight* tool call -- no new turn, no
 * sendUserMessage, no budget -- the same channel `error-leak-guard.ts` and
 * `artifact-guard.ts` already use to act synchronously mid-session. That
 * sidesteps the failure mode the 2026-08-19 decoupling was actually
 * defending against (a queued correction with nowhere to drain), because
 * nothing is queued: the note lands in the result of the very call that
 * tripped the threshold, which the model is about to read regardless.
 *
 * Deliberately narrow in what it's allowed to say: a fact about the
 * session's own history the model may no longer be able to see (compaction
 * can evict the earlier repeats from context entirely, so "you already
 * tried this" may not be something the model can otherwise know), never a
 * suggested fix -- guessing at intent and guessing wrong would just add a
 * second red herring on top of the first. Fires at most twice per session
 * (8 and 25 repeats of the same failure category), gated off by default
 * behind `PI_STALL_GUARD_INTERCEPT` pending its own live-trial adoption bar,
 * matching this repo's convention for anything not yet proven live
 * (continuation-nudge.ts needed 3 live firings before adoption; this has
 * one so far -- see pi-harness-history.md).
 *
 * INDEPENDENT WALL-CLOCK TIMER (new 2026-08-19, PR #20 Codex review): the
 * unconditional backstop above was still only evaluated inside the
 * `tool_result` handler, so it inherited that handler's own precondition --
 * a `tool_result` event has to fire. Two real shapes defeat that: a hang
 * with no tool call at all, and a single bash invocation that itself never
 * returns. Neither produces a `tool_result`, so the hard-abort stage could
 * never actually fire for either -- the file's "hard ceiling, no manual
 * intervention" claim didn't hold for its own worst case. Fixed with a
 * `setInterval` (`TIMER_INTERVAL_MS`, 15s) started at the true first
 * `agent_start` and stopped at `agent_end`, checking elapsed time on its own
 * cadence and calling the live `ExtensionContext`'s `abort()` directly --
 * independent of whether any tool event ever fires. Only acts while
 * `!ctx.isIdle()`; an idle session between turns is not a stall. The soft
 * stage stays `tool_result`-only, since there's no in-flight tool result to
 * append warning text to when nothing is running -- the timer's job is only
 * to guarantee the hard ceiling actually is one.
 *
 * The same timer also closes a second reviewer-flagged gap: the
 * `tool_result` handler only resets the sourceless clock on `write`/`edit`
 * tool calls, so a model editing source through `bash` (`sed -i`, `tee`, a
 * codegen or formatter script) never registered as progress. Rather than
 * pattern-match bash commands for edit-shaped ones (the same trap
 * `SCRATCH_EXECUTION_PATTERNS` above deliberately stays narrow to avoid --
 * redirects into scratch paths, decoy `2>&1`, a long tail of editor CLIs),
 * each tick asks git directly: `git status --porcelain` for non-test-file
 * paths, same exclusions as `lib/verification.ts`'s `snapshotDiff`. A path
 * that's newly dirty since the previous tick is real, tool-agnostic
 * evidence of progress and triggers the same full reset a trustworthy
 * write/edit does. Known, accepted narrower gap: this catches a path going
 * dirty, not further edits to a file already dirty from an earlier tick --
 * repeatedly rewriting the same already-modified file produces no new
 * signature and doesn't keep re-resetting the clock. Widening that would
 * mean diffing file *content* every tick instead of just `status`, a
 * meaningfully heavier per-tick cost for a case not yet observed live.
 *
 * Bug 5, live-observed 2026-08-19 (`go-flutter/bookmarks-app`, pair 4,
 * `pi-harness-history.md`'s matching entry): the independent timer above
 * was started only on the true first `agent_start` (`seenFirstAgentStart`
 * gating, same guard as item 2's fix) but stopped on *every* `agent_end` --
 * and `agent_end` fires per internal agent loop (retry, auto-compaction,
 * queued continuation), not once per invocation, per Pi's own SDK docs
 * ("Fired when an agent loop ends," distinct from `agent_settled`, "Fired
 * after an agent run has fully settled and no automatic retry, compaction,
 * or queued continuation will run"). The first such boundary anywhere in a
 * run killed the timer permanently: the next `agent_start` saw
 * `seenFirstAgentStart` already true and skipped `startTimer()`, so the
 * one mechanism meant to catch a single hung tool call with no
 * `tool_result` ever produced (the exact case item 3 in the header above
 * introduced this timer to fix) was silently dead for the rest of the
 * session. Live consequence: a `go run /tmp/... | head` hang ran the full
 * remaining ~83 minutes of a 90-minute budget with zero further trace
 * events -- the hard backstop's "hard ceiling, no manual intervention"
 * claim didn't hold, again, for its own worst case. Fixed by calling
 * `startTimer()` unconditionally on every `agent_start` (idempotent --
 * `startTimer()` already calls `stopTimer()` first) while keeping the
 * state-reset (`resetStallState()`, `sawTestThisTurn`, `intercepts`,
 * `lastBashEditSignature`, later renamed `lastBashEditPaths` -- see "F5"
 * below) gated to the true first start only, same as
 * before. Confirmed directly against the live incident's own evidence, not
 * just plausible from the mechanism: `pair4-medium-rerun/evidence/
 * pi-output.jsonl` contains exactly `agent_start` (event 3), `agent_end`
 * (7262), `agent_start` (7264), and no further `agent_end` in an 8421-event
 * run -- the pre-fix timer died at 7262 and never restarted, the last
 * `pi-stall-trace` is at 7953, and the fatal `go run` hang begins around
 * 8135.
 *
 * Two follow-ups from an Opus review of the fix above, same day:
 *
 * 5a. The first pass moved `lastBashEditSignature = undefined` into
 *     `startTimer()` itself, so it silently started resetting on every
 *     retry once `startTimer()` became unconditional -- the exact class of
 *     bug the `seenFirstAgentStart` gate exists to prevent, just for a
 *     different field than the ones already gated. A bash-driven edit
 *     landing in the blind window right after a retry would get absorbed
 *     into the new baseline instead of counting as progress. Moved back
 *     into the gated block alongside the rest of the state reset.
 * 5b. `stopTimer()` moved from `agent_end` to `agent_settled` (the
 *     genuinely-once-per-invocation event, per the SDK doc quoted above).
 *     Stopping on `agent_end` left a narrower version of the same
 *     coverage gap: a hang between one `agent_end` and the next
 *     `agent_start` (mid-retry-backoff, or the auto-compaction call
 *     itself hanging) had no timer running, and if that call never
 *     returns, no further `agent_start` ever fires to restart it. The
 *     tick's own `liveCtx.isIdle()` guard already prevents timing out a
 *     truly idle session (confirmed: `isIdle` stays `false` for the run's
 *     entire duration until the same `_emitAgentSettled` call, per pi's
 *     `agent-session.js`), so there was no safety benefit to stopping any
 *     earlier -- only lost coverage.
 *
 * Two more bugs found via an Opus code review of the Bug-5 fix itself,
 * 2026-08-20, both reproduced live against a scratch harness (not just
 * argued from the diff) and both of the same shape as Bug 5: the fix that
 * closed one hole in the backstop's "hard ceiling, no manual intervention"
 * claim opened a different one.
 *
 * F1. `startTimer()`'s claim of being "idempotent by construction" (it
 *     called `stopTimer()` then recreated the interval) was true of the
 *     *outcome* -- a timer ends up running either way -- but not of its
 *     *cadence*: every call restarted the 15s phase from zero. If
 *     `agent_start` fires more often than `TIMER_INTERVAL_MS` -- exactly
 *     the 16-retries-under-proxy-contention shape this file's own header
 *     already documents (item 2, "Two bugs found live 2026-08-16") -- the
 *     tick callback never gets to execute once, and the hard backstop is
 *     as dead as it was pre-Bug-5, just via starvation instead of a
 *     stopped timer. Reproduced: `agent_start` fired every 10s for 5
 *     simulated minutes against a 2-minute hard deadline produced zero
 *     aborts. Fixed by making `startTimer()` a genuine no-op when a timer
 *     is already running, rather than stop-then-recreate -- the interval's
 *     cadence is now owned by the session's actual lifetime, not by how
 *     often `agent_start` fires.
 * F2. The `input` handler (`pi.on("input")`) called the same
 *     `resetFailureState()` that Recommendation 1 had folded the
 *     wall-clock fields (`lastSourceEditAt`, `backstopSoftFired`,
 *     `backstopHardFired`) into -- silently extending an "ask" reset that
 *     was only ever meant to clear a stale failure fingerprint (its own
 *     comment says so) into resetting the hard-abort clock too. `input` is
 *     not just a human's new message: `pi.sendUserMessage()` fires it for
 *     every extension-injected nudge, including `continuation-nudge.ts` on
 *     any zero-tool-call turn and `goal-gate.ts` on every corrective round.
 *     A stalled run that gets nudged by either more often than the
 *     backstop window can never reach a hard abort. Reproduced: an `input`
 *     fired every 60s against a 2-minute hard deadline, over 10 simulated
 *     minutes, produced zero aborts. Fixed by splitting the reset:
 *     `resetFailureState()` now clears only the failure-fingerprint fields;
 *     `lastSourceEditAt`/`backstopSoftFired`/`backstopHardFired` moved
 *     exclusively into `resetStallState()`, which `input` never calls.
 *
 * Both were the same lesson as Bug 5, generalized: this file's shared
 * reset/restart helpers get called from more places than the change that
 * touches them tends to audit, and "fires once" or "only resets what I
 * meant it to" needs re-checking against every call site, not just the one
 * motivating the change.
 *
 * The same review surfaced four smaller fixes, applied same day:
 *
 * F3. The timer tick runs inside a bare `void (async () => ...)()`, not a pi
 *     handler emit, so an uncaught throw is a raw unhandled promise
 *     rejection -- Node's default for that is process termination, not a
 *     logged error. The captured `ctx` (see the note above where it's
 *     declared) is safe to read for staleness of *values*, but calling
 *     `ctx.isIdle()`/`ctx.abort()` after the session has been replaced
 *     (fork, new session, switch, resume, quit) throws -- the same class
 *     `git-checkpoint.ts` already guards against, observed live in the
 *     2026-08-17 hardened-battery run. Fixed with a try/catch using the same
 *     `isStaleContextError` helper, stopping the timer on a stale hit
 *     instead of re-throwing every tick; a `session_shutdown` handler was
 *     also added alongside the existing `agent_settled` one as a second,
 *     broader stop path.
 * F4. The `tool_result` handler's write/edit branch returned unconditionally,
 *     before the backstop elapsed check below it ever ran -- a model looping
 *     on test-file-only edits (not evidence of progress, so never resets)
 *     never saw the soft-stage warning text either, since the branch bailed
 *     out first. Fixed: a trustworthy edit still returns immediately (there
 *     is nothing to warn about on the exact call that just reset the clock),
 *     but a test-file-only or failed write/edit now falls through to the
 *     shared backstop check like any other tool call.
 * F5. `resolveBashEditPaths` (then `resolveBashEditSignature`) compared the
 *     whole dirty-path set for *any* difference, which also reset on a path
 *     going clean -- a revert or `git checkout` is not progress. Fixed to
 *     require a genuinely *added* non-test path.
 * F6. The `-z` git-status parse split on `\n` as well as `\0` (defeating the
 *     point of `-z` for a path containing a newline) and sliced every
 *     NUL-delimited field by a fixed offset -- but a rename/copy entry's
 *     second field (the original path) carries no `XY ` status prefix of
 *     its own, so it was mis-sliced into a 1-character garbage path. Fixed
 *     to walk entries with an index cursor and discard the paired orig-path
 *     field for rename/copy status codes instead of parsing it as a path.
 *
 * CROSS-PROMPT RESET (Codex implementation review, 2026-08-19): the reset
 * guard above distinguished retries from the first `agent_start`, but it was
 * scoped to the extension lifetime rather than one top-level prompt.
 * `agent_settled` stopped the timer without clearing that guard, so a second
 * prompt in the same interactive session inherited the prior prompt's
 * `lastSourceEditAt` and could be aborted on its first tool result. The reset
 * now runs on `before_agent_start`, Pi's top-level-prompt-only boundary; the
 * first `agent_start` remains a fallback for runtimes/tests that omit that
 * event, and retry/compaction `agent_start` events still preserve evidence.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isStaleContextError } from "./lib/stale-context.ts";
import { explainVerificationMasking, type MaskReason } from "./lib/verification.ts";

// Deliberately broader than lib/verification.ts's BROAD_VERIFICATION_PATTERNS
// requires a whole-suite invocation (`go test ... ./...`) because it exists
// to gate settlement evidence. This module exists to catch iteration, so it
// also matches narrowed runs (`go test -run TestFoo`) that
// BROAD_VERIFICATION_PATTERNS deliberately excludes -- the observed stall
// used exactly such a narrowed run. The `make (?:verify|test|check)` entry
// mirrors BROAD_VERIFICATION_PATTERNS's coverage of that indirection.
const TEST_EXECUTION_PATTERNS = [
	/\bmake (?:verify|test|check)\b/i,
	/\bgo test\b/i,
	/\bnpm (?:run )?test\b/i,
	/\b(?:pnpm|yarn) test\b/i,
	/\bpytest\b/i,
	/\bflutter test\b/i,
	/\bdart test\b/i,
	/\bcargo test\b/i,
];

// Scratch-file loops are still diagnostic execution even when the command
// never invokes a test runner. Keep this deliberately narrow: the guard
// should not treat arbitrary shell failures as evidence of repeated work on
// the same bug. The observed live shape was a heredoc into /tmp followed by
// repeated `go run` calls against that scratch file.
const SCRATCH_EXECUTION_PATTERNS = [
	/\b(?:cat|tee)\s+>\s*\/?(?:tmp|var\/tmp)\//i,
	/\b(?:go|node|python(?:3)?|dart)\s+run\s+\/?(?:tmp|var\/tmp)\//i,
];

// Conservative on purpose: matching "contains test" as a substring
// misclassifies real production files (testutil/helpers.go,
// internal/testing/harness.go, contest.go) as test files, which would make
// genuine fixing edits invisible to the sourcelessRounds counter -- a direct
// false-positive generator identified during design review.
const TEST_FILE_PATTERNS = [
	/(^|\/)tests?\//i,
	/_test\.go$/i,
	/\.(test|spec)\.[jt]sx?$/i,
	/(^|\/)test_[^/]+\.py$/i,
	/_test\.py$/i,
	/_spec\.rb$/i,
];

const STALL_ROUNDS_THRESHOLD = 3;
const SAME_FAILURE_THRESHOLD = 2;

// See file header, "CYCLE DETECTION": a trailing window over the same
// per-attempt fingerprints failureCategory() already computes, checked for
// genuine alternation (each distinct value repeats) instead of consecutive
// repetition. 6 gives a 2-state alternation (A,B,A,B,A,B) two full rounds
// to fill the window before firing. 2 distinct values is deliberately the
// only case covered -- 3+-state rotations are a known, undetected gap (see
// file header); a 3+-distinct window with every value repeating still does
// not fire, since CYCLE_DISTINCT_THRESHOLD caps it at 2.
const CYCLE_WINDOW = 6;
const CYCLE_DISTINCT_THRESHOLD = 2;

// Action thresholds are deliberately much higher than the trace threshold
// above: 2 consecutive same-category results is enough to be worth recording,
// but not enough to be confident this is a genuine stall rather than a
// legitimate short bisection streak (see the file-level "known false-positive
// case" note). Firing content into the model's own tool result is a bigger
// intervention than a trace entry, so it waits for much stronger evidence.
// Two thresholds, not a `>=` on one, so it fires exactly twice total and then
// goes silent rather than re-flagging every single call past the first hit.
const ACTION_SAME_FAILURE_THRESHOLDS = [8, 25];

const DEFAULT_BACKSTOP_MINUTES = 10;
const MINUTE_MS = 60_000;

export interface StallBackstopThresholds {
	softMs: number;
	hardMs: number;
}

export function resolveBackstopThresholds(env: NodeJS.ProcessEnv = process.env): StallBackstopThresholds {
	const raw = Number(env.PI_STALL_GUARD_BACKSTOP_MINUTES ?? DEFAULT_BACKSTOP_MINUTES);
	const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BACKSTOP_MINUTES;
	return { softMs: minutes * MINUTE_MS, hardMs: minutes * MINUTE_MS * 2 };
}

function backstopMessage(kind: "soft" | "hard", elapsedMs: number): string {
	const minutes = Math.max(1, Math.round(elapsedMs / MINUTE_MS));
	if (kind === "hard") {
		return `\n\n[pi-harness] No non-test source edit has occurred for about ${minutes} minutes. The run is being stopped as a confirmed stall.`;
	}
	return `\n\n[pi-harness] No non-test source edit has occurred for about ${minutes} minutes. This is a stall warning; change what you're doing or stop and report honestly what you have so far.`;
}

/**
 * True once `window` is full, holds between 2 and `CYCLE_DISTINCT_THRESHOLD`
 * distinct values, AND every one of those distinct values repeats at least
 * twice in the window -- genuine alternation, not "mostly the same value
 * plus one outlier."
 *
 * That last requirement is load-bearing, not decorative: an earlier version
 * checked only distinct-value count (2 to CYCLE_DISTINCT_THRESHOLD), which
 * an Opus design review caught firing on `["a","a","a","a","a","b"]` --
 * five identical results plus one novel one -- while `["a","a","a","a",
 * "a","a"]` (six identical, strictly stronger evidence of a stall) didn't
 * fire at all, since that shape is `sameFailure`'s job and needs 9
 * consecutive matches to intercept. A single novel result mixed into an
 * otherwise-uniform window must not fire *more* readily than the uniform
 * window itself. Requiring every distinct value to repeat rejects that
 * shape while still accepting true alternation (`a,b,a,b,a,b`) and
 * same-window rotation-like mixes (`a,a,b,b,a,b`).
 *
 * Deliberately excludes a single repeated value (distinct === 1): that
 * shape is pure consecutive repetition, already `sameFailure`'s job and
 * reported with its own escalating thresholds -- this detector would only
 * preempt it with a flatter, less informative signal. A full window with
 * more distinct values than the threshold reads as varied exploration, not
 * a closed loop, and also does not count -- including a genuine 3-state
 * rotation (`a,b,c,a,b,c`), a known gap; see the file header.
 */
export function detectsCycle(window: readonly string[]): boolean {
	if (window.length < CYCLE_WINDOW) return false;
	const counts = new Map<string, number>();
	for (const value of window) counts.set(value, (counts.get(value) ?? 0) + 1);
	if (counts.size < 2 || counts.size > CYCLE_DISTINCT_THRESHOLD) return false;
	return Math.min(...counts.values()) >= 2;
}

function isTestFile(path: string): boolean {
	return TEST_FILE_PATTERNS.some((re) => re.test(path));
}

function matchesTestExecution(command: string): boolean {
	return TEST_EXECUTION_PATTERNS.some((re) => re.test(command));
}

function matchesDiagnosticExecution(command: string): boolean {
	return matchesTestExecution(command) || SCRATCH_EXECUTION_PATTERNS.some((re) => re.test(command));
}

/** Opt-in, off by default -- see the file header's ACTION section. */
export function resolveInterceptEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.PI_STALL_GUARD_INTERCEPT;
	return raw === "1" || raw === "true";
}

/**
 * Last ~20 non-empty output lines, with timings/line-numbers/addresses/temp
 * paths normalized out, folded into a short hash. Not cryptographic --
 * collision resistance doesn't matter here, only "did this failure move."
 */
export function fingerprintFailure(text: string): string {
	const lines = text
		.split("\n")
		.map((line) =>
			line
				.replace(/\d+(\.\d+)?(ms|s|ns)\b/gi, "<dur>")
				.replace(/:\d+:/g, ":<line>:")
				.replace(/0x[0-9a-f]+/gi, "<addr>")
				.replace(/goroutine \d+/gi, "goroutine <n>")
				.replace(/\/(tmp|var)\/\S+/g, "<tmppath>")
				.trim(),
		)
		.filter((line) => line.length > 0);
	const tail = lines.slice(-20).join("\n");
	let hash = 0;
	for (let i = 0; i < tail.length; i += 1) {
		hash = (hash * 31 + tail.charCodeAt(i)) | 0;
	}
	return `${tail.length}:${hash}`;
}

// Deliberately keyed on failure category alone, not command shape -- see the
// file header, "Two more bugs found live 2026-08-19," item 3. Category is
// already invariant to the kind of surface variation (heredoc bodies, grep
// flags, search terms) a model tries while stuck on one underlying problem;
// adding shape back on top only reintroduces the false-negative that item 3
// found.
// Names the actual mechanism `explainVerificationMasking` detected with
// certainty, for the intercept text -- not a guess at what the model should
// do differently (the file header's "never a suggested fix" invariant),
// just the concrete reason a clean-looking result isn't trustworthy
// evidence. Undefined reason (a genuine, unmasked failure) contributes no
// text.
function maskReasonNote(reason: MaskReason | undefined): string {
	switch (reason) {
		case "negated":
			return " The command's exit code is inverted by a leading `!`, so a real failure reports as success.";
		case "or-fallback":
			return " A `||` fallback in the same line is swallowing the real exit code.";
		case "unguarded-pipe":
			return " The exit code being reported is the pipe's last command's, not the test command's.";
		case "trailing-command":
			return " A later command on the same line overrides the test command's own exit code.";
		case "backgrounded":
			return " The command is backgrounded, so its exit code is never observed.";
		default:
			return "";
	}
}

function failureCategory(text: string): string {
	const normalized = text.replace(/\r/g, "");
	const goTest = normalized.match(/--- FAIL:\s*([^\s(]+)/);
	if (goTest) return `go-test:${goTest[1]}`;
	const panic = normalized.match(/\bpanic:\s*([^\s:]+)/i);
	if (panic) return `panic:${panic[1].toLowerCase()}`;
	const error = normalized.match(/\b(error|fatal error|exception)\s*:?\s*([^\s:]+)/i);
	if (error) return `${error[1].trim().toLowerCase()}:${error[2].toLowerCase()}`;
	return `output:${fingerprintFailure(text)}`;
}

// How often the independent wall-clock timer below re-checks elapsed time
// and bash-driven source changes. Deliberately much finer-grained than the
// backstop thresholds themselves (minutes) so the timer's own polling
// interval never meaningfully inflates the elapsed time reported at either
// threshold.
const TIMER_INTERVAL_MS = 15_000;

export default function (pi: ExtensionAPI) {
	let sourcelessRounds = 0;
	let sameFailure = 0;
	let lastFailureCategory: string | undefined;
	let recentCategories: string[] = [];
	let cycleIntercepted = false;
	let sawTestThisTurn = false;
	let intercepts = 0;
	let lastSourceEditAt = Date.now();
	let backstopSoftFired = false;
	let backstopHardFired = false;
	// git-status snapshot of non-test-file dirty paths as of the last timer
	// tick -- see resolveBashEditPaths below. `undefined` until the first
	// tick establishes a baseline, so that baseline itself never counts as
	// an edit.
	let lastBashEditPaths: Set<string> | undefined;

	const interceptEnabled = resolveInterceptEnabled();
	const backstopThresholds = resolveBackstopThresholds();

	// Reset only the failure-fingerprint fields -- factored out so the
	// (agent_start | write/edit | bash-detected-edit | input) call sites
	// can't drift out of sync on what "a stale fingerprint" clears.
	// Deliberately does NOT touch `sourcelessRounds`, `lastSourceEditAt`, or
	// either `backstop*Fired` flag: those are wall-clock progress evidence,
	// not failure-fingerprint state, and belong exclusively to
	// resetStallState() below. They used to live here too, which is exactly
	// what let a routine extension-injected `input` (see the `pi.on("input")`
	// handler) silently defer the hard abort forever -- "F2" from an Opus
	// review, 2026-08-20 (`resolveInterceptEnabled`-adjacent review of the
	// Bug-5 fix): `input` fires on every zero-tool-call turn via
	// `continuation-nudge.ts`, every corrective round via `goal-gate.ts`, and
	// several other extensions' own `sendUserMessage` calls, none of which
	// are evidence of a source edit. Keeping the wall-clock fields out of
	// this function is what makes that true regardless of which extension
	// fires next.
	function resetFailureState() {
		sameFailure = 0;
		lastFailureCategory = undefined;
		recentCategories = [];
		cycleIntercepted = false;
	}

	// Full reset -- for the reset points that really are evidence of
	// progress (a trustworthy write/edit, a bash-detected edit, the true
	// first agent_start): the failure fingerprint, sourcelessRounds, AND the
	// wall-clock backstop clock together.
	function resetStallState() {
		sourcelessRounds = 0;
		resetFailureState();
		lastSourceEditAt = Date.now();
		backstopSoftFired = false;
		backstopHardFired = false;
	}

	// Live context captured from whichever event handler last ran, reused by
	// the independent timer below. `ExtensionContext`'s `abort()`/`isIdle()`
	// read current session state at call time, not at capture time (see
	// `runner.d.ts`: "Create an ExtensionContext for use in event handlers" --
	// one long-lived object, not a per-event snapshot), so holding onto a
	// stale-looking reference across ticks is safe.
	let liveCtx: import("@earendil-works/pi-coding-agent").ExtensionContext | undefined;
	let liveCwd: string | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	// Reviewer-flagged gap (Codex, PR #20): checking elapsed time only inside
	// the `tool_result` handler below cannot enforce a genuine hard deadline,
	// because a hang with no tool call at all -- or a single bash invocation
	// that itself never returns -- produces no `tool_result` event for that
	// handler to run on. This timer is the independent backstop: it re-checks
	// elapsed time on a fixed wall-clock cadence regardless of whether any
	// tool event fires, and can call `ctx.abort()` on its own. It only aborts
	// while the agent is actually mid-run (`!isIdle()`) -- an idle session
	// waiting on the next user turn is not a stall.
	//
	// Also folds in bash-driven source-edit detection (Codex, same PR): the
	// `tool_result` handler only resets on `write`/`edit` tool calls, so a
	// model editing source through `bash` (`sed -i`, `tee`, a codegen script)
	// never resets the sourceless clock there. Rather than pattern-match bash
	// commands (fragile -- redirects into scratch paths, `2>&1` decoys, a
	// dozen editor CLIs), each tick asks git directly what actually changed:
	// the set of non-test-file paths `git status` reports. A path *newly*
	// appearing in that set is real, tool-agnostic evidence of progress.
	// Only a newly-*added* path counts ("F5", Opus review 2026-08-20; the
	// original version compared the whole set for any difference at all,
	// which also reset on a path going clean -- a revert or `git checkout`
	// is not progress and shouldn't read as some). Two accepted, narrower
	// gaps remain, both cheaper to accept than to close: this catches a path
	// going dirty, not further edits to a path already dirty from a prior
	// tick; and `--untracked-files=all` means a genuinely new scratch file
	// created inside the repo (not just under `/tmp`) still counts as
	// progress -- closing that would mean either losing detection of a
	// model's own newly-created *source* file, or pattern-matching filenames
	// to guess scratch-vs-source, the exact fragility this git-based
	// approach exists to avoid. Neither gap is a claim of catching every
	// subsequent bash edit.
	async function resolveBashEditPaths(cwd: string): Promise<Set<string> | undefined> {
		const result = await pi
			.exec(
				"git",
				[
					"status",
					"--porcelain=v1",
					"-z",
					"--untracked-files=all",
					"--",
					".",
					":(exclude)node_modules",
					":(exclude)build",
					":(exclude)dist",
					":(exclude).dart_tool",
				],
				{ cwd, timeout: 5_000 },
			)
			.catch(() => undefined);
		if (!result || result.code !== 0) return undefined;
		// `-z` NUL-terminates every field, including the *second* field a
		// rename/copy entry carries (the original path, with no "XY " status
		// prefix of its own) -- splitting on `\n` too (the pre-fix code did)
		// defeats the whole point of `-z` for a path containing a newline, and
		// naively slicing every NUL-delimited field by 3 mis-parses that
		// second field as a 1-character garbage path ("F6", Opus review
		// 2026-08-20). Walk the NUL-split entries with an index cursor instead:
		// consume the extra field when the status code says rename/copy,
		// rather than treating it as its own path.
		const fields = result.stdout.split("\0").filter(Boolean);
		const paths = new Set<string>();
		for (let i = 0; i < fields.length; i++) {
			const entry = fields[i];
			const status = entry.slice(0, 2);
			const path = entry.slice(3);
			if (path.length > 0 && !isTestFile(path)) paths.add(path);
			if (status.includes("R") || status.includes("C")) i++; // discard the paired orig-path field
		}
		return paths;
	}

	function stopTimer() {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	function startTimer() {
		// A genuine no-op if a timer is already running -- NOT stop-then-
		// recreate. "F1" from an Opus review, 2026-08-20: the file header's
		// claim that stop-then-recreate is "idempotent by construction" was
		// wrong -- it's idempotent in *outcome* (a timer ends up running
		// either way) but not in *cadence*: each call restarts the 15s phase
		// from zero. `agent_start` firing more often than TIMER_INTERVAL_MS
		// (documented elsewhere in this file as happening with 16 retries
		// under real proxy contention) can starve the tick from ever
		// executing at all, silently defeating the hard backstop exactly the
		// way Bug 5 did, via a different mechanism. Guarding on `timer`
		// already being set makes every subsequent agent_start's startTimer()
		// call a true no-op, so the interval's own cadence is owned by the
		// session's actual lifetime, not by how often agent_start fires.
		if (timer) return;
		// Re-entrancy guard ("F7", Opus review 2026-08-20): setInterval does not
		// await its callback, and resolveBashEditPaths awaits a bounded but
		// non-instant `git exec` (up to its own 5s timeout). Without this guard,
		// a slow tick (a large repo, or `.git/index.lock` contention from
		// git-checkpoint.ts's own per-turn_start git calls) could still be
		// mid-flight when the next 15s tick fires, letting two ticks race on
		// `lastBashEditPaths`'s undefined-baseline check. Low-impact even
		// unguarded (the exec timeout bounds the overlap, and losing a race
		// only delays the elapsed check slightly), but a one-line fix removes
		// the question entirely.
		let ticking = false;
		timer = setInterval(() => {
			if (ticking) return;
			ticking = true;
			void (async () => {
				try {
					if (!liveCtx || !liveCwd) return;
					if (liveCtx.isIdle()) return; // no run in progress -- nothing to time out

					const paths = await resolveBashEditPaths(liveCwd);
					if (paths !== undefined) {
						if (lastBashEditPaths === undefined) {
							lastBashEditPaths = paths;
						} else {
							// Only a newly-added path counts as progress ("F5" -- see
							// resolveBashEditPaths's own comment); a path going clean
							// (present in lastBashEditPaths but not in paths) does not.
							let added = false;
							for (const path of paths) {
								if (!lastBashEditPaths.has(path)) {
									added = true;
									break;
								}
							}
							lastBashEditPaths = paths;
							if (added) {
								resetStallState();
								return;
							}
						}
					}

					const elapsedMs = Date.now() - lastSourceEditAt;
					if (!backstopHardFired && elapsedMs >= backstopThresholds.hardMs) {
						backstopHardFired = true;
						pi.appendEntry("pi-stall-trace", {
							sourcelessRounds,
							sameFailure,
							stalled: true,
							stallTimeout: true,
							outcome: "stall-timeout",
							stallElapsedMs: elapsedMs,
							source: "wall-clock-timer",
						});
						liveCtx?.abort();
					}
				} catch (error) {
					// "F3", Opus review 2026-08-20: this callback runs inside a bare
					// `void (async () => ...)()`, not inside a pi handler emit, so an
					// uncaught throw here is a raw unhandled promise rejection, not
					// something runner.emitError sees -- Node's default for that is
					// process termination. The captured `ctx`/`cwd` above are safe to
					// read for staleness of *values*, per the file-level note where
					// they're declared, but calling `ctx.isIdle()`/`ctx.abort()` on a
					// `ctx` whose session has since been replaced (fork, new session,
					// switch, resume, quit) throws -- see isStaleContextError's own
					// doc comment, and git-checkpoint.ts's identical handling of the
					// same class of error, observed live in the 2026-08-17
					// hardened-battery run. Nothing productive is left to do once
					// that's happened: a fresh extension instance is already
					// registered for the replacement session, so just stop this
					// timer rather than let it keep re-throwing every tick.
					if (isStaleContextError(error)) {
						stopTimer();
						return;
					}
					throw error;
				} finally {
					ticking = false;
				}
			})();
		}, TIMER_INTERVAL_MS);
		timer.unref?.();
	}

	let topLevelRunInitialized = false;
	function resetTopLevelRun() {
		resetStallState();
		lastBashEditPaths = undefined;
		sawTestThisTurn = false;
		intercepts = 0;
		topLevelRunInitialized = true;
	}

	// `before_agent_start` is the genuine top-level prompt boundary. Unlike
	// `agent_start`, it does not fire for retries, compaction, or queued
	// continuations (the reviewer extension relies on the same distinction).
	// Reset the whole stall episode here so a second prompt in a long-lived
	// interactive session cannot inherit the previous prompt's wall clock.
	pi.on("before_agent_start", () => {
		resetTopLevelRun();
	});

	pi.on("agent_start", (_event, ctx) => {
		liveCtx = ctx;
		liveCwd = ctx.cwd;
		// startTimer() always runs, independent of the state-reset gating below --
		// see "Bug 5" in the file header. agent_end fires per internal agent
		// loop (retry, auto-compaction, queued continuation), not once per
		// invocation, so it can stop the timer well before the run is actually
		// over; the timer must restart on every subsequent agent_start or it
		// stays dead for the rest of the session. A true no-op when a timer is
		// already running (see "F1" in the file header) -- it does NOT
		// stop-then-recreate, which would restart the 15s cadence from zero on
		// every call and could starve the tick entirely under frequent retries.
		startTimer();
		// Only the top-level prompt boundary resets state -- a retry restart must
		// not wipe real evidence of repeated inaction. See file
		// header, "Two bugs found live 2026-08-16," item 2. lastBashEditPaths
		// belongs to this same gated reset, not to startTimer() (Opus review of
		// the Bug 5 fix, 2026-08-19): it's stall-tracking state exactly like the
		// rest of this block, so resetting it on every retry would open a blind
		// window each time -- a bash-driven edit landing between a retry and the
		// timer's next tick gets silently absorbed into the new baseline instead
		// of counting as progress.
		// Fallback for runtimes/tests that enter through agent_start without a
		// preceding before_agent_start. Once initialized, later agent_start
		// events are internal continuations and must preserve stall evidence.
		if (topLevelRunInitialized) return;
		resetTopLevelRun();
	});

	// agent_settled, not agent_end (Opus review of the Bug 5 fix, 2026-08-19):
	// agent_end fires per internal agent loop, so stopping here left a second,
	// narrower version of the same coverage gap -- a hang between agent_end and
	// the next agent_start (an auto-compaction call, a retry backoff) had no
	// timer running, and if that call itself never returns, no further
	// agent_start ever fires to restart it. agent_settled fires exactly once,
	// only after the whole run has genuinely finished with no queued
	// continuation -- confirmed against pi's own agent-session.js, where
	// isIdle() stays false for the run's entire duration until the same
	// _emitAgentSettled call. The tick's own `liveCtx.isIdle()` guard already
	// prevents timing out a truly idle session, so stopping any earlier than
	// this trades real coverage for no safety benefit.
	pi.on("agent_settled", () => {
		stopTimer();
	});

	// Belt-and-suspenders alongside agent_settled above ("F3", Opus review
	// 2026-08-20): session_shutdown fires "before an extension runtime is
	// torn down due to quit, reload, or session replacement" -- broader than
	// agent_settled (which only covers a run finishing normally) and the
	// specific hook this repo's own convention treats as authoritative for
	// this class of cleanup. Idempotent -- stopTimer() is always safe to call
	// when nothing is running.
	pi.on("session_shutdown", () => {
		stopTimer();
	});

	// A new ask (steering message, injected message from another extension)
	// resets the failure
	// scope, mirroring continuation-nudge.ts -- a stale fingerprint from a
	// prior ask must not count toward this one.
	pi.on("input", () => {
		resetFailureState();
	});

	pi.on("tool_result", (event, ctx) => {
		liveCtx = ctx;
		liveCwd = ctx.cwd;
		if (event.toolName === "write" || event.toolName === "edit") {
			const path = (event.input as { path?: string }).path;
			if (path && !event.isError && !isTestFile(path)) {
				// Trustworthy progress -- return here, before the backstop check
				// below, is correct: resetStallState() just moved lastSourceEditAt
				// to now, so there is nothing to warn about on this exact call.
				resetStallState();
				return undefined;
			}
			// Falls through to the shared backstop check below rather than
			// returning here ("F4", Opus review 2026-08-20): a test-file-only or
			// failed write/edit is not evidence of progress, and used to return
			// unconditionally at this point, silently skipping the soft-stage
			// check the same way the file's own header describes for
			// SCRATCH_EXECUTION_PATTERNS-gated checks -- a model looping on
			// edits to test files only would never see the soft warning text
			// (the hard ceiling still fired via the independent timer, so this
			// was a lost recovery attempt, not a lost ceiling).
		}

		const elapsedMs = Date.now() - lastSourceEditAt;
		if (!backstopHardFired && elapsedMs >= backstopThresholds.hardMs) {
			backstopHardFired = true;
			pi.appendEntry("pi-stall-trace", {
				sourcelessRounds,
				sameFailure,
				stalled: true,
				stallTimeout: true,
				outcome: "stall-timeout",
				stallElapsedMs: elapsedMs,
			});
			ctx.abort();
			return {
				content: [...event.content, { type: "text" as const, text: backstopMessage("hard", elapsedMs) }],
			};
		}
		if (!backstopSoftFired && elapsedMs >= backstopThresholds.softMs) {
			backstopSoftFired = true;
			pi.appendEntry("pi-stall-trace", {
				sourcelessRounds,
				sameFailure,
				stalled: true,
				stallBackstop: true,
				stallElapsedMs: elapsedMs,
			});
			return {
				content: [...event.content, { type: "text" as const, text: backstopMessage("soft", elapsedMs) }],
			};
		}

		if (event.toolName !== "bash") return undefined;
		const command = event.input?.command;
		if (typeof command !== "string" || !matchesDiagnosticExecution(command)) return undefined;

		sawTestThisTurn = true;

		// A trustworthy success -- exit 0, and not run through a pipeline that
		// could be hiding the real exit code -- is the one case that's actually
		// evidence of progress. See file header, "Two more bugs found live
		// 2026-08-19," item 4: a maskable exit-0 (e.g. `dart test | head`) is
		// NOT trustworthy and falls through to be fingerprinted like a failure
		// instead of silently resetting the streak.
		// Computed once per call and reused below for both the reset check and
		// the intercept text -- only relevant when isError is false (an isError
		// result already reflects a real nonzero exit, nothing to explain). Note
		// this describes only the CURRENT call, not the whole window: if a cycle
		// intercept fires on a window mixing masked-pipe and genuine-failure
		// calls, the reason note (if any) reflects whichever call tripped the
		// intercept, not the other half of the window. Never wrong (it's an
		// honest description of the triggering call), just not exhaustive over
		// the window -- not worth threading a reason per window entry for.
		const masking = event.isError ? { masks: false as const } : explainVerificationMasking(command, TEST_EXECUTION_PATTERNS);
		if (!event.isError && !masking.masks) {
			sameFailure = 0;
			lastFailureCategory = undefined;
			recentCategories = [];
			cycleIntercepted = false;
			return undefined;
		}

		const text = event.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		const category = failureCategory(text);
		sameFailure = category === lastFailureCategory ? sameFailure + 1 : 0;
		lastFailureCategory = category;

		// See file header, "CYCLE DETECTION": tracked alongside, not instead of,
		// sameFailure -- alternation between a small closed set of attempts
		// never sustains a consecutive-match streak, but does fill this window
		// with few distinct values.
		recentCategories.push(category);
		if (recentCategories.length > CYCLE_WINDOW) recentCategories.shift();
		const cycling = detectsCycle(recentCategories);

		if (
			interceptEnabled &&
			intercepts < ACTION_SAME_FAILURE_THRESHOLDS.length &&
			sameFailure === ACTION_SAME_FAILURE_THRESHOLDS[intercepts]
		) {
			intercepts += 1;
			pi.appendEntry("pi-stall-trace", {
				sourcelessRounds,
				sameFailure,
				stalled: true,
				intercepted: true,
				...(masking.reason ? { maskReason: masking.reason } : {}),
			});
			return {
				content: [
					...event.content,
					{
						type: "text" as const,
						text:
							// sameFailure starts at 0 on the first occurrence of a category
							// (line above: `category === lastFailureCategory ? sameFailure + 1
							// : 0`), so a streak of sameFailure===N is actually N+1
							// occurrences -- "F8", Opus review 2026-08-20. Report the true
							// count to the model, not the zero-based counter.
							`\n\n[pi-harness] This command has now produced the same result ${sameFailure + 1} times ` +
							"in this session with no source edit in between." +
							maskReasonNote(masking.reason) +
							" Earlier repeats may no longer be " +
							"visible in your context if it's been compacted. This is not new information -- " +
							"change what you're doing, or stop and report honestly what you have so far.",
					},
				],
			};
		}

		// Independent of the consecutive-streak action above: fires at most once
		// per stall EPISODE (cycleIntercepted resets at the same four points as
		// sameFailure -- source edit, trustworthy success, new input, true
		// agent start), not once per session the way `intercepts` above is --
		// a low-cardinality window doesn't sharpen with more repeats the way a
		// growing consecutive count does, so there's no equivalent of the 8/25
		// two-stage escalation, but two separate stall episodes can each still
		// warrant their own single warning.
		if (interceptEnabled && !cycleIntercepted && cycling) {
			cycleIntercepted = true;
			pi.appendEntry("pi-stall-trace", {
				sourcelessRounds,
				sameFailure,
				stalled: true,
				cycleDetected: true,
				intercepted: true,
				...(masking.reason ? { maskReason: masking.reason } : {}),
			});
			return {
				content: [
					...event.content,
					{
						type: "text" as const,
						text:
							`\n\n[pi-harness] The last ${recentCategories.length} diagnostic commands in this session ` +
							"have alternated between only a couple of distinct results, with no source edit in " +
							"between." +
							maskReasonNote(masking.reason) +
							" Earlier repeats may no longer be visible in your context if it's been " +
							"compacted. This is not new information -- change what you're doing, or stop and " +
							"report honestly what you have so far.",
					},
				],
			};
		}
		return undefined;
	});

	pi.on("turn_end", (event) => {
		if (event.toolResults.length === 0) return; // continuation-nudge.ts's territory, not this one's
		if (!sawTestThisTurn) return;
		sawTestThisTurn = false;
		sourcelessRounds += 1;

		const cycling = detectsCycle(recentCategories);
		const stalled =
			sourcelessRounds >= STALL_ROUNDS_THRESHOLD && (sameFailure >= SAME_FAILURE_THRESHOLD || cycling);
		pi.appendEntry(
			"pi-stall-trace",
			cycling ? { sourcelessRounds, sameFailure, stalled, cycleDetected: true } : { sourcelessRounds, sameFailure, stalled },
		);
	});
}
