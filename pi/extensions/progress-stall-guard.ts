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
 * Ships in TRACE-ONLY mode: every fire is recorded via `appendEntry`. In-band
 * nudging was removed because `deliverAs: "followUp"` cannot interrupt a
 * model that keeps calling tools; this follows the established
 * cross-model-review.ts and quality-gate.ts precedent.
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
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

export default function (pi: ExtensionAPI) {
	let sourcelessRounds = 0;
	let sameFailure = 0;
	let lastFailureCategory: string | undefined;
	let recentCategories: string[] = [];
	let cycleIntercepted = false;
	let sawTestThisTurn = false;
	let intercepts = 0;

	const interceptEnabled = resolveInterceptEnabled();

	let seenFirstAgentStart = false;
	pi.on("agent_start", () => {
		// Only the true first start of this invocation resets state -- a retry
		// restart must not wipe real evidence of repeated inaction. See file
		// header, "Two bugs found live 2026-08-16," item 2.
		if (seenFirstAgentStart) return;
		seenFirstAgentStart = true;
		sourcelessRounds = 0;
		sameFailure = 0;
		lastFailureCategory = undefined;
		recentCategories = [];
		cycleIntercepted = false;
		sawTestThisTurn = false;
		intercepts = 0;
	});

	// A new ask (steering message, injected message from another extension)
	// resets the failure
	// scope, mirroring continuation-nudge.ts -- a stale fingerprint from a
	// prior ask must not count toward this one.
	pi.on("input", () => {
		sameFailure = 0;
		lastFailureCategory = undefined;
		recentCategories = [];
		cycleIntercepted = false;
	});

	pi.on("tool_result", (event) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			const path = (event.input as { path?: string }).path;
			if (path && !event.isError && !isTestFile(path)) {
				sourcelessRounds = 0;
				sameFailure = 0;
				lastFailureCategory = undefined;
				recentCategories = [];
				cycleIntercepted = false;
			}
			return undefined;
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
							`\n\n[pi-harness] This command has now produced the same result ${sameFailure} times ` +
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
