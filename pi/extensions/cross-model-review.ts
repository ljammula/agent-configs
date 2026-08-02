/**
 * Cross-model second-opinion review extension.
 *
 * Phase 2 of ai-stack/local-quality-next-steps-plan.md: the previously-
 * scoped-but-never-built "blind-reviewer pass". Both ai-stack slots are
 * already resident (:8080 ThinkingCap 27B 8-bit "code", :8081 35B-A3B
 * 5-bit "general");
 * nothing today has one model review the other's diff before a task is
 * called done.
 *
 * On the first green run of the task's own verification command this
 * session, sends the diff since session start (working tree + any commits
 * made mid-session) plus the original task spec (the first user message) to
 * ai-stack-general with a tight review prompt. Blind by construction: the
 * reviewer sees only the diff and spec, never the first model's own
 * reasoning or self-assessment, so it can't just agree with a stated
 * conclusion. On a flagged issue, feeds it back as a fix-it turn.
 *
 * The `tool_result` handler is deliberately synchronous (not `async`) and
 * never returns the review's promise: pi awaits whatever a handler returns,
 * and this handler fires from `agent.afterToolCall`, which is awaited
 * *before* the tool result is returned to the primary model. Awaiting the
 * review here would mean the primary model sees its own "tests passed"
 * result up to REVIEW_TIMEOUT_MS late, every single time, for a check it
 * didn't ask for. The review instead runs as an untracked background
 * promise; `sendUserMessage(..., { deliverAs: "followUp" })` is safe to call
 * whether the primary run is still streaming (queues correctly) or has
 * already settled by the time the review finishes (starts a fresh turn) --
 * both paths are handled by pi's own `prompt()`, not by this extension.
 *
 * Bounded at MAX_REVIEW_ROUNDS review rounds per agent run (see
 * ai-stack/cross-model-review-bounded-loop-plan.md): each round is a real
 * extra model turn, not a free check, so the loop stops as soon as a round
 * comes back clean or the cap is hit, whichever comes first. A round is
 * only consumed once a non-empty diff has actually been submitted and
 * answered with a real (flagged or clean) verdict -- a green test run
 * before any edit, an empty diff, an identical diff to the last-reviewed
 * one, a request that times out (REVIEW_TIMEOUT_MS, combined with
 * ctx.signal), or a transient ai-stack outage doesn't burn a round -- a
 * later qualifying bash call can retry. `reviewInFlight` prevents two
 * overlapping attempts from a rapid run of qualifying bash calls before the
 * first attempt resolves.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

const NO_ISSUE_MARKER = "NO_ISSUES_FOUND";
// 60s (the prior value) measured too short for realistic diffs: a ~10.5k-
// token multi-file diff (a real personal-assistant feature commit) took
// 73.5s end-to-end against the live gemma4 endpoint, which would abort
// under the old timeout and silently skip the review. 120s leaves headroom
// above that measurement (see ai-stack/cross-model-review-bounded-loop-plan.md
// validation item 4).
const REVIEW_TIMEOUT_MS = 120_000;
const EXEC_TIMEOUT_MS = 5000;
const MAX_REVIEW_ROUNDS = 3;

function reviewModel(): { host: string; model: string } {
	return {
		host: process.env.AI_STACK_HOST || "127.0.0.1",
		model: "/Users/kanna/code/ai-stack/models/Qwen3.6-35B-A3B-5bit",
	};
}

function messageText(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

/**
 * Formatting-only tolerance for the clean-verdict marker: strips backtick /
 * markdown-emphasis wrapping from the *edges* of the reply and trims
 * whitespace, then the caller still requires full-string equality against
 * NO_ISSUE_MARKER. Only the edges, not a global strip -- NO_ISSUE_MARKER
 * itself contains underscores, so a blanket `_` strip would corrupt the
 * marker being matched against. Deliberately not a prefix match either -- a
 * genuine finding phrased as "No issues found in the core logic, but ..."
 * must stay "flagged", not silently collapse to "clean" (see
 * ai-stack/cross-model-review-bounded-loop-plan.md's NO_ISSUE_MARKER
 * section).
 */
function normalizeForMarkerMatch(text: string): string {
	return text
		.trim()
		.replace(/^[`*_]+/, "")
		.replace(/[`*_]+$/, "")
		.trim();
}

/**
 * Scopes the clean-verdict check to the reply's last non-empty line instead
 * of the whole reply: a reviewer that reasons at length before a terse
 * verdict (observed live, see
 * ai-stack/cross-model-review-marker-lastline-fix-plan.md) would otherwise
 * never full-string-match NO_ISSUE_MARKER and get scored "flagged" for a
 * genuinely clean diff. Drops trailing code-fence-only lines first, since a
 * model told to "reply with exactly: X" commonly wraps X in a code block.
 */
