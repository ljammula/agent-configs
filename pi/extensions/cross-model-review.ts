/**
 * Truthful blind-review extension.
 *
 * The historical filename is retained so existing installations keep the
 * same symlink. Runtime behavior is explicitly configured: an independent
 * endpoint/model enables review; a same-route/model reviewer is disabled by
 * default and labeled blind-self-review when explicitly allowed.
 *
 * Deliberately does not act on a flagged verdict inside the live session.
 * An earlier version queued a corrective follow-up via
 * `sendUserMessage(..., {deliverAs:"followUp"})`; live-found 2026-08-18 that
 * this can never interrupt a model that keeps calling tools (a `followUp`
 * message is only drained once a turn produces zero tool calls -- confirmed
 * from `pi-agent-core`'s `agent-loop.js`), so a real, correctly-queued
 * correction sat undelivered for the rest of a 30-minute run. Rather than
 * chase a loop-interrupting delivery mode, this extension's scope was
 * narrowed instead: it reviews and reports, the harness's job is writing
 * code and reporting an honest result, and any correction is a decision a
 * human (or a separate pass, e.g. `/code-review`) makes after the session
 * ends, not something injected back into it. See pi-harness-history.md's
 * 2026-08-19 "decouple nudging from review" entry.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lastAssistantMessageFailed } from "./lib/agent-end-guard.ts";
import { appendHarnessTrace } from "./lib/harness-telemetry.ts";
import { isStaleContextError } from "./lib/stale-context.ts";
import {
	buildReviewDiff,
	isBroadVerificationCommand,
	resolveDiffTarget,
	snapshotDiff,
	verificationPipelineCanMaskFailure,
} from "./lib/verification.ts";

const REVIEW_TIMEOUT_MS = 240_000;
const EXEC_TIMEOUT_MS = 5000;
// Reserves guaranteed headroom for `verdict`/`findings` after `analysis`.
// Live-found 2026-08-18: with no cap, the server's own default (16384)
// applied and a long, self-looping `analysis` field consumed the entire
// budget before the JSON ever closed. 8192 still gives a generous budget for
// a real multi-file diff's analysis while capping cost/latency well below
// the failure point observed live.
const MAX_REVIEW_TOKENS = 8192;
const RETRYABLE_REVIEW_FAILURES = new Set<ReviewUnavailableReason>(["empty-response", "request-failed"]);

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
	const primaryModel = env.AI_PRIMARY_MODEL ?? "/Users/kanna/code/ai-stack/models/Qwen3.8-27B-8bit";
	const samePrimary = baseUrl === primaryBaseUrl && model === primaryModel;
	if (samePrimary && env.AI_REVIEW_ALLOW_SELF !== "1") {
		return { enabled: false, kind: "disabled", baseUrl, model, reason: "same-primary" };
	}
	return { enabled: true, kind: samePrimary ? "blind-self-review" : "independent-review", baseUrl, model };
}

/**
 * The reviewer's verdict is enforced by the serving route rather than parsed
 * out of prose. Verified against gemma-4-26b-a4b-it-4bit on :8081, which
 * honors response_format and returns exactly this shape.
 *
 * Note the coupling: structured output and speculative decoding are mutually
 * exclusive on this stack -- :8080 rejects a schema request outright with
 * "Structured response_format is not supported with speculative decoding".
 * If the reviewer route is ever moved onto a draft/MTP launcher, every request
 * here starts failing. That now surfaces as a `model-rejected` trace instead
 * of a silent no-op, but the route itself must stay non-speculative.
 */
const VERDICT_SCHEMA = {
	type: "object",
	properties: {
		// `analysis` is first on purpose, and is not decoration. Constrained
		// decoding emits properties in schema order, so a verdict-first schema
		// forces the model to commit before it has reasoned at all. Measured on
		// this route: verdict-first missed the planted `divide` zero-check bug 5/5
		// at temperature 0, while the prose protocol it replaced caught it 5/5.
		// Restoring an analysis field ahead of the verdict recovers the catch.
		analysis: { type: "string" },
		verdict: { type: "string", enum: ["clean", "flagged"] },
		findings: {
			type: "array",
			items: {
				type: "object",
				properties: {
					file: { type: "string" },
					severity: { type: "string", enum: ["bug", "nit"] },
					issue: { type: "string" },
				},
				required: ["file", "severity", "issue"],
				additionalProperties: false,
			},
		},
	},
	required: ["analysis", "verdict", "findings"],
	additionalProperties: false,
} as const;

