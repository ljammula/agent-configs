import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import makefileScaffoldNudge from "../extensions/makefile-scaffold-nudge.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

test("nudges a Makefile wired to the resolved command when none exists", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-makefile-nudge-"));
	await writeFile(join(cwd, "go.mod"), "module example.test\n");
	const harness = new ExtensionHarness({ cwd });
	makefileScaffoldNudge(harness.api);
	const [outcome] = await harness.emit({ type: "before_agent_start", systemPrompt: "base" } as any);
	const prompt = (outcome as { systemPrompt: string }).systemPrompt;
	assert.match(prompt, /go vet .\/\.\.\. && go test .\/\.\.\./);
	assert.match(prompt, /`test`/);
	assert.match(prompt, /`lint`/);
	assert.match(prompt, /`verify`/);
});

test("stays silent when a Makefile already exists", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-makefile-has-one-"));
	await writeFile(join(cwd, "Makefile"), "verify:\n\t@true\n");
	await writeFile(join(cwd, "go.mod"), "module example.test\n");
	const harness = new ExtensionHarness({ cwd });
	makefileScaffoldNudge(harness.api);
	const [outcome] = await harness.emit({ type: "before_agent_start", systemPrompt: "base" } as any);
	assert.equal(outcome, undefined);
});

test("stays silent when a verification command is already documented", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-makefile-documented-"));
	await writeFile(join(cwd, "go.mod"), "module example.test\n");
	await writeFile(join(cwd, "README.md"), "Run the test command: `go test ./...`\n");
	const harness = new ExtensionHarness({ cwd });
	makefileScaffoldNudge(harness.api);
	const [outcome] = await harness.emit({ type: "before_agent_start", systemPrompt: "base" } as any);
	assert.equal(outcome, undefined);
});

test("stays silent when nothing is resolvable to scaffold from", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-makefile-empty-"));
	const harness = new ExtensionHarness({ cwd });
	makefileScaffoldNudge(harness.api);
	const [outcome] = await harness.emit({ type: "before_agent_start", systemPrompt: "base" } as any);
	assert.equal(outcome, undefined);
});
