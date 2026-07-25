/**
 * Git Safety Extension
 *
 * Blocks destructive git commands run via the `bash` tool, mirroring the
 * confirm-before-destructive-action norm this user's Claude Code setup
 * already follows (never git reset --hard / push --force / clean -f /
 * branch -D without being asked first) -- pi has no native permission
 * prompts, so the equivalent here is a hard block, not a confirmation.
 *
 * Added 2026-07-25 after a real occurrence in the personal-assistant
 * daily-briefing-screen dispatch: `pi`, running in `-p` (non-interactive)
 * mode, hit `git switch -c <branch>` failing because the branch already
 * existed, and self-recovered with `git switch <branch> && git reset --hard
 * main` -- silently discarding a prior commit on that branch with no
 * confirmation. `git-checkpoint.ts` had a snapshot that could have
 * recovered it, but only via `/fork`, which is interactive-UI-only and does
 * nothing in `-p` mode -- the mode this actually ran in. See the
 * "Follow-up" section of pi-real-task-report-daily-briefing-screen.md.
 *
 * Each block names a safe alternative, not just a refusal. This matters
 * more here than it would for a cloud model: the `flutter gen-l10n`
 * rediscovery flail in the same dispatch (~8 failed bash commands in a
 * 5-minute span before landing on the right invocation) is direct evidence
 * that this model thrashes when blocked without being told what to do
 * instead, rather than backing off and reconsidering.
 *
 * Commands are matched loosely (regex search over the whole string, not an
 * exact-argv parse) so this still catches the command inside a chain
 * (`a && git reset --hard main`) and after rtk-rewrite.ts's `rtk git ...`
 * rewriting. That looseness is deliberate: a missed block is silent data
 * loss, a false-positive block just costs the model one retry with an
 * explanation.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface DestructivePattern {
	re: RegExp;
	reason: string;
	alternative: string;
}

const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
	{
		re: /\bgit\s+reset\s+(?:.*\s+)?--hard\b/,
		reason: "discards uncommitted changes and moves the branch pointer, losing any commits not reachable from the target",
		alternative:
			'if you need a clean branch, use "git switch -c <new-name>" instead of resetting an existing one; ' +
			'if a branch already exists and you want it to match main, ask first -- do not reset it yourself',
	},
	{
		re: /\bgit\s+push\s+(?:.*\s+)?--force\b(?!-with-lease)/,
		reason: "can overwrite commits on the remote that you haven't seen, including other people's work",
		alternative: 'use "git push --force-with-lease" if a force-push is genuinely needed, or ask first',
	},
	{
		re: /\bgit\s+clean\s+(?:(?!--dry-run)[^\n])*-[a-zA-Z]*f/,
		reason: "permanently deletes untracked files with no recovery path",
		alternative: 'run "git clean -n" (dry run) first to see what would be deleted, then ask before running it for real',
	},
	{
		re: /\bgit\s+branch\s+(?:.*\s+)?-D\b/,
		reason: "force-deletes a branch even if it has unmerged commits",
		alternative: 'use "git branch -d" (lowercase) which refuses to delete unmerged work, or ask first',
	},
	{
		re: /\bgit\s+(?:checkout|restore)\s+(?:.*\s+)?(?:--\s+\.|\.\s*$)/,
		reason: "discards uncommitted changes in the working tree with no recovery path",
		alternative: 'run "git status" and "git diff" first to see what would be discarded, then ask before discarding it',
	},
];

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string | undefined;
		if (!command) return undefined;

		for (const { re, reason, alternative } of DESTRUCTIVE_PATTERNS) {
			if (re.test(command)) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Blocked destructive git command: ${command}`, "warning");
				}
				return {
					block: true,
					reason:
						`Blocked: this command is destructive (${reason}) and was not explicitly ` +
						`requested. Do not work around this block by rephrasing the same command. ${alternative}.`,
				};
			}
		}

		return undefined;
	});
}
