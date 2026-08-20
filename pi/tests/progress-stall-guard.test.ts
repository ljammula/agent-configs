import assert from "node:assert/strict";
import test, { mock } from "node:test";
import progressStallGuard, {
	detectsCycle,
	fingerprintFailure,
	resolveBackstopThresholds,
	resolveInterceptEnabled,
} from "../extensions/progress-stall-guard.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

const FAILURE_TEXT = "--- FAIL: TestEvictionWithDistinctKeysAndValues (0.00s)\n    lru_test.go:95: key 10 should have been evicted\nFAIL";

function failingTestResult() {
	return {
		type: "tool_result",
		toolCallId: "1",
		toolName: "bash",
		input: { command: "go test -run TestEvictionWithDistinctKeysAndValues -v ." },
		content: [{ type: "text", text: FAILURE_TEXT }],
		isError: true,
	} as any;
}

function passingTestResult() {
	return {
		type: "tool_result",
		toolCallId: "2",
		toolName: "bash",
		input: { command: "go test ./..." },
		content: [{ type: "text", text: "ok" }],
		isError: false,
	} as any;
}

function nonEmptyTurnEnd() {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: { role: "assistant", stopReason: "toolUse", content: [] },
		toolResults: [{ role: "toolResult", toolCallId: "1", content: [], isError: true }],
	} as any;
}

test("reproduces the observed stall: same-failure test reruns with no source edit trace as stalled", async () => {
	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);

	for (let i = 0; i < 3; i += 1) {
		await harness.emit(failingTestResult());
		await harness.emit(nonEmptyTurnEnd());
	}

	assert.equal(harness.messages.length, 0, "the guard is trace-only");
	const traces = harness.entries.filter((e) => e.type === "pi-stall-trace");
	assert.equal(traces.length, 3);
	assert.deepEqual(traces.at(-1)?.data, { sourcelessRounds: 3, sameFailure: 2, stalled: true });
});

test("does not inject a nudge when the stall pattern reproduces", async () => {
	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);

	for (let i = 0; i < 3; i += 1) {
		await harness.emit(failingTestResult());
		await harness.emit(nonEmptyTurnEnd());
	}

	assert.equal(harness.messages.length, 0);
});

test("backstop thresholds default to ten minutes and a two-times hard ceiling", () => {
	assert.deepEqual(resolveBackstopThresholds({}), { softMs: 600_000, hardMs: 1_200_000 });
	assert.deepEqual(resolveBackstopThresholds({ PI_STALL_GUARD_BACKSTOP_MINUTES: "2.5" }), {
		softMs: 150_000,
		hardMs: 300_000,
	});
	assert.deepEqual(resolveBackstopThresholds({ PI_STALL_GUARD_BACKSTOP_MINUTES: "invalid" }), {
		softMs: 600_000,
		hardMs: 1_200_000,
	});
});

test("unconditional backstop warns on non-diagnostic tool activity and then aborts", async () => {
	const originalNow = Date.now;
	let now = 0;
	Date.now = () => now;
	const originalMinutes = process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
	process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = "1";
	try {
		const harness = new ExtensionHarness();
		progressStallGuard(harness.api);
		await harness.emit({ type: "agent_start" } as any);

		now = 60_000;
		const [warning] = await harness.emit({
			type: "tool_result",
			toolCallId: "ls-1",
			toolName: "bash",
			input: { command: "git ls-files" },
			content: [{ type: "text", text: "lib/lru.go" }],
			isError: false,
		} as any);
		assert.match((warning as any).content.at(-1).text, /stall warning/);
		assert.equal(harness.abortCalls, 0);

		now = 120_000;
		const [aborted] = await harness.emit({
			type: "tool_result",
			toolCallId: "ls-2",
			toolName: "ls",
			input: {},
			content: [{ type: "text", text: "lib" }],
			isError: false,
		} as any);
		assert.match((aborted as any).content.at(-1).text, /stall-timeout|run is being stopped/);
		assert.equal(harness.abortCalls, 1);
		const trace = harness.entries.at(-1)?.data as any;
		assert.equal(trace.outcome, "stall-timeout");
		assert.equal(trace.stallTimeout, true);
	} finally {
		Date.now = originalNow;
		if (originalMinutes === undefined) delete process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
		else process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = originalMinutes;
	}
});

test("a successful non-test source edit resets the wall-clock backstop", async () => {
	const originalNow = Date.now;
	let now = 0;
	Date.now = () => now;
	const originalMinutes = process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
	process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = "1";
	try {
		const harness = new ExtensionHarness();
		progressStallGuard(harness.api);
		await harness.emit({ type: "agent_start" } as any);
		now = 60_000;
		await harness.emit({
			type: "tool_result",
			toolCallId: "edit-1",
			toolName: "edit",
			input: { path: "lib/lru.go" },
			content: [],
			isError: false,
		} as any);
		now = 119_999;
		const [result] = await harness.emit({
			type: "tool_result",
			toolCallId: "ls-1",
			toolName: "ls",
			input: {},
			content: [],
			isError: false,
		} as any);
		assert.equal(result, undefined);
		assert.equal(harness.abortCalls, 0);
	} finally {
		Date.now = originalNow;
		if (originalMinutes === undefined) delete process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
		else process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = originalMinutes;
	}
});

