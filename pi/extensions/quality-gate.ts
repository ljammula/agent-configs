/**
 * Settlement quality gate: binds passing evidence to the current diff hash
 * and rejects truncated/shell-masked results.
 *
 * Deliberately does not queue a corrective follow-up on a failing check
 * inside the live session. An earlier version did, via
 * `sendUserMessage(..., {deliverAs:"followUp"})`; live-found 2026-08-18 (on
 * `cross-model-review.ts`, which had the identical mechanism) that a
 * `followUp` message is only drained once a model's turn produces zero tool
 * calls -- it cannot interrupt a model that keeps calling tools, which is
 * exactly when a correction is needed most. Rather than chase a
 * loop-interrupting delivery mode, this extension's scope was narrowed
 * instead: it verifies and reports truthfully, the harness's job is writing
 * code and reporting an honest result, and any correction is a decision a
 * human (or a separate pass, e.g. `/code-review`) makes after the session
 * ends. See pi-harness-history.md's 2026-08-19 "decouple nudging from
 * review" entry.
 */
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lastAssistantMessageFailed } from "./lib/agent-end-guard.ts";
import { appendHarnessTrace } from "./lib/harness-telemetry.ts";
import { isStaleContextError } from "./lib/stale-context.ts";
import {
	commandSatisfiesCanonical,
	evidencePassesCurrentDiff,
	isBroadVerificationCommand,
	resolveVerificationCommand,
	snapshotDiff,
	verificationPipelineCanMaskFailure,
	type VerificationEvidence,
} from "./lib/verification.ts";

function truncated(details: unknown): boolean {
	return Boolean((details as { truncation?: { truncated?: boolean } } | undefined)?.truncation?.truncated);
}

function commandHash(command: string): string {
	return createHash("sha256").update(command).digest("hex").slice(0, 16);
}

export function redactFailureOutput(output: string): string {
	return output
		.replace(/(authorization:\s*bearer\s+)\S+/gi, "$1<redacted>")
		.replace(/\b(password|passwd|token|secret|api[_-]?key)\s*[=:]\s*[^\s]+/gi, "$1=<redacted>")
		.replace(/:\/\/([^\s:/]+):([^\s@]+)@/g, "://$1:<redacted>@")
		.trim()
		.slice(0, 3000);
}

export default function qualityGate(pi: ExtensionAPI): void {
	let baseSha: string | undefined;
	let evidence: VerificationEvidence | undefined;
	let settling = false;
	const starts = new Map<string, number>();

	pi.on("agent_start", async (_event, ctx) => {
		if (!baseSha) {
			const result = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: 5000 }).catch(() => undefined);
			if (result?.code === 0) baseSha = result.stdout.trim();
		}
	});

	pi.on("tool_call", (event) => {
		if (
			event.toolName === "bash" &&
			typeof event.input.command === "string" &&
			isBroadVerificationCommand(event.input.command)
		) {
			starts.set(event.toolCallId, Date.now());
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const command = event.input.command;
		if (typeof command !== "string" || !isBroadVerificationCommand(command)) return;
		try {
			// A command can look broad (e.g. a bare `go test ./...`) without
			// actually being the project's canonical check (e.g. once the Go
			// fallback requires `go vet ./... && go test ./...`). Only accept it
			// as evidence when it satisfies every segment of the resolved
			// canonical command; an unresolved canonical falls back to the old
			// loose match rather than blocking evidence entirely.
			const canonical = await resolveVerificationCommand(ctx.cwd).catch(() => undefined);
			if (canonical && !commandSatisfiesCanonical(command, canonical)) return;
			const snapshot = await snapshotDiff(pi, ctx.cwd, baseSha);
			const inconclusive = verificationPipelineCanMaskFailure(command) || truncated(event.details);
			evidence = {
				command,
				diffHash: snapshot.hash,
				startedAt: starts.get(event.toolCallId) ?? Date.now(),
				endedAt: Date.now(),
				exitCode: event.isError || inconclusive ? 1 : 0,
				truncated: truncated(event.details),
			};
			appendHarnessTrace(pi, {
				extension: "quality-gate",
				diffHash: snapshot.hash,
				event: "verification",
				outcome: evidence.exitCode === 0 ? "pass" : "fail",
				durationMs: evidence.endedAt - evidence.startedAt,
				metadata: {
					commandHash: commandHash(command),
					pipedWithoutPipefail: verificationPipelineCanMaskFailure(command),
					truncated: evidence.truncated,
				},
			});
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		}
	});

	// Hooked on `agent_end`, which fires while the session is still mid-run
	// (unlike `agent_settled`, documented to fire only once no queued
	// continuation will run) -- kept from when this handler used to queue a
	// corrective follow-up from here, since `agent_end` also fires on
	// internal retry/abort/compaction cycles and `lastAssistantMessageFailed`
	// still needs to skip those (an unfiltered handler previously produced a
	// killed run resurrected by a fabricated nudge; see that helper's own
	// doc comment). No longer queues anything itself -- see the file-top
	// comment for why -- this just runs the settlement check once and
	// records the result.
	pi.on("agent_end", async (event, ctx) => {
		if (lastAssistantMessageFailed(event.messages)) return;
		if (settling) return;
		settling = true;
		try {
			const before = await snapshotDiff(pi, ctx.cwd, baseSha);
			if (!before.material || evidencePassesCurrentDiff(evidence, before)) return;

			const command = await resolveVerificationCommand(ctx.cwd);
			if (!command) {
				appendHarnessTrace(pi, {
					extension: "quality-gate",
					diffHash: before.hash,
					event: "verification",
					outcome: "unconfigured",
					durationMs: 0,
					metadata: {},
				});
				return;
			}

			const startedAt = Date.now();
			const result = await pi.exec("bash", ["-o", "pipefail", "-lc", command], {
				cwd: ctx.cwd,
				timeout: 20 * 60_000,
				signal: ctx.signal,
			}).catch(() => undefined);
			const after = await snapshotDiff(pi, ctx.cwd, baseSha);
			const diffChanged = before.hash !== after.hash;
			evidence = {
				command,
				diffHash: before.hash,
				startedAt,
				endedAt: Date.now(),
				exitCode: result?.code ?? 1,
				truncated: false,
			};
			const passed = evidencePassesCurrentDiff(evidence, after);
			const failureOutput = redactFailureOutput(`${result?.stdout ?? ""}\n${result?.stderr ?? ""}`);
			// No corrective follow-up is queued on failure -- decoupled by
			// design (see file-top comment). `failureExcerpt` is included here
			// specifically because there is no other channel left for a human
			// to see it after the session ends; it used to travel only in the
			// injected message text.
			appendHarnessTrace(pi, {
				extension: "quality-gate",
				diffHash: after.hash,
				event: "verification",
				outcome: passed ? "pass" : "fail",
				durationMs: evidence.endedAt - startedAt,
				metadata: {
					commandHash: commandHash(command),
					exitCode: evidence.exitCode,
					diffChanged,
					hadOutput: failureOutput.length > 0,
					...(failureOutput ? { failureExcerpt: failureOutput } : {}),
				},
			});
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		} finally {
			settling = false;
		}
	});
}
