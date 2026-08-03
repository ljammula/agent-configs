import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import qualityGate, { redactFailureOutput } from "../extensions/quality-gate.ts";
import { ExtensionHarness, type ExecCall } from "./extension-api-harness.ts";

function result(code: number, stdout = "") {
	return { code, stdout, stderr: "", killed: false };
}

test("failure excerpts redact common credential forms", () => {
	const redacted = redactFailureOutput(
		"TOKEN=abc123 Authorization: Bearer xyz postgresql://user:hunter2@localhost/db",
	);
	assert.equal(redacted.includes("abc123"), false);
	assert.equal(redacted.includes("xyz"), false);
	assert.equal(redacted.includes("hunter2"), false);
});

test("green check followed by an edit is stale and reruns the canonical check", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-gate-"));
	await writeFile(join(cwd, "Makefile"), "verify:\n\t@true\n");
	let diff = "first";
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "rev-parse") return result(0, "base\n");
			if (command === "git" && args[0] === "diff") return result(0, diff);
			if (command === "git" && args[0] === "status") return result(0, " M app.ts\n");
			if (command === "bash") return result(0);
			return result(1);
		},
	});
	qualityGate(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	await harness.emit({ type: "tool_call", toolCallId: "v1", toolName: "bash", input: { command: "make verify" } } as any);
	await harness.emit({ type: "tool_result", toolCallId: "v1", toolName: "bash", input: { command: "make verify" }, content: [], details: {}, isError: false } as any);
	diff = "second";
	await harness.emit({ type: "agent_settled" } as any);
	assert.equal(harness.execCalls.filter((call) => call.command === "bash").length, 1);
	assert.equal(harness.messages.length, 0);
});

test("green check with no later edit avoids a redundant rerun", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-gate-"));
	await writeFile(join(cwd, "Makefile"), "verify:\n\t@true\n");
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "rev-parse") return result(0, "base\n");
			if (command === "git" && args[0] === "diff") return result(0, "same");
			if (command === "git" && args[0] === "status") return result(0, " M app.ts\n");
			return result(1);
		},
	});
	qualityGate(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	await harness.emit({ type: "tool_result", toolCallId: "v1", toolName: "bash", input: { command: "make verify" }, content: [], details: {}, isError: false } as any);
	await harness.emit({ type: "agent_settled" } as any);
	assert.equal(harness.execCalls.filter((call) => call.command === "bash").length, 0);
});

test("green-looking masked evidence reruns the canonical check", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-gate-"));
	await writeFile(join(cwd, "Makefile"), "verify:\n\t@true\n");
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "rev-parse") return result(0, "base\n");
			if (command === "git" && args[0] === "diff") return result(0, "same");
			if (command === "git" && args[0] === "status") return result(0, " M app.ts\n");
			if (command === "bash") return result(0);
			return result(1);
		},
	});
	qualityGate(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	await harness.emit({ type: "tool_result", toolCallId: "v1", toolName: "bash", input: { command: "npm test; echo EXIT=$?" }, content: [], details: {}, isError: false } as any);
	await harness.emit({ type: "agent_settled" } as any);
	assert.equal(harness.execCalls.filter((call) => call.command === "bash").length, 1);
});

test("failed canonical checks nudge at most three times and record cap hit", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-gate-"));
	await writeFile(join(cwd, "Makefile"), "verify:\n\t@false\n");
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "rev-parse") return result(0, "base\n");
			if (command === "git" && args[0] === "diff") return result(0, "diff");
			if (command === "git" && args[0] === "status") return result(0, " M app.ts\n");
			if (command === "bash") return result(1);
			return result(1);
		},
	});
	qualityGate(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	for (let i = 0; i < 5; i += 1) await harness.emit({ type: "agent_settled" } as any);
	assert.equal(harness.messages.length, 3);
	assert.equal(harness.entries.some((entry) => (entry.data as any)?.outcome === "cap-hit"), true);
});

test("an unconfigured repository records evidence instead of guessing success", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-gate-empty-"));
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "rev-parse") return result(0, "base\n");
			if (command === "git" && args[0] === "diff") return result(0, "diff");
			if (command === "git" && args[0] === "status") return result(0, "?? app.txt\n");
			return result(1);
		},
	});
	qualityGate(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	await harness.emit({ type: "agent_settled" } as any);
	assert.equal(harness.entries.some((entry) => (entry.data as any)?.outcome === "unconfigured"), true);
});
