/**
 * Protected Paths Extension
 *
 * Blocks write and edit operations to protected paths, and to anything
 * outside the session's working directory.
 *
 * Vendored from pi's examples/extensions/protected-paths.ts with two changes,
 * both driven by observed local-model behavior rather than theory:
 *
 * 1. Extended path list. A 27B model is likelier than a cloud model to "fix"
 *    a failing build by rewriting a lockfile or a generated file.
 * 2. Working-directory confinement. Asked to write `main.go` with cwd set to a
 *    temp dir, Qwen3.6-27B emitted an absolute path to a completely different
 *    directory (`/Users/kanna/code/fmt-test/main.go`) and pi's write tool
 *    obeyed it. The block message names the cwd so the model's next attempt
 *    lands in the right place -- a wrong write that fails loudly is
 *    recoverable, one that silently succeeds elsewhere is not.
 *
 * This is a guardrail, not a sandbox: it resolves `..` and existing symlink
 * ancestors, but bash and child processes still need OS-level containment.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

async function resolveThroughExistingAncestor(path: string): Promise<string> {
	let cursor = path;
	const suffix: string[] = [];
	while (true) {
		try {
			return resolve(await realpath(cursor), ...suffix.reverse());
		} catch {
			const parent = dirname(cursor);
			if (parent === cursor) return path;
			suffix.push(cursor.slice(parent.length + 1));
			cursor = parent;
		}
	}
}

export default function (pi: ExtensionAPI) {
	const protectedPaths = [
		".env",
		".git/",
		"node_modules/",
		"/.ssh/",
		"/.aws/",
		".gitconfig",
		"pubspec.lock",
		"go.sum",
		".g.dart",
		".freezed.dart",
	];

	function isOutsideCwd(absolutePath: string, cwd: string): boolean {
		const rel = relative(cwd, absolutePath);
		return rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || resolve(rel) === rel;
	}

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") {
			return undefined;
		}

		const path = event.input.path as string;
		if (!path) return undefined;

		const absolutePath = resolve(ctx.cwd, path);
		const [realCwd, resolvedTarget] = await Promise.all([
			realpath(ctx.cwd).catch(() => resolve(ctx.cwd)),
			resolveThroughExistingAncestor(absolutePath),
		]);

		if (protectedPaths.some((p) => absolutePath.includes(p))) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
			}
			return { block: true, reason: `Path "${path}" is protected` };
		}

		if (isOutsideCwd(resolvedTarget, realCwd)) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Blocked write outside working directory: ${path}`, "warning");
			}
			return {
				block: true,
					reason:
					`Path "${path}" resolves to "${resolvedTarget}", which is outside the working ` +
					`directory "${ctx.cwd}". Write to a path inside the working directory instead ` +
					`-- a plain relative path such as "main.go" is usually what you want.`,
			};
		}

		return undefined;
	});
}
