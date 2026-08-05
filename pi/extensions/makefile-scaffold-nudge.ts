/**
 * Makefile scaffold nudge (todo-app-hardening-plan.md fix 4).
 *
 * Prompt-only, like new-project-scaffold.ts: an extension writing a
 * generated Makefile itself would be the harness's first autonomous file
 * write, and a generated `verify` target that silently misses one
 * component of a multi-language repo would *shrink* coverage compared to
 * verification.ts's own nested scan today. Handing the exact resolved
 * command to the model and asking it to wire that into a Makefile keeps
 * the model in the loop to sanity-check it, and keeps the harness's
 * write surface at zero.
 *
 * Gated on the same precedence resolveVerificationCommand.ts already uses:
 * only fires when there is no Makefile target and no documented command in
 * AGENTS.md/README.md (a repo that already documents its check doesn't
 * need one restated as a Makefile), and only when something is actually
 * resolvable to build a Makefile from -- an unconfigured repo has nothing
 * to scaffold.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isStaleContextError } from "./lib/stale-context.ts";
import { documentedCommand, makefileVerificationCommand, resolveVerificationCommand } from "./lib/verification.ts";

export default function makefileScaffoldNudge(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const [makefileCommand, documented] = await Promise.all([
				makefileVerificationCommand(ctx.cwd),
				documentedCommand(ctx.cwd),
			]);
			if (makefileCommand || documented) return undefined;

			const resolved = await resolveVerificationCommand(ctx.cwd);
			if (!resolved) return undefined;

			return {
				systemPrompt:
					`${event.systemPrompt}\n\n` +
					"This project has no Makefile and no documented verification command, but its actual " +
					`check resolves to: \`${resolved}\`. Add a Makefile with \`test\`, \`lint\`, and \`verify\` ` +
					"targets that run this exact command (it is fine for all three to run the same command " +
					"if there is no separate lint step) so `make verify` becomes this repo's canonical check. " +
					"The target must cover every component this project actually has, not a narrower or " +
					"different command than the one resolved above.",
			};
		} catch (error) {
			if (isStaleContextError(error)) return undefined;
			throw error;
		}
	});
}
