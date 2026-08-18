import assert from "node:assert/strict";
import test from "node:test";
import gitCheckpoint from "../extensions/git-checkpoint.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

test("turn_start captures a checkpoint from a clean repo", async () => {
	const harness = new ExtensionHarness({
		exec: (call) => {
			if (call.args[0] === "rev-parse") return { code: 0, stdout: "deadbeef\n", stderr: "", killed: false };
			if (call.args[0] === "stash") return { code: 0, stdout: "", stderr: "", killed: false }; // clean tree: no stash ref
			if (call.args[0] === "ls-files") return { code: 0, stdout: "", stderr: "", killed: false }; // no untracked files
			return { code: 0, stdout: "", stderr: "", killed: false };
		},
		branch: [{ id: "leaf-1" }],
	});
	gitCheckpoint(harness.api);

	await harness.emit({ type: "turn_start" } as any);

	assert.equal(harness.execCalls.length, 3);
	assert.deepEqual(
		harness.execCalls.map((call) => call.args[0]),
		["rev-parse", "stash", "ls-files"],
	);
});

test("turn_start swallows a stale ctx thrown mid-handler instead of crashing the turn", async () => {
	// Reproduces the live 2026-08-17 hardened-battery finding (pair 7,
	// go/notes-api): a session reload/compaction/fork landing before this
	// handler runs invalidates the captured ctx, and the first synchronous
	// ctx call (ctx.sessionManager.getLeafEntry()) throws Pi's documented
	// stale-context message. pi.exec() itself is already individually
	// `.catch()`-guarded in this extension, so this call site is the one
	// that actually crashed the turn prior to the fix.
	const harness = new ExtensionHarness({ branch: [{ id: "leaf-1" }] });
	(harness.context.sessionManager as any).getLeafEntry = () => {
		throw new Error(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
		);
	};
	gitCheckpoint(harness.api);

	// Must not throw and must not crash the turn.
	await assert.doesNotReject(() => harness.emit({ type: "turn_start" } as any));
});

test("turn_start re-throws a non-stale-context error", async () => {
	const harness = new ExtensionHarness({ branch: [{ id: "leaf-1" }] });
	(harness.context.sessionManager as any).getLeafEntry = () => {
		throw new Error("git binary not found");
	};
	gitCheckpoint(harness.api);

	await assert.rejects(() => harness.emit({ type: "turn_start" } as any), /git binary not found/);
});

test("turn_start is a no-op with no leaf entry", async () => {
	const harness = new ExtensionHarness({ branch: [] });
	gitCheckpoint(harness.api);

	await harness.emit({ type: "turn_start" } as any);

	assert.equal(harness.execCalls.length, 0);
});
