import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import protectedPaths from "../extensions/protected-paths.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "pi-paths-"));
	const cwd = join(root, "workspace");
	const outside = join(root, "outside");
	await mkdir(cwd);
	await mkdir(outside);
	const harness = new ExtensionHarness({ cwd });
	protectedPaths(harness.api);
	return { harness, cwd, outside };
}

test("allows ordinary writes inside the real workspace", async () => {
	const { harness } = await setup();
	const [result] = await harness.emit({ type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "src/app.ts", content: "x" } } as any);
	assert.equal(result, undefined);
});

test("blocks traversal, protected files, and symlink escapes", async () => {
	const { harness, cwd, outside } = await setup();
	await symlink(outside, join(cwd, "escape"));
	for (const path of ["../outside/x", ".env", "escape/secret.txt"]) {
		const [result] = await harness.emit({ type: "tool_call", toolCallId: path, toolName: "write", input: { path, content: "x" } } as any);
		assert.equal((result as { block: boolean }).block, true, path);
	}
});

test("blocks an in-workspace symlink to a protected file", async () => {
	const { harness, cwd } = await setup();
	await writeFile(join(cwd, ".env"), "SECRET=x\n");
	await symlink(join(cwd, ".env"), join(cwd, "alias.txt"));
	const [result] = await harness.emit({ type: "tool_call", toolCallId: "alias", toolName: "edit", input: { path: "alias.txt" } } as any);
	assert.equal((result as { block: boolean }).block, true);
});
