import assert from "node:assert/strict";
import test from "node:test";
import goalGate, { resolveKickoffTimeoutMs, resolveMaxRounds } from "../extensions/goal-gate.ts";
import { ExtensionHarness, type ExecCall } from "./extension-api-harness.ts";

function result(code: number, stdout = "") {
	return { code, stdout, stderr: "", killed: false };
}

// snapshotDiff() (lib/verification.ts) needs `git rev-parse`/`diff`/`status`
// to resolve to something material for evidencePassesCurrentDiff() to ever
// return true. `diffState.value` is the fixture's current diff content --
// tests that need to simulate an edit landing between a passing
// verification and a later completion claim mutate it mid-test; everyone
// else can leave it alone and get a stable, matching diff hash throughout.
function gitFixture(initialDiff = "diff-v1") {
	const diffState = { value: initialDiff };
	const exec = ({ command, args }: ExecCall) => {
		if (command === "git" && args[0] === "rev-parse") return result(0, "base\n");
		if (command === "git" && args[0] === "diff") return result(0, diffState.value);
		if (command === "git" && args[0] === "status") return result(0, " M app.ts\n");
		return result(1);
	};
	return { diffState, exec };
}

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

// Setting a goal awaits `waitForNextAgentStart()` inside the command
// handler before it resolves (see goal-gate.ts's header comment on why:
// under `pi -p`, the process would otherwise exit before the kicked-off
// turn ever started). The handler registers its waiter synchronously
// before its first await, so starting the invocation, then emitting
// agent_start, then awaiting the invocation, resolves it without relying
// on the real (10s) timeout fallback.
function setGoal(harness: ExtensionHarness, condition: string): Promise<void> {
	const invocation = harness.invokeCommand("goal", condition);
	harness.emit({ type: "agent_start" } as any);
	return invocation;
}

test("resolveMaxRounds falls back to the default on missing/invalid env", () => {
	assert.equal(resolveMaxRounds({}), 15);
	assert.equal(resolveMaxRounds({ PI_GOAL_MAX_ROUNDS: "not-a-number" }), 15);
	assert.equal(resolveMaxRounds({ PI_GOAL_MAX_ROUNDS: "0" }), 15);
	assert.equal(resolveMaxRounds({ PI_GOAL_MAX_ROUNDS: "3" }), 3);
});

test("resolveKickoffTimeoutMs falls back to the default on missing/invalid env", () => {
	assert.equal(resolveKickoffTimeoutMs({}), 10_000);
	assert.equal(resolveKickoffTimeoutMs({ PI_GOAL_KICKOFF_TIMEOUT_MS: "nope" }), 10_000);
	assert.equal(resolveKickoffTimeoutMs({ PI_GOAL_KICKOFF_TIMEOUT_MS: "25" }), 25);
});

test("the kickoff wait falls back to its timeout instead of hanging when agent_start never fires", async () => {
	process.env.PI_GOAL_KICKOFF_TIMEOUT_MS = "20";
	try {
		const harness = new ExtensionHarness();
		goalGate(harness.api);
		await harness.invokeCommand("goal", "orphaned kickoff"); // no agent_start emitted
		assert.equal(harness.messages.length, 1); // the kickoff message was still sent
	} finally {
		delete process.env.PI_GOAL_KICKOFF_TIMEOUT_MS;
	}
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
	await setGoal(harness, "make the app full-stack");
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
	await setGoal(harness, "ship it");
	await harness.invokeCommand("goal", "clear");
	assert.match(harness.notifications[1]?.message ?? "", /Goal cleared \(was: "ship it", 0 round\(s\) used\)/);
	await harness.emit(stopTurn("all done"));
	assert.equal(harness.messages.length, 1); // only the original kickoff, no nudge
});

test("a stop turn with no completion marker is nudged and rounds increment", async () => {
	const harness = new ExtensionHarness();
	goalGate(harness.api);
	await setGoal(harness, "add a dashboard");
	await harness.emit(stopTurn("I think that covers it."));
	assert.equal(harness.messages.length, 2);
	assert.match(String(harness.messages[1].content), /Goal not yet met: "add a dashboard"/);
	assert.match(String(harness.messages[1].content), /round 1\/15/);
});

test("GOAL COMPLETE without a passing verification is rejected and nudged", async () => {
	const harness = new ExtensionHarness();
	goalGate(harness.api);
	await setGoal(harness, "add a dashboard");
	await harness.emit(stopTurn("GOAL COMPLETE: dashboard renders."));
	assert.equal(harness.messages.length, 2);
	assert.match(String(harness.messages[1].content), /did not pass against the current diff/);
});

test("GOAL COMPLETE with a failing verification is rejected", async () => {
	const harness = new ExtensionHarness();
	goalGate(harness.api);
	await setGoal(harness, "add a dashboard");
	await failingVerify(harness);
	await harness.emit(stopTurn("GOAL COMPLETE: dashboard renders."));
	assert.equal(harness.messages.length, 2);
});