interface ReviewVerdict {
	analysis?: string;
	verdict: "clean" | "flagged";
	findings: { file: string; severity: "bug" | "nit"; issue: string }[];
}

export function parseVerdict(text: string): ReviewVerdict | undefined {
	try {
		const parsed = JSON.parse(text) as ReviewVerdict;
		if (parsed?.verdict !== "clean" && parsed?.verdict !== "flagged") return undefined;
		if (!Array.isArray(parsed.findings)) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

/** Renders findings into the follow-up message the agent already receives. */
export function renderFindings(findings: ReviewVerdict["findings"]): string {
	return findings.map((finding) => `- [${finding.severity}] ${finding.file}: ${finding.issue}`).join("\n");
}

/**
 * Why a configured reviewer produced no verdict. Every one of these used to
 * collapse into a bare `transient` that the caller drops silently -- the same
 * shape as the stale AI_REVIEW_MODEL incident, where every request 400'd for
 * days and the harness recorded nothing distinguishable from "reviewer off".
 */
export type ReviewUnavailableReason =
	| "not-configured"
	| "cancelled"
	| "model-rejected"
	| "empty-response"
	| "request-failed"
	| "malformed-verdict"
	| "truncated-response";

interface ReviewCallResult {
	outcome: "clean" | "flagged" | "transient";
	text?: string;
	reason?: ReviewUnavailableReason;
	status?: number;
	finishReason?: string;
}

/**
 * `concise` tightens the brevity instruction for a retry after a truncated
 * first attempt. Deliberately keeps `analysis` first and required either
 * way -- the schema's own doc comment on `VERDICT_SCHEMA` records that
 * verdict-first ordering measurably cost catch rate (5/5 -> 0/5 on a planted
 * bug), so the fix for rambling analysis is bounding its length, not
 * skipping or reordering it.
 */
function buildReviewPrompt(spec: string, diff: string, concise: boolean): string {
	return [
		"Review this code diff only against its task spec. Focus on concrete logic bugs that passing tests may miss.",
		"First write your analysis, then the verdict. Report a finding only for a concrete defect; return an empty findings list when the diff satisfies the spec.",
		concise
			? "Your analysis must be at most 3 sentences: state the single most important issue, if any, and move directly to the verdict. Do not re-derive or double-check the same example more than once."
			: "Keep your analysis concise -- a few sentences identifying the specific issue, or confirming there is none. Do not restate your reasoning or re-verify the same example multiple times; commit to a verdict once you've reached one.",
		"## Task spec", spec, "## Diff", "```diff", diff, "```",
	].join("\n");
}

async function callReviewer(
	config: ReviewerConfig,
	prompt: string,
	signal: AbortSignal | undefined,
	fetchImpl: typeof fetch,
): Promise<ReviewCallResult> {
	if (signal?.aborted) return { outcome: "transient", reason: "cancelled" };
	try {
		const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: config.model,
				messages: [{ role: "user", content: prompt }],
				temperature: 0,
				max_tokens: MAX_REVIEW_TOKENS,
				response_format: { type: "json_schema", json_schema: { name: "review_verdict", strict: true, schema: VERDICT_SCHEMA } },
			}),
			signal: AbortSignal.any([AbortSignal.timeout(REVIEW_TIMEOUT_MS), ...(signal ? [signal] : [])]),
		});
		if (!response.ok) return { outcome: "transient", reason: "model-rejected", status: response.status };
		const body = (await response.json()) as {
			choices?: { message?: { content?: string }; finish_reason?: string }[];
		};
		const choice = body.choices?.[0];
		const text = choice?.message?.content?.trim();
		if (!text) return { outcome: "transient", reason: "empty-response" };
		const parsed = parseVerdict(text);
		// The route enforces the schema, so this is a route/config problem rather
		// than a review verdict -- treating it as `clean` would pass unreviewed code.
		// `finish_reason: "length"` distinguishes a specific, previously conflated
		// cause: the completion hit its token cap mid-JSON (a long `analysis`
		// field, e.g. the model looping over its own reasoning) rather than the
		// model emitting well-formed-but-wrong JSON. Live-found 2026-08-18 on a
		// real `go/lru-cache` run: two "malformed-verdict" traces with no raw
		// text captured to tell the two apart post hoc.
		if (!parsed) {
			return {
				outcome: "transient",
				reason: choice?.finish_reason === "length" ? "truncated-response" : "malformed-verdict",
				text,
				finishReason: choice?.finish_reason,
			};
		}
		return parsed.verdict === "clean" && parsed.findings.length === 0
			? { outcome: "clean", text }
			: { outcome: "flagged", text: renderFindings(parsed.findings) || text };
	} catch {
		if (signal?.aborted) return { outcome: "transient", reason: "cancelled" };
		return { outcome: "transient", reason: "request-failed" };
	}
}

