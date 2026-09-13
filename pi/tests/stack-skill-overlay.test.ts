import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import stackSkillOverlay, { resolveStackSkillsRoot } from "../extensions/stack-skill-overlay.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

async function fixture(files: Record<string, string>): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stack-overlay-"));
	for (const [name, content] of Object.entries(files)) {
		await mkdir(join(cwd, name, ".."), { recursive: true });
		await writeFile(join(cwd, name), content);
	}
	return cwd;
}

test("skill root follows the extension symlink back to repository source", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stack-overlay-link-"));
	const installed = join(root, "agent", "extensions");
	await mkdir(installed, { recursive: true });
	const source = join(import.meta.dirname, "..", "extensions", "stack-skill-overlay.ts");
	const link = join(installed, "stack-skill-overlay.ts");
	await symlink(source, link);
	// `source` itself may be a symlink now (pi-harness-hardening is this
	// extension's authoritative source; agent-configs/pi/extensions/ links
	// into it) -- resolve to where the file actually lives before deriving
	// the expected skills root, same as resolveStackSkillsRoot itself does.
	const realSource = await realpath(source);
	assert.equal(await resolveStackSkillsRoot(link), join(realSource, "..", "..", "skills"));
});

test("a repo with no stack evidence receives no skill paths", async () => {
	const cwd = await fixture({ "readme.txt": "no manifest here" });
	const harness = new ExtensionHarness({ cwd });
	stackSkillOverlay(harness.api);
	const [result] = await harness.emit({ type: "resources_discover", cwd, reason: "startup" } as any);
	assert.equal(result, undefined);
});

test("a Go + Temporal repo gets only the matching stack skill paths", async () => {
	const cwd = await fixture({ "go.mod": "module x\nrequire go.temporal.io/sdk v1.0.0\n" });
	const harness = new ExtensionHarness({ cwd });
	stackSkillOverlay(harness.api);
	const [result] = await harness.emit({ type: "resources_discover", cwd, reason: "startup" } as any);
	const paths = (result as { skillPaths: string[] }).skillPaths;
	assert.equal(paths.length, 2);
	assert.equal(paths.some((path) => path.endsWith("go-service")), true);
	assert.equal(paths.some((path) => path.endsWith("temporal-go")), true);
	assert.equal(paths.some((path) => path.endsWith("kafka-processing")), false);
});