test("GOAL COMPLETE backed by a passing verification clears the goal", async () => {
	const { exec } = gitFixture();
	const harness = new ExtensionHarness({ exec });
	goalGate(harness.api);
	await setGoal(harness, "add a dashboard");
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

test("GOAL COMPLETE followed by more prose is not treated as a final-line completion", async () => {
	// Regression test: COMPLETE_MARKER used to run in multiline mode, so `$`
	// matched the end of any line, not just the message's actual last line.
	// A marker line followed by a hedge ("Actually, more work remains") was
	// wrongly accepted even though the docstring's contract requires the
	// marker to be the message's final line.
	const harness = new ExtensionHarness();
	goalGate(harness.api);
	await setGoal(harness, "add a dashboard");
	await passingVerify(harness);
	await harness.emit(stopTurn("GOAL COMPLETE: dashboard renders.\nActually, more work remains."));
	assert.equal(harness.messages.length, 2); // nudged, not accepted
	assert.equal(harness.entries.length, 0); // no pi-goal-trace complete entry
	assert.match(String(harness.messages[1].content), /Goal not yet met: "add a dashboard"/);
});

test("GOAL COMPLETE as the true final line is still accepted with trailing blank lines", async () => {
	const { exec } = gitFixture();
	const harness = new ExtensionHarness({ exec });
	goalGate(harness.api);
	await setGoal(harness, "add a dashboard");
	await passingVerify(harness);
	await harness.emit(stopTurn("All done.\n\nGOAL COMPLETE: dashboard renders.\n\n"));
	assert.equal(harness.messages.length, 1); // no nudge, accepted
	assert.equal(harness.entries.length, 1);
	assert.equal(harness.entries[0].type, "pi-goal-trace");
});

test("an ordinary not-yet-met nudge does not discard a genuine pass -- a later claim still succeeds", async () => {
	// Live-confirmed 2026-08-09 (see goal-gate.ts's turn_end comment): a
	// stopReason:"stop" turn fires on ordinary mid-task narrative with no
	// tool call too, not just genuine stopping points. Wiping the pass
	// signal on *every* such nudge meant a real pass right before a real
	// GOAL COMPLETE kept getting rejected as unverified.
	const { exec } = gitFixture();
	const harness = new ExtensionHarness({ exec });
	goalGate(harness.api);
	await setGoal(harness, "add a dashboard");
	await passingVerify(harness);
	await harness.emit(stopTurn("still working, more to do")); // plain nudge, no claim -- pass must survive
	await harness.emit(stopTurn("GOAL COMPLETE: done now."));
	assert.equal(harness.messages.length, 2); // kickoff + the one "not yet met" nudge, then cleared
	assert.equal(harness.entries.some((e) => e.type === "pi-goal-trace" && (e.data as any).event === "complete"), true);
});

test("a pass followed by a further unverified edit does not back an immediate completion claim", async () => {
	// Regression test for the diff-hash-binding fix: evidence used to be a
	// bare pass/fail flag with no tie to *which* diff it verified, so a real
	// pass followed by more edits and an immediate GOAL COMPLETE could slip
	// through on stale evidence. evidencePassesCurrentDiff() (shared with
	// quality-gate.ts) now requires the verification's diff hash to match
	// the diff at the moment of the claim.
	const { diffState, exec } = gitFixture("diff-v1");
	const harness = new ExtensionHarness({ exec });
	goalGate(harness.api);
	await setGoal(harness, "add a dashboard");
	await passingVerify(harness); // passes against diff-v1
	diffState.value = "diff-v2"; // further edit lands, never verified
	await harness.emit(stopTurn("GOAL COMPLETE: done now."));
	assert.equal(harness.messages.length, 2); // rejected, nudged instead of cleared
	assert.match(String(harness.messages[1].content), /did not pass against the current diff/);
	assert.equal(harness.entries.some((e) => e.type === "pi-goal-trace" && (e.data as any).event === "complete"), false);
});

test("a rejected completion claim resets the signal -- immediately repeating the claim still fails", async () => {
	const harness = new ExtensionHarness();
	goalGate(harness.api);
	await setGoal(harness, "add a dashboard");
	await harness.emit(stopTurn("GOAL COMPLETE: done now.")); // no verification ever ran -- rejected
	await harness.emit(stopTurn("GOAL COMPLETE: done now.")); // repeated verbatim, still no fresh evidence
	assert.equal(harness.messages.length, 3); // kickoff + 2 rejections
	assert.equal(harness.entries.some((e) => e.type === "pi-goal-trace" && (e.data as any).event === "complete"), false);
});

test("round budget is exhausted and the goal is dropped without an unbounded nudge loop", async () => {
	const harness = new ExtensionHarness();
	goalGate(harness.api);
	await setGoal(harness, "keep trying");
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
	await setGoal(harness, "keep trying");
	await harness.emit({
		type: "turn_end",
		turnIndex: 0,
		message: { role: "assistant", stopReason: "tool_use", content: [] },
		toolResults: [],
	} as any);
	assert.equal(harness.messages.length, 1); // just the kickoff
});
