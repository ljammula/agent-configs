/**
 * Wall-clock-budget-nudge extension.
 *
 * The proximate cause of the loss described in `progress-stall-guard.ts`'s
 * header wasn't that the model never found the right answer -- it found it
 * in the first 7 of 31 minutes, then kept re-verifying an already-correct
 * diagnosis until an *external* harness timeout killed the process with no
 * warning it was about to happen. Pi itself has no notion of that external
 * deadline; only the caller (e.g. `local-model-bench`'s runner, which enforces
 * `harness_timeout_minutes` from a task's `meta.json`) knows it. This
 * extension closes that specific gap: if the caller tells it the budget, it
 * warns once near the end of it, regardless of whether anything else here
 * thinks the model is stuck.
 *
 * Deliberately simple and low-risk: unlike `progress-stall-guard.ts`, this
 * has near-zero false-positive surface (the deadline is either real or the
 * env var is unset, in which case the extension is inert) and needed no
 * design debate before shipping live. See
 * `pi-harness-validation-status.md`'s 2026-08-16 entry for the run this
 * would have plausibly rescued.
 *
 * `PI_HARNESS_TIMEOUT_MINUTES` must be set by the caller before `pi -p`
 * starts (read once at registration, same convention as `AI_STACK_HOST` in
 * `ai-stack-local.ts`). Unset or non-numeric: no-op, no listeners registered.
 *
 * Bug found live 2026-08-16 (see pi-harness-validation-status.md): `pi -p`
 * fires `agent_start` on every internal auto-retry after a transient
 * provider error (`503`/`502`/dropped connection), not just once at the
 * true start of the invocation -- a run that hit 16 retries under real
 * ai-stack proxy contention re-armed `startedAt` 16 times, so the deadline
 * never actually accumulated and the warning never fired despite 25+ real
 * minutes elapsed. `AgentStartEvent` carries no payload distinguishing a
 * retry restart from a fresh invocation, so the fix is structural: only the
 * *first* `agent_start` this extension instance ever sees sets the clock.
 * Since each extension registration corresponds to exactly one `pi -p`
 * process (confirmed against the harness's own retry implementation), that
 * first-start is the correct, retry-invariant deadline anchor.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WARN_AT_FRACTION = 0.75;

export default function (pi: ExtensionAPI) {
	const raw = process.env.PI_HARNESS_TIMEOUT_MINUTES;
	const minutes = raw ? Number(raw) : NaN;
	if (!Number.isFinite(minutes) || minutes <= 0) return;

	const budgetMs = minutes * 60_000;
	const warnAtMs = budgetMs * WARN_AT_FRACTION;
	let startedAt: number | undefined;
	let warned = false;

	pi.on("agent_start", () => {
		// Only the true first start anchors the deadline -- see file header.
		if (startedAt !== undefined) return;
		startedAt = Date.now();
	});

	pi.on("turn_end", () => {
		if (warned || startedAt === undefined) return;
		const elapsedMs = Date.now() - startedAt;
		if (elapsedMs < warnAtMs) return;

		warned = true;
		const usedMinutes = Math.round(elapsedMs / 60_000);
		pi.appendEntry("pi-wall-clock-budget-warning", { minutes, usedMinutes });
		pi.sendUserMessage(
			`You have used approximately ${usedMinutes} of ${minutes} available minutes on this task. If you have already diagnosed a fix, apply and verify it now rather than continuing to investigate -- the process will be terminated at the deadline with no chance to land a change in progress.`,
			{ deliverAs: "followUp" },
		);
	});
}
