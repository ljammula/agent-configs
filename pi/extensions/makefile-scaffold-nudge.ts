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
 * Two paths, because `before_agent_start` fires exactly once, before the
 * session's first tool call:
 *
 * 1. Populated repo (a manifest already exists at session start): resolve
 *    the command up front and nudge immediately, as before.
 * 2. Greenfield repo (nothing resolves yet -- an empty directory has no
 *    go.mod/package.json to resolve a command from): the up-front nudge
 *    can only plant a conditional instruction ("once you create a
 *    manifest, also add a Makefile"), not a concrete command, since none
 *    exists yet. A live test confirmed this path is silently unreachable
 *    on its own -- a `pi -p` run against an empty directory never
 *    revisited the precondition after `go mod init` created it mid-session.
 *    The `tool_result`/`turn_end` backstop below closes that gap: it arms
 *    when a manifest file gets written (via the `write` tool) OR a
 *    manifest-generating CLI command runs (via `bash` -- `go mod init`,
 *    `npm init`, `cargo init`, etc.; that same live test's model used
 *    exactly this path, not the write tool, to create go.mod), then
 *    re-evaluates at the next turn boundary (not immediately -- a manifest
 *    can appear and change shape within the same turn, and nudging
 *    mid-turn would read as a non-sequitur) and nudges once per cwd per
 *    session if still eligible.
 */
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isStaleContextError } from "./lib/stale-context.ts";
import { documentedCommand, makefileVerificationCommand, resolveVerificationCommand } from "./lib/verification.ts";

const MANIFEST_BASENAMES = new Set(["go.mod", "package.json", "pubspec.yaml", "Cargo.toml"]);
// In the real live test this fix is responding to, the model created
// go.mod via `git init && go mod init todo-go` (bash), never via the
// write tool -- a manifest-generating CLI command is at least as common
// as writing the manifest file directly, so the write-tool-only arming
// trigger below would have missed the exact scenario it exists to catch.
const MANIFEST_CREATING_BASH_PATTERN =
	/\bgo mod init\b|\bnpm init\b|\byarn init\b|\bpnpm init\b|\bcargo init\b|\bcargo new\b|\bflutter create\b|\bdart create\b/;

function nudgeText(resolved: string): string {
	return (
		"This project has no Makefile and no documented verification command, but its actual " +
		`check resolves to: \`${resolved}\`. Add a Makefile with \`test\`, \`lint\`, and \`verify\` ` +
		"targets that run this exact command (it is fine for all three to run the same command " +
		"if there is no separate lint step) so `make verify` becomes this repo's canonical check. " +
		"The target must cover every component this project actually has, not a narrower or " +
		"different command than the one resolved above."
	);
}

type Evaluation =
	| { state: "already-covered" }
	| { state: "eligible"; resolved: string }
	| { state: "greenfield" };

// Three states, not a boolean: "nothing resolved" means two different
// things -- a Makefile/documented command already covers this repo (stay
// silent, permanently), or there's genuinely nothing to resolve yet
// because no manifest exists (greenfield -- give conditional guidance).
// Collapsing these into one falsy check was a real bug: it re-nudged the
// "already covered" case with greenfield guidance it didn't need.
async function evaluate(cwd: string): Promise<Evaluation> {
	const [makefileCommand, documented] = await Promise.all([
		makefileVerificationCommand(cwd),
		documentedCommand(cwd),
	]);
	if (makefileCommand || documented) return { state: "already-covered" };
	const resolved = await resolveVerificationCommand(cwd);
	return resolved ? { state: "eligible", resolved } : { state: "greenfield" };
}

export default function makefileScaffoldNudge(pi: ExtensionAPI): void {
	// Per cwd: armed once a manifest file is written this session, and
	// nudged at most once regardless of how many manifest files follow.
	const armedCwds = new Set<string>();
	const nudgedCwds = new Set<string>();

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const evaluation = await evaluate(ctx.cwd);
			if (evaluation.state === "already-covered") return undefined;
			if (evaluation.state === "eligible") {
				nudgedCwds.add(ctx.cwd);
				return { systemPrompt: `${event.systemPrompt}\n\n${nudgeText(evaluation.resolved)}` };
			}
			return {
				systemPrompt:
					`${event.systemPrompt}\n\n` +
					"This project has no build/dependency manifest yet, so there is nothing to resolve a " +
					"Makefile target from. Once you create one (go.mod, package.json, pubspec.yaml, " +
					"Cargo.toml), also add a Makefile with `test`, `lint`, and `verify` targets running that " +
					"stack's real check, so `make verify` becomes this repo's canonical check from the start.",
			};
		} catch (error) {
			if (isStaleContextError(error)) return undefined;
			throw error;
		}
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return;
		if (event.toolName === "write") {
			const path = (event.input as { path?: string }).path;
			if (path && MANIFEST_BASENAMES.has(basename(path))) armedCwds.add(ctx.cwd);
			return;
		}
		if (event.toolName === "bash") {
			const command = (event.input as { command?: string }).command;
			if (command && MANIFEST_CREATING_BASH_PATTERN.test(command)) armedCwds.add(ctx.cwd);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!armedCwds.has(ctx.cwd) || nudgedCwds.has(ctx.cwd)) return;
		armedCwds.delete(ctx.cwd);
		try {
			const evaluation = await evaluate(ctx.cwd);
			if (evaluation.state !== "eligible") return;
			nudgedCwds.add(ctx.cwd);
			pi.sendUserMessage(nudgeText(evaluation.resolved), { deliverAs: "followUp" });
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		}
	});
}