// Regression test for a Codex PR review finding (2026-08-19, PR #20): the
// original implementation only checked elapsed time inside the
// `tool_result` handler, so a hang with no tool call at all -- or a single
// bash invocation that itself never returns -- produced no event for that
// handler to run on, and the "hard" backstop stage could never fire. This
// exercises the independent timer added to close that gap: no tool_result
// is emitted at all, only wall-clock time passing.
test("the independent timer enforces the hard deadline even when no tool_result ever fires", async () => {
	mock.timers.enable({ apis: ["setInterval", "Date"] });
	const originalMinutes = process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
	process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = "1";
	try {
		const harness = new ExtensionHarness({ idle: false });
		progressStallGuard(harness.api);
		await harness.emit({ type: "agent_start" } as any);

		await mock.timers.tick(2 * 60_000 + 15_000);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(harness.abortCalls, 1);
		const trace = harness.entries.at(-1)?.data as any;
		assert.equal(trace.outcome, "stall-timeout");
		assert.equal(trace.stallTimeout, true);
		assert.equal(trace.source, "wall-clock-timer");
	} finally {
		if (originalMinutes === undefined) delete process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
		else process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = originalMinutes;
		mock.timers.reset();
	}
});

// Regression test for the same review: an idle session (no run in progress)
// must never be aborted just because wall-clock time passed -- the timer
// only fires while the agent is actually mid-run.
test("the independent timer does not abort an idle session", async () => {
	mock.timers.enable({ apis: ["setInterval", "Date"] });
	const originalMinutes = process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
	process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = "1";
	try {
		const harness = new ExtensionHarness({ idle: true });
		progressStallGuard(harness.api);
		await harness.emit({ type: "agent_start" } as any);

		await mock.timers.tick(2 * 60_000 + 15_000);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(harness.abortCalls, 0);
	} finally {
		if (originalMinutes === undefined) delete process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
		else process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = originalMinutes;
		mock.timers.reset();
	}
});

// Regression test for a second Codex PR review finding (same PR): the
// backstop only reset on `write`/`edit` tool calls, so a model editing
// source through `bash` (`sed -i`, `tee`, a codegen script) never reset the
// sourceless clock. The independent timer now also polls `git status` each
// tick and treats a newly-dirty non-test path as evidence of progress.
test("a bash-driven edit detected via git status resets the wall-clock backstop", async () => {
	mock.timers.enable({ apis: ["setInterval", "Date"] });
	const originalMinutes = process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
	process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = "1";
	let dirty = false;
	try {
		const harness = new ExtensionHarness({
			idle: false,
			exec: (call) => {
				if (call.command === "git" && call.args[0] === "status") {
					return { code: 0, stdout: dirty ? "\0 M lib/lru.go\0" : "", stderr: "", killed: false };
				}
				return { code: 0, stdout: "", stderr: "", killed: false };
			},
		});
		progressStallGuard(harness.api);
		await harness.emit({ type: "agent_start" } as any);

		// First tick establishes the clean baseline.
		await mock.timers.tick(15_000);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// The model edits lib/lru.go via `sed -i` -- no write/edit tool call,
		// only git status changing.
		dirty = true;
		await mock.timers.tick(15_000);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// Advance well past what would have been the original hard deadline;
		// the bash-detected edit should have reset the clock.
		await mock.timers.tick(100_000);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(harness.abortCalls, 0, "the bash-detected edit should have reset the wall clock");
	} finally {
		if (originalMinutes === undefined) delete process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
		else process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = originalMinutes;
		mock.timers.reset();
	}
});

// A tracked path that never leaves git status dirty (e.g. a file the model
// keeps rewriting to the SAME modified state each tick, or noise from an
// already-dirty tree at session start) must not repeatedly reset the clock
// -- only a *newly* appearing non-test path counts. This is the accepted,
// narrower gap documented at the timer's definition: it catches a path
// newly going dirty, not further edits to a file already dirty.
test("git status noise present since the baseline tick does not repeatedly reset the backstop", async () => {
	mock.timers.enable({ apis: ["setInterval", "Date"] });
	const originalMinutes = process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
	process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = "1";
	try {
		const harness = new ExtensionHarness({
			idle: false,
			exec: (call) => {
				if (call.command === "git" && call.args[0] === "status") {
					// Already dirty from before this session started, and stays
					// exactly this dirty for the whole run.
					return { code: 0, stdout: "\0 M lib/lru.go\0", stderr: "", killed: false };
				}
				return { code: 0, stdout: "", stderr: "", killed: false };
			},
		});
		progressStallGuard(harness.api);
		await harness.emit({ type: "agent_start" } as any);

		await mock.timers.tick(2 * 60_000 + 15_000);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(harness.abortCalls, 1, "an unchanging dirty tree is not fresh evidence of progress");
	} finally {
		if (originalMinutes === undefined) delete process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
		else process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = originalMinutes;
		mock.timers.reset();
	}
});

// Regression test, live-observed 2026-08-19 (`go-flutter/bookmarks-app`,
// pair 4 -- see the file header's "Bug 5"): agent_end fires per internal
// agent loop (retry, auto-compaction, queued continuation), not once per
// invocation, so it can stop the independent timer well before the run is
// actually over. The timer must restart on every subsequent agent_start,
// not just the true first one, or a single mid-run agent_end permanently
// kills the one mechanism that can catch a tool call that never returns.
test("the independent timer restarts after an agent_end mid-run, not just on the first agent_start", async () => {
	mock.timers.enable({ apis: ["setInterval", "Date"] });
	const originalMinutes = process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
	process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = "1";
	try {
		const harness = new ExtensionHarness({ idle: false });
		progressStallGuard(harness.api);

		// First agent loop segment: starts, then ends (e.g. an internal retry
		// or auto-compaction boundary) well before any stall threshold.
		await harness.emit({ type: "agent_start" } as any);
		await mock.timers.tick(1_000);
		await harness.emit({ type: "agent_end" } as any);
		assert.equal(harness.abortCalls, 0);

		// Second segment of the SAME invocation (not seenFirstAgentStart's
		// first start) -- the timer must be running again from here.
		await harness.emit({ type: "agent_start" } as any);

		await mock.timers.tick(2 * 60_000 + 15_000);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(
			harness.abortCalls,
			1,
			"the timer must restart on the second agent_start, not stay dead after the first agent_end",
		);
		const trace = harness.entries.at(-1)?.data as any;
		assert.equal(trace.outcome, "stall-timeout");
		assert.equal(trace.source, "wall-clock-timer");
	} finally {
		if (originalMinutes === undefined) delete process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
		else process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = originalMinutes;
		mock.timers.reset();
	}
});

