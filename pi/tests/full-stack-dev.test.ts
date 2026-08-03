import assert from "node:assert/strict";
import test from "node:test";
import fullStackDev from "../extensions/full-stack-dev.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

test("preserves and deduplicates active tools", async () => {
	const harness = new ExtensionHarness({ activeTools: ["read", "custom"] });
	fullStackDev(harness.api);
	await harness.emit({ type: "session_start" } as any);
	assert.deepEqual(harness.getActiveTools(), ["read", "custom", "edit", "write", "find", "grep", "bash"]);
});

test("chains the workflow prompt after the existing prompt", async () => {
	const harness = new ExtensionHarness();
	fullStackDev(harness.api);
	const [result] = await harness.emit({ type: "before_agent_start", prompt: "x", systemPrompt: "base", systemPromptOptions: {} } as any);
	assert.match((result as { systemPrompt: string }).systemPrompt, /^base[\s\S]*Strict autonomous/);
});