export async function requestReview(
	config: ReviewerConfig,
	spec: string,
	diff: string,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<ReviewCallResult> {
	if (!config.enabled || !config.baseUrl || !config.model) return { outcome: "transient", reason: "not-configured" };
	const first = await callReviewer(config, buildReviewPrompt(spec, diff, false), signal, fetchImpl);
	if (first.reason === "truncated-response") {
		// A retry of the identical prompt at temperature 0 would just reproduce
		// the same truncation deterministically -- the retry only has a chance of
		// landing because the prompt itself changes to a stricter brevity
		// instruction. One retry, not a loop.
		return signal?.aborted
			? { outcome: "transient", reason: "cancelled" }
			: callReviewer(config, buildReviewPrompt(spec, diff, true), signal, fetchImpl);
	}
	const retryable = first.outcome === "transient" && (
		(first.reason !== undefined && RETRYABLE_REVIEW_FAILURES.has(first.reason)) ||
		(first.reason === "model-rejected" && first.status !== undefined && (first.status === 429 || first.status >= 500))
	);
	if (!retryable) return first;
	// Transport and empty-response failures are normally transient. Give the
	// same bounded review request one more chance, then preserve the failure so
	// the build gate cannot mistake unavailable review for a clean verdict.
	return signal?.aborted
		? { outcome: "transient", reason: "cancelled" }
		: callReviewer(config, buildReviewPrompt(spec, diff, false), signal, fetchImpl);
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
	let lastReviewedDiff: string | undefined;
	let transientRetryDiff: string | undefined;
	let reviewInFlight = false;
	// A review round (~60-120s network round trip) routinely outlives the
	// model's own remaining turns: pi settles and -p mode exits without
	// waiting on this extension's fire-and-forget tool_result chain, so the
	// round never gets a chance to log or to flag a real issue. agent_end
	// awaits this so settlement genuinely blocks on a pending round instead
	// of abandoning it.
	let inFlightReview: Promise<void> | undefined;
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

	// `agent_start` fires again on every internal continuation, not only on
	// a genuinely new top-level prompt (confirmed in pi-agent-core's
	// runAgentLoopContinue) -- resetting `lastReviewedDiff` there would wipe
	// it on every continuation. Reset on `before_agent_start` instead: it
	// fires exactly once per genuine top-level user prompt
	// (agent-session.js's single `emitBeforeAgentStart` call site is inside
	// `prompt()`'s non-streaming path), never on a continuation, retry, or
	// compaction.
	pi.on("before_agent_start", () => {
		lastReviewedDiff = undefined;
		transientRetryDiff = undefined;
	});

	pi.on("agent_start", async (_event, ctx) => {
		runId += 1;
		reviewInFlight = false;
		inFlightReview = undefined;
		if (baseSha) return;
		const result = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: EXEC_TIMEOUT_MS }).catch(() => undefined);
		if (result?.code === 0) baseSha = result.stdout.trim();
	});

	// Shared by both triggers below. `trigger` only affects telemetry: the
	// tool_result path fires reactively off the model's own verification
	// command; the agent_settled path (added to fix the todo item that this
	// extension "structurally cannot activate" on suites where the model
	// never runs one itself, e.g. local-model-bench) fires once at
	// settlement as a backstop, gated on a materially non-empty diff instead
	// of on any particular bash command.
	function startReviewRound(ctx: ExtensionContext, trigger: "tool_result" | "settlement"): Promise<void> {
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
		const round = resolveDiffTarget(pi, ctx.cwd, baseSha)
			.then((target) => buildReviewDiff(pi, ctx.cwd, target))
			.then(async (diff) => {
				if (reviewRunId !== runId) return;
				const spec = taskSpec(ctx);
				const transientRetryExhausted = diff !== undefined && diff === transientRetryDiff;
				if (!diff || !spec || diff === lastReviewedDiff || transientRetryExhausted) {
					appendHarnessTrace(pi, {
						extension: "reviewer",
						diffHash: null,
						event: "review",
						outcome: "blocked",
						durationMs: Date.now() - startedAt,
						metadata: {
							kind: config.kind,
							trigger,
							reason: !diff
								? "empty-diff"
								: !spec
									? "no-task-spec"
									: transientRetryExhausted
										? "transient-retry-exhausted"
										: "unchanged-since-last-review",
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
					metadata: {
						kind: config.kind,
						trigger,
						...(result.reason ? { reason: result.reason } : {}),
						...(result.status ? { status: result.status } : {}),
						...(result.finishReason ? { finishReason: result.finishReason } : {}),
						// Only channel left for the finding text now that nothing
						// injects it back into the session -- a human reading the
						// trace after the fact needs it here.
						...(result.outcome === "flagged" && result.text ? { findings: result.text } : {}),
					},
				});
				if (result.outcome === "transient") {
					transientRetryDiff = diff;
					return;
				}
				lastReviewedDiff = diff;
				transientRetryDiff = undefined;
				// Deliberately does not act on a flagged verdict any further --
				// this extension no longer injects a corrective follow-up into
				// the live session. A queued `deliverAs: "followUp"` message is
				// only drained once the model's own turn produces zero tool
				// calls (confirmed from pi-agent-core's agent-loop.js), so it
				// cannot interrupt a model that keeps calling tools -- live-found
				// 2026-08-18 on a real go/lru-cache run: a correct, queued
				// correction sat undelivered for the rest of a 30-minute run
				// while the model was stuck in an unrelated debugging loop. The
				// harness's job is now scoped to writing code and reporting an
				// honest result; review is pure reporting, surfaced in this trace
				// event for a human (or a separate `/code-review`-style pass) to
				// read once the session ends, not injected back into it. See
				// pi-harness-history.md's 2026-08-19 "decouple nudging from
				// review" entry for the full rationale.
			})
			.catch((error) => {
				// A stale context means a fresh extension instance now owns the
				// replacement session; there is nothing left here to log against.
				if (isStaleContextError(error)) return;
				try {
					appendHarnessTrace(pi, { extension: "reviewer", diffHash: null, event: "review", outcome: "transient", durationMs: Date.now() - startedAt, metadata: { kind: config.kind, trigger, reason: "review-pipeline-error" } });
				} catch (traceError) {
					if (!isStaleContextError(traceError)) throw traceError;
				}
			})
			.finally(() => {
				if (reviewRunId === runId) reviewInFlight = false;
			});
		inFlightReview = round;
		return round;
	}

	pi.on("tool_result", (event, ctx) => {
		if (!config.enabled || reviewInFlight || event.toolName !== "bash" || event.isError) return;
		const command = event.input.command;
		if (typeof command !== "string" || !isBroadVerificationCommand(command) || verificationPipelineCanMaskFailure(command)) return;
		startReviewRound(ctx, "tool_result");
	});

	// Hooked on `agent_end` rather than `agent_settled` so a pending
	// tool_result-triggered round gets a chance to finish and log before pi
	// decides this run-cycle is done; requestReview's own timeout bounds the
	// wait. The chain above only re-throws a non-stale error out of its own
	// trace-logging fallback (a genuine bug, not staleness), so mirror the
	// same stale-context guard used everywhere else in the harness rather
	// than swallow it here too.
	//
	// Settlement backstop: if the model's own turn never runs a broad
	// verification command itself (the tool_result trigger requires that;
	// task suites like local-model-bench never give it the chance to), fire
	// a review directly here on every agent_end, gated on a materially
	// non-empty diff so an empty/no-op turn doesn't spend a round on
	// nothing. `startReviewRound` itself skips a diff already reviewed
	// (`diff === lastReviewedDiff`, logged as "blocked"/
	// "unchanged-since-last-review", not a wasted network call), so this
	// outer guard only needs `reviewInFlight`. `trigger: "settlement"` is
	// kept as the telemetry label for continuity with existing evidence
	// records.
	//
	// A pending tool_result-triggered round is still awaited even on an
	// aborted/errored agent_end -- letting an already-running review finish
	// and log is harmless. What must NOT happen on an aborted/errored
	// agent_end is *starting a new* round (see lastAssistantMessageFailed's
	// doc comment), so that guard sits after the await but before the
	// backstop itself.
	pi.on("agent_end", async (event, ctx) => {
		try {
			if (inFlightReview) await inFlightReview;
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		}
		if (lastAssistantMessageFailed(event.messages)) return;
		if (!config.enabled || reviewInFlight) return;
		try {
			const snapshot = await snapshotDiff(pi, ctx.cwd, baseSha);
			if (!snapshot.material) return;
			await startReviewRound(ctx, "settlement");
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		}
	});
}
