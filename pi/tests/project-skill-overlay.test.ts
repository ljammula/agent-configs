import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import projectSkillOverlay, { isDayTrixRemote, resolveProjectSkillsRoot } from "../extensions/project-skill-overlay.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

test("recognizes only the explicit DayTrix repository remote", () => {
	assert.equal(isDayTrixRemote("git@github.com:ljammula/personal-assistant.git"), true);
	assert.equal(isDayTrixRemote("https://github.com/ljammula/personal-assistant"), true);
	assert.equal(isDayTrixRemote("https://github.com/example/backend"), false);
});

test("skill root follows the extension symlink back to repository source", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-overlay-link-"));
	const installed = join(root, "agent", "extensions");
	await mkdir(installed, { recursive: true });
	const source = join(import.meta.dirname, "..", "extensions", "project-skill-overlay.ts");
	const link = join(installed, "project-skill-overlay.ts");
	await symlink(source, link);
	assert.equal(await resolveProjectSkillsRoot(link), join(import.meta.dirname, "..", "skills"));
});

test("unrelated repositories receive no DayTrix skill paths", async () => {
	const harness = new ExtensionHarness({ exec: () => ({ code: 0, stdout: "https://github.com/example/backend.git\n", stderr: "", killed: false }) });
	projectSkillOverlay(harness.api);
	const [result] = await harness.emit({ type: "resources_discover", cwd: "/workspace", reason: "startup" } as any);
	assert.equal(result, undefined);
});

test("DayTrix keeps its project-scoped workflows", async () => {
	const harness = new ExtensionHarness({ exec: () => ({ code: 0, stdout: "git@github.com:ljammula/personal-assistant.git\n", stderr: "", killed: false }) });
	projectSkillOverlay(harness.api);
	const [result] = await harness.emit({ type: "resources_discover", cwd: "/workspace", reason: "startup" } as any);
	const paths = (result as { skillPaths: string[] }).skillPaths;
	assert.equal(paths.some((path) => path.endsWith("backend-dev")), true);
	assert.equal(paths.some((path) => path.endsWith("release")), true);
});
