import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import makefileScaffoldNudge from "../extensions/makefile-scaffold-nudge.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

test("nudges a Makefile wired to the resolved command when a manifest already exists", async () => {
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

test("gives conditional guidance instead of staying silent when nothing is resolvable yet", async () => {
	// This is the greenfield case: before_agent_start fires once, before any
	// files exist, so there's nothing to resolve a concrete command from.
	// Staying fully silent here was the bug a live test caught -- the
	// precondition is never re-evaluated once go.mod appears mid-session.
	const cwd = await mkdtemp(join(tmpdir(), "pi-makefile-empty-"));
	const harness = new ExtensionHarness({ cwd });
	makefileScaffoldNudge(harness.api);
	const [outcome] = await harness.emit({ type: "before_agent_start", systemPrompt: "base" } as any);
	const prompt = (outcome as { systemPrompt: string }).systemPrompt;
	assert.match(prompt, /no build\/dependency manifest yet/);
	assert.match(prompt, /go\.mod/);
});

test("backstop: nudges once a manifest is written mid-session and the next turn ends", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-makefile-backstop-"));
	const harness = new ExtensionHarness({ cwd });
	makefileScaffoldNudge(harness.api);
	await harness.emit({ type: "before_agent_start", systemPrompt: "base" } as any);
	assert.equal(harness.messages.length, 0);

	// The manifest doesn't exist on disk until the model's write actually
	// lands -- write it before emitting tool_result, mirroring real timing.
	await writeFile(join(cwd, "go.mod"), "module example.test\n");
	await harness.emit({
		type: "tool_result",
		toolCallId: "w1",
		toolName: "write",
		input: { path: join(cwd, "go.mod"), content: "module example.test\n" },
		content: [],
		isError: false,
	} as any);
	assert.equal(harness.messages.length, 0, "must not nudge mid-turn, only at the next turn boundary");

	await harness.emit({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] } as any);
	assert.equal(harness.messages.length, 1);
	assert.match(String(harness.messages[0]?.content), /go vet .\/\.\.\. && go test .\/\.\.\./);
});

test("backstop does not nudge twice, and does not re-arm without a new manifest write", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-makefile-backstop-once-"));
	const harness = new ExtensionHarness({ cwd });
	makefileScaffoldNudge(harness.api);
	await harness.emit({ type: "before_agent_start", systemPrompt: "base" } as any);

	await writeFile(join(cwd, "go.mod"), "module example.test\n");
	await harness.emit({
		type: "tool_result",
		toolCallId: "w1",
		toolName: "write",
		input: { path: join(cwd, "go.mod"), content: "module example.test\n" },
		content: [],
		isError: false,
	} as any);
	await harness.emit({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] } as any);
	assert.equal(harness.messages.length, 1);

	// A later, unrelated turn_end (no new manifest write armed it) must not
	// nudge again.
	await harness.emit({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [] } as any);
	assert.equal(harness.messages.length, 1);
});

test("backstop stays silent if a Makefile already exists by the time the manifest lands", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-makefile-backstop-has-makefile-"));
	await writeFile(join(cwd, "Makefile"), "verify:\n\t@true\n");
	const harness = new ExtensionHarness({ cwd });
	makefileScaffoldNudge(harness.api);
	await harness.emit({ type: "before_agent_start", systemPrompt: "base" } as any);

	await writeFile(join(cwd, "go.mod"), "module example.test\n");
	await harness.emit({
		type: "tool_result",
		toolCallId: "w1",
		toolName: "write",
		input: { path: join(cwd, "go.mod"), content: "module example.test\n" },
		content: [],
		isError: false,
	} as any);
	await harness.emit({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] } as any);
	assert.equal(harness.messages.length, 0);
});

test("backstop also arms on a bash manifest-creating command, not only the write tool", async () => {
	// The exact real scenario: the model ran `git init && go mod init
	// todo-go` via bash, never the write tool, to create go.mod.
	const cwd = await mkdtemp(join(tmpdir(), "pi-makefile-backstop-bash-"));
	const harness = new ExtensionHarness({ cwd });
	makefileScaffoldNudge(harness.api);
	await harness.emit({ type: "before_agent_start", systemPrompt: "base" } as any);

	await writeFile(join(cwd, "go.mod"), "module todo-go\n");
	await harness.emit({
		type: "tool_result",
		toolCallId: "b1",
		toolName: "bash",
		input: { command: "git init && go mod init todo-go" },
		content: [],
		isError: false,
	} as any);
	await harness.emit({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] } as any);
	assert.equal(harness.messages.length, 1);
	assert.match(String(harness.messages[0]?.content), /go vet .\/\.\.\. && go test .\/\.\.\./);
});

test("backstop does not arm on an unrelated bash command", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-makefile-backstop-bash-unrelated-"));
	const harness = new ExtensionHarness({ cwd });
	makefileScaffoldNudge(harness.api);
	await harness.emit({ type: "before_agent_start", systemPrompt: "base" } as any);
	await harness.emit({
		type: "tool_result",
		toolCallId: "b1",
		toolName: "bash",
		input: { command: "ls -la" },
		content: [],
		isError: false,
	} as any);
	await harness.emit({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] } as any);
	assert.equal(harness.messages.length, 0);
});
