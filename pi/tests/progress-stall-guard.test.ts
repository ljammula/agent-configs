import assert from "node:assert/strict";
import test from "node:test";
import progressStallGuard, { fingerprintFailure } from "../extensions/progress-stall-guard.ts";
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

test("reproduces the observed stall: same-failure test reruns with no source edit trace as stalled but stay silent by default", async () => {
	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);

	for (let i = 0; i < 3; i += 1) {
		await harness.emit(failingTestResult());
		await harness.emit(nonEmptyTurnEnd());
	}

	assert.equal(harness.messages.length, 0, "trace-only by default: no nudge without PI_STALL_GUARD_NUDGE=1");
	const traces = harness.entries.filter((e) => e.type === "pi-stall-trace");
	assert.equal(traces.length, 3);
	assert.deepEqual(traces.at(-1)?.data, { sourcelessRounds: 3, sameFailure: 2, stalled: true, nudged: false });
});

test("nudges when PI_STALL_GUARD_NUDGE=1 and the stall pattern reproduces", async (t) => {
	process.env.PI_STALL_GUARD_NUDGE = "1";
	t.after(() => {
		delete process.env.PI_STALL_GUARD_NUDGE;
	});

	const harness = new ExtensionHarness();
	progressStallGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);

	for (let i = 0; i < 3; i += 1) {
		await harness.emit(failingTestResult());
		await harness.emit(nonEmptyTurnEnd());
	}

	assert.equal(harness.messages.length, 1);
	assert.match(String(harness.messages[0].content), /same failure/);
});

test("an edit to a non-test source file resets the stall counters", async (t) => {
	process.env.PI_STALL_GUARD_NUDGE = "1";
	t.after(() => {
		delete process.env.PI_STALL_GUARD_NUDGE;
	});

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

test("an edit to a test file does not reset the stall counters", async (t) => {
	process.env.PI_STALL_GUARD_NUDGE = "1";
	t.after(() => {
		delete process.env.PI_STALL_GUARD_NUDGE;
	});

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

	assert.equal(harness.messages.length, 1);
});

test("a passing test run resets sameFailure even without a source edit", async (t) => {
	process.env.PI_STALL_GUARD_NUDGE = "1";
	t.after(() => {
		delete process.env.PI_STALL_GUARD_NUDGE;
	});

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

test("matches `make verify`/`make test`/`make check`, mirroring BROAD_VERIFICATION_PATTERNS's coverage", async (t) => {
	process.env.PI_STALL_GUARD_NUDGE = "1";
	t.after(() => {
		delete process.env.PI_STALL_GUARD_NUDGE;
	});

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

	assert.equal(harness.messages.length, 1, "make verify runs should count toward the stall the same as a direct go test call");
});

// Regression test for the 2026-08-16 live finding: agent_start fires on every
// internal auto-retry after a transient provider error, not once per
// invocation. A naive reset-on-every-agent_start implementation wipes real
// evidence of repeated inaction every time a retry happens, so a run that
// hits frequent retries (as one did, under real ai-stack proxy contention)
// never accumulates enough rounds to fire. See file header.
test("a later agent_start (simulating an auto-retry restart) does not wipe accumulated stall evidence", async (t) => {
	process.env.PI_STALL_GUARD_NUDGE = "1";
	t.after(() => {
		delete process.env.PI_STALL_GUARD_NUDGE;
	});

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
	assert.equal(harness.messages.length, 1);
});

test("fingerprintFailure normalizes timings, line numbers, addresses, and temp paths", () => {
	const a = "lru_test.go:95: key 10 should have been evicted (0.03s) at 0x104f2a3c0 in /tmp/go-build123/b001/lru.test";
	const b = "lru_test.go:95: key 10 should have been evicted (0.09s) at 0x1a2b3c4d5 in /tmp/go-build999/b002/lru.test";
	assert.equal(fingerprintFailure(a), fingerprintFailure(b));

	const different = "lru_test.go:95: key 20 should have been evicted";
	assert.notEqual(fingerprintFailure(a), fingerprintFailure(different));
});
