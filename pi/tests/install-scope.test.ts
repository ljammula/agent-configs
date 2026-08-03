import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readlink, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repo = resolve(import.meta.dirname, "../..");

test("installer removes managed DayTrix globals and installs portable Pi skills", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-install-"));
	const skills = join(home, ".pi/agent/skills");
	const extensions = join(home, ".pi/agent/extensions");
	await mkdir(skills, { recursive: true });
	await mkdir(extensions, { recursive: true });
	await symlink(join(repo, "pi/skills/backend-dev"), join(skills, "backend-dev"));
	await symlink(join(repo, "pi/extensions/continuation-nudge.ts"), join(extensions, "continuation-nudge.ts"));
	await symlink(join(repo, "pi/extensions/co-change-suggest.ts"), join(extensions, "co-change-suggest.ts"));
	await execFileAsync("bash", [join(repo, "install.sh"), "--force"], { env: { ...process.env, HOME: home } });
	await assert.rejects(readlink(join(skills, "backend-dev")));
	await assert.rejects(readlink(join(extensions, "continuation-nudge.ts")));
	await assert.rejects(readlink(join(extensions, "co-change-suggest.ts")));
	assert.equal(await readlink(join(skills, "go-service")), join(repo, "pi/skills/go-service"));
	assert.equal(await readlink(join(skills, "before-done")), join(repo, "pi/skills/before-done"));
	assert.equal(await readlink(join(extensions, "quality-gate.ts")), join(repo, "pi/extensions/quality-gate.ts"));
});

test("ordinary upgrades replace known legacy core skill links", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-install-legacy-"));
	const claudeSkills = join(home, ".claude/skills");
	const codexSkills = join(home, ".codex/skills");
	await mkdir(claudeSkills, { recursive: true });
	await mkdir(codexSkills, { recursive: true });
	await symlink(join(repo, "claude/skills/before-done"), join(claudeSkills, "before-done"));
	await symlink(join(repo, "claude/skills/wiring-verify"), join(claudeSkills, "wiring-verify"));
	await symlink(join(repo, "codex/skills/before-done"), join(codexSkills, "before-done"));
	await symlink(join(repo, "codex/skills/wiring-verify"), join(codexSkills, "wiring-verify"));
	await execFileAsync("bash", [join(repo, "install.sh")], { env: { ...process.env, HOME: home } });
	for (const skills of [claudeSkills, codexSkills]) {
		assert.equal(await readlink(join(skills, "before-done")), join(repo, "pi/skills/before-done"));
		assert.equal(await readlink(join(skills, "wiring-verify")), join(repo, "pi/skills/wiring-verify"));
	}
});
