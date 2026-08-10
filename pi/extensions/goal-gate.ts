/**
 * Goal-gate extension: pi's version of a Claude-Code-style `/goal` command.
 *
 * `/goal <condition>` sets a goal for the rest of this pi process (session-
 * scoped, same as Claude Code's own /goal). On every turn that looks like a
 * stopping point (`stopReason === "stop"`), the gate checks whether the
 * model has actually earned the right to stop: its final message must end
 * with a `GOAL COMPLETE: <evidence>` line, and the most recent broad
 * verification command run since then must have passed. Absent either, the
 * gate nudges the model to keep working instead of letting the turn -- and,
 * under `pi -p`, the process -- end. Bounded by `PI_GOAL_MAX_ROUNDS`
 * (default 15) so a goal that can't converge doesn't nudge forever.
 *
 * Deliberately does not call out to an LLM to judge completion the way
 * cross-model-review.ts does: AGENTS.md documents that a small model told to
 * "run the gate" reports success without running anything, and a same-model
 * completion judge carries exactly that same self-report bias. A passing
 * verification command is the one signal this harness already treats as
 * real evidence elsewhere (before-done, quality-gate, continuation-nudge);
 * goal-gate reuses that convention instead of inventing a second, weaker one.
 *
 * `/goal clear` clears an active goal early. `/goal status` reports the
 * current condition and round count without changing anything.
 *
 * Scope: state lives in this extension instance's memory, not on disk. A
 * fresh `pi -p` process (including `pi -p --continue`, which is a new OS
 * process against the same session file) starts with no active goal --
 * this mirrors an interactive session's own Stop-hook-style scoping, but
 * does not survive process restarts. For a zero-human batch build that must
 * survive restarts, use `pi/scripts/build_app.py`'s outer round loop
 * instead; that script drives verification from outside the process for
 * exactly this reason (see its own header comment).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BROAD_VERIFICATION_PATTERNS, verificationPipelineCanMaskFailure } from "./lib/verification.ts";

const DEFAULT_MAX_ROUNDS = 15;
const COMPLETE_MARKER = /^GOAL COMPLETE:\s*(.+)$/im;

export function resolveMaxRounds(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_GOAL_MAX_ROUNDS;
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ROUNDS;
}

const DEFAULT_KICKOFF_TIMEOUT_MS = 10_000;

export function resolveKickoffTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_GOAL_KICKOFF_TIMEOUT_MS;
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_KICKOFF_TIMEOUT_MS;
}

interface GoalState {
	condition: string;
	rounds: number;
	maxRounds: number;
}

function messageText(message: { content: { type: string; text?: string }[] }): string {
	return message.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

function kickoffMessage(condition: string): string {
	return [
		`Goal set: ${condition}`,
		"",
		"Work toward this now. Make real edits, use the appropriate skill(s), and run the",
		"project's actual verification command after each meaningful chunk. Keep going across",
		"turns until the goal is genuinely met -- a description of what you would do is not the",
		"same as doing it.",
		"",
		"Only once it is met, and only after a verification command you actually ran has",
		"passed, end your final message with a line reading exactly:",
		"GOAL COMPLETE: <one-sentence summary of the evidence>",
		"Do not write that line speculatively, before verifying, or if any verification failed.",
	].join("\n");
}

export default function goalGate(pi: ExtensionAPI): void {
	let goal: GoalState | undefined;
	// Reflects only the *most recent* broad verification command's outcome.
	// Reset to "none" specifically when a GOAL COMPLETE claim is rejected
	// (see the turn_end handler below for why only that path resets it, not
	// every nudge). Known, accepted gap: unlike quality-gate.ts, this is not
	// bound to the current diff hash, so a pass followed by further
	// unverified edits and an immediate completion claim can still slip
	// through. goal-gate deliberately trades that precision for simplicity;
	// tighten it if this gap is ever hit live.
	let lastVerification: "pass" | "fail" | "none" = "none";

	// `ctx.waitForIdle()` returns immediately if the agent is idle *right
	// now* (confirmed by reading agent-session.js: `if (this.isIdle) return`).
	// `pi.sendUserMessage()` only queues a turn -- it doesn't return a
	// promise, and the turn it triggers hasn't started by the time the
	// command handler's next line runs, so calling waitForIdle() straight
	// after sendUserMessage races the turn and returns instantly, doing
	// nothing. Confirmed live: under `pi -p`, without this, the process
	// exited with zero agent events at all -- not even `agent_start`.
	// Wait for the turn to actually *start* first (bounded, in case it
	// never does), then wait for it to finish.
	const agentStartWaiters: (() => void)[] = [];
	pi.on("agent_start", () => {
		for (const resolve of agentStartWaiters.splice(0)) resolve();
	});
	function waitForNextAgentStart(timeoutMs = resolveKickoffTimeoutMs()): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(resolve, timeoutMs);
			agentStartWaiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	pi.registerCommand("goal", {
		description: "Set a goal pi keeps working toward across turns until it's verifiably met",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			if (!args) {
				ctx.ui.notify("Usage: /goal <condition to keep working toward> | /goal status | /goal clear", "info");
				return;
			}
			if (/^clear$/i.test(args)) {
				if (!goal) {
					ctx.ui.notify("No active goal.", "info");
					return;
				}
				ctx.ui.notify(`Goal cleared (was: "${goal.condition}", ${goal.rounds} round(s) used).`, "info");
				goal = undefined;
				return;
			}
			if (/^status$/i.test(args)) {
				ctx.ui.notify(
					goal ? `Active goal: "${goal.condition}" -- round ${goal.rounds}/${goal.maxRounds}.` : "No active goal.",
					"info",
				);
				return;
			}
			goal = { condition: args, rounds: 0, maxRounds: resolveMaxRounds() };
			lastVerification = "none";
			ctx.ui.notify(`Goal set: ${args}`, "info");
			pi.sendUserMessage(kickoffMessage(args), { deliverAs: "followUp" });
			// Under `pi -p`, the process exits once this command handler's
			// promise resolves. Wait for the kicked-off turn to start, then
			// for the agent to go idle again, so the process stays alive
			// through it. Interactive sessions don't need this (the process
			// outlives the command either way), but waiting is harmless there.
			await waitForNextAgentStart();
			await ctx.waitForIdle();
		},
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") return;
		const command = event.input?.command;
		if (typeof command !== "string" || !BROAD_VERIFICATION_PATTERNS.some((re) => re.test(command))) return;
		lastVerification = event.isError || verificationPipelineCanMaskFailure(command) ? "fail" : "pass";
	});

	pi.on("turn_end", (event) => {
		if (!goal) return;
		const { message } = event;
		if (message.role !== "assistant" || message.stopReason !== "stop") return;

		const declaredComplete = COMPLETE_MARKER.test(messageText(message));

		if (declaredComplete && lastVerification === "pass") {
			pi.appendEntry("pi-goal-trace", { event: "complete", condition: goal.condition, rounds: goal.rounds });
			goal = undefined;
			return;
		}

		goal.rounds += 1;
		if (goal.rounds > goal.maxRounds) {
			pi.appendEntry("pi-goal-trace", { event: "cap-hit", condition: goal.condition, rounds: goal.rounds });
			goal = undefined;
			return;
		}

		const nudge = declaredComplete
			? "You wrote GOAL COMPLETE but the most recent verification command did not pass (or none has " +
				"run since). Run the project's real verification command and only claim complete once it actually passes."
			: `Goal not yet met: "${goal.condition}". Keep working -- make the next concrete edit, then verify it.`;
		// Only discard the current pass/fail signal on a *rejected completion
		// claim* -- that's the one case where reusing it would be wrong (the
		// model must re-verify before claiming again). A plain "not yet met"
		// nudge fires on every stopReason:"stop" turn, including ordinary
		// mid-task narrative with no tool call attached (exactly what
		// continuation-nudge.ts calls an abandoned turn) -- live-confirmed
		// 2026-08-09: resetting on *every* nudge wiped out a genuine pass
		// long before the model's next real GOAL COMPLETE attempt, so a
		// truthful claim kept getting rejected as unverified. See
		// pi-harness-validation-status.md's goal-gate entry.
		if (declaredComplete) lastVerification = "none";
		pi.sendUserMessage(`${nudge}\n\n(round ${goal.rounds}/${goal.maxRounds})`, { deliverAs: "followUp" });
	});
}
