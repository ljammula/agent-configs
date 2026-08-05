/**
 * Raw-error-into-HTTP-response guard (todo-app-hardening-plan.md item E).
 *
 * The plan's original draft folded centralized domain errors into a
 * prompt-only, project-init-time nudge (see new-project-scaffold.ts) --
 * but "is the architecture layered" has no deterministic observer, while
 * "is a raw error string being written into an HTTP response body" does.
 * This is the one piece of item E implemented as a real Tier 1 check
 * instead of prose: it directly targets todo-app's actual pattern
 * (`http.Error(w, err.Error(), http.StatusInternalServerError)`), which
 * leaks internal detail (SQL errors, file paths) to API clients instead of
 * mapping to a stable domain error / status code.
 *
 * Scans both the tracked diff AND untracked file content. Diff-only misses
 * the exact motivating case: a fresh project's files are untracked until
 * `git add`, so `git diff` never shows them and the guard would stay
 * silent through the entire scenario it was built for.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendHarnessTrace } from "./lib/harness-telemetry.ts";
import { isStaleContextError } from "./lib/stale-context.ts";
import { EMPTY_TREE_HASH, resolveDiffTarget } from "./lib/verification.ts";

const ERROR_LEAK_PATTERN = /\bhttp\.Error\([^,]+,\s*err(?:or)?\.Error\(\)/;

export interface ErrorLeak {
	path: string;
	line: string;
}

// Parses unified diff text, attributing each flagged added line to the file
// it belongs to (from the `+++ b/<path>` hunk header) so findings can be
// deduped and reported per file instead of by line text alone -- two
// different files with an identical offending line must both get flagged
// and neither should mask a fix to the other.
export function findErrorLeaksInDiff(diffText: string): ErrorLeak[] {
	const leaks: ErrorLeak[] = [];
	let currentPath: string | undefined;
	for (const rawLine of diffText.split("\n")) {
		const fileHeader = rawLine.match(/^\+\+\+ b\/(.+)$/);
		if (fileHeader) {
			currentPath = fileHeader[1];
			continue;
		}
		if (rawLine.startsWith("+++")) {
			currentPath = undefined;
			continue;
		}
		if (!rawLine.startsWith("+")) continue;
		const content = rawLine.slice(1);
		if (ERROR_LEAK_PATTERN.test(content)) {
			leaks.push({ path: currentPath ?? "(unknown file)", line: content.trim() });
		}
	}
	return leaks;
}

export function findErrorLeaksInFile(path: string, content: string): ErrorLeak[] {
	return content
		.split("\n")
		.filter((line) => ERROR_LEAK_PATTERN.test(line))
		.map((line) => ({ path, line: line.trim() }));
}

async function untrackedGoPaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const status = await pi
		.exec(
			"git",
			["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", ":(exclude)node_modules", ":(exclude)build", ":(exclude)dist", ":(exclude).dart_tool"],
			{ cwd, timeout: 10_000 },
		)
		.catch(() => undefined);
	if (!status || status.code !== 0) return [];
	return status.stdout
		.split(/[\0\n]/)
		.filter((entry) => entry.startsWith("?? "))
		.map((entry) => entry.slice(3))
		.filter((path) => path.endsWith(".go"));
}

export async function collectErrorLeaks(pi: ExtensionAPI, cwd: string): Promise<ErrorLeak[]> {
	const target = await resolveDiffTarget(pi, cwd, undefined).catch(() => EMPTY_TREE_HASH);
	const [diff, untrackedPaths] = await Promise.all([
		pi.exec("git", ["diff", "--binary", target], { cwd, timeout: 10_000 }).catch(() => undefined),
		untrackedGoPaths(pi, cwd),
	]);

	const leaks: ErrorLeak[] = diff && diff.code === 0 && diff.stdout ? findErrorLeaksInDiff(diff.stdout) : [];

	for (const relativePath of untrackedPaths) {
		const content = await readFile(join(cwd, relativePath), "utf8").catch(() => undefined);
		if (content) leaks.push(...findErrorLeaksInFile(relativePath, content));
	}
	return leaks;
}

export default function errorLeakGuard(pi: ExtensionAPI): void {
	// Keyed by cwd, same reasoning as artifact-guard.ts's lastFlaggedKeyByCwd.
	const lastFlaggedKeyByCwd = new Map<string, string>();

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			const leaks = await collectErrorLeaks(pi, ctx.cwd);
			if (!leaks.length) {
				lastFlaggedKeyByCwd.delete(ctx.cwd);
				return;
			}
			const key = leaks
				.map((leak) => `${leak.path}:${leak.line}`)
				.sort()
				.join("\n");
			if (key === lastFlaggedKeyByCwd.get(ctx.cwd)) return;
			lastFlaggedKeyByCwd.set(ctx.cwd, key);

			appendHarnessTrace(pi, {
				extension: "error-leak-guard",
				diffHash: null,
				event: "nudge",
				outcome: "flagged",
				durationMs: 0,
				metadata: { count: leaks.length },
			});

			const list = leaks.map((leak) => `- ${leak.path}: ${leak.line}`).join("\n");
			pi.sendUserMessage(
				`Raw error text is being written directly into an HTTP response:\n\n${list}\n\n` +
					"This leaks internal detail (SQL errors, file paths, stack fragments) to API clients. " +
					"Map it to a stable domain error / status code instead of forwarding err.Error() verbatim.",
				{ deliverAs: "followUp" },
			);
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		}
	});
}
