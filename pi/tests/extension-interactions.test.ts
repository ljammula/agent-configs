import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fullStack from "../extensions/full-stack-dev.ts";
import guardrail from "../extensions/karpathy-guardrail.ts";
import stackRouter from "../extensions/stack-router.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

test("prompt extensions chain without replacing prior instructions", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-chain-"));
	await writeFile(join(cwd, "go.mod"), "module x\n");
	const harness = new ExtensionHarness({ cwd });
	guardrail(harness.api);
	fullStack(harness.api);
	stackRouter(harness.api);
	let prompt = "base";
	for (const handler of harness.handlers.get("before_agent_start") ?? []) {
		const result = await handler({ type: "before_agent_start", prompt: "task", systemPrompt: prompt, systemPromptOptions: {} }, harness.context) as { systemPrompt?: string } | undefined;
		prompt = result?.systemPrompt ?? prompt;
	}
	assert.match(prompt, /^base/);
	assert.match(prompt, /karpathy-guidelines/);
	assert.match(prompt, /Strict autonomous/);
	assert.match(prompt, /go-service/);
});