// Regression test for an Opus review finding on the Bug 5 fix above
// (2026-08-19): the first pass moved `lastBashEditSignature = undefined`
// into startTimer() itself, which made it silently reset on every retry
// once startTimer() became unconditional -- the same class of bug
// seenFirstAgentStart exists to prevent, just for a field that wasn't
// gated yet. Consequence: a bash-driven edit landing right after a retry
// gets folded into the "fresh" baseline instead of triggering
// resetStallState(), so lastSourceEditAt never advances to reflect it --
// the run ends up CLOSER to a spurious hard abort, not further from one.
test("a bash-driven edit that lands right after a retry still resets the wall-clock backstop", async () => {
	mock.timers.enable({ apis: ["setInterval", "Date"] });
	const originalMinutes = process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
	process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = "1";
	let dirty = false;
	try {
		const harness = new ExtensionHarness({
			idle: false,
			exec: (call) => {
				if (call.command === "git" && call.args[0] === "status") {
					return { code: 0, stdout: dirty ? "\0 M lib/lru.go\0" : "", stderr: "", killed: false };
				}
				return { code: 0, stdout: "", stderr: "", killed: false };
			},
		});
		progressStallGuard(harness.api);
		await harness.emit({ type: "agent_start" } as any);

		// First tick establishes the clean baseline before any retry.
		await mock.timers.tick(15_000);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// Internal retry boundary: agent_end, then agent_start again -- NOT
		// the true first start, so state-reset gating must leave
		// lastBashEditSignature alone here.
		await harness.emit({ type: "agent_end" } as any);
		await harness.emit({ type: "agent_start" } as any);

		// The model edits lib/lru.go via `sed -i` in the resumed run -- no
		// write/edit tool call, only git status going dirty.
		dirty = true;
		await mock.timers.tick(15_000);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// Advance past the original hard deadline; a preserved baseline
		// means this edit was detected and reset the clock.
		await mock.timers.tick(100_000);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(
			harness.abortCalls,
			0,
			"the post-retry bash-detected edit should have reset the wall clock, not been absorbed into a fresh baseline",
		);
	} finally {
		if (originalMinutes === undefined) delete process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
		else process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = originalMinutes;
		mock.timers.reset();
	}
});

// Regression test for the same Opus review: stopTimer() moved from
// agent_end to agent_settled, since agent_end fires per internal agent
// loop and left a narrower version of the same coverage gap. Exercises
// two full retry cycles (agent_start/agent_end pairs) with no
// agent_settled in between, confirming the timer keeps restarting each
// time rather than leaking duplicate intervals or double-firing.
test("the timer survives multiple agent_end/agent_start retry cycles without double-firing", async () => {
	mock.timers.enable({ apis: ["setInterval", "Date"] });
	const originalMinutes = process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
	process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = "1";
	try {
		const harness = new ExtensionHarness({ idle: false });
		progressStallGuard(harness.api);

		await harness.emit({ type: "agent_start" } as any);
		await mock.timers.tick(1_000);
		await harness.emit({ type: "agent_end" } as any);

		await harness.emit({ type: "agent_start" } as any);
		await mock.timers.tick(1_000);
		await harness.emit({ type: "agent_end" } as any);

		await harness.emit({ type: "agent_start" } as any);
		await mock.timers.tick(2 * 60_000 + 15_000);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(harness.abortCalls, 1, "exactly one abort, no leaked duplicate timers from the earlier cycles");

		// agent_settled -- the true end -- must stop the timer for good;
		// further wall-clock time must not somehow fire it again.
		await harness.emit({ type: "agent_settled" } as any);
		await mock.timers.tick(10 * 60_000);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(harness.abortCalls, 1, "agent_settled must stop the timer for good");
	} finally {
		if (originalMinutes === undefined) delete process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
		else process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = originalMinutes;
		mock.timers.reset();
	}
});

// Regression test for "F1" (Opus review of the Bug-5 fix, 2026-08-20):
// startTimer()'s old stop-then-recreate implementation restarted the 15s
// tick cadence from zero on every call, so agent_start firing more often
// than TIMER_INTERVAL_MS could starve the tick from ever executing. Fires
// agent_start every 10 simulated seconds -- well under the 15s tick
// interval -- for 5 simulated minutes against a 2-minute hard deadline; the
// old code produced zero aborts here.
test("frequent agent_start churn (faster than the tick interval) does not starve the wall-clock timer", async () => {
	mock.timers.enable({ apis: ["setInterval", "Date"] });
	const originalMinutes = process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
	process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = "1";
	try {
		const harness = new ExtensionHarness({ idle: false });
		progressStallGuard(harness.api);

		for (let elapsed = 0; elapsed < 5 * 60_000; elapsed += 10_000) {
			await harness.emit({ type: "agent_start" } as any);
			await mock.timers.tick(10_000);
		}
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(
			harness.abortCalls,
			1,
			"the hard deadline (2min) must still fire even though agent_start churns every 10s",
		);
	} finally {
		if (originalMinutes === undefined) delete process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
		else process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = originalMinutes;
		mock.timers.reset();
	}
});

