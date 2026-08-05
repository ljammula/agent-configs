import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
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

test("recognizes go test with allowlisted non-narrowing flags", () => {
	assert.equal(isBroadVerificationCommand("go test -race ./..."), true);
	assert.equal(isBroadVerificationCommand("go test -race -v ./..."), true);
	assert.equal(isBroadVerificationCommand("go test -count=1 ./..."), true);
	assert.equal(isBroadVerificationCommand("go test -timeout=60s ./..."), true);
	assert.equal(isBroadVerificationCommand("go test -timeout 60s ./..."), true);
	assert.equal(isBroadVerificationCommand("go test -parallel=4 ./..."), true);
});

test("does not recognize go test flags that narrow test scope", () => {
	assert.equal(isBroadVerificationCommand("go test -run TestFoo ./..."), false);
	assert.equal(isBroadVerificationCommand("go test -short ./..."), false);
	assert.equal(isBroadVerificationCommand("go test -list . ./..."), false);
});

test("recognizes plain dart test alongside flutter test", () => {
	assert.equal(isBroadVerificationCommand("dart test"), true);
	assert.equal(isBroadVerificationCommand("flutter test"), true);
});

test("recognizes make test and make check alongside make verify", () => {
	assert.equal(isBroadVerificationCommand("make test"), true);
	assert.equal(isBroadVerificationCommand("make check"), true);
	assert.equal(isBroadVerificationCommand("make build"), false);
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

test("snapshot hashes a symlink target without following its outside content", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-snapshot-link-"));
	const outside = join(await mkdtemp(join(tmpdir(), "pi-snapshot-outside-")), "secret.txt");
	await writeFile(outside, "secret one");
	await symlink(outside, join(cwd, "linked-secret"));
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ args }) => args[0] === "diff"
			? { code: 0, stdout: "", stderr: "", killed: false }
			: { code: 0, stdout: "?? linked-secret\0", stderr: "", killed: false },
	});
	const first = await snapshotDiff(harness.api, cwd, "base");
	await writeFile(outside, "secret two");
	const second = await snapshotDiff(harness.api, cwd, "base");
	assert.equal(first.hash, second.hash);
});

test("verification resolution prefers make verify", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-verify-"));
	await writeFile(join(cwd, "Makefile"), "verify:\n\tgo test ./...\n");
	await writeFile(join(cwd, "go.mod"), "module example.test\n");
	assert.equal(await resolveVerificationCommand(cwd), "make verify");
});

test("verification resolution recognizes make test when there is no verify target", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-make-test-"));
	await writeFile(join(cwd, "Makefile"), "test:\n\tgo test ./...\n");
	await writeFile(join(cwd, "go.mod"), "module example.test\n");
	assert.equal(await resolveVerificationCommand(cwd), "make test");
});

test("verification resolution recognizes make check when there is no verify or test target", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-make-check-"));
	await writeFile(join(cwd, "Makefile"), "check:\n\tgo vet ./... && go test ./...\n");
	assert.equal(await resolveVerificationCommand(cwd), "make check");
});

test("verification resolution still prefers make verify over make test when both exist", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-make-both-"));
	await writeFile(join(cwd, "Makefile"), "test:\n\tgo test ./...\nverify: test\n\tgo vet ./...\n");
	assert.equal(await resolveVerificationCommand(cwd), "make verify");
});

test("verification resolution falls back to manifests and can stay unconfigured", async () => {
	const go = await mkdtemp(join(tmpdir(), "pi-go-"));
	await writeFile(join(go, "go.mod"), "module example.test\n");
	assert.equal(await resolveVerificationCommand(go), "go test ./...");
	const empty = await mkdtemp(join(tmpdir(), "pi-empty-"));
	assert.equal(await resolveVerificationCommand(empty), undefined);
});

test("verification resolution finds nested manifests when the root has none", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-nested-"));
	await mkdir(join(cwd, "go"), { recursive: true });
	await writeFile(join(cwd, "go", "go.mod"), "module example.test\n");
	await mkdir(join(cwd, "flutter_app"), { recursive: true });
	await writeFile(
		join(cwd, "flutter_app", "pubspec.yaml"),
		"name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
	);
	assert.equal(
		await resolveVerificationCommand(cwd),
		"(cd 'flutter_app' && flutter test ) && (cd 'go' && go test ./... )",
	);
});

test("a pubspec.yaml without the flutter SDK dependency resolves to dart test, not flutter test", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-plain-dart-"));
	await writeFile(join(cwd, "pubspec.yaml"), "name: a_dart_library\ndependencies:\n  http: ^1.2.0\n");
	assert.equal(await resolveVerificationCommand(cwd), "dart test");
});

test("nested manifest scan picks dart test for a plain-Dart package next to a Go module", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-nested-plain-dart-"));
	await mkdir(join(cwd, "server"), { recursive: true });
	await writeFile(join(cwd, "server", "go.mod"), "module example.test\n");
	await mkdir(join(cwd, "client"), { recursive: true });
	await writeFile(join(cwd, "client", "pubspec.yaml"), "name: client\ndependencies:\n  http: ^1.2.0\n");
	assert.equal(
		await resolveVerificationCommand(cwd),
		"(cd 'client' && dart test ) && (cd 'server' && go test ./... )",
	);
});

test("verification resolution ignores build and dependency trees while scanning nested manifests", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-nested-ignored-"));
	await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true });
	await writeFile(join(cwd, "node_modules", "pkg", "package.json"), "{}\n");
	assert.equal(await resolveVerificationCommand(cwd), undefined);
});
