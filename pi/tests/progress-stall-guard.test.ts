import assert from "node:assert/strict";
import test from "node:test";
import progressStallGuard, { fingerprintFailure, resolveInterceptEnabled } from "../extensions/progress-stall-guard.ts";
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
