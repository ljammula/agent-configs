/**
 * Artifact/binary-size guard (todo-app-hardening-plan.md fix 2).
 *
 * Deterministic Tier 1 check, not a prompt nudge: scans untracked AND
 * staged/modified working-tree files at `agent_settled` for size >1MB or a
 * compiled-executable magic number (ELF, Mach-O in any byte order), and
 * sends a corrective follow-up if any are found. Targets the todo-app
 * finding directly (a 13MB compiled `backend/backend` binary left in the
 * working tree) and doubles as a performance fix: verification.ts's
 * snapshotDiff/hashUntrackedPath currently sha256-streams every untracked
 * file, including that binary, on every settle event -- flagging it here
 * gives the model a reason to remove it instead of leaving it to be
 * re-hashed every turn.
 *
 * Known limitation: this reads `git status`, so it only sees the current
 * working tree (untracked, staged, or modified). A binary already
 * committed to history with a since-clean working tree is invisible to
 * this check -- catching that needs a full tracked-tree scan, which is a
 * materially bigger feature than this fix.
 */
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendHarnessTrace } from "./lib/harness-telemetry.ts";
import { isStaleContextError } from "./lib/stale-context.ts";

const SIZE_THRESHOLD_BYTES = 1_000_000;

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

export async function findLargeOrBinaryArtifacts(pi: ExtensionAPI, cwd: string): Promise<FlaggedArtifact[]> {
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
	const relevantPaths = status.stdout
		.split(/[\0\n]/)
		.filter((entry) => entry.length > 3)
		.filter((entry) => entry.startsWith("??") || entry[0] === "A" || entry[0] === "M" || entry[1] === "A" || entry[1] === "M")
		.map((entry) => entry.slice(3))
		.filter(Boolean);

	const flagged: FlaggedArtifact[] = [];
	for (const relativePath of relevantPaths) {
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

export default function artifactGuard(pi: ExtensionAPI): void {
	// Keyed by cwd, not a single closure variable: a long-running pi process
	// can move across projects (or a test harness across fixtures) within
	// one lifetime, and a bare shared variable would let a real finding in
	// project B go unreported if project A happened to flag the same
	// path:reason pair first.
	const lastFlaggedKeyByCwd = new Map<string, string>();

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			const flagged = await findLargeOrBinaryArtifacts(pi, ctx.cwd);
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
				metadata: { count: flagged.length },
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
