/**
 * Cross-model second-opinion review extension.
 *
 * Phase 2 of ai-stack/local-quality-next-steps-plan.md: the previously-
 * scoped-but-never-built "blind-reviewer pass". Both ai-stack slots are
 * already resident (:8080 27B "code", :8081 35B-A3B "general"); nothing
 * today has one model review the other's diff before a task is called done.
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
 * Runs at most once per agent run (one review pass per completed task, not
 * one per test invocation) to bound cost -- this is a real extra model turn,
 * not a free check (see plan's Phase 2 cost note). The "reviewed" flag is
 * only set once a non-empty diff has actually been submitted and answered,
 * so a green test run before any edit, an empty diff, a request that times
 * out (REVIEW_TIMEOUT_MS, combined with ctx.signal), or a transient ai-stack
 * outage doesn't burn the one review attempt -- a later qualifying bash call
 * can retry. `reviewInFlight` prevents two overlapping attempts from a rapid
 * run of qualifying bash calls before the first attempt resolves.
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
const REVIEW_TIMEOUT_MS = 60_000;
const EXEC_TIMEOUT_MS = 5000;

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

/** Returns true iff a real review was submitted and answered (flagged or not). */
async function runReview(pi: ExtensionAPI, ctx: ExtensionContext, baseSha: string | undefined): Promise<boolean> {
	// Diff since session start: baseSha..working-tree, so commits made
	// mid-session are included, not just uncommitted changes.
	const diffArgs = baseSha ? ["diff", baseSha] : ["diff"];
	const diffResult = await pi.exec("git", diffArgs, { cwd: ctx.cwd, timeout: EXEC_TIMEOUT_MS }).catch(() => undefined);
	if (!diffResult || diffResult.code !== 0) return false;
	const diff = diffResult.stdout.trim();
	if (!diff) return false; // nothing to review yet -- don't consume the one attempt

	const leaf = ctx.sessionManager.getLeafEntry();
	const branch = leaf ? ctx.sessionManager.getBranch(leaf.id) : [];
	const firstUserEntry = branch.find((e) => e.type === "message" && e.message.role === "user");
	const spec =
		firstUserEntry && firstUserEntry.type === "message" && firstUserEntry.message.role === "user"
			? messageText(firstUserEntry.message.content)
			: "";
	if (!spec) return false;

	const { host, model } = reviewModel();
	const prompt = [
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
		if (!res.ok) return false; // transient outage -- don't consume the one attempt
		const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
		reviewText = data.choices?.[0]?.message?.content?.trim() ?? "";
	} catch {
		return false; // timeout, abort, or transient outage -- don't consume the one attempt
	}

	if (!reviewText) return false;

	if (reviewText !== NO_ISSUE_MARKER) {
		pi.sendUserMessage(
			[
				"A blind second-opinion review (ai-stack-general, diff + spec only,",
				"no access to your reasoning) flagged a possible issue with your",
				"passing-tests diff:",
				"",
				reviewText,
				"",
				"Investigate. If it's real, fix it. If it's a false positive, say why",
				"briefly and move on.",
			].join("\n"),
			{ deliverAs: "followUp" },
		);
	}

	return true; // real, answered review -- consume the one-per-run budget
}

export default function (pi: ExtensionAPI) {
	let reviewedThisRun = false;
	let reviewInFlight = false;
	let baseSha: string | undefined;

	pi.on("agent_start", async (_event, ctx) => {
		reviewedThisRun = false;
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
		if (reviewedThisRun || reviewInFlight) return;
		if (event.toolName !== "bash") return;
		if (event.isError) return;
		const command = event.input?.command;
		if (typeof command !== "string") return;
		if (!VERIFICATION_COMMAND_PATTERNS.some((re) => re.test(command))) return;

		reviewInFlight = true;
		runReview(pi, ctx, baseSha)
			.then((reviewed) => {
				if (reviewed) reviewedThisRun = true;
			})
			.catch(() => {})
			.finally(() => {
				reviewInFlight = false;
			});
	});
}
