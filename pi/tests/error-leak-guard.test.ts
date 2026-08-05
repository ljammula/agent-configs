import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import errorLeakGuard, { collectErrorLeaks, findErrorLeaksInDiff, findErrorLeaksInFile } from "../extensions/error-leak-guard.ts";
import { ExtensionHarness, type ExecCall } from "./extension-api-harness.ts";

function result(code: number, stdout = "") {
	return { code, stdout, stderr: "", killed: false };
}

test("findErrorLeaksInDiff flags err.Error() written directly into an http.Error response, attributed to its file", () => {
	const diff = [
		"diff --git a/main.go b/main.go",
		"+++ b/main.go",
		"@@ -1,1 +1,1 @@",
		"+\thttp.Error(w, err.Error(), http.StatusInternalServerError)",
	].join("\n");
	assert.deepEqual(findErrorLeaksInDiff(diff), [
		{ path: "main.go", line: "http.Error(w, err.Error(), http.StatusInternalServerError)" },
	]);
});

test("findErrorLeaksInDiff does not flag error handling mapped to a stable message", () => {
	const diff = ["+++ b/main.go", '+\thttp.Error(w, "todo not found", http.StatusNotFound)'].join("\n");
	assert.deepEqual(findErrorLeaksInDiff(diff), []);
});

test("findErrorLeaksInDiff ignores removed lines", () => {
	const diff = ["+++ b/main.go", "-\thttp.Error(w, err.Error(), http.StatusInternalServerError)"].join("\n");
	assert.deepEqual(findErrorLeaksInDiff(diff), []);
});

test("findErrorLeaksInFile flags a leak inside a whole untracked file's content", () => {
	const content = 'package main\n\nfunc handle() {\n\thttp.Error(w, err.Error(), 500)\n}\n';
	assert.deepEqual(findErrorLeaksInFile("handler.go", content), [
		{ path: "handler.go", line: "http.Error(w, err.Error(), 500)" },
	]);
});

test("collectErrorLeaks finds a leak in an untracked file, the exact motivating scenario", async () => {
	// A fresh project's files are untracked until `git add` -- `git diff`
	// alone never shows them, which is the bug this test guards against.
	const cwd = await mkdtemp(join(tmpdir(), "pi-error-leak-untracked-"));
	await writeFile(join(cwd, "main.go"), 'package main\n\nfunc handle() {\n\thttp.Error(w, err.Error(), 500)\n}\n');
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "rev-parse") return result(128, "");
			if (command === "git" && args[0] === "diff") return result(0, "");
			if (command === "git" && args[0] === "status") return result(0, "?? main.go\0");
			return result(1);
		},
	});
	const leaks = await collectErrorLeaks(harness.api, cwd);
	assert.equal(leaks.length, 1);
	assert.equal(leaks[0]?.path, "main.go");
});

test("nudges once per distinct leak set and stops once resolved", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-error-leak-"));
	let diff = "+++ b/main.go\n+\thttp.Error(w, err.Error(), http.StatusInternalServerError)\n";
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "rev-parse") return result(0, "abc\n");
			if (command === "git" && args[0] === "diff") return result(0, diff);
			if (command === "git" && args[0] === "status") return result(0, "");
			return result(1);
		},
	});
	errorLeakGuard(harness.api);
	await harness.emit({ type: "agent_settled" } as any);
	await harness.emit({ type: "agent_settled" } as any);
	assert.equal(harness.messages.length, 1);
	assert.match(String(harness.messages[0]?.content), /err\.Error/);

	diff = "+++ b/main.go\n+\thttp.Error(w, \"not found\", http.StatusNotFound)\n";
	await harness.emit({ type: "agent_settled" } as any);
	assert.equal(harness.messages.length, 1);
});

