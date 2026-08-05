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

test("tool_result on a build command flags the artifact it just produced, in-band", async () => {
	// The exact scenario a live test found broken: agent_settled fires once,
	// after the model's own commit, so a build artifact created and
	// committed mid-session was invisible to the settle-only check. This
	// hook catches it the moment the build command that made it runs.
	const cwd = await mkdtemp(join(tmpdir(), "pi-artifact-build-"));
	await writeFile(join(cwd, "backend"), Buffer.alloc(1_100_000));
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) =>
			command === "git" && args[0] === "status" ? statusResult(["backend"]) : { code: 1, stdout: "", stderr: "", killed: false },
	});
	artifactGuard(harness.api);
	const [outcome] = await harness.emit({
		type: "tool_result",
		toolCallId: "b1",
		toolName: "bash",
		input: { command: "go build -o backend ./cmd/server" },
		content: [{ type: "text", text: "" }],
		isError: false,
	} as any);
	assert.match(
		String((outcome as { content: { text: string }[] }).content[1]?.text ?? ""),
		/backend.*MB file/,
	);
});

test("tool_result on a non-build bash command stays silent", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-artifact-nonbuild-"));
	await writeFile(join(cwd, "backend"), Buffer.alloc(1_100_000));
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) =>
			command === "git" && args[0] === "status" ? statusResult(["backend"]) : { code: 1, stdout: "", stderr: "", killed: false },
	});
	artifactGuard(harness.api);
	const [outcome] = await harness.emit({
		type: "tool_result",
		toolCallId: "b1",
		toolName: "bash",
		input: { command: "go test ./..." },
		content: [],
		isError: false,
	} as any);
	assert.equal(outcome, undefined);
});

test("committed-since-baseSha paths are checked even once the working tree is clean", async () => {
	// A build artifact that got `git add -A && git commit`ed is no longer
	// untracked or modified -- but it's still on disk, and it's still a
	// path that changed between the session's baseSha and HEAD.
	const cwd = await mkdtemp(join(tmpdir(), "pi-artifact-committed-"));
	await writeFile(join(cwd, "backend"), Buffer.alloc(1_100_000));
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "base-sha\n", stderr: "", killed: false };
			if (command === "git" && args[0] === "status") return statusResult([]); // clean: already committed
			if (command === "git" && args[0] === "diff") return { code: 0, stdout: "backend\n", stderr: "", killed: false };
			return { code: 1, stdout: "", stderr: "", killed: false };
		},
	});
	artifactGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	await harness.emit({ type: "agent_settled" } as any);
	assert.equal(harness.messages.length, 1);
	assert.match(String(harness.messages[0]?.content), /backend/);
});

test("committed-since check still works when baseSha was never captured (unborn HEAD at agent_start)", async () => {
	// The greenfield case this fix specifically targets: git init + first
	// commit both happen mid-session, so agent_start's rev-parse HEAD fails
	// and baseSha stays undefined for the rest of the session. Without an
	// empty-tree fallback, committedSincePaths silently no-ops forever.
	const cwd = await mkdtemp(join(tmpdir(), "pi-artifact-unborn-"));
	await writeFile(join(cwd, "backend"), Buffer.alloc(1_100_000));
	let diffTarget: string | undefined;
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "rev-parse") return { code: 128, stdout: "", stderr: "unknown revision", killed: false };
			if (command === "git" && args[0] === "status") return statusResult([]);
			if (command === "git" && args[0] === "diff") {
				diffTarget = args[2];
				return { code: 0, stdout: "backend\n", stderr: "", killed: false };
			}
			return { code: 1, stdout: "", stderr: "", killed: false };
		},
	});
	artifactGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	await harness.emit({ type: "agent_settled" } as any);
	assert.equal(harness.messages.length, 1);
	assert.equal(diffTarget, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
});

test("build-command pattern does not fire on grep/curl/sort's unrelated -o flag", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-artifact-falsepositive-"));
	const harness = new ExtensionHarness({
		cwd,
		exec: () => ({ code: 1, stdout: "", stderr: "", killed: false }),
	});
	artifactGuard(harness.api);
	for (const command of ["grep -o pattern file.txt", "curl -o out.json https://example.com", "sort -o sorted.txt input.txt"]) {
		const [outcome] = await harness.emit({
			type: "tool_result",
			toolCallId: "b1",
			toolName: "bash",
			input: { command },
			content: [],
			isError: false,
		} as any);
		assert.equal(outcome, undefined, command);
	}
});

test("tool_result and agent_settled share dedup: a still-present finding does not double-nudge", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-artifact-shared-dedup-"));
	await writeFile(join(cwd, "backend"), Buffer.alloc(1_100_000));
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) =>
			command === "git" && args[0] === "status" ? statusResult(["backend"]) : { code: 1, stdout: "", stderr: "", killed: false },
	});
	artifactGuard(harness.api);
	const [outcome] = await harness.emit({
		type: "tool_result",
		toolCallId: "b1",
		toolName: "bash",
		input: { command: "go build -o backend ./cmd/server" },
		content: [],
		isError: false,
	} as any);
	assert.notEqual(outcome, undefined);

	await harness.emit({ type: "agent_settled" } as any);
	assert.equal(harness.messages.length, 0, "agent_settled must not re-nudge what tool_result already flagged in-band");
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
