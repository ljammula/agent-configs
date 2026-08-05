/**
 * Truthful blind-review extension.
 *
 * The historical filename is retained so existing installations keep the
 * same symlink. Runtime behavior is explicitly configured: an independent
 * endpoint/model enables review; a same-route/model reviewer is disabled by
 * default and labeled blind-self-review when explicitly allowed.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendHarnessTrace } from "./lib/harness-telemetry.ts";
import { isStaleContextError } from "./lib/stale-context.ts";
import { buildReviewDiff, isBroadVerificationCommand, resolveDiffTarget, verificationPipelineCanMaskFailure } from "./lib/verification.ts";

export const NO_ISSUE_MARKER = "NO_ISSUES_FOUND";
const REVIEW_TIMEOUT_MS = 240_000;
const EXEC_TIMEOUT_MS = 5000;
const MAX_REVIEW_ROUNDS = 3;

export interface ReviewerConfig {
	enabled: boolean;
	kind: "independent-review" | "blind-self-review" | "disabled";
	baseUrl?: string;
	model?: string;
	reason?: "missing-configuration" | "invalid-configuration" | "same-primary";
}

function normalizeUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
		return url.toString().replace(/\/$/, "");
	} catch {
		return undefined;
	}
}

export function resolveReviewerConfig(env: NodeJS.ProcessEnv = process.env): ReviewerConfig {
	const rawBaseUrl = env.AI_REVIEW_BASE_URL;
	const model = env.AI_REVIEW_MODEL?.trim();
	if (!rawBaseUrl || !model) return { enabled: false, kind: "disabled", reason: "missing-configuration" };
	const baseUrl = normalizeUrl(rawBaseUrl);
	if (!baseUrl) return { enabled: false, kind: "disabled", reason: "invalid-configuration" };

	const primaryBaseUrl = normalizeUrl(
		env.AI_PRIMARY_BASE_URL ?? `http://${env.AI_STACK_HOST || "127.0.0.1"}:8080/v1`,
	);
	const primaryModel = env.AI_PRIMARY_MODEL ?? "/Users/kanna/code/ai-stack/models/ThinkingCap-Qwen3.6-27B-MLX-8bit";
	const samePrimary = baseUrl === primaryBaseUrl && model === primaryModel;
	if (samePrimary && env.AI_REVIEW_ALLOW_SELF !== "1") {
		return { enabled: false, kind: "disabled", baseUrl, model, reason: "same-primary" };
	}
	return { enabled: true, kind: samePrimary ? "blind-self-review" : "independent-review", baseUrl, model };
}

export function normalizeForMarkerMatch(text: string): string {
	return text.trim().replace(/^[`*_]+/, "").replace(/[`*_]+$/, "").trim();
}

export function extractLastNonEmptyLine(text: string): string {
	const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
	while (lines.length > 0 && /^```\S*$/.test(lines.at(-1)!)) lines.pop();
	return lines.at(-1) ?? "";
}

export async function requestReview(
	config: ReviewerConfig,
	spec: string,
	diff: string,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<{ outcome: "clean" | "flagged" | "transient"; text?: string }> {
	if (!config.enabled || !config.baseUrl || !config.model) return { outcome: "transient" };
	const prompt = [
		"Review this code diff only against its task spec. Focus on concrete logic bugs that passing tests may miss.",
		`If there is no concrete issue, end with exactly ${NO_ISSUE_MARKER}.`,
		"## Task spec", spec, "## Diff", "```diff", diff, "```",
	].join("\n");
	try {
		const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: prompt }], temperature: 0 }),
			signal: AbortSignal.any([AbortSignal.timeout(REVIEW_TIMEOUT_MS), ...(signal ? [signal] : [])]),
		});
		if (!response.ok) return { outcome: "transient" };
		const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
		const text = body.choices?.[0]?.message?.content?.trim();
		if (!text) return { outcome: "transient" };
		return normalizeForMarkerMatch(extractLastNonEmptyLine(text)) === NO_ISSUE_MARKER
			? { outcome: "clean", text }
			: { outcome: "flagged", text };
	} catch {
		return { outcome: "transient" };
	}
}

function taskSpec(ctx: ExtensionContext): string {
	const leaf = ctx.sessionManager.getLeafEntry();
	const branch = leaf ? ctx.sessionManager.getBranch(leaf.id) : [];
	const entry = branch.find((candidate) => candidate.type === "message" && candidate.message.role === "user");
	if (!entry || entry.type !== "message" || entry.message.role !== "user") return "";
	if (typeof entry.message.content === "string") return entry.message.content;
	return entry.message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

export default function reviewer(pi: ExtensionAPI): void {
	const config = resolveReviewerConfig();
	let baseSha: string | undefined;
	let reviewCount = 0;
	let lastReviewedDiff: string | undefined;
	let reviewInFlight = false;
	// A review round (~60-120s network round trip) routinely outlives the
	// model's own remaining turns: pi settles and -p mode exits without
	// waiting on this extension's fire-and-forget tool_result chain, so the
	// round never gets a chance to log or to flag a real issue. agent_settled
	// awaits this so settlement genuinely blocks on a pending round instead
	// of abandoning it.
	let inFlightReview: Promise<void> | undefined;
	let settled = false;
	let runId = 0;

	pi.on("session_start", () => {
		appendHarnessTrace(pi, {
			extension: "reviewer",
			diffHash: null,
			event: "startup",
			outcome: config.enabled ? "pass" : "blocked",
			durationMs: 0,
			metadata: {
				kind: config.kind,
				baseUrl: config.baseUrl ?? null,
				model: config.model ?? null,
				reason: config.reason ?? null,
			},
		});
	});

	pi.on("agent_start", async (_event, ctx) => {
		runId += 1;
		reviewCount = 0;
		lastReviewedDiff = undefined;
		reviewInFlight = false;
		inFlightReview = undefined;
		settled = false;
		if (baseSha) return;
		const result = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: EXEC_TIMEOUT_MS }).catch(() => undefined);
		if (result?.code === 0) baseSha = result.stdout.trim();
	});

	pi.on("tool_result", (event, ctx) => {
		if (!config.enabled || settled || reviewInFlight || event.toolName !== "bash" || event.isError) return;
		const command = event.input.command;
		if (typeof command !== "string" || !isBroadVerificationCommand(command) || verificationPipelineCanMaskFailure(command)) return;
		reviewInFlight = true;
		const reviewRunId = runId;
		const startedAt = Date.now();
		// A bare `git diff` (no baseSha yet) compares the working tree to the
		// index, which is silently empty if the model staged everything with
		// `git add` before this fires -- resolveDiffTarget's empty-tree
		// fallback for an unborn HEAD gives a real, non-empty target instead.
		// buildReviewDiff additionally synthesizes diff blocks for untracked
		// files, since a bare `git diff` never shows their content -- without
		// this, a project with nothing committed or staged yet (exactly the
		// state new-project-scaffold.ts leaves a repo in) always sees an empty
		// diff and never actually reviews anything, silently.
		inFlightReview = resolveDiffTarget(pi, ctx.cwd, baseSha)
			.then((target) => buildReviewDiff(pi, ctx.cwd, target))
			.then(async (diff) => {
				if (reviewRunId !== runId) return;
				const spec = taskSpec(ctx);
				if (!diff || !spec || diff === lastReviewedDiff) {
					appendHarnessTrace(pi, {
						extension: "reviewer",
						diffHash: null,
						event: "review",
						outcome: "blocked",
						durationMs: Date.now() - startedAt,
						metadata: {
							kind: config.kind,
							reason: !diff ? "empty-diff" : !spec ? "no-task-spec" : "unchanged-since-last-review",
						},
					});
					return;
				}
				const result = await requestReview(config, spec, diff, ctx.signal);
				if (reviewRunId !== runId) return;
				appendHarnessTrace(pi, {
					extension: "reviewer",
					diffHash: null,
					event: "review",
					outcome: result.outcome,
					durationMs: Date.now() - startedAt,
					metadata: { kind: config.kind, round: reviewCount + 1 },
				});
				if (result.outcome === "transient") return;
				lastReviewedDiff = diff;
				if (result.outcome === "clean") {
					settled = true;
					return;
				}
				reviewCount += 1;
				settled = reviewCount >= MAX_REVIEW_ROUNDS;
				pi.sendUserMessage(
					`A ${config.kind} flagged a possible issue (round ${reviewCount}/${MAX_REVIEW_ROUNDS}):\n\n${result.text}\n\nInvestigate it against the code and spec; fix it if real, otherwise explain why it is false.`,
					{ deliverAs: "followUp" },
				);
			})
			.catch((error) => {
				// A stale context means a fresh extension instance now owns the
				// replacement session; there is nothing left here to log against.
				if (isStaleContextError(error)) return;
				try {
					appendHarnessTrace(pi, { extension: "reviewer", diffHash: null, event: "review", outcome: "transient", durationMs: Date.now() - startedAt, metadata: { kind: config.kind } });
				} catch (traceError) {
					if (!isStaleContextError(traceError)) throw traceError;
				}
			})
			.finally(() => {
				if (reviewRunId === runId) reviewInFlight = false;
			});
	});

	// Give a pending review round time to finish before pi decides the run
	// is done; requestReview's own timeout bounds the wait. The chain above
	// only re-throws a non-stale error out of its own trace-logging fallback
	// (a genuine bug, not staleness), so mirror the same stale-context guard
	// used everywhere else in the harness rather than swallow it here too.
	pi.on("agent_settled", async () => {
		if (!inFlightReview) return;
		try {
			await inFlightReview;
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		}
	});
}