// Regression test for "F2" (Opus review of the Bug-5 fix, 2026-08-20): the
// `input` handler used to call the same resetFailureState() that
// Recommendation 1 had folded the wall-clock backstop fields into, so any
// extension-injected nudge (continuation-nudge.ts on a zero-tool-call turn,
// goal-gate.ts on a corrective round, etc.) silently deferred the hard
// abort. Fires an input event every 60 simulated seconds -- more often than
// the 2-minute hard deadline -- for 10 simulated minutes; the old code
// produced zero aborts here.
test("a repeating input event (simulating a nudge from another extension) does not reset the wall-clock backstop", async () => {
	mock.timers.enable({ apis: ["setInterval", "Date"] });
	const originalMinutes = process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
	process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = "1";
	try {
		const harness = new ExtensionHarness({ idle: false });
		progressStallGuard(harness.api);
		await harness.emit({ type: "agent_start" } as any);

		for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += 60_000) {
			await harness.emit({ type: "input" } as any);
			await mock.timers.tick(60_000);
		}
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(
			harness.abortCalls,
			1,
			"a nudge-shaped input every minute must not indefinitely defer the 2-minute hard deadline",
		);
	} finally {
		if (originalMinutes === undefined) delete process.env.PI_STALL_GUARD_BACKSTOP_MINUTES;
		else process.env.PI_STALL_GUARD_BACKSTOP_MINUTES = originalMinutes;
		mock.timers.reset();
	}
});

// Regression/documentation test for the resetStallState/resetFailureState
// refactor: an "input" event (a new ask) resets the failure-fingerprint
// fields but, unlike a real source edit, does NOT reset sourcelessRounds --
// a fresh ask is not itself evidence a source edit happened. This behavior
// predates the refactor; pinned here so a future shared-reset change can't
// silently widen it.
test("an input event resets the failure fingerprint but not sourcelessRounds", async () => {
	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);

	await harness.emit(failingTestResult());
	await harness.emit(nonEmptyTurnEnd());
	await harness.emit(failingTestResult());
	await harness.emit(nonEmptyTurnEnd());

	await harness.emit({ type: "input" } as any);

	await harness.emit(failingTestResult());
	await harness.emit(nonEmptyTurnEnd());

	// sourcelessRounds carried through the input event (3, not reset to 1);
	// sameFailure did reset (this is the first failure since the input, so
	// no repeat yet).
	const trace = harness.entries.at(-1)?.data as any;
	assert.equal(trace.sourcelessRounds, 3);
	assert.equal(trace.sameFailure, 0);
});

test("an edit to a non-test source file resets the stall counters", async () => {
	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);

	await harness.emit(failingTestResult());
	await harness.emit(nonEmptyTurnEnd());
	await harness.emit(failingTestResult());
	await harness.emit(nonEmptyTurnEnd());

	// The model actually edits the source file this round -- real progress.
	await harness.emit({
		type: "tool_result",
		toolCallId: "3",
		toolName: "edit",
		input: { path: "lru.go" },
		content: [],
		isError: false,
	} as any);
	await harness.emit(failingTestResult());
	await harness.emit(nonEmptyTurnEnd());

	assert.equal(harness.messages.length, 0, "the counter should have reset on the edit, not reached the threshold yet");
});

test("an edit to a test file does not reset the stall counters", async () => {
	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);

	for (let i = 0; i < 3; i += 1) {
		// Rewriting the scratch test itself each round -- this is exactly the
		// observed failure mode and must not count as progress.
		await harness.emit({
			type: "tool_result",
			toolCallId: `w${i}`,
			toolName: "write",
			input: { path: "debug_test.go" },
			content: [],
			isError: false,
		} as any);
		await harness.emit(failingTestResult());
		await harness.emit(nonEmptyTurnEnd());
	}

	assert.equal(harness.messages.length, 0);
});

test("a passing test run resets sameFailure even without a source edit", async () => {
	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);

	await harness.emit(failingTestResult());
	await harness.emit(nonEmptyTurnEnd());
	await harness.emit(failingTestResult());
	await harness.emit(nonEmptyTurnEnd());
	await harness.emit(passingTestResult());
	await harness.emit(nonEmptyTurnEnd());
	await harness.emit(failingTestResult());
	await harness.emit(nonEmptyTurnEnd());

	assert.equal(harness.messages.length, 0, "the pass broke the same-failure streak; only 1 failing repeat since");
});

test("turns with no tool calls at all are ignored -- continuation-nudge.ts's territory", async () => {
	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	await harness.emit({
		type: "turn_end",
		turnIndex: 0,
		message: { role: "assistant", stopReason: "stop", content: [] },
		toolResults: [],
	} as any);
	assert.equal(harness.entries.filter((e) => e.type === "pi-stall-trace").length, 0);
});

test("matches `make verify`/`make test`/`make check`, mirroring BROAD_VERIFICATION_PATTERNS's coverage", async () => {
	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);

	for (let i = 0; i < 3; i += 1) {
		await harness.emit({
			type: "tool_result",
			toolCallId: `m${i}`,
			toolName: "bash",
			input: { command: "make verify" },
			content: [{ type: "text", text: FAILURE_TEXT }],
			isError: true,
		} as any);
		await harness.emit(nonEmptyTurnEnd());
	}

	assert.equal(harness.messages.length, 0, "the guard is trace-only");
});

