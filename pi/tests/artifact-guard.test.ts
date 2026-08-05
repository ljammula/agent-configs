import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import artifactGuard, { findLargeOrBinaryArtifacts } from "../extensions/artifact-guard.ts";
import { ExtensionHarness, type ExecCall } from "./extension-api-harness.ts";

function statusResult(entries: string[]) {
	return { code: 0, stdout: entries.map((entry) => `?? ${entry}\0`).join(""), stderr: "", killed: false };
}

test("flags an untracked file over the size threshold", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-artifact-big-"));
	await writeFile(join(cwd, "backend"), Buffer.alloc(1_100_000));
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) =>
			command === "git" && args[0] === "status" ? statusResult(["backend"]) : { code: 1, stdout: "", stderr: "", killed: false },
	});
	const flagged = await findLargeOrBinaryArtifacts(harness.api, cwd);
	assert.equal(flagged.length, 1);
	assert.equal(flagged[0]?.path, "backend");
	assert.match(flagged[0]?.reason ?? "", /MB file/);
});

test("flags a staged (not just untracked) oversized file", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-artifact-staged-"));
	await writeFile(join(cwd, "backend"), Buffer.alloc(1_100_000));
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) =>
			command === "git" && args[0] === "status"
				? { code: 0, stdout: "A  backend\0", stderr: "", killed: false }
				: { code: 1, stdout: "", stderr: "", killed: false },
	});
	const flagged = await findLargeOrBinaryArtifacts(harness.api, cwd);
	assert.equal(flagged.length, 1);
	assert.equal(flagged[0]?.path, "backend");
});

test("ignores renamed and deleted entries rather than misreading their paths", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-artifact-renamed-"));
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) =>
			command === "git" && args[0] === "status"
				? { code: 0, stdout: "R  new.txt\0old.txt\0D  gone.txt\0", stderr: "", killed: false }
				: { code: 1, stdout: "", stderr: "", killed: false },
	});
	assert.deepEqual(await findLargeOrBinaryArtifacts(harness.api, cwd), []);
});

test("flags an untracked ELF binary under the size threshold by magic bytes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-artifact-elf-"));
	await writeFile(join(cwd, "tool"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]));
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) =>
			command === "git" && args[0] === "status" ? statusResult(["tool"]) : { code: 1, stdout: "", stderr: "", killed: false },
	});
	const flagged = await findLargeOrBinaryArtifacts(harness.api, cwd);
	assert.equal(flagged.length, 1);
	assert.equal(flagged[0]?.reason, "ELF executable");
});

test("ignores small, non-executable untracked files", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-artifact-clean-"));
	await writeFile(join(cwd, "notes.txt"), "just some notes");
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) =>
			command === "git" && args[0] === "status" ? statusResult(["notes.txt"]) : { code: 1, stdout: "", stderr: "", killed: false },
	});
	assert.deepEqual(await findLargeOrBinaryArtifacts(harness.api, cwd), []);
});

test("sends exactly one corrective nudge for a repeated unresolved finding, then stops once resolved", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-artifact-nudge-"));
	await writeFile(join(cwd, "backend"), Buffer.alloc(1_100_000));
	let stillPresent = true;
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "status") return stillPresent ? statusResult(["backend"]) : statusResult([]);
			return { code: 1, stdout: "", stderr: "", killed: false };
		},
	});
	artifactGuard(harness.api);
	await harness.emit({ type: "agent_settled" } as any);
	await harness.emit({ type: "agent_settled" } as any);
	assert.equal(harness.messages.length, 1);
	stillPresent = false;
	await harness.emit({ type: "agent_settled" } as any);
	await writeFile(join(cwd, "backend"), Buffer.alloc(1_100_000));
	stillPresent = true;
	await harness.emit({ type: "agent_settled" } as any);
	assert.equal(harness.messages.length, 2);
});
