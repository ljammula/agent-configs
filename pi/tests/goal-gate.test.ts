import assert from "node:assert/strict";
import test from "node:test";
import goalGate, { resolveMaxRounds } from "../extensions/goal-gate.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

function stopTurn(text: string) {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: { role: "assistant", stopReason: "stop", content: text ? [{ type: "text", text }] : [] },
		toolResults: [],
	} as any;
}

function passingVerify(harness: ExtensionHarness) {
	return harness.emit({
		type: "tool_result",
		toolCallId: "1",
		toolName: "bash",
		input: { command: "make verify" },
		content: [],
		details: {},
		isError: false,
	} as any);
}

function failingVerify(harness: ExtensionHarness) {
	return harness.emit({
		type: "tool_result",
		toolCallId: "1",
		toolName: "bash",
		input: { command: "make verify" },
		content: [],
		details: {},
		isError: true,
	} as any);
}

test("resolveMaxRounds falls back to the default on missing/invalid env", () => {
	assert.equal(resolveMaxRounds({}), 15);
	assert.equal(resolveMaxRounds({ PI_GOAL_MAX_ROUNDS: "not-a-number" }), 15);
	assert.equal(resolveMaxRounds({ PI_GOAL_MAX_ROUNDS: "0" }), 15);
	assert.equal(resolveMaxRounds({ PI_GOAL_MAX_ROUNDS: "3" }), 3);
});

test("/goal with no args prints usage and does not set a goal", async () => {
	const harness = new ExtensionHarness();
	goalGate(harness.api);
	await harness.invokeCommand("goal", "  ");
	assert.match(harness.notifications[0]?.message ?? "", /Usage: \/goal/);
	await harness.invokeCommand("goal", "status");
	assert.match(harness.notifications[1]?.message ?? "", /No active goal/);
});

test("/goal <condition> sets a goal and kicks off a follow-up turn", async () => {
	const harness = new ExtensionHarness();
	goalGate(harness.api);
	await harness.invokeCommand("goal", "make the app full-stack");
	assert.match(harness.notifications[0]?.message ?? "", /Goal set: make the app full-stack/);
	assert.equal(harness.messages.length, 1);
	assert.match(String(harness.messages[0].content), /Goal set: make the app full-stack/);
	assert.match(String(harness.messages[0].content), /GOAL COMPLETE:/);
	assert.deepEqual(harness.messages[0].options, { deliverAs: "followUp" });
});

test("/goal clear with no active goal is a no-op notification", async () => {
	const harness = new ExtensionHarness();
	goalGate(harness.api);
	await harness.invokeCommand("goal", "clear");
	assert.match(harness.notifications[0]?.message ?? "", /No active goal/);
});

test("/goal clear ends an active goal and further stop turns are ignored", async () => {
	const harness = new ExtensionHarness();
	goalGate(harness.api);
	await harness.invokeCommand("goal", "ship it");
	await harness.invokeCommand("goal", "clear");
	assert.match(harness.notifications[1]?.message ?? "", /Goal cleared \(was: "ship it", 0 round\(s\) used\)/);
	await harness.emit(stopTurn("all done"));
	assert.equal(harness.messages.length, 1); // only the original kickoff, no nudge
});

test("a stop turn with no completion marker is nudged and rounds increment", async () => {
	const harness = new ExtensionHarness();
	goalGate(harness.api);
	await harness.invokeCommand("goal", "add a dashboard");
	await harness.emit(stopTurn("I think that covers it."));
	assert.equal(harness.messages.length, 2);
	assert.match(String(harness.messages[1].content), /Goal not yet met: "add a dashboard"/);
	assert.match(String(harness.messages[1].content), /round 1\/15/);
});

test("GOAL COMPLETE without a passing verification is rejected and nudged", async () => {
	const harness = new ExtensionHarness();
	goalGate(harness.api);
	await harness.invokeCommand("goal", "add a dashboard");
	await harness.emit(stopTurn("GOAL COMPLETE: dashboard renders."));
	assert.equal(harness.messages.length, 2);
	assert.match(String(harness.messages[1].content), /did not pass \(or none has/);
});

test("GOAL COMPLETE with a failing verification is rejected", async () => {
	const harness = new ExtensionHarness();
	goalGate(harness.api);
	await harness.invokeCommand("goal", "add a dashboard");
	await failingVerify(harness);
	await harness.emit(stopTurn("GOAL COMPLETE: dashboard renders."));
	assert.equal(harness.messages.length, 2);
});

test("GOAL COMPLETE backed by a passing verification clears the goal", async () => {
	const harness = new ExtensionHarness();
	goalGate(harness.api);
	await harness.invokeCommand("goal", "add a dashboard");
	await passingVerify(harness);
	await harness.emit(stopTurn("GOAL COMPLETE: make verify passes, dashboard is live."));
	assert.equal(harness.messages.length, 1); // no further nudge
	assert.equal(harness.entries.length, 1);
	assert.equal(harness.entries[0].type, "pi-goal-trace");
	assert.deepEqual(harness.entries[0].data, { event: "complete", condition: "add a dashboard", rounds: 0 });
	// Goal is cleared -- a further stop turn produces no additional nudge.
	await harness.emit(stopTurn("anything"));
	assert.equal(harness.messages.length, 1);
});

test("a stale pass does not carry over to back a later, unverified completion claim", async () => {
	const harness = new ExtensionHarness();
	goalGate(harness.api);
	await harness.invokeCommand("goal", "add a dashboard");
	await passingVerify(harness);
	await harness.emit(stopTurn("still working, more to do")); // nudge resets lastVerification to "none"
	await harness.emit(stopTurn("GOAL COMPLETE: done now."));
	assert.equal(harness.messages.length, 3); // kickoff + 2 nudges, never cleared
});

test("round budget is exhausted and the goal is dropped without an unbounded nudge loop", async () => {
	const harness = new ExtensionHarness();
	goalGate(harness.api);
	await harness.invokeCommand("goal", "keep trying");
	for (let i = 0; i < 20; i += 1) await harness.emit(stopTurn("not done yet"));
	assert.equal(harness.entries.some((e) => e.type === "pi-goal-trace" && (e.data as any).event === "cap-hit"), true);
	// after the cap trips, further stop turns produce no more nudges
	const messageCountAtCap = harness.messages.length;
	await harness.emit(stopTurn("still not done"));
	assert.equal(harness.messages.length, messageCountAtCap);
});

test("turn_end is ignored when the assistant did not actually stop (tool call pending)", async () => {
	const harness = new ExtensionHarness();
	goalGate(harness.api);
	await harness.invokeCommand("goal", "keep trying");
	await harness.emit({
		type: "turn_end",
		turnIndex: 0,
		message: { role: "assistant", stopReason: "tool_use", content: [] },
		toolResults: [],
	} as any);
	assert.equal(harness.messages.length, 1); // just the kickoff
});