test("counts repeated scratch-file runs as diagnostic activity", async () => {
	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);

	for (let i = 0; i < 3; i += 1) {
		await harness.emit({
			type: "tool_result",
			toolCallId: `scratch-${i}`,
			toolName: "bash",
			input: { command: "cat > /tmp/lru-dbg/main.go <<'EOF'\npackage main\nfunc main() {}\nEOF\ngo run /tmp/lru-dbg/main.go" },
			content: [{ type: "text", text: FAILURE_TEXT }],
			isError: true,
		} as any);
		await harness.emit(nonEmptyTurnEnd());
	}

	assert.equal(harness.messages.length, 0, "the guard is trace-only");
	assert.deepEqual(harness.entries.at(-1)?.data, { sourcelessRounds: 3, sameFailure: 2, stalled: true });
});

test("varied scratch heredocs still accumulate sameFailure for the same underlying Go test", async () => {
	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);

	for (const key of ["10", "11", "12"]) {
		await harness.emit({
			type: "tool_result",
			toolCallId: `varying-${key}`,
			toolName: "bash",
			input: { command: `cat > /tmp/lru-dbg/main.go <<'EOF'\npackage main\n// probe key ${key}\nfunc main() {}\nEOF\ngo run /tmp/lru-dbg/main.go` },
			content: [{ type: "text", text: `--- FAIL: TestEvictionWithDistinctKeysAndValues (0.0${key}s)\n    lru_test.go:95: key ${key} should have been evicted\nFAIL` }],
			isError: true,
		} as any);
		await harness.emit(nonEmptyTurnEnd());
	}

	const trace = harness.entries.at(-1)?.data as any;
	assert.equal(trace.sameFailure, 2);
	assert.equal(trace.stalled, true);
});

// Regression test for the 2026-08-16 live finding: agent_start fires on every
// internal auto-retry after a transient provider error, not once per
// invocation. A naive reset-on-every-agent_start implementation wipes real
// evidence of repeated inaction every time a retry happens, so a run that
// hits frequent retries (as one did, under real ai-stack proxy contention)
// never accumulates enough rounds to fire. See file header.
test("a later agent_start (simulating an auto-retry restart) does not wipe accumulated stall evidence", async () => {
	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any); // true start

	await harness.emit(failingTestResult());
	await harness.emit(nonEmptyTurnEnd());

	await harness.emit({ type: "agent_start" } as any); // retry restart -- must not reset

	await harness.emit(failingTestResult());
	await harness.emit(nonEmptyTurnEnd());
	await harness.emit(failingTestResult());
	await harness.emit(nonEmptyTurnEnd());

	// Naive reset-on-every-agent_start would have wiped round 1's evidence at
	// the retry restart, leaving only 2 rounds accumulated -- one short of
	// STALL_ROUNDS_THRESHOLD (3) -- and never nudge.
	assert.equal(harness.messages.length, 0);
});

test("fingerprintFailure normalizes timings, line numbers, addresses, and temp paths", () => {
	const a = "lru_test.go:95: key 10 should have been evicted (0.03s) at 0x104f2a3c0 in /tmp/go-build123/b001/lru.test";
	const b = "lru_test.go:95: key 10 should have been evicted (0.09s) at 0x1a2b3c4d5 in /tmp/go-build999/b002/lru.test";
	assert.equal(fingerprintFailure(a), fingerprintFailure(b));

	const different = "lru_test.go:95: key 20 should have been evicted";
	assert.notEqual(fingerprintFailure(a), fingerprintFailure(different));
});

// Regression test for the 2026-08-19 pair-5 (dart/sequential-runner) rerun:
// the model alternated between ~15 syntactically distinct `dart test --help
// | grep '<term>'` probes, all producing identical empty output, and the old
// shape+category key reset sameFailure on every alternation because the
// command text itself (not just a heredoc body) genuinely differed. See file
// header, "Two more bugs found live 2026-08-19," item 3.
test("near-identical (not byte-identical) diagnostic commands with the same output still accumulate sameFailure", async () => {
	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);

	const variants = [
		"dart test --help 2>&1 | grep -i -B2 -A10 'no-test'",
		"dart test --help 2>&1 | grep -i -B2 -A8 'no-test'",
		"dart test --help 2>&1 | grep -i -B3 -A3 '79\\|code'",
	];
	for (const command of variants) {
		await harness.emit({
			type: "tool_result",
			toolCallId: command,
			toolName: "bash",
			input: { command },
			content: [{ type: "text", text: "(no output)\nCommand exited with code 1" }],
			isError: true,
		} as any);
		await harness.emit(nonEmptyTurnEnd());
	}

	const trace = harness.entries.at(-1)?.data as any;
	assert.equal(trace.sameFailure, 2, "3 distinct commands, identical output -- 2 repeats of the same failure");
	assert.equal(trace.stalled, true);
});

test("distinct diagnostic output still breaks the streak, even across varying commands", async () => {
	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);

	await harness.emit({
		type: "tool_result",
		toolCallId: "a",
		toolName: "bash",
		input: { command: "dart test --help 2>&1 | grep -i -A2 'fail'" },
		content: [{ type: "text", text: "  --fail-fast    Stop running tests after the first failure.\n" }],
		isError: false,
	} as any);
	await harness.emit(nonEmptyTurnEnd());
	await harness.emit({
		type: "tool_result",
		toolCallId: "b",
		toolName: "bash",
		input: { command: "dart test --help 2>&1 | grep -i -A2 'no-test'" },
		content: [{ type: "text", text: "(no output)\nCommand exited with code 1" }],
		isError: true,
	} as any);
	await harness.emit(nonEmptyTurnEnd());

	const trace = harness.entries.at(-1)?.data as any;
	assert.equal(trace.sameFailure, 0, "genuinely different output must not be conflated with a repeat");
});

