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
 *       STALL_ROUNDS_THRESHOLD consecutive turns that ran a test command, AND
 *   (b) the test command's failure output fingerprint hasn't changed across
 *       SAME_FAILURE_THRESHOLD consecutive failing runs.
 * Neither alone is safe: (a) alone flags legitimate read-only exploration;
 * (b) alone flags a flaky test genuinely being re-run to check reproducibility.
 * Together they describe "diagnosed and reproduced, but never acted on."
 *
 * Known false-positive case, accepted deliberately: a model correctly
 * bisecting an unfamiliar bug via a sequence of small probe tests, without
 * touching source until it has localized the fault, produces a
 * tool-call trace this heuristic cannot distinguish from the stall above --
 * that distinction lives in the model's reasoning, not the tool stream. The
 * cost asymmetry justifies firing anyway: a false positive costs one
 * ignorable nudge; a false negative costs a killed multi-minute run, as it
 * did here.
 *
 * Ships in TRACE-ONLY mode: every fire is recorded via `appendEntry`
 * regardless of `PI_STALL_GUARD_NUDGE`, so the false-positive rate can be
 * measured against real sessions before the nudge itself is trusted to run
 * live. Set `PI_STALL_GUARD_NUDGE=1` to actually send the nudge message.
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
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
const MAX_NUDGES_PER_RUN = 2;

function isTestFile(path: string): boolean {
	return TEST_FILE_PATTERNS.some((re) => re.test(path));
}

function matchesTestExecution(command: string): boolean {
	return TEST_EXECUTION_PATTERNS.some((re) => re.test(command));
}

function matchesDiagnosticExecution(command: string): boolean {
	return matchesTestExecution(command) || SCRATCH_EXECUTION_PATTERNS.some((re) => re.test(command));
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

export default function (pi: ExtensionAPI) {
	// Read per-registration, not at module load, so a caller (or a test) that
	// sets this env var right before starting a session is honored -- same
	// reasoning as wall-clock-budget-nudge.ts.
	const nudgeEnabled = process.env.PI_STALL_GUARD_NUDGE === "1";
	let sourcelessRounds = 0;
	let sameFailure = 0;
	let lastFingerprint: string | undefined;
	let sawTestThisTurn = false;
	let nudges = 0;

	let seenFirstAgentStart = false;
	pi.on("agent_start", () => {
		// Only the true first start of this invocation resets state -- a retry
		// restart must not wipe real evidence of repeated inaction. See file
		// header, "Two bugs found live 2026-08-16," item 2.
		if (seenFirstAgentStart) return;
		seenFirstAgentStart = true;
		sourcelessRounds = 0;
		sameFailure = 0;
		lastFingerprint = undefined;
		sawTestThisTurn = false;
		nudges = 0;
	});

	// A new ask (steering message, injected follow-up) resets the failure
	// scope, mirroring continuation-nudge.ts -- a stale fingerprint from a
	// prior ask must not count toward this one.
	pi.on("input", () => {
		sameFailure = 0;
		lastFingerprint = undefined;
	});

	pi.on("tool_result", (event) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			const path = (event.input as { path?: string }).path;
			if (path && !event.isError && !isTestFile(path)) {
				sourcelessRounds = 0;
				sameFailure = 0;
				lastFingerprint = undefined;
			}
			return undefined;
		}
		if (event.toolName !== "bash") return undefined;
		const command = event.input?.command;
		if (typeof command !== "string" || !matchesDiagnosticExecution(command)) return undefined;

		sawTestThisTurn = true;
		if (!event.isError) {
			sameFailure = 0;
			lastFingerprint = undefined;
			return undefined;
		}
		const text = event.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		const fp = fingerprintFailure(text);
		sameFailure = fp === lastFingerprint ? sameFailure + 1 : 0;
		lastFingerprint = fp;
		return undefined;
	});

	pi.on("turn_end", (event) => {
		if (event.toolResults.length === 0) return; // continuation-nudge.ts's territory, not this one's
		if (!sawTestThisTurn) return;
		sawTestThisTurn = false;
		sourcelessRounds += 1;

		const stalled = sourcelessRounds >= STALL_ROUNDS_THRESHOLD && sameFailure >= SAME_FAILURE_THRESHOLD;
		const willNudge = stalled && nudgeEnabled && nudges < MAX_NUDGES_PER_RUN;
		pi.appendEntry("pi-stall-trace", { sourcelessRounds, sameFailure, stalled, nudged: willNudge });
		if (!willNudge) return;

		nudges += 1;
		pi.sendUserMessage(
			`You have run this test ${sameFailure + 1} times in a row with the same failure and have not edited any non-test source file in that span. The bug is in the implementation, not the test. Edit the source file the test is about, or state explicitly why the test itself is wrong.`,
			{ deliverAs: "followUp" },
		);
	});
}
