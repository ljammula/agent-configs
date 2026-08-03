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
 * Fixed 2026-07-26 after a real occurrence in local-model-bench's
 * `go/notes-api` run: the model ran `go test` early for its original
 * implementation, `cross-model-review.ts` then injected a followUp
 * flagging a real bug, the model correctly diagnosed the fix in prose and
 * abandoned it without a tool call -- and the nudge stayed silent.
 * `verificationRan` scanned the *whole current invocation* for any prior
 * passing verification command, so that early, unrelated `go test` run
 * permanently disarmed the nudge for the rest of the session, even though
 * the specific fix the model abandoned was never itself verified. Now
 * scoped to *since the most recent user-role message* (the original task,
 * a steering message, or an injected followUp like a review flag) instead
 * of since the start of the invocation -- each new ask gets its own
 * verification requirement. See `local-model-bench/SPEC.md`'s 2026-07-26
 * report for the full transcript trace.
 *
 * Heuristic: on a turn that ends with stopReason "stop" and no tool call,
 * inject a follow-up nudge when the model announces unfinished work, stops
 * silently, or the most recent verification command failed. A passing check
 * suppresses abandonment nudges; merely running a failing check does not.
 * Verification piped without `pipefail` is inconclusive because the final
 * consumer can hide the test runner's non-zero exit status.
 * Retries are bounded to avoid an infinite loop when a model cannot recover.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	BROAD_VERIFICATION_PATTERNS,
	verificationPipelineCanMaskFailure,
} from "./lib/verification.ts";

const FORWARD_LOOKING_PATTERNS = [
	/\bi(?:'ll| will) now\b/i,
	/\bnext,? i(?:'ll| will)\b/i,
	/\bnow (?:add|implement|write|fix|update|create|refactor)\b/i,
	/\blet me now\b/i,
	/\bi(?:'m| am) going to\b/i,
];

const NUDGE_MESSAGES = {
	"forward-looking": "You described an edit but didn't make it. Make it now.",
	silent: "You stopped without making a tool call or finishing your response. Continue the task.",
	"failed-verification":
		"The latest verification command failed. Inspect its output, make the smallest corrective edit, and rerun the relevant check. Do not stop until it passes.",
} as const;

const MAX_NUDGES_PER_RUN = 3;

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
	let nudgeCount = 0;
	let latestVerificationFailed = false;
	// Entry id at the start of *this* pi invocation, so verificationRan only looks
	// at what this run itself has done -- not at verification from an earlier
	// `--continue`d pass in the same persisted session. Without this, once any
	// pass in a multi-dispatch session runs `make verify` once, the nudge is
	// silently disarmed for every later pass too, even if that later pass
	// abandons before verifying its own change. See the "Follow-up" section of
	// pi-real-task-report-daily-briefing-screen.md.
	let runStartEntryId: string | undefined;

	pi.on("agent_start", (_event, ctx) => {
		nudgeCount = 0;
		latestVerificationFailed = false;
		const leaf = ctx.sessionManager.getLeafEntry();
		runStartEntryId = leaf?.id;
	});

	// A new original, steering, or extension follow-up ask starts a fresh
	// verification scope. A failed check from the prior ask must not leak into it.
	pi.on("input", () => {
		latestVerificationFailed = false;
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") return;
		const command = event.input?.command;
		if (typeof command !== "string") return;
		if (!BROAD_VERIFICATION_PATTERNS.some((re) => re.test(command))) return;
		const pipelineCanMaskFailure = verificationPipelineCanMaskFailure(command);
		latestVerificationFailed = event.isError || pipelineCanMaskFailure;
	});

	pi.on("turn_end", async (event, ctx) => {
		if (nudgeCount >= MAX_NUDGES_PER_RUN) return;
		const { message } = event;
		if (message.role !== "assistant") return;
		if (message.stopReason !== "stop") return;
		if (event.toolResults.length > 0) return;
		const kind = latestVerificationFailed
			? "failed-verification"
			: classifyAbandonedTurn(message.content);
		if (!kind) return;

		const leaf = ctx.sessionManager.getLeafEntry();
		const branch = leaf ? ctx.sessionManager.getBranch(leaf.id) : [];
		const startIdx = runStartEntryId ? branch.findIndex((entry) => entry.id === runStartEntryId) : -1;
		const thisRunBranch = startIdx >= 0 ? branch.slice(startIdx + 1) : branch;

		// Scope to since the most recent ask (the original task, a steering
		// message, or an injected followUp such as a review flag) rather than
		// since the start of the whole invocation -- a verification run that
		// predates the current ask says nothing about whether *this* abandoned
		// turn's change has been checked. See file header, "Fixed 2026-07-26".
		let lastAskIdx = -1;
		thisRunBranch.forEach((entry, i) => {
			if (entry.type === "message" && entry.message.role === "user") lastAskIdx = i;
		});
		const sinceLastAsk = lastAskIdx >= 0 ? thisRunBranch.slice(lastAskIdx + 1) : thisRunBranch;

		const verificationRan = sinceLastAsk.some((entry) => {
			if (entry.type !== "message" || entry.message.role !== "assistant") return false;
			return entry.message.content.some(
				(c) =>
					c.type === "toolCall" &&
					c.name === "bash" &&
					typeof c.arguments?.command === "string" &&
					BROAD_VERIFICATION_PATTERNS.some((re) => re.test(c.arguments.command)),
			);
		});
		if (verificationRan && !latestVerificationFailed) return;

		nudgeCount += 1;
		pi.sendUserMessage(NUDGE_MESSAGES[kind], { deliverAs: "followUp" });
	});
}
