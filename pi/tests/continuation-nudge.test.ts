import assert from "node:assert/strict";
import test from "node:test";
import continuationNudge from "../extensions/continuation-nudge.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

const silentTurn = {
	type: "turn_end",
	turnIndex: 0,
	message: { role: "assistant", stopReason: "stop", content: [] },
	toolResults: [],
} as any;

test("failed verification triggers a bounded corrective nudge", async () => {
	const harness = new ExtensionHarness();
	continuationNudge(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	await harness.emit({ type: "tool_result", toolCallId: "1", toolName: "bash", input: { command: "make verify" }, content: [], details: {}, isError: true } as any);
	for (let i = 0; i < 5; i += 1) await harness.emit(silentTurn);
	assert.equal(harness.messages.length, 3);
	assert.match(String(harness.messages[0].content), /verification command failed/);
});

test("a current passing verification suppresses abandonment nudges", async () => {
	const branch: any[] = [
		{ id: "prior", type: "message", message: { role: "assistant", content: [{ type: "text", text: "prior" }] } },
	];
	const harness = new ExtensionHarness({ branch });
	continuationNudge(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	branch.push(
		{ id: "u", type: "message", message: { role: "user", content: [{ type: "text", text: "task" }] } },
		{ id: "a", type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "make verify" } }] } },
	);
	await harness.emit({ type: "tool_result", toolCallId: "1", toolName: "bash", input: { command: "make verify" }, content: [], details: {}, isError: false } as any);
	await harness.emit(silentTurn);
	assert.equal(harness.messages.length, 0);
});

test("forward-looking prose with no tool call is nudged", async () => {
	const harness = new ExtensionHarness();
	continuationNudge(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	await harness.emit({ ...silentTurn, message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Now add the helper." }] } } as any);
	assert.equal(harness.messages.length, 1);
});
