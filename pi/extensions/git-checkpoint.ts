/**
 * Git Checkpoint Extension
 *
 * Creates git checkpoints at each turn so /fork can restore code state.
 * When forking, offers to restore code to that point in history.
 *
 * Three things are captured at `turn_start`, all non-destructive (none touch
 * the working tree or index):
 *
 * - `baseSha` (`git rev-parse HEAD`) -- the tracked-file baseline. Captured
 *   unconditionally, not just when something is dirty: `git stash create`
 *   returns an empty ref on a clean working tree (the common case -- most
 *   turns start clean), and the original version of this file only stored a
 *   checkpoint when that ref was non-empty. That meant restore silently did
 *   nothing for tracked-file edits whenever the turn started clean, which is
 *   most of the time -- a bigger gap than the untracked-file one below, just
 *   less visible since it fails silently rather than incompletely.
 * - `stashRef` (`git stash create`) -- any tracked-file changes that were
 *   already dirty *before* this turn started, so restore doesn't wipe
 *   legitimate prior work back to `baseSha`.
 * - `untracked` -- files present but not yet `git add`ed at turn_start,
 *   which `git stash create` can't see at all (a large fraction of coding
 *   turns *create* new files, not just edit existing ones -- exactly the
 *   case this checkpoint exists to protect). Snapshotted with
 *   `git hash-object -w` (writes a blob to the object DB only) and restored
 *   with `git cat-file -p`. Text files only -- `pi.exec`'s stdout capture is
 *   UTF-8, so a binary untracked file would be corrupted by this path;
 *   there's no detection/skip for that today, a known residual gap.
 *
 * Restore order matters: `checkout baseSha -- .` first (resets all tracked
 * paths to the pre-turn commit, correctly reverting the common clean-start
 * case), *then* `stash apply stashRef` on top if there was pre-existing
 * dirty work (reintroduces exactly the turn_start diff), *then* untracked
 * files. Doing stash-apply without the checkout first is what silently did
 * nothing on a clean start; doing checkout without stash-apply after would
 * wipe out legitimate work that predated this turn.
 */

import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_UNTRACKED_FILES = 50; // bound turn_start latency in a messy repo
const EXEC_TIMEOUT_MS = 5000;

interface Checkpoint {
	baseSha: string | undefined;
	stashRef: string | undefined;
	untracked: { path: string; blobSha: string }[];
}

export default function (pi: ExtensionAPI) {
	const checkpoints = new Map<string, Checkpoint>();

	pi.on("turn_start", async (_event, ctx) => {
		const leaf = ctx.sessionManager.getLeafEntry();
		if (!leaf) return;

		const headResult = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: EXEC_TIMEOUT_MS }).catch(() => undefined);
		const baseSha = headResult && headResult.code === 0 ? headResult.stdout.trim() || undefined : undefined;

		// Pre-existing dirty tracked-file changes, if any. Non-destructive.
		const stashResult = await pi.exec("git", ["stash", "create"], { cwd: ctx.cwd, timeout: EXEC_TIMEOUT_MS }).catch(() => undefined);
		const stashRef = stashResult && stashResult.code === 0 ? stashResult.stdout.trim() || undefined : undefined;

		// Untracked files: `stash create` can't see these at all. Snapshot each
		// as a loose blob instead -- also non-destructive.
		const untracked: { path: string; blobSha: string }[] = [];
		const lsResult = await pi
			.exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd: ctx.cwd, timeout: EXEC_TIMEOUT_MS })
			.catch(() => undefined);
		if (lsResult && lsResult.code === 0) {
			const paths = lsResult.stdout.split("\n").filter(Boolean).slice(0, MAX_UNTRACKED_FILES);
			for (const path of paths) {
				const hashResult = await pi
					.exec("git", ["hash-object", "-w", "--", path], { cwd: ctx.cwd, timeout: EXEC_TIMEOUT_MS })
					.catch(() => undefined);
				const blobSha = hashResult && hashResult.code === 0 ? hashResult.stdout.trim() : undefined;
				if (blobSha) untracked.push({ path, blobSha });
			}
		}

		if (baseSha || stashRef || untracked.length > 0) {
			checkpoints.set(leaf.id, { baseSha, stashRef, untracked });
		}
	});

	pi.on("session_before_fork", async (event, ctx) => {
		const checkpoint = checkpoints.get(event.entryId);
		if (!checkpoint) return;

		if (!ctx.hasUI) {
			// In non-interactive mode, don't restore automatically
			return;
		}

		const choice = await ctx.ui.select("Restore code state?", [
			"Yes, restore code to that point",
			"No, keep current code",
		]);
		if (!choice?.startsWith("Yes")) return;

		let ok = true;

		if (checkpoint.baseSha) {
			const checkoutResult = await pi.exec("git", ["checkout", checkpoint.baseSha, "--", "."], { cwd: ctx.cwd }).catch(() => undefined);
			if (!checkoutResult || checkoutResult.code !== 0) ok = false;
		}

		if (checkpoint.stashRef) {
			const applyResult = await pi.exec("git", ["stash", "apply", checkpoint.stashRef], { cwd: ctx.cwd }).catch(() => undefined);
			if (!applyResult || applyResult.code !== 0) ok = false;
		}

		for (const { path, blobSha } of checkpoint.untracked) {
			const catResult = await pi.exec("git", ["cat-file", "-p", blobSha], { cwd: ctx.cwd }).catch(() => undefined);
			if (!catResult || catResult.code !== 0) {
				ok = false;
				continue;
			}
			try {
				const fullPath = join(ctx.cwd, path);
				await mkdir(dirname(fullPath), { recursive: true });
				await writeFile(fullPath, catResult.stdout);
			} catch {
				ok = false;
			}
		}

		ctx.ui.notify(
			ok ? "Code restored to checkpoint" : "Code restore incomplete -- check `git status` and `git stash list`",
			ok ? "info" : "warning",
		);
	});

	pi.on("agent_end", async () => {
		// Clear checkpoints after agent completes
		checkpoints.clear();
	});
}