function extractLastNonEmptyLine(text: string): string {
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	while (lines.length > 0 && /^```\S*$/.test(lines[lines.length - 1])) {
		lines.pop();
	}
	return lines.length > 0 ? lines[lines.length - 1] : "";
}

type ReviewOutcome = "unchanged" | "no-diff" | "no-spec" | "transient" | "clean" | "flagged";

interface ReviewResult {
	outcome: ReviewOutcome;
	/** Present on "clean" | "flagged", for the caller's lastReviewedDiff. */
	diff?: string;
	/** Present on "flagged" only -- the reviewer's actual finding. */
	reviewText?: string;
}

async function runReview(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	baseSha: string | undefined,
	lastReviewedDiff: string | undefined,
): Promise<ReviewResult> {
	// Diff since session start: baseSha..working-tree, so commits made
	// mid-session are included, not just uncommitted changes.
	const diffArgs = baseSha ? ["diff", baseSha] : ["diff"];
	const diffResult = await pi.exec("git", diffArgs, { cwd: ctx.cwd, timeout: EXEC_TIMEOUT_MS }).catch(() => undefined);
	if (!diffResult || diffResult.code !== 0) return { outcome: "transient" };
	const diff = diffResult.stdout.trim();
	if (!diff) return { outcome: "no-diff" }; // nothing to review yet -- don't consume a round
	if (diff === lastReviewedDiff) return { outcome: "unchanged" }; // rerun with no edits -- don't consume a round

	const leaf = ctx.sessionManager.getLeafEntry();
	const branch = leaf ? ctx.sessionManager.getBranch(leaf.id) : [];
	const firstUserEntry = branch.find((e) => e.type === "message" && e.message.role === "user");
	const spec =
		firstUserEntry && firstUserEntry.type === "message" && firstUserEntry.message.role === "user"
			? messageText(firstUserEntry.message.content)
			: "";
	if (!spec) return { outcome: "no-spec" };

	const { host, model } = reviewModel();
	const prompt = [
		"Keep your internal reasoning short -- a few sentences at most -- then",
		"give your verdict immediately.",
		"",
		"You are reviewing a code diff against its task spec. You did not write",
		"this diff and have not seen the author's reasoning -- judge only what's",
		"in front of you.",
		"",
		"Look specifically for logic bugs a passing test suite would not catch:",
		"wrong-but-plausible fixture data, a convention from sibling code that",
		"was not followed, an edge case the tests do not exercise.",
		"",
		`If you find a real, concrete issue, describe it precisely (file, what's`,
		"wrong, why it matters). If you find nothing, reply with exactly:",
		NO_ISSUE_MARKER,
		"",
		"## Task spec",
		spec,
		"",
		"## Diff",
		"```diff",
		diff,
		"```",
	].join("\n");

	const signals = [AbortSignal.timeout(REVIEW_TIMEOUT_MS), ...(ctx.signal ? [ctx.signal] : [])];
	let reviewText: string;
	try {
		const res = await fetch(`http://${host}:8081/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: prompt }],
				temperature: 0,
			}),
			signal: AbortSignal.any(signals),
		});
		if (!res.ok) return { outcome: "transient" };
		const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
		reviewText = data.choices?.[0]?.message?.content?.trim() ?? "";
	} catch {
		return { outcome: "transient" };
	}

	if (!reviewText) return { outcome: "transient" };

	if (normalizeForMarkerMatch(extractLastNonEmptyLine(reviewText)) === NO_ISSUE_MARKER) {
		// Verbose-but-clean replies are the exact failure mode last-line
		// matching was added to tolerate -- log the full reply so a future
		// recurrence of "verbose reasoning that isn't actually about a found
		// issue" is auditable from session logs, not only catchable by
		// someone happening to read a transcript by hand.
		if (reviewText.length > 200) {
			pi.appendEntry("cross-model-review-verbose-clean", { reviewText });
		}
		return { outcome: "clean", diff };
	}
	return { outcome: "flagged", diff, reviewText };
}

export default function (pi: ExtensionAPI) {
	let reviewCount = 0;
	let lastReviewedDiff: string | undefined;
	let done = false;
	let reviewInFlight = false;
	let baseSha: string | undefined;

	pi.on("agent_start", async (_event, ctx) => {
		reviewCount = 0;
		lastReviewedDiff = undefined;
		done = false;
		reviewInFlight = false;
		baseSha = undefined;
		const result = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd, timeout: EXEC_TIMEOUT_MS }).catch(() => undefined);
		if (result && result.code === 0) {
			baseSha = result.stdout.trim();
		}
	});

	// Deliberately synchronous: see file header for why this must not return
	// (and therefore pi must not await) the review's promise.
	pi.on("tool_result", (event, ctx) => {
		if (done || reviewInFlight) return;
		if (event.toolName !== "bash") return;
		if (event.isError) return;
		const command = event.input?.command;
		if (typeof command !== "string") return;
		if (!VERIFICATION_COMMAND_PATTERNS.some((re) => re.test(command))) return;

		reviewInFlight = true;
		runReview(pi, ctx, baseSha, lastReviewedDiff)
			.then((result) => {
				if (result.outcome === "unchanged" || result.outcome === "no-diff" || result.outcome === "no-spec" || result.outcome === "transient") {
					return;
				}

				lastReviewedDiff = result.diff;

				if (result.outcome === "clean") {
					done = true;
					return;
				}

				// flagged
				reviewCount += 1;
				const capHit = reviewCount >= MAX_REVIEW_ROUNDS;
				if (capHit) done = true;

				pi.sendUserMessage(
					[
						"A blind second-opinion review (ai-stack-general, diff + spec only,",
						"no access to your reasoning) flagged a possible issue with your",
						`passing-tests diff (review round ${reviewCount} of ${MAX_REVIEW_ROUNDS}):`,
						"",
						result.reviewText ?? "",
						"",
						"Investigate. If it's real, fix it. If it's a false positive, say why",
						"briefly and move on.",
						...(capHit
							? [
									"",
									`This was round ${MAX_REVIEW_ROUNDS} of ${MAX_REVIEW_ROUNDS} -- no further`,
									"automatic review will happen this session.",
								]
							: []),
					].join("\n"),
					{ deliverAs: "followUp" },
				);
			})
			.catch(() => {})
			.finally(() => {
				reviewInFlight = false;
			});
	});
}
