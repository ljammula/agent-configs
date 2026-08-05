import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import newProjectScaffold from "../extensions/new-project-scaffold.ts";
import { ExtensionHarness, type ExecCall } from "./extension-api-harness.ts";

function result(code: number, stdout = "") {
	return { code, stdout, stderr: "", killed: false };
}

test("nudges git-init, an initial commit, and up-front architecture when no repo exists", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-scaffold-norepo-"));
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) =>
			command === "git" && args[0] === "rev-parse" ? result(128, "") : result(1),
	});
	newProjectScaffold(harness.api);
	const [outcome] = await harness.emit({ type: "before_agent_start", systemPrompt: "base" } as any);
	assert.match((outcome as { systemPrompt: string }).systemPrompt, /git init/);
	assert.match((outcome as { systemPrompt: string }).systemPrompt, /initial commit/);
	assert.match((outcome as { systemPrompt: string }).systemPrompt, /internal\/domain/);
	assert.match((outcome as { systemPrompt: string }).systemPrompt, /README\.md/);
});

test("stays silent once a repo and README both already exist", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-scaffold-ready-"));
	await writeFile(join(cwd, "README.md"), "# ready\n");
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => (command === "git" && args[0] === "rev-parse" ? result(0, cwd) : result(1)),
	});
	newProjectScaffold(harness.api);
	const [outcome] = await harness.emit({ type: "before_agent_start", systemPrompt: "base" } as any);
	assert.equal(outcome, undefined);
});

test("only nudges the missing README when a repo already exists", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-scaffold-noreadme-"));
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => (command === "git" && args[0] === "rev-parse" ? result(0, cwd) : result(1)),
	});
	newProjectScaffold(harness.api);
	const [outcome] = await harness.emit({ type: "before_agent_start", systemPrompt: "base" } as any);
	assert.match((outcome as { systemPrompt: string }).systemPrompt, /README\.md/);
	assert.doesNotMatch((outcome as { systemPrompt: string }).systemPrompt, /git init/);
});