// Regression test for Task 4's *first* pair-5 rerun (2026-08-18): 127 calls
// piped `dart test` through `head`, every one reporting isError: false
// because head's exit code -- not dart test's -- is what the shell actually
// returns without pipefail. See file header, "Two more bugs found live
// 2026-08-19," item 4.
test("a maskable exit-0 pipeline does not reset the streak, unlike a genuinely trustworthy success", async () => {
	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);

	const maskedFailure = {
		type: "tool_result",
		toolCallId: "1",
		toolName: "bash",
		input: { command: "dart test 2>&1 | head -20" },
		content: [{ type: "text", text: FAILURE_TEXT }],
		isError: false, // head's exit code, not dart test's
	} as any;

	await harness.emit(maskedFailure);
	await harness.emit(nonEmptyTurnEnd());
	await harness.emit({ ...maskedFailure, toolCallId: "2" });
	await harness.emit(nonEmptyTurnEnd());
	await harness.emit({ ...maskedFailure, toolCallId: "3" });
	await harness.emit(nonEmptyTurnEnd());

	const trace = harness.entries.at(-1)?.data as any;
	assert.equal(trace.sameFailure, 2, "masked exit-0 results must not be treated as a trustworthy reset");
	assert.equal(trace.stalled, true);
});

test("detectsCycle: a 2-state alternation fills the window as a cycle", () => {
	assert.equal(detectsCycle(["a", "b", "a", "b", "a"]), false, "window not full yet (5 < 6)");
	assert.equal(detectsCycle(["a", "b", "a", "b", "a", "b"]), true);
});

test("detectsCycle: a single repeated value is NOT a cycle -- that's sameFailure's job", () => {
	assert.equal(detectsCycle(["a", "a", "a", "a", "a", "a"]), false);
});

test("detectsCycle: more distinct values than the threshold reads as varied exploration, not a cycle", () => {
	assert.equal(detectsCycle(["a", "b", "c", "d", "e", "f"]), false);
});

// Regression test for an Opus design review finding (2026-08-19): a bare
// distinct-count check fired on five identical results plus one novel one,
// which is weaker evidence than six identical results (sameFailure's own
// territory, needing 9 consecutive matches to intercept). A single outlier
// mixed into an otherwise-uniform window must not fire more readily than
// the uniform window itself.
test("detectsCycle: a single outlier mixed into an otherwise-uniform window is NOT a cycle", () => {
	assert.equal(detectsCycle(["a", "a", "a", "a", "a", "b"]), false, "the 'b' appears only once -- not genuine alternation");
	assert.equal(detectsCycle(["b", "a", "a", "a", "a", "a"]), false, "same shape, outlier at the front");
});

test("detectsCycle: every distinct value repeating at least twice IS a cycle, even without strict alternation", () => {
	assert.equal(detectsCycle(["a", "a", "b", "b", "a", "b"]), true, "a x3, b x3, both repeat -- genuine cycling, not just alternation");
});

// A 3-state rotation is a known, explicitly undetected gap -- see the file
// header's "CYCLE DETECTION" section. Pinned here so the header's claim
// can't silently drift out of sync with the code again.
test("detectsCycle: a 3-state rotation is NOT detected -- a known gap, not a claimed capability", () => {
	assert.equal(detectsCycle(["a", "b", "c", "a", "b", "c"]), false);
});

// Regression test for the third live pair-5 (dart/sequential-runner) rerun,
// 2026-08-19: the model alternated between two `dart test ... | head`
// commands whose literal filter arguments got echoed into the output text
// itself, so failureCategory()'s output-hash fallback saw genuinely
// different text on every alternation and sameFailure never sustained a
// streak. See file header, "CYCLE DETECTION."
test("alternating between two distinct diagnostic outputs is caught as a cycle even though sameFailure never accumulates", async () => {
	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);

	const outputs = [
		"Command exited with code 1\nfilter: 'x'/'y' matched nothing",
		"Command exited with code 1\nfilter: 'ok'/'zzz' matched nothing",
	];
	for (let i = 0; i < 6; i += 1) {
		await harness.emit({
			type: "tool_result",
			toolCallId: `alt-${i}`,
			toolName: "bash",
			input: { command: "dart test 2>&1 | head -20" },
			content: [{ type: "text", text: outputs[i % 2] }],
			isError: true,
		} as any);
		await harness.emit(nonEmptyTurnEnd());
	}

	const trace = harness.entries.at(-1)?.data as any;
	assert.equal(trace.sameFailure, 0, "strict alternation never sustains a consecutive-match streak");
	assert.equal(trace.cycleDetected, true, "the trailing window catches the alternation sameFailure misses");
	assert.equal(trace.stalled, true);
});

test("the cycle intercept fires once, independent of and not preempted by the sameFailure action thresholds", async () => {
	process.env.PI_STALL_GUARD_INTERCEPT = "1";
	try {
		const harness = new ExtensionHarness();
		progressStallGuard(harness.api);
		await harness.emit({ type: "agent_start" } as any);

		const outputs = [
			"Command exited with code 1\nfilter: 'x'/'y' matched nothing",
			"Command exited with code 1\nfilter: 'ok'/'zzz' matched nothing",
		];
		const fires: number[] = [];
		for (let i = 0; i < 12; i += 1) {
			const [outcome] = await harness.emit({
				type: "tool_result",
				toolCallId: `alt-${i}`,
				toolName: "bash",
				input: { command: "dart test 2>&1 | head -20" },
				content: [{ type: "text", text: outputs[i % 2] }],
				isError: true,
			} as any);
			if (outcome !== undefined) fires.push(i);
		}

		assert.deepEqual(fires, [5], "fires once, the call that fills the window (index 5 = the 6th call)");
		assert.equal(harness.messages.length, 0, "action goes through tool_result content, never sendUserMessage");
	} finally {
		delete process.env.PI_STALL_GUARD_INTERCEPT;
	}
});

