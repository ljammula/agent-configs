/**
 * Continuation-nudge extension.
 *
 * Targets the "plan-then-abandon" failure mode observed in the local-model-bench
 * pi-local run (go/lru-cache, 2026-07-23): the model correctly diagnosed a bug,
 * announced the fix in plain text ("Now add the moveToEnd helper...") with no
 * tool call, and stopped (stopReason "stop", agent_settled) instead of making
 * the edit. See ai-stack/local-quality-next-steps-plan.md Phase 1.
 *
 * Heuristic: on a turn that ends with stopReason "stop", pure prose content
 * (no tool call), text matching a forward-looking verb pattern, and no
 * verification command run yet this session -- inject one follow-up nudge
 * instead of letting the turn end. Fires at most once per agent run to avoid
 * looping if the model keeps abandoning.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FORWARD_LOOKING_PATTERNS = [
	/\bi(?:'ll| will) now\b/i,
	/\bnext,? i(?:'ll| will)\b/i,
	/\bnow (?:add|implement|write|fix|update|create|refactor)\b/i,
	/\blet me now\b/i,
	/\bi(?:'m| am) going to\b/i,
];

const VERIFICATION_COMMAND_PATTERNS = [
	/\bgo (?:test|build)\b/i,
	/\bnpm test\b/i,
	/\byarn test\b/i,
	/\bpytest\b/i,
	/\bmake (?:verify|test)\b/i,
	/\bflutter (?:test|analyze)\b/i,
	/\bcargo test\b/i,
	/\bdart (?:test|format)\b/i,
];

const NUDGE_MESSAGE = "You described an edit but didn't make it. Make it now.";

function isPureForwardLookingProse(content: { type: string; text?: string }[]): boolean {
	if (content.some((c) => c.type === "toolCall")) return false;
	const text = content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n")
		.trim();
	if (!text) return false;
	return FORWARD_LOOKING_PATTERNS.some((re) => re.test(text));
}

export default function (pi: ExtensionAPI) {
	let nudgedThisRun = false;

	pi.on("agent_start", () => {
		nudgedThisRun = false;
	});

	pi.on("turn_end", async (event, ctx) => {
		if (nudgedThisRun) return;
		const { message } = event;
		if (message.role !== "assistant") return;
		if (message.stopReason !== "stop") return;
		if (event.toolResults.length > 0) return;
		if (!isPureForwardLookingProse(message.content)) return;

		const leaf = ctx.sessionManager.getLeafEntry();
		const branch = leaf ? ctx.sessionManager.getBranch(leaf.id) : [];
		const verificationRan = branch.some((entry) => {
			if (entry.type !== "message" || entry.message.role !== "assistant") return false;
			return entry.message.content.some(
				(c) =>
					c.type === "toolCall" &&
					c.name === "bash" &&
					typeof c.arguments?.command === "string" &&
					VERIFICATION_COMMAND_PATTERNS.some((re) => re.test(c.arguments.command)),
			);
		});
		if (verificationRan) return;

		nudgedThisRun = true;
		pi.sendUserMessage(NUDGE_MESSAGE);
	});
}
