// Shared support module; the installed lib directory is not an extension entry point.
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * `agent_end` fires while the session is still mid-run, on every internal
 * retry/abort/compaction cycle -- not only on a genuine "the model is done"
 * stop (confirmed against pi-coding-agent's `_handlePostAgentRun`, which
 * decides retry/compaction *after* `agent_end`'s listeners have already
 * run, so extensions can't tell the difference from the event itself).
 * `AgentEndEvent.messages` carries the run's message list, mirroring the
 * scan `_willRetryAfterAgentEnd` does internally: the same shape documented
 * on `@earendil-works/pi-agent-core`'s own module comment -- "a run ends in
 * exactly one of: ... `error` carrying the final AssistantMessage with
 * stopReason 'error' or 'aborted'".
 *
 * Any `agent_end` handler that runs verification or queues a corrective
 * follow-up must call this first and bail on `true`. Two live-confirmed
 * failure modes without this guard (2026-08-18 Opus review of the
 * agent_end-based follow-up fix -- see pi-harness-history.md):
 *   - an aborted run (user Ctrl-C, or a `-p` timeout) still reaches
 *     `agent_end` mid-abort; running verification against an already-
 *     aborted signal fails, and a corrective follow-up gets queued that
 *     resurrects a run the user just killed.
 *   - a retryable transport error re-fires `agent_end` on an *unchanged*
 *     failing diff; without this guard each retry burns a full
 *     verification run and one of a small, shared corrective-round budget
 *     on transport flakiness instead of a real failure.
 */
export function lastAssistantMessageFailed(messages: readonly AgentMessage[]): boolean {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message.role === "assistant") {
			return message.stopReason === "error" || message.stopReason === "aborted";
		}
	}
	return false;
}
