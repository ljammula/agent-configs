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
