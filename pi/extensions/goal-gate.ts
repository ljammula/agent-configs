/**
 * Goal-gate extension: pi's version of a Claude-Code-style `/goal` command.
 *
 * `/goal <condition>` sets a goal for the rest of this pi process (session-
 * scoped, same as Claude Code's own /goal). On every turn that looks like a
 * stopping point (`stopReason === "stop"`), the gate checks whether the
 * model has actually earned the right to stop: its final message must end
 * with a `GOAL COMPLETE: <evidence>` line, and the most recent broad
 * verification command run since then must have passed against the diff as
 * it stands *right now* -- the same diff-hash-bound evidence check
 * quality-gate.ts uses (lib/verification.ts's `evidencePassesCurrentDiff`),
 * so a pass followed by further unverified edits can't be reused to back a
 * later completion claim. Absent either, the gate nudges the model to keep
 * working instead of letting the turn -- and, under `pi -p`, the process --
 * end. Bounded by `PI_GOAL_MAX_ROUNDS` (default 15) so a goal that can't
 * converge doesn't nudge forever.
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
 *
 * Known operational risk, root-caused 2026-08-12 (see
 * pi-harness-validation-status.md's "root cause found via the inference
 * host's own server-side logs" entry): a long-running `/goal` session's
 * accumulated context can push a single request's *prefill* time past
 * roughly two minutes on the local `ai-stack-local` route, and something
 * client-side (not yet traced to its exact call site, but confirmed
 * shorter than the vendored OpenAI SDK's own 10-minute default) aborts
 * the connection right as the first token would otherwise arrive -- this
 * is believed to have killed the `pi -p` process outright on at least two
 * confirmed occasions, mid-round, on this exact goal-gate flow. Not a bug
 * in this file (the timeout lives in the request/HTTP layer, not
 * goal-gate.ts's own logic), and this extension's session-scoped-only
 * state (see above) means a kill here loses the active goal entirely --
 * documented here so a future reader debugging a `/goal` session that
 * silently stopped mid-build knows where to look first.
 *
 * Non-Claude-model hardening (live-confirmed 2026-08-11/12 on the local
 * ai-stack route, see pi-harness-validation-status.md): a weaker model can
 * run an entire multi-round goal without ever attempting the `GOAL
 * COMPLETE:` marker, instead relying on whatever ad hoc "done?" phrasing a
 * skill (e.g. before-done) trained into it -- the gate then only ever fires
 * the generic "not yet met" nudge, which used to say nothing about the
 * marker format at all beyond the one-time kickoff message. Two mitigations:
 * (1) every plain nudge now restates the exact marker requirement, so
 * recalling it doesn't depend on a single early instruction surviving
 * context compaction; (2) a `session_compact` handler re-sends that same
 * reminder immediately after any compaction lands while a goal is active,
 * since a paraphrased compaction summary is not guaranteed to preserve a
 * literal string requirement. A third guard tracks the working diff's hash
 * across nudged rounds: if it hasn't changed for `STALL_ROUNDS_BEFORE_
 * ESCALATION` consecutive rounds, the model is re-asserting "done" without
 * making new edits, and the nudge escalates to say so explicitly instead of
 * repeating the same generic prompt until the round cap silently drops the
 * goal.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isStaleContextError } from "./lib/stale-context.ts";
import {
	BROAD_VERIFICATION_PATTERNS,
	evidencePassesCurrentDiff,
	snapshotDiff,
	verificationPipelineCanMaskFailure,
	type VerificationEvidence,
} from "./lib/verification.ts";

const DEFAULT_MAX_ROUNDS = 15;
const COMPLETE_MARKER = /^GOAL COMPLETE:\s*(.+)$/i;
// Consecutive plain "not yet met" nudges whose diff hash didn't move before
// the nudge text escalates from generic to "you have not actually changed
// anything." Two rather than one: the first unchanged round is often just a
// verification-only turn (re-running `make verify` after a real prior edit
// that already got its own nudge), not yet a real stall.
const STALL_ROUNDS_BEFORE_ESCALATION = 2;

const MARKER_REMINDER =
	'Once it truly passes, end your final message with exactly this line: "GOAL COMPLETE: <one-sentence summary of the evidence>" -- no other phrasing (e.g. "done?", "all set") satisfies this gate.';

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

// The docstring's contract is "end your final message with a line reading
// exactly: GOAL COMPLETE: ...", i.e. the marker must be the message's last
// line, not merely present anywhere in it. COMPLETE_MARKER's `$` (no `m`
// flag) only anchors to the end of the whole string, so it must be tested
// against just the final non-empty line -- otherwise a multiline regex would
// match a marker line followed by more prose (e.g. a hedge like "Actually,
// more work remains" after the marker), and testing the full message would
// wrongly reject a genuine completion that has ordinary narrative before it.
function lastNonEmptyLine(text: string): string {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		if (lines[i].trim() !== "") return lines[i];
	}
	return "";
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
	// The most recent broad verification command's outcome, bound to the
	// diff it actually ran against -- same VerificationEvidence shape and
	// evidencePassesCurrentDiff() check quality-gate.ts uses. Reset to
	// undefined specifically when a GOAL COMPLETE claim is rejected (see the
	// turn_end handler below for why only that path resets it, not every
	// nudge). Previously this only tracked pass/fail with no diff binding,
	// so a pass followed by further unverified edits and an immediate
	// completion claim could slip through; tightened to close that gap.
	let evidence: VerificationEvidence | undefined;
	let baseSha: string | undefined;
	// Stall tracking for the escalation nudge: the diff hash as of the last
	// *plain* nudge (not a rejected-completion-claim nudge -- that path
	// already tells the model exactly what's wrong) and how many nudges in a
	// row it hasn't moved. Reset whenever a goal is (re)set.
	let lastNudgeDiffHash: string | undefined;
	let staleRounds = 0;

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
	pi.on("agent_start", async (_event, ctx) => {
		for (const resolve of agentStartWaiters.splice(0)) resolve();
		if (!baseSha) {
			const result = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: 5000 }).catch(() => undefined);
			if (result?.code === 0) baseSha = result.stdout.trim();
		}
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
			evidence = undefined;
			lastNudgeDiffHash = undefined;
			staleRounds = 0;
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

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const command = event.input?.command;
		if (typeof command !== "string" || !BROAD_VERIFICATION_PATTERNS.some((re) => re.test(command))) return;
		try {
			const snapshot = await snapshotDiff(pi, ctx.cwd, baseSha);
			const inconclusive = event.isError || verificationPipelineCanMaskFailure(command);
			evidence = {
				command,
				diffHash: snapshot.hash,
				startedAt: Date.now(),
				endedAt: Date.now(),
				exitCode: inconclusive ? 1 : 0,
				truncated: false,
			};
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		}
	});

	// A compaction summary is a paraphrase, not a transcript -- it is not
	// guaranteed to preserve the kickoff message's literal marker
	// requirement, and the model has no other way to rediscover the exact
	// required string. Re-assert it immediately once a goal-bearing session
	// gets compacted, rather than waiting on the next turn_end nudge to carry
	// it. Skipped when `willRetry` is true: that's context-overflow recovery
	// mid-turn, and the aborted turn is about to be retried automatically --
	// injecting a follow-up here would race that retry instead of landing
	// cleanly between turns the way every other nudge does.
	pi.on("session_compact", async (event, _ctx) => {
		if (!goal || event.willRetry) return;
		pi.appendEntry("pi-goal-trace", { event: "compaction-reminder", condition: goal.condition, rounds: goal.rounds });
		pi.sendUserMessage(
			[
				`(Context was just compacted. Goal is still active: ${goal.condition})`,
				"",
				"Keep working toward it using whatever the compaction summary preserved of prior progress.",
				MARKER_REMINDER,
			].join("\n"),
			{ deliverAs: "followUp" },
		);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!goal) return;
		const { message } = event;
		if (message.role !== "assistant" || message.stopReason !== "stop") return;

		const declaredComplete = COMPLETE_MARKER.test(lastNonEmptyLine(messageText(message)));

		// Only bother snapshotting the diff for a completion claim's own
		// verification check -- an ordinary "not yet met" nudge doesn't need
		// that. It still needs *a* snapshot for stall tracking below, though,
		// so a completion-claim snapshot is reused there when we have one
		// rather than paying for `git diff` twice on the same turn.
		let verified = false;
		let snapshot: Awaited<ReturnType<typeof snapshotDiff>> | undefined;
		if (declaredComplete) {
			try {
				snapshot = await snapshotDiff(pi, ctx.cwd, baseSha);
				verified = evidencePassesCurrentDiff(evidence, snapshot);
			} catch (error) {
				if (!isStaleContextError(error)) throw error;
				return; // stale session; a fresh extension instance owns whatever comes next
			}
		}

		if (declaredComplete && verified) {
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

		// Stall tracking only applies to plain "not yet met" nudges -- a
		// rejected completion claim already gets a specific, actionable
		// message regardless of whether the diff moved.
		let stalled = false;
		if (!declaredComplete) {
			if (!snapshot) {
				try {
					snapshot = await snapshotDiff(pi, ctx.cwd, baseSha);
				} catch (error) {
					if (!isStaleContextError(error)) throw error;
					// Can't tell if it stalled; fall through without tracking
					// rather than dropping the nudge entirely.
				}
			}
			if (snapshot) {
				stalled = snapshot.hash === lastNudgeDiffHash && staleRounds + 1 >= STALL_ROUNDS_BEFORE_ESCALATION;
				staleRounds = snapshot.hash === lastNudgeDiffHash ? staleRounds + 1 : 0;
				lastNudgeDiffHash = snapshot.hash;
			}
		}
		if (stalled) {
			pi.appendEntry("pi-goal-trace", { event: "stalled", condition: goal.condition, rounds: goal.rounds });
		}

		const nudge = declaredComplete
			? "You wrote GOAL COMPLETE but the most recent verification command did not pass against the current diff " +
				"(or none has run since). Run the project's real verification command against the latest edits and only " +
				"claim complete once it actually passes."
			: stalled
				? `Goal not yet met: "${goal.condition}". The working diff hasn't changed across the last ` +
					`${staleRounds} check(s) -- restating that it's done isn't progress. Make a concrete code edit, ` +
					`then verify it. ${MARKER_REMINDER}`
				: `Goal not yet met: "${goal.condition}". Keep working -- make the next concrete edit, then verify it. ${MARKER_REMINDER}`;
		// Only discard the current evidence on a *rejected completion claim* --
		// that's the one case where reusing it would be wrong (the model must
		// re-verify before claiming again). A plain "not yet met" nudge fires
		// on every stopReason:"stop" turn, including ordinary mid-task
		// narrative with no tool call attached (exactly what
		// continuation-nudge.ts calls an abandoned turn) -- live-confirmed
		// 2026-08-09: resetting on *every* nudge wiped out a genuine pass
		// long before the model's next real GOAL COMPLETE attempt, so a
		// truthful claim kept getting rejected as unverified. See
		// pi-harness-validation-status.md's goal-gate entry.
		if (declaredComplete) evidence = undefined;
		pi.sendUserMessage(`${nudge}\n\n(round ${goal.rounds}/${goal.maxRounds})`, { deliverAs: "followUp" });
	});
}