test("tool_result on write flags a leak immediately, in-band, independent of git state entirely", async () => {
	// The exact scenario a live test found broken: the model writes the
	// leak, then commits before agent_settled ever runs. This check must
	// not depend on git at all to catch it -- no exec mock is provided.
	const cwd = await mkdtemp(join(tmpdir(), "pi-error-leak-write-"));
	const harness = new ExtensionHarness({ cwd });
	errorLeakGuard(harness.api);
	const content = 'package main\n\nfunc handle() {\n\thttp.Error(w, err.Error(), 500)\n}\n';
	const [outcome] = await harness.emit({
		type: "tool_result",
		toolCallId: "w1",
		toolName: "write",
		input: { path: join(cwd, "handler.go"), content },
		content: [{ type: "text", text: "Successfully wrote handler.go" }],
		isError: false,
	} as any);
	const appended = (outcome as { content: { type: string; text: string }[] }).content;
	assert.equal(appended[0]?.text, "Successfully wrote handler.go");
	assert.match(appended[1]?.text ?? "", /err\.Error/);
});

test("tool_result on write stays silent when there is no leak", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-error-leak-write-clean-"));
	const harness = new ExtensionHarness({ cwd });
	errorLeakGuard(harness.api);
	const [outcome] = await harness.emit({
		type: "tool_result",
		toolCallId: "w1",
		toolName: "write",
		input: { path: join(cwd, "handler.go"), content: 'http.Error(w, "not found", 404)\n' },
		content: [],
		isError: false,
	} as any);
	assert.equal(outcome, undefined);
});

test("tool_result on edit re-reads the file from disk (edits carry only fragments, not full content)", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-error-leak-edit-"));
	const filePath = join(cwd, "handler.go");
	await writeFile(filePath, 'package main\n\nfunc handle() {\n\thttp.Error(w, err.Error(), 500)\n}\n');
	const harness = new ExtensionHarness({ cwd });
	errorLeakGuard(harness.api);
	const [outcome] = await harness.emit({
		type: "tool_result",
		toolCallId: "e1",
		toolName: "edit",
		input: { path: filePath, edits: [{ oldText: "500", newText: "500" }] },
		content: [],
		isError: false,
	} as any);
	assert.match(String((outcome as { content: { text: string }[] }).content[0]?.text), /err\.Error/);
});

test("ignores non-.go files and errored tool calls", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-error-leak-ignore-"));
	const harness = new ExtensionHarness({ cwd });
	errorLeakGuard(harness.api);
	const [notGo] = await harness.emit({
		type: "tool_result",
		toolCallId: "w1",
		toolName: "write",
		input: { path: join(cwd, "notes.txt"), content: "http.Error(w, err.Error(), 500)" },
		content: [],
		isError: false,
	} as any);
	assert.equal(notGo, undefined);

	const [errored] = await harness.emit({
		type: "tool_result",
		toolCallId: "w2",
		toolName: "write",
		input: { path: join(cwd, "handler.go"), content: "http.Error(w, err.Error(), 500)" },
		content: [],
		isError: true,
	} as any);
	assert.equal(errored, undefined);
});

test("agent_start captures baseSha once, and agent_settled diffs against it", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-error-leak-basesha-"));
	const diffTargets: string[] = [];
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "rev-parse") return result(0, "captured-sha\n");
			if (command === "git" && args[0] === "diff") {
				diffTargets.push(args[args.length - 1] ?? "");
				return result(0, "");
			}
			if (command === "git" && args[0] === "status") return result(0, "");
			return result(1);
		},
	});
	errorLeakGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	await harness.emit({ type: "agent_settled" } as any);
	await harness.emit({ type: "agent_settled" } as any);
	assert.deepEqual(diffTargets, ["captured-sha", "captured-sha"]);
});