// Regression/documentation test for an Opus design review finding
// (2026-08-19): cycleIntercepted resets at the same four points as
// sameFailure (source edit, trustworthy success, new input, true agent
// start), so it's a per-STALL-EPISODE budget, not the per-SESSION budget
// `intercepts` is. Two edit-separated episodes should each get their own
// single cycle warning -- this is intentional, not a bug, but the file
// header previously (wrongly) called it "at most once per session."
test("the cycle intercept fires again in a second stall episode after a source edit resets it", async () => {
	process.env.PI_STALL_GUARD_INTERCEPT = "1";
	try {
		const harness = new ExtensionHarness();
		progressStallGuard(harness.api);
		await harness.emit({ type: "agent_start" } as any);

		const outputs = [
			"Command exited with code 1\nfilter: 'x'/'y' matched nothing",
			"Command exited with code 1\nfilter: 'ok'/'zzz' matched nothing",
		];
		const fireEpisode = async (prefix: string) => {
			const fires: number[] = [];
			for (let i = 0; i < 6; i += 1) {
				const [outcome] = await harness.emit({
					type: "tool_result",
					toolCallId: `${prefix}-${i}`,
					toolName: "bash",
					input: { command: "dart test 2>&1 | head -20" },
					content: [{ type: "text", text: outputs[i % 2] }],
					isError: true,
				} as any);
				if (outcome !== undefined) fires.push(i);
			}
			return fires;
		};

		assert.deepEqual(await fireEpisode("ep1"), [5], "first episode's cycle intercept fires once");

		// A real source edit ends the episode -- genuine progress, not the same stall.
		await harness.emit({
			type: "tool_result",
			toolCallId: "edit-1",
			toolName: "edit",
			input: { path: "lib/sequential_runner.dart" },
			content: [],
			isError: false,
		} as any);

		assert.deepEqual(await fireEpisode("ep2"), [5], "a fresh episode after an edit gets its own cycle intercept");
	} finally {
		delete process.env.PI_STALL_GUARD_INTERCEPT;
	}
});

// Regression/feature test: the intercept text now names the actual masking
// mechanism (from lib/verification.ts's explainVerificationMasking) when
// the trigger was a maskable exit-0 pipeline, instead of only the generic
// "produced the same result N times" wording. See pi-harness-history.md's
// "quality-gate reason in stall intercept" entry.
test("the intercept action names the masking mechanism when the trigger was a maskable pipe", async () => {
	process.env.PI_STALL_GUARD_INTERCEPT = "1";
	try {
		const harness = new ExtensionHarness();
		progressStallGuard(harness.api);
		await harness.emit({ type: "agent_start" } as any);

		const maskedFailure = {
			type: "tool_result",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "dart test 2>&1 | head -20" },
			content: [{ type: "text", text: FAILURE_TEXT }],
			isError: false, // head's exit code, not dart test's
		} as any;

		let lastOutcome: any;
		for (let i = 1; i <= 9; i += 1) {
			const [outcome] = await harness.emit({ ...maskedFailure, toolCallId: `d${i}` });
			lastOutcome = outcome;
		}

		assert.match(lastOutcome.content[1].text, /\[pi-harness\]/);
		assert.match(lastOutcome.content[1].text, /8 times/);
		assert.match(
			lastOutcome.content[1].text,
			/pipe's last command/i,
			"names the specific mechanism quality-gate already detected, without naming the remedy",
		);
		const trace = harness.entries.find((e) => (e.data as any)?.intercepted && (e.data as any)?.sameFailure === 8)?.data as any;
		assert.equal(trace.maskReason, "unguarded-pipe");
	} finally {
		delete process.env.PI_STALL_GUARD_INTERCEPT;
	}
});

