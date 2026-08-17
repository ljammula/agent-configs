import assert from "node:assert/strict";
import test from "node:test";
import wallClockBudgetNudge from "../extensions/wall-clock-budget-nudge.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

function withEnv(minutes: string | undefined, fn: () => Promise<void> | void) {
	const prior = process.env.PI_HARNESS_TIMEOUT_MINUTES;
	if (minutes === undefined) delete process.env.PI_HARNESS_TIMEOUT_MINUTES;
	else process.env.PI_HARNESS_TIMEOUT_MINUTES = minutes;
	return Promise.resolve(fn()).finally(() => {
		if (prior === undefined) delete process.env.PI_HARNESS_TIMEOUT_MINUTES;
		else process.env.PI_HARNESS_TIMEOUT_MINUTES = prior;
	});
}

const emptyTurnEnd = {
	type: "turn_end",
	turnIndex: 0,
	message: { role: "assistant", stopReason: "toolUse", content: [] },
	toolResults: [{ role: "toolResult", toolCallId: "1", content: [], isError: false }],
} as any;

test("unset env var: no listeners registered, fully inert", async () => {
	await withEnv(undefined, async () => {
		const harness = new ExtensionHarness();
		wallClockBudgetNudge(harness.api);
		assert.equal(harness.handlers.size, 0);
	});
});

test("non-numeric or non-positive env var: inert", async () => {
	for (const bad of ["not-a-number", "0", "-5"]) {
		await withEnv(bad, async () => {
			const harness = new ExtensionHarness();
			wallClockBudgetNudge(harness.api);
			assert.equal(harness.handlers.size, 0, `expected inert for PI_HARNESS_TIMEOUT_MINUTES=${bad}`);
		});
	}
});

test("warns once after crossing the 75% mark, not before", async () => {
	await withEnv("30", async () => {
		const harness = new ExtensionHarness();
		wallClockBudgetNudge(harness.api);
		await harness.emit({ type: "agent_start" } as any);

		// Well under 75% of 30 minutes -- must stay silent.
		await harness.emit(emptyTurnEnd);
		assert.equal(harness.messages.length, 0);
	});
});

test("fires once past the deadline fraction and never again in the same run", async () => {
	await withEnv("30", async () => {
		const harness = new ExtensionHarness();
		wallClockBudgetNudge(harness.api);

		const realNow = Date.now;
		let simulatedNow = realNow();
		Date.now = () => simulatedNow;
		try {
			await harness.emit({ type: "agent_start" } as any);
			simulatedNow += 23 * 60_000; // past the 22.5-minute (75% of 30) mark
			await harness.emit(emptyTurnEnd);
			await harness.emit(emptyTurnEnd);
		} finally {
			Date.now = realNow;
		}

		assert.equal(harness.messages.length, 1);
		assert.match(String(harness.messages[0].content), /23 of 30 available minutes/);
	});
});

// Regression test for the 2026-08-16 live finding: pi -p fires agent_start on
// every internal auto-retry after a transient provider error, not once per
// invocation. A naive "reset the clock on agent_start" implementation lets a
// retry storm push the deadline out indefinitely, so the warning never fires
// no matter how much real wall-clock time elapses. See file header.
test("a later agent_start (simulating an auto-retry restart) does not push the deadline out", async () => {
	await withEnv("30", async () => {
		const harness = new ExtensionHarness();
		wallClockBudgetNudge(harness.api);

		const realNow = Date.now;
		let simulatedNow = realNow();
		Date.now = () => simulatedNow;
		try {
			await harness.emit({ type: "agent_start" } as any); // true start
			simulatedNow += 10 * 60_000;
			await harness.emit({ type: "agent_start" } as any); // retry restart #1, 10min in
			simulatedNow += 10 * 60_000;
			await harness.emit({ type: "agent_start" } as any); // retry restart #2, 20min in
			simulatedNow += 3 * 60_000; // now 23 real minutes since the TRUE start
			await harness.emit(emptyTurnEnd);
		} finally {
			Date.now = realNow;
		}

		// Naive reset-on-every-agent_start would put startedAt at 20min-in,
		// making elapsed-since-start only 3min -- well under the 22.5min
		// threshold -- and never warn. Correct behavior measures from the
		// true first start (23min elapsed), which is past threshold.
		assert.equal(harness.messages.length, 1);
		assert.match(String(harness.messages[0].content), /23 of 30 available minutes/);
	});
});

test("a fresh extension instance (a genuinely new pi -p process) starts its own clock", async () => {
	await withEnv("30", async () => {
		const harness = new ExtensionHarness();
		wallClockBudgetNudge(harness.api);

		const realNow = Date.now;
		let simulatedNow = realNow();
		Date.now = () => simulatedNow;
		try {
			await harness.emit({ type: "agent_start" } as any);
			simulatedNow += 25 * 60_000;
			await harness.emit(emptyTurnEnd);
			assert.equal(harness.messages.length, 1);
		} finally {
			Date.now = realNow;
		}
	});
});
