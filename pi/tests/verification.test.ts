import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	evidencePassesCurrentDiff,
	isBroadVerificationCommand,
	resolveVerificationCommand,
	snapshotDiff,
	verificationPipelineCanMaskFailure,
} from "../extensions/lib/verification.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

test("recognizes broad project verification commands", () => {
	assert.equal(isBroadVerificationCommand("make verify"), true);
	assert.equal(isBroadVerificationCommand("go test ./..."), true);
	assert.equal(isBroadVerificationCommand("gofmt -w main.go"), false);
});

test("piped verification is inconclusive unless pipefail is set", () => {
	assert.equal(verificationPipelineCanMaskFailure("go test ./... | tail -20"), true);
	assert.equal(verificationPipelineCanMaskFailure("set -o pipefail; go test ./... | tail -20"), false);
	assert.equal(verificationPipelineCanMaskFailure("echo 'go test ./... | tail'"), false);
});

test("shell control flow cannot disguise a failed verification exit", () => {
	assert.equal(verificationPipelineCanMaskFailure("npm test; echo EXIT=$?"), true);
	assert.equal(verificationPipelineCanMaskFailure("npm test || true"), true);
	assert.equal(verificationPipelineCanMaskFailure("! npm test"), true);
	assert.equal(verificationPipelineCanMaskFailure("npm test & echo waiting"), true);
	assert.equal(verificationPipelineCanMaskFailure("npm test 2>&1"), false);
	assert.equal(verificationPipelineCanMaskFailure("npm test; # trailing separator"), false);
	assert.equal(verificationPipelineCanMaskFailure("npm test && echo passed"), false);
});

test("only evidence for the current non-truncated diff passes", () => {
	const evidence = { command: "make verify", diffHash: "a", startedAt: 1, endedAt: 2, exitCode: 0, truncated: false };
	assert.equal(evidencePassesCurrentDiff(evidence, { hash: "a", material: true }), true);
	assert.equal(evidencePassesCurrentDiff(evidence, { hash: "b", material: true }), false);
	assert.equal(evidencePassesCurrentDiff({ ...evidence, truncated: true }, { hash: "a", material: true }), false);
	assert.equal(evidencePassesCurrentDiff(evidence, { hash: "a", material: false }), false);
});

test("snapshot identity changes with untracked content and sees committed-since-base diffs", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-snapshot-"));
	const path = join(cwd, "new file.txt");
	await writeFile(path, "one");
	const untrackedHarness = new ExtensionHarness({
		cwd,
		exec: ({ args }) => args[0] === "diff"
			? { code: 0, stdout: "", stderr: "", killed: false }
			: { code: 0, stdout: "?? new file.txt\0", stderr: "", killed: false },
	});
	const first = await snapshotDiff(untrackedHarness.api, cwd, "base");
	await writeFile(path, "two");
	const second = await snapshotDiff(untrackedHarness.api, cwd, "base");
	assert.equal(first.material, true);
	assert.notEqual(first.hash, second.hash);

	const committedHarness = new ExtensionHarness({
		cwd,
		exec: ({ args }) => args[0] === "diff"
			? { code: 0, stdout: "committed diff", stderr: "", killed: false }
			: { code: 0, stdout: "", stderr: "", killed: false },
	});
	assert.equal((await snapshotDiff(committedHarness.api, cwd, "base")).material, true);
});

test("verification resolution prefers make verify", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-verify-"));
	await writeFile(join(cwd, "Makefile"), "verify:\n\tgo test ./...\n");
	await writeFile(join(cwd, "go.mod"), "module example.test\n");
	assert.equal(await resolveVerificationCommand(cwd), "make verify");
});

test("verification resolution falls back to manifests and can stay unconfigured", async () => {
	const go = await mkdtemp(join(tmpdir(), "pi-go-"));
	await writeFile(join(go, "go.mod"), "module example.test\n");
	assert.equal(await resolveVerificationCommand(go), "go test ./...");
	const empty = await mkdtemp(join(tmpdir(), "pi-empty-"));
	assert.equal(await resolveVerificationCommand(empty), undefined);
});
