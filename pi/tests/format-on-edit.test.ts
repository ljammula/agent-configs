import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import formatOnEdit from "../extensions/format-on-edit.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

test("formats successful Go and Dart mutations only", async () => {
	const harness = new ExtensionHarness();
	formatOnEdit(harness.api);
	await harness.emit({ type: "tool_result", toolCallId: "1", toolName: "write", input: { path: "main.go" }, content: [], details: undefined, isError: false } as any);
	await harness.emit({ type: "tool_result", toolCallId: "2", toolName: "edit", input: { path: "app.dart" }, content: [], details: undefined, isError: false } as any);
	await harness.emit({ type: "tool_result", toolCallId: "3", toolName: "write", input: { path: "bad.go" }, content: [], details: undefined, isError: true } as any);
	assert.deepEqual(harness.execCalls.map((call) => [call.command, ...call.args]), [
		["gofmt", "-w", "/workspace/main.go"],
		["dart", "format", "/workspace/app.dart"],
	]);
});

test("runs the repo's installed prettier on TS/JS mutations", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-format-"));
	await mkdir(join(cwd, "node_modules", ".bin"), { recursive: true });
	await writeFile(join(cwd, "node_modules", ".bin", "prettier"), "#!/bin/sh\n");
	const harness = new ExtensionHarness({ cwd });
	formatOnEdit(harness.api);
	await harness.emit({ type: "tool_result", toolCallId: "1", toolName: "write", input: { path: "src/app.tsx" }, content: [], details: undefined, isError: false } as any);
	await harness.emit({ type: "tool_result", toolCallId: "2", toolName: "edit", input: { path: "src/util.js" }, content: [], details: undefined, isError: false } as any);
	assert.deepEqual(harness.execCalls.map((call) => [call.command, ...call.args]), [
		[join(cwd, "node_modules", ".bin", "prettier"), "--write", join(cwd, "src/app.tsx")],
		[join(cwd, "node_modules", ".bin", "prettier"), "--write", join(cwd, "src/util.js")],
	]);
});

test("skips TS/JS formatting silently when prettier isn't installed", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-format-noprettier-"));
	const harness = new ExtensionHarness({ cwd });
	formatOnEdit(harness.api);
	await harness.emit({ type: "tool_result", toolCallId: "1", toolName: "write", input: { path: "src/app.ts" }, content: [], details: undefined, isError: false } as any);
	assert.deepEqual(harness.execCalls, []);
});
