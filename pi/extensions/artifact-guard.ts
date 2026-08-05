/**
 * Artifact/binary-size guard (todo-app-hardening-plan.md fix 2).
 *
 * Three layers, the first two added after a live end-to-end test found the
 * original agent_settled-only design has a real blind spot in `-p`
 * (non-interactive) mode: `agent_settled` fires exactly once, at the very
 * end of the process, after the model's own final actions -- including its
 * own `git commit`. By the time the settle check ran, a build artifact the
 * model itself had built and left in the tree was already committed, so
 * neither "untracked" nor "modified" status covered it anymore.
 *
 * 1. Primary: `tool_result` on `bash`, after any command shaped like a
 *    build (`go build`, `-o <path>`, `cargo build`, `npm run build`,
 *    `flutter build`) -- checks immediately, in-band, before any
 *    subsequent git operation can hide the artifact.
 * 2. `agent_settled`, extended: in addition to untracked/staged/modified
 *    working-tree entries, also checks paths that changed between
 *    `baseSha` (captured at `agent_start`, matching quality-gate.ts's own
 *    pattern) and the current HEAD -- the file is still present on disk
 *    even after being committed, so the existing size/magic-byte check
 *    applies to it unchanged; only the path *selection* needed to widen.
 * 3. Known limitation, still real: a binary already committed to history
 *    before this session started, with a since-clean working tree, is
 *    still invisible -- that needs a full tracked-tree scan across all of
 *    history, a materially bigger feature than this fix.
 */
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendHarnessTrace } from "./lib/harness-telemetry.ts";
import { isStaleContextError } from "./lib/stale-context.ts";
import { EMPTY_TREE_HASH } from "./lib/verification.ts";

const SIZE_THRESHOLD_BYTES = 1_000_000;
// Deliberately narrower than a bare `\s-o\s+\S`: that also matches
// `grep -o`, `curl -o`, `sort -o` and would run a full git status+diff
// scan (and risk a false nudge) on any of those. Only pair -o with an
// actual compiler invocation.
const BUILD_COMMAND_PATTERN =
	/\bgo build\b|\bcargo build\b|\bnpm run build\b|\bflutter build\b|\b(?:gcc|clang|cc|g\+\+)\b[^\n]*\s-o\s+\S/;

const EXECUTABLE_MAGIC: Array<[name: string, bytes: number[]]> = [
	["ELF", [0x7f, 0x45, 0x4c, 0x46]],
	["Mach-O 32-bit", [0xfe, 0xed, 0xfa, 0xce]],
	["Mach-O 64-bit", [0xfe, 0xed, 0xfa, 0xcf]],
	["Mach-O 32-bit (byte-swapped)", [0xce, 0xfa, 0xed, 0xfe]],
	["Mach-O 64-bit (byte-swapped)", [0xcf, 0xfa, 0xed, 0xfe]],
	["Mach-O universal binary", [0xca, 0xfe, 0xba, 0xbe]],
];

async function executableMagicName(path: string): Promise<string | undefined> {
	const handle = await open(path, "r").catch(() => undefined);
	if (!handle) return undefined;
	try {
		const buffer = Buffer.alloc(4);
		const { bytesRead } = await handle.read(buffer, 0, 4, 0);
		if (bytesRead < 4) return undefined;
		for (const [name, bytes] of EXECUTABLE_MAGIC) {
			if (bytes.every((byte, index) => buffer[index] === byte)) return name;
		}
		return undefined;
	} finally {
		await handle.close();
	}
}

export interface FlaggedArtifact {
	path: string;
	reason: string;
}

async function checkPaths(cwd: string, relativePaths: string[]): Promise<FlaggedArtifact[]> {
	const flagged: FlaggedArtifact[] = [];
	for (const relativePath of relativePaths) {
		const absolutePath = join(cwd, relativePath);
		const info = await stat(absolutePath).catch(() => undefined);
		if (!info || !info.isFile()) continue;
		if (info.size > SIZE_THRESHOLD_BYTES) {
			flagged.push({ path: relativePath, reason: `${(info.size / 1_000_000).toFixed(1)}MB file` });
			continue;
		}
		const magic = await executableMagicName(absolutePath);
		if (magic) flagged.push({ path: relativePath, reason: `${magic} executable` });
	}
	return flagged;
}

async function workingTreePaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const status = await pi
		.exec(
			"git",
			[
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=all",
				"--",
				".",
				":(exclude)node_modules",
				":(exclude)build",
				":(exclude)dist",
				":(exclude).dart_tool",
			],
			{ cwd, timeout: 10_000 },
		)
		.catch(() => undefined);
	if (!status || status.code !== 0) return [];

	// Untracked ("??") and staged/modified (an 'A' or 'M' in either status
	// column) entries all have working-tree content worth checking. Renames
	// and deletes are skipped: -z rename entries carry two NUL-separated
	// paths with no "->" marker, and a delete has no working-tree file left
	// to check (stat() below would just fail harmlessly on it anyway).
	return status.stdout
		.split(/[\0\n]/)
		.filter((entry) => entry.length > 3)
		.filter((entry) => entry.startsWith("??") || entry[0] === "A" || entry[0] === "M" || entry[1] === "A" || entry[1] === "M")
		.map((entry) => entry.slice(3))
		.filter(Boolean);
}