test("the intercept action stays generic (no mechanism claimed) for a genuinely unmasked failure", async () => {
	process.env.PI_STALL_GUARD_INTERCEPT = "1";
	try {
		const harness = new ExtensionHarness();
		progressStallGuard(harness.api);
		await harness.emit({ type: "agent_start" } as any);

		let lastOutcome: any;
		for (let i = 1; i <= 9; i += 1) {
			const [outcome] = await harness.emit({ ...failingTestResult(), toolCallId: `d${i}` });
			lastOutcome = outcome;
		}

		assert.doesNotMatch(lastOutcome.content[1].text, /pipe's last command|negated|fallback|backgrounded/i);
	} finally {
		delete process.env.PI_STALL_GUARD_INTERCEPT;
	}
});

// Regression test for the third live pair-5 rerun's actual shape: an
// alternating maskable pipe (echoed args defeat the fingerprint AND every
// call is a `| head` pipe), so the cycle intercept's text should also name
// the mechanism.
test("the cycle intercept also names the masking mechanism when the alternating commands are maskable pipes", async () => {
	process.env.PI_STALL_GUARD_INTERCEPT = "1";
	try {
		const harness = new ExtensionHarness();
		progressStallGuard(harness.api);
		await harness.emit({ type: "agent_start" } as any);

		const outputs = [
			"filter: 'x'/'y' matched nothing",
			"filter: 'ok'/'zzz' matched nothing",
		];
		let lastOutcome: any;
		for (let i = 0; i < 6; i += 1) {
			const [outcome] = await harness.emit({
				type: "tool_result",
				toolCallId: `alt-${i}`,
				toolName: "bash",
				input: { command: "dart test 2>&1 | head -20" },
				content: [{ type: "text", text: outputs[i % 2] }],
				isError: false,
			} as any);
			lastOutcome = outcome;
		}

		assert.match(lastOutcome.content[1].text, /alternated between only a couple/);
		assert.match(lastOutcome.content[1].text, /pipe's last command/i);
	} finally {
		delete process.env.PI_STALL_GUARD_INTERCEPT;
	}
});

// Documents a known, accepted gap (Opus design review, 2026-08-19): the
// reason note describes only the call that triggered the intercept, not
// necessarily every call in the window. A window mixing masked and genuine
// calls still fires correctly (cycling is about the categories, which don't
// depend on isError), but the note's presence/absence tracks the parity of
// the specific triggering call.
test("a cycle mixing masked and genuine calls still fires, but the reason note reflects only the triggering call", async () => {
	process.env.PI_STALL_GUARD_INTERCEPT = "1";
	try {
		const harness = new ExtensionHarness();
		progressStallGuard(harness.api);
		await harness.emit({ type: "agent_start" } as any);

		const genuine = {
			toolName: "bash",
			input: { command: "dart test -f x" },
			content: [{ type: "text", text: "filter: 'x'/'y' matched nothing" }],
			isError: true, // a real, unmasked failure
		};
		const masked = {
			toolName: "bash",
			input: { command: "dart test 2>&1 | head -20" },
			content: [{ type: "text", text: "filter: 'ok'/'zzz' matched nothing" }],
			isError: false, // masked pipe -- same category text as the genuine call's counterpart shape
		};

		let lastOutcome: any;
		for (let i = 0; i < 6; i += 1) {
			const call = i % 2 === 0 ? genuine : masked;
			const [outcome] = await harness.emit({ type: "tool_result", toolCallId: `mix-${i}`, ...call } as any);
			lastOutcome = outcome;
		}

		assert.notEqual(lastOutcome, undefined, "the cycle still fires -- categories alternate regardless of isError");
		assert.match(lastOutcome.content[1].text, /alternated between only a couple/);
		// Call index 5 (the triggering call) is `masked` -- the note reflects it.
		assert.match(lastOutcome.content[1].text, /pipe's last command/i);
	} finally {
		delete process.env.PI_STALL_GUARD_INTERCEPT;
	}
});

test("resolveInterceptEnabled is opt-in and off for anything but an explicit '1' or 'true'", () => {
	assert.equal(resolveInterceptEnabled({}), false);
	assert.equal(resolveInterceptEnabled({ PI_STALL_GUARD_INTERCEPT: "0" }), false);
	assert.equal(resolveInterceptEnabled({ PI_STALL_GUARD_INTERCEPT: "yes" }), false);
	assert.equal(resolveInterceptEnabled({ PI_STALL_GUARD_INTERCEPT: "1" }), true);
	assert.equal(resolveInterceptEnabled({ PI_STALL_GUARD_INTERCEPT: "true" }), true);
});

test("the intercept action stays off by default, even past both action thresholds", async () => {
	delete process.env.PI_STALL_GUARD_INTERCEPT;
	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);

	for (let i = 0; i < 30; i += 1) {
		const [outcome] = await harness.emit({ ...failingTestResult(), toolCallId: `d${i}` });
		assert.equal(outcome, undefined);
	}
	assert.equal(harness.messages.length, 0);
});

test("the intercept action fires exactly twice (sameFailure 8 and 25) when opted in, and never via sendUserMessage", async () => {
	process.env.PI_STALL_GUARD_INTERCEPT = "1";
	try {
		const harness = new ExtensionHarness();
		progressStallGuard(harness.api);
		await harness.emit({ type: "agent_start" } as any);

		// sameFailure only starts counting from the *second* identical call
		// (the first has no prior fingerprint to match), so it reaches N after
		// N+1 identical calls -- call 9 is the one where sameFailure hits 8.
		const fires: number[] = [];
		for (let i = 1; i <= 30; i += 1) {
			const [outcome] = await harness.emit({ ...failingTestResult(), toolCallId: `d${i}` });
			if (outcome !== undefined) fires.push(i);
		}

		assert.deepEqual(fires, [9, 26]);
		assert.equal(harness.messages.length, 0, "action goes through tool_result content, never sendUserMessage");
	} finally {
		delete process.env.PI_STALL_GUARD_INTERCEPT;
	}
});

test("the intercepted tool_result appends to the model's own content instead of replacing it", async () => {
	process.env.PI_STALL_GUARD_INTERCEPT = "1";
	try {
		const harness = new ExtensionHarness();
		progressStallGuard(harness.api);
		await harness.emit({ type: "agent_start" } as any);

		let lastOutcome: any;
		for (let i = 1; i <= 9; i += 1) {
			const [outcome] = await harness.emit({ ...failingTestResult(), toolCallId: `d${i}` });
			lastOutcome = outcome;
		}

		assert.equal(lastOutcome.content[0].text, FAILURE_TEXT, "the model's original result text is preserved first");
		assert.match(lastOutcome.content[1].text, /\[pi-harness\]/);
		assert.match(lastOutcome.content[1].text, /8 times/);
		assert.doesNotMatch(lastOutcome.content[1].text, /\btry\b|\badd\b|\bpipefail\b/i, "states a fact, not a suggested fix");
	} finally {
		delete process.env.PI_STALL_GUARD_INTERCEPT;
	}
});
