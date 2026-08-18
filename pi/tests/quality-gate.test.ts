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
	await harness.emit({ type: "agent_end", messages: [] } as any);
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
	await harness.emit({ type: "agent_end", messages: [] } as any);
	assert.equal(harness.execCalls.filter((call) => call.command === "bash").length, 0);
});

test("canonical check that changes the diff is inconclusive", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-gate-"));
	await writeFile(join(cwd, "Makefile"), "verify:\n\t@true\n");
	let diff = "before-check";
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "rev-parse") return result(0, "base\n");
			if (command === "git" && args[0] === "diff") return result(0, diff);
			if (command === "git" && args[0] === "status") return result(0, " M app.ts\n");
			if (command === "bash") {
				diff = "changed-by-check";
				return result(0);
			}
			return result(1);
		},
	});
	qualityGate(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	await harness.emit({ type: "agent_end", messages: [] } as any);
	// Decoupled 2026-08-19: a check that changes the diff it's verifying is
	// reported as a failing trace entry, not a queued corrective follow-up
	// (see quality-gate.ts's file-top comment). `diffChanged: true` and
	// outcome "fail" are what a human reading the trace afterward sees.
	assert.equal(harness.messages.length, 0);
	const trace = harness.entries.find((entry) => (entry.data as any)?.event === "verification");
	assert.equal((trace?.data as any)?.outcome, "fail");
	assert.equal((trace?.data as any)?.metadata?.diffChanged, true);
});

// agent_end fires on internal retry/abort cycles too, not only on a genuine
// "the model is done" stop (see extensions/lib/agent-end-guard.ts). Without
// this guard: (a) an aborted run gets a fabricated "verification failed"
// corrective nudge that resurrects a run the user just killed, and (b) each
// retryable transport error re-runs the full canonical check against an
// *unchanged* failing diff, burning the small shared corrective-round
// budget on flakiness instead of a real failure -- live-found in the
// 2026-08-18 Opus review of this fix's first cut. Same test body as
// "canonical check that changes the diff is inconclusive" above (would
// otherwise queue a corrective follow-up), except the run's last message
// is an error/aborted assistant turn.
for (const stopReason of ["error", "aborted"] as const) {
	test(`agent_end does not run verification or nudge when the run ended in ${stopReason}`, async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-gate-"));
		await writeFile(join(cwd, "Makefile"), "verify:\n\t@true\n");
		const harness = new ExtensionHarness({
			cwd,
			exec: ({ command, args }: ExecCall) => {
				if (command === "git" && args[0] === "rev-parse") return result(0, "base\n");
				if (command === "git" && args[0] === "diff") return result(0, "diff");
				if (command === "git" && args[0] === "status") return result(0, " M app.ts\n");
				if (command === "bash") return result(0);
				return result(1);
			},
		});
		qualityGate(harness.api);
		await harness.emit({ type: "agent_start" } as any);
		await harness.emit({
			type: "agent_end",
			messages: [{ role: "assistant", stopReason, content: [], api: "chat", provider: "test", model: "test", usage: {} }],
		} as any);
		assert.equal(harness.execCalls.filter((call) => call.command === "bash").length, 0, "no verification command ran");
		assert.equal(harness.messages.length, 0, "no corrective follow-up was queued");
	});
}

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
	await harness.emit({ type: "agent_end", messages: [] } as any);
	assert.equal(harness.execCalls.filter((call) => call.command === "bash").length, 1);
});

// Decoupled 2026-08-19: no corrective follow-up is ever queued, so there is
// no round cap to hit anymore (see quality-gate.ts's file-top comment).
// Repeated failures against materially distinct diffs are each reported as
// their own failing trace entry, with the redacted failure text carried in
// `failureExcerpt` -- the only channel left for a human to see it, now that
// nothing injects it into the session.
test("repeated failing canonical checks never queue a message, each recorded with its failure excerpt", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-gate-"));
	await writeFile(join(cwd, "Makefile"), "verify:\n\t@false\n");
	let diff = "diff-0";
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "rev-parse") return result(0, "base\n");
			if (command === "git" && args[0] === "diff") return result(0, diff);
			if (command === "git" && args[0] === "status") return result(0, " M app.ts\n");
			if (command === "bash") return result(1, "FAIL: something broke");
			return result(1);
		},
	});
	qualityGate(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	for (let i = 0; i < 5; i += 1) {
		diff = `diff-${i + 1}`;
		await harness.emit({ type: "agent_end", messages: [] } as any);
	}
	assert.equal(harness.messages.length, 0, "no corrective follow-up is ever queued, no matter how many times it fails");
	const verificationTraces = harness.entries.filter((entry) => (entry.data as any)?.event === "verification");
	assert.equal(verificationTraces.length, 5, "every materially distinct failing diff gets its own trace entry");
	assert.ok(
		verificationTraces.every((entry) => (entry.data as any)?.outcome === "fail"),
		"all five are recorded as failing",
	);
	assert.ok(
		verificationTraces.every((entry) => String((entry.data as any)?.metadata?.failureExcerpt ?? "").includes("something broke")),
		"the failure text is carried in the trace, the only remaining channel a human can read it from",
	);
});

test("a stale extension context during tool_result does not crash the turn", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-gate-stale-tool-"));
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "rev-parse") return result(0, "base\n");
			if (command === "git") throw new Error("This extension ctx is stale after session replacement or reload.");
			return result(1);
		},
	});
	qualityGate(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	await assert.doesNotReject(
		harness.emit({ type: "tool_result", toolCallId: "v1", toolName: "bash", input: { command: "make verify" }, content: [], details: {}, isError: false } as any),
	);
});

test("a stale extension context during agent_end does not crash the turn", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-gate-stale-settle-"));
	await writeFile(join(cwd, "Makefile"), "verify:\n\t@true\n");
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "rev-parse") return result(0, "base\n");
			if (command === "git" && args[0] === "diff") return result(0, "diff");
			if (command === "git" && args[0] === "status") throw new Error("This extension ctx is stale after session replacement or reload.");
			return result(1);
		},
	});
	qualityGate(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	await assert.doesNotReject(harness.emit({ type: "agent_end", messages: [] } as any));
});

test("a bare go test cannot satisfy a canonical command that also requires go vet", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-gate-govet-"));
	await writeFile(join(cwd, "go.mod"), "module example.test\n");
	let bashCalls = 0;
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "rev-parse") return result(0, "base\n");
			if (command === "git" && args[0] === "diff") return result(0, "diff");
			if (command === "git" && args[0] === "status") return result(0, " M main.go\n");
			if (command === "bash") {
				bashCalls += 1;
				return result(0);
			}
			return result(1);
		},
	});
	qualityGate(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	// The model ran only `go test ./...` directly; the resolved canonical
	// command for a bare go.mod project is `go vet ./... && go test ./...`,
	// so this must not be accepted as passing evidence on its own.
	await harness.emit({ type: "tool_result", toolCallId: "v1", toolName: "bash", input: { command: "go test ./..." }, content: [], details: {}, isError: false } as any);
	await harness.emit({ type: "agent_end", messages: [] } as any);
	// Evidence from the partial command was rejected, so settle had to run
	// the full canonical command itself.
	assert.equal(bashCalls, 1);
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
	await harness.emit({ type: "agent_end", messages: [] } as any);
	assert.equal(harness.entries.some((entry) => (entry.data as any)?.outcome === "unconfigured"), true);
});