async function committedSincePaths(pi: ExtensionAPI, cwd: string, baseSha: string | undefined): Promise<string[]> {
	// A brand-new repo (the exact scenario this fix targets) has an unborn
	// HEAD when agent_start runs, so `rev-parse HEAD` fails and baseSha
	// stays undefined for the rest of the session -- diffing against the
	// empty tree instead of skipping entirely still finds everything
	// committed since session start, same fallback resolveDiffTarget uses.
	const diff = await pi
		.exec("git", ["diff", "--name-only", baseSha ?? EMPTY_TREE_HASH, "HEAD"], { cwd, timeout: 10_000 })
		.catch(() => undefined);
	if (!diff || diff.code !== 0 || !diff.stdout) return [];
	return diff.stdout.split("\n").filter(Boolean);
}

export async function findLargeOrBinaryArtifacts(pi: ExtensionAPI, cwd: string, baseSha?: string): Promise<FlaggedArtifact[]> {
	const [workingTree, committedSince] = await Promise.all([
		workingTreePaths(pi, cwd),
		committedSincePaths(pi, cwd, baseSha),
	]);
	const uniquePaths = [...new Set([...workingTree, ...committedSince])];
	return checkPaths(cwd, uniquePaths);
}

export default function artifactGuard(pi: ExtensionAPI): void {
	let baseSha: string | undefined;
	// Keyed by cwd, not a single closure variable: a long-running pi process
	// can move across projects (or a test harness across fixtures) within
	// one lifetime, and a bare shared variable would let a real finding in
	// project B go unreported if project A happened to flag the same
	// path:reason pair first.
	const lastFlaggedKeyByCwd = new Map<string, string>();

	pi.on("agent_start", async (_event, ctx) => {
		if (baseSha) return;
		const result = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: 5000 }).catch(() => undefined);
		if (result?.code === 0) baseSha = result.stdout.trim();
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash" || event.isError) return undefined;
		const command = (event.input as { command?: string }).command;
		if (!command || !BUILD_COMMAND_PATTERN.test(command)) return undefined;

		try {
			const flagged = await findLargeOrBinaryArtifacts(pi, ctx.cwd, baseSha);
			if (!flagged.length) return undefined;

			// Shares lastFlaggedKeyByCwd with the agent_settled path below: once
			// a binary is committed, committedSincePaths keeps returning it for
			// the rest of the session, so without this every later build
			// command would re-append the identical warning.
			const key = flagged
				.map((artifact) => `${artifact.path}:${artifact.reason}`)
				.sort()
				.join("|");
			if (key === lastFlaggedKeyByCwd.get(ctx.cwd)) return undefined;
			lastFlaggedKeyByCwd.set(ctx.cwd, key);

			appendHarnessTrace(pi, {
				extension: "artifact-guard",
				diffHash: null,
				event: "nudge",
				outcome: "flagged",
				durationMs: 0,
				metadata: { count: flagged.length, trigger: "build-command" },
			});

			const list = flagged.map((artifact) => `- ${artifact.path} (${artifact.reason})`).join("\n");
			return {
				content: [
					...event.content,
					{
						type: "text" as const,
						text:
							`\n\nBuild artifact(s) in the working tree, not source:\n${list}\n` +
							"Remove them and add a matching .gitignore entry so they don't get committed. Build " +
							"output and compiled binaries do not belong in the repository.",
					},
				],
			};
		} catch (error) {
			if (isStaleContextError(error)) return undefined;
			throw error;
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			const flagged = await findLargeOrBinaryArtifacts(pi, ctx.cwd, baseSha);
			if (!flagged.length) {
				lastFlaggedKeyByCwd.delete(ctx.cwd);
				return;
			}
			const key = flagged
				.map((artifact) => `${artifact.path}:${artifact.reason}`)
				.sort()
				.join("|");
			if (key === lastFlaggedKeyByCwd.get(ctx.cwd)) return;
			lastFlaggedKeyByCwd.set(ctx.cwd, key);

			appendHarnessTrace(pi, {
				extension: "artifact-guard",
				diffHash: null,
				event: "nudge",
				outcome: "flagged",
				durationMs: 0,
				metadata: { count: flagged.length, trigger: "settle" },
			});

			const list = flagged.map((artifact) => `- ${artifact.path} (${artifact.reason})`).join("\n");
			pi.sendUserMessage(
				`Build artifact(s) in the working tree, not source:\n\n${list}\n\n` +
					"Remove them and add a matching .gitignore entry so they don't get committed. Build " +
					"output and compiled binaries do not belong in the repository.",
				{ deliverAs: "followUp" },
			);
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		}
	});
}
