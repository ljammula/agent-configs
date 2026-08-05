import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

const MAX_CORRECTIVE_FOLLOW_UPS = 3;

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
	let correctiveFollowUps = 0;
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

	pi.on("agent_settled", async (_event, ctx) => {
		if (settling) return;
		if (correctiveFollowUps >= MAX_CORRECTIVE_FOLLOW_UPS) return;
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
				},
			});
			if (passed) return;

			correctiveFollowUps += 1;
			const capHit = correctiveFollowUps >= MAX_CORRECTIVE_FOLLOW_UPS;
			if (capHit) {
				appendHarnessTrace(pi, {
					extension: "quality-gate",
					diffHash: after.hash,
					event: "nudge",
					outcome: "cap-hit",
					durationMs: 0,
					metadata: {
						attempts: correctiveFollowUps,
						commandHash: commandHash(command),
						exitCode: evidence.exitCode,
					},
				});
			}
			pi.sendUserMessage(
				`The current-diff quality gate ran \`${command}\` but did not establish passing evidence for the latest material diff ` +
					`(attempt ${correctiveFollowUps}/${MAX_CORRECTIVE_FOLLOW_UPS}).` +
					(diffChanged ? " The check changed the material diff, so the resulting content must be verified again." : "") +
					(failureOutput ? `\n\nRedacted failure excerpt:\n\n${failureOutput}` : "") +
					"\n\nInspect the failure, make the smallest fix, and rerun it." +
					(capHit ? " The correction cap is now reached; report the remaining failure truthfully if it cannot be fixed." : ""),
				{ deliverAs: "followUp" },
			);
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		} finally {
			settling = false;
		}
	});
}
