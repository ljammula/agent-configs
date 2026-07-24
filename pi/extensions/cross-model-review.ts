/**
 * Cross-model second-opinion review extension.
 *
 * Phase 2 of ai-stack/local-quality-next-steps-plan.md: the previously-
 * scoped-but-never-built "blind-reviewer pass". Both ai-stack slots are
 * already resident (:8080 27B "code", :8081 35B-A3B "general"); nothing
 * today has one model review the other's diff before a task is called done.
 *
 * On the first green run of the task's own verification command this
 * session, sends `git diff` plus the original task spec (the first user
 * message) to ai-stack-general with a tight review prompt. Blind by
 * construction: the reviewer sees only the diff and spec, never the first
 * model's own reasoning or self-assessment, so it can't just agree with a
 * stated conclusion. On a flagged issue, feeds it back as a fix-it turn.
 *
 * Runs at most once per agent run (one review pass per completed task, not
 * one per test invocation) to bound cost -- this is a real extra model turn,
 * not a free check (see plan's Phase 2 cost note).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export default function (pi: ExtensionAPI) {
	let reviewedThisRun = false;

	pi.on("agent_start", () => {
		reviewedThisRun = false;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (reviewedThisRun) return;
		if (event.toolName !== "bash") return;
		if (event.isError) return;
		const command = event.input?.command;
		if (typeof command !== "string") return;
		if (!VERIFICATION_COMMAND_PATTERNS.some((re) => re.test(command))) return;

		reviewedThisRun = true;

		const diffResult = await pi.exec("git", ["diff"], { cwd: ctx.cwd }).catch(() => undefined);
		if (!diffResult || diffResult.code !== 0) return;
		const diff = diffResult.stdout.trim();
		if (!diff) return;

		const leaf = ctx.sessionManager.getLeafEntry();
		const branch = leaf ? ctx.sessionManager.getBranch(leaf.id) : [];
		const firstUserEntry = branch.find((e) => e.type === "message" && e.message.role === "user");
		const spec =
			firstUserEntry && firstUserEntry.type === "message" && firstUserEntry.message.role === "user"
				? messageText(firstUserEntry.message.content)
				: "";
		if (!spec) return;

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
			});
			if (!res.ok) return;
			const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
			reviewText = data.choices?.[0]?.message?.content?.trim() ?? "";
		} catch {
			return;
		}

		if (!reviewText || reviewText.includes(NO_ISSUE_MARKER)) return;

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
		);
	});
}
