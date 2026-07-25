/**
 * Continuation-nudge extension.
 *
 * Targets the "plan-then-abandon" failure mode observed in the local-model-bench
 * pi-local run (go/lru-cache, 2026-07-23): the model correctly diagnosed a bug,
 * announced the fix in plain text ("Now add the moveToEnd helper...") with no
 * tool call, and stopped (stopReason "stop", agent_settled) instead of making
 * the edit. See ai-stack/local-quality-next-steps-plan.md Phase 1.
 *
 * Widened 2026-07-25 after a real occurrence in the personal-assistant
 * daily-briefing-screen dispatch: the model stopped with stopReason "stop",
 * no tool call, and *zero text content* -- not forward-looking prose. The
 * original forward-looking-prose check (isPureForwardLookingProse) requires
 * non-empty text and so never fired on this case. See
 * pi-real-task-report-daily-briefing-screen.md, "Follow-up" section.
 *
 * Heuristic: on a turn that ends with stopReason "stop", no tool call, and no
 * verification command run yet this session, inject one follow-up nudge
 * instead of letting the turn end -- if either (a) the text matches a
 * forward-looking verb pattern, or (b) the text is empty/whitespace-only
 * (silent abandonment, no announcement at all). Fires at most once per agent
 * run to avoid looping if the model keeps abandoning.
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

const NUDGE_MESSAGES = {
	"forward-looking": "You described an edit but didn't make it. Make it now.",
	silent: "You stopped without making a tool call or finishing your response. Continue the task.",
} as const;

type AbandonKind = keyof typeof NUDGE_MESSAGES;

/** Returns which abandonment pattern this turn matches, or null if it doesn't look abandoned. */
function classifyAbandonedTurn(content: { type: string; text?: string }[]): AbandonKind | null {
	if (content.some((c) => c.type === "toolCall")) return null;
	const text = content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n")
		.trim();
	if (!text) return "silent";
	return FORWARD_LOOKING_PATTERNS.some((re) => re.test(text)) ? "forward-looking" : null;
}

export default function (pi: ExtensionAPI) {
	let nudgedThisRun = false;
	// Entry id at the start of *this* pi invocation, so verificationRan only looks
	// at what this run itself has done -- not at verification from an earlier
	// `--continue`d pass in the same persisted session. Without this, once any
	// pass in a multi-dispatch session runs `make verify` once, the nudge is
	// silently disarmed for every later pass too, even if that later pass
	// abandons before verifying its own change. See the "Follow-up" section of
	// pi-real-task-report-daily-briefing-screen.md.
	let runStartEntryId: string | undefined;

	pi.on("agent_start", (_event, ctx) => {
		nudgedThisRun = false;
		const leaf = ctx.sessionManager.getLeafEntry();
		runStartEntryId = leaf?.id;
	});

	pi.on("turn_end", async (event, ctx) => {
		if (nudgedThisRun) return;
		const { message } = event;
		if (message.role !== "assistant") return;
		if (message.stopReason !== "stop") return;
		if (event.toolResults.length > 0) return;
		const kind = classifyAbandonedTurn(message.content);
		if (!kind) return;

		const leaf = ctx.sessionManager.getLeafEntry();
		const branch = leaf ? ctx.sessionManager.getBranch(leaf.id) : [];
		const startIdx = runStartEntryId ? branch.findIndex((entry) => entry.id === runStartEntryId) : -1;
		const thisRunBranch = startIdx >= 0 ? branch.slice(startIdx + 1) : branch;
		const verificationRan = thisRunBranch.some((entry) => {
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
		pi.sendUserMessage(NUDGE_MESSAGES[kind], { deliverAs: "followUp" });
	});
}
