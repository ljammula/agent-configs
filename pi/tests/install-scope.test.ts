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
	await mkdir(skills, { recursive: true });
	await symlink(join(repo, "pi/skills/backend-dev"), join(skills, "backend-dev"));
	await execFileAsync("bash", [join(repo, "install.sh"), "--force"], { env: { ...process.env, HOME: home } });
	await assert.rejects(readlink(join(skills, "backend-dev")));
	assert.equal(await readlink(join(skills, "go-service")), join(repo, "pi/skills/go-service"));
	assert.equal(await readlink(join(skills, "before-done")), join(repo, "pi/skills/before-done"));
});