test("agent_settled backstop still finds a leak committed in a session that started with an unborn HEAD", async () => {
	// The bug a reviewer caught: agent_start's rev-parse HEAD fails (unborn),
	// so baseSha is never captured. By agent_settled time the model has
	// committed, so HEAD now exists. Passing the captured (undefined)
	// baseSha straight through to resolveDiffTarget would make it re-derive
	// "HEAD" from *current* state and diff HEAD against itself -- finding
	// nothing. Pinning to the empty tree when baseSha was never captured
	// must still catch this.
	const cwd = await mkdtemp(join(tmpdir(), "pi-error-leak-committed-unborn-"));
	// rev-parse fails the first time (agent_start, unborn HEAD) and succeeds
	// after that (the model has since committed). This is what makes the
	// test actually distinguish the fix from its absence: pre-fix code
	// passes the captured (undefined) baseSha straight to resolveDiffTarget,
	// which re-checks rev-parse at settle time, gets a real sha now that
	// HEAD exists, and diffs against "HEAD" -- self-diff, finds nothing. A
	// mock that always fails rev-parse can't distinguish that from the fix
	// (both would fall back to the empty tree either way).
	let revParseCalls = 0;
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "rev-parse") {
				revParseCalls += 1;
				return revParseCalls === 1 ? result(128, "unknown revision") : result(0, "committed-sha\n");
			}
			if (command === "git" && args[0] === "diff") {
				assert.equal(args[2], "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
				return result(0, "+++ b/main.go\n+\thttp.Error(w, err.Error(), 500)\n");
			}
			if (command === "git" && args[0] === "status") return result(0, "");
			return result(1);
		},
	});
	errorLeakGuard(harness.api);
	await harness.emit({ type: "agent_start" } as any);
	await harness.emit({ type: "agent_settled" } as any);
	assert.equal(harness.messages.length, 1);
});

test("baseSha capture is keyed per cwd, not shared across projects in one long-running process", async () => {
	// ExtensionHarness.emit() always uses one fixed context, so this invokes
	// the registered handlers directly with two different per-call contexts
	// -- the same shape a real long-running process moving between projects
	// would produce (one pi instance, cwd varying per agent run).
	const cwdA = await mkdtemp(join(tmpdir(), "pi-error-leak-cwd-a-"));
	const cwdB = await mkdtemp(join(tmpdir(), "pi-error-leak-cwd-b-"));
	const shas: Record<string, string> = { [cwdA]: "sha-a", [cwdB]: "sha-b" };
	const diffTargetsByCwd: Record<string, string[]> = { [cwdA]: [], [cwdB]: [] };
	const harness = new ExtensionHarness({
		cwd: cwdA,
		exec: ({ command, args, options }: ExecCall) => {
			const cwd = (options as { cwd?: string } | undefined)?.cwd ?? cwdA;
			if (command === "git" && args[0] === "rev-parse") return result(0, `${shas[cwd]}\n`);
			if (command === "git" && args[0] === "diff") {
				diffTargetsByCwd[cwd]!.push(args[args.length - 1] ?? "");
				return result(0, "");
			}
			if (command === "git" && args[0] === "status") return result(0, "");
			return result(1, "");
		},
	});
	errorLeakGuard(harness.api);
	const ctxA = { ...harness.context, cwd: cwdA };
	const ctxB = { ...harness.context, cwd: cwdB };
	for (const handler of harness.handlers.get("agent_start") ?? []) await handler({ type: "agent_start" }, ctxA);
	for (const handler of harness.handlers.get("agent_start") ?? []) await handler({ type: "agent_start" }, ctxB);
	for (const handler of harness.handlers.get("agent_settled") ?? []) await handler({ type: "agent_settled" }, ctxA);
	for (const handler of harness.handlers.get("agent_settled") ?? []) await handler({ type: "agent_settled" }, ctxB);
	assert.deepEqual(diffTargetsByCwd[cwdA], ["sha-a"]);
	assert.deepEqual(diffTargetsByCwd[cwdB], ["sha-b"]);
});

test("re-nudges once a resolved finding reappears", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-error-leak-reappear-"));
	let diff = "+++ b/main.go\n+\thttp.Error(w, err.Error(), http.StatusInternalServerError)\n";
	const harness = new ExtensionHarness({
		cwd,
		exec: ({ command, args }: ExecCall) => {
			if (command === "git" && args[0] === "rev-parse") return result(0, "abc\n");
			if (command === "git" && args[0] === "diff") return result(0, diff);
			if (command === "git" && args[0] === "status") return result(0, "");
			return result(1);
		},
	});
	errorLeakGuard(harness.api);
	await harness.emit({ type: "agent_settled" } as any);
	assert.equal(harness.messages.length, 1);
	diff = "";
	await harness.emit({ type: "agent_settled" } as any);
	diff = "+++ b/main.go\n+\thttp.Error(w, err.Error(), http.StatusInternalServerError)\n";
	await harness.emit({ type: "agent_settled" } as any);
	assert.equal(harness.messages.length, 2);
});
