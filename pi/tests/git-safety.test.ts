import assert from "node:assert/strict";
import test from "node:test";
import gitSafety from "../extensions/git-safety.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

test("blocks documented destructive commands inside chains and rtk rewrites", async () => {
	const harness = new ExtensionHarness();
	gitSafety(harness.api);
	for (const command of [
		"git reset --hard main",
		"echo x && rtk git push --force origin main",
		"git clean -fd",
		"git branch -D old",
		"git restore -- .",
	]) {
		const [result] = await harness.emit({ type: "tool_call", toolCallId: command, toolName: "bash", input: { command } } as any);
		assert.equal((result as { block: boolean }).block, true, command);
	}
});

test("allows safe git inspection and force-with-lease", async () => {
	const harness = new ExtensionHarness();
	gitSafety(harness.api);
	for (const command of ["git status", "git diff", "git push --force-with-lease origin branch"]) {
		const [result] = await harness.emit({ type: "tool_call", toolCallId: command, toolName: "bash", input: { command } } as any);
		assert.equal(result, undefined, command);
	}
});
