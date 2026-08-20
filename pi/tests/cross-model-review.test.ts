import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	default as reviewer,
	parseVerdict,
	renderFindings,
	requestReview,
	resolveReviewerConfig,
} from "../extensions/cross-model-review.ts";
import qualityGate from "../extensions/quality-gate.ts";
import { ExtensionHarness, type ExecCall } from "./extension-api-harness.ts";

const model = "primary-model";
const primary = { AI_PRIMARY_BASE_URL: "http://host:8080/v1", AI_PRIMARY_MODEL: model };

test("reviewer configuration requires an explicit valid endpoint and model", () => {
	assert.equal(resolveReviewerConfig({}).reason, "missing-configuration");
	assert.equal(resolveReviewerConfig({ AI_REVIEW_BASE_URL: "file:///tmp/x", AI_REVIEW_MODEL: "x" }).reason, "invalid-configuration");
});

test("same reviewer is disabled unless explicitly labeled and allowed", () => {
	const same = { ...primary, AI_REVIEW_BASE_URL: primary.AI_PRIMARY_BASE_URL, AI_REVIEW_MODEL: model };
	assert.deepEqual(resolveReviewerConfig(same).kind, "disabled");
	assert.deepEqual(resolveReviewerConfig({ ...same, AI_REVIEW_ALLOW_SELF: "1" }).kind, "blind-self-review");
});

test("a different route or model is an independent reviewer", () => {
	const config = resolveReviewerConfig({ ...primary, AI_REVIEW_BASE_URL: "http://host:8081/v1", AI_REVIEW_MODEL: "reviewer" });
	assert.equal(config.enabled, true);
	assert.equal(config.kind, "independent-review");
});

test("a verdict is accepted only as a well-formed schema response", () => {
	assert.equal(parseVerdict('{"verdict":"clean","findings":[]}')?.verdict, "clean");
	assert.equal(parseVerdict('{"verdict":"flagged","findings":[{"file":"a.ts","severity":"bug","issue":"off by one"}]}')?.findings.length, 1);
	assert.equal(parseVerdict("NO_ISSUES_FOUND"), undefined);
	assert.equal(parseVerdict('{"verdict":"maybe","findings":[]}'), undefined);
	assert.equal(parseVerdict('{"verdict":"clean"}'), undefined);
});

test("findings render into the trace's flagged-verdict text", () => {
	assert.equal(
		renderFindings([{ file: "a.ts", severity: "bug", issue: "missing upper clamp" }]),
		"- [bug] a.ts: missing upper clamp",
	);
});

test("review request classifies clean, flagged, malformed, and unreachable responses", async () => {
	const config = { enabled: true, kind: "independent-review" as const, baseUrl: "http://review/v1", model: "reviewer" };
	const response = (content?: string, ok = true, finishReason = "stop") => async () =>
		({ ok, json: async () => ({ choices: content === undefined ? [] : [{ message: { content }, finish_reason: finishReason }] }) }) as Response;
	assert.equal((await requestReview(config, "spec", "diff", undefined, response('{"verdict":"clean","findings":[]}'))).outcome, "clean");
	assert.equal((await requestReview(config, "spec", "diff", undefined, response('{"verdict":"flagged","findings":[{"file":"app.ts","severity":"bug","issue":"off by one"}]}'))).outcome, "flagged");
	// Prose where a schema response is required means the route is misconfigured,
	// not that the diff is clean.
	assert.equal((await requestReview(config, "spec", "diff", undefined, response("NO_ISSUES_FOUND"))).reason, "malformed-verdict");
	assert.equal((await requestReview(config, "spec", "diff", undefined, response(undefined))).outcome, "transient");
	assert.equal((await requestReview(config, "spec", "diff", undefined, async () => { throw new Error("down"); })).outcome, "transient");

	// Live-found 2026-08-18 on a real go/lru-cache run: a long, self-looping
	// `analysis` field can exhaust the completion's token cap before the JSON
	// ever closes. finish_reason: "length" distinguishes this from a genuinely
	// malformed response instead of collapsing both into the same reason.
	// This fetchImpl always truncates, so the request should retry once (with
	// a stricter brevity prompt) and still report the same terminal outcome
	// rather than looping.
	const alwaysTruncates = response('{"analysis": "still reasoning, never', true, "length");
	const truncated = await requestReview(config, "spec", "diff", undefined, alwaysTruncates);
	assert.equal(truncated.reason, "truncated-response");
	assert.equal(truncated.finishReason, "length");
});

test("a transient reviewer transport failure gets one bounded retry", async () => {
	const config = { enabled: true, kind: "independent-review" as const, baseUrl: "http://review/v1", model: "reviewer" };
	let callCount = 0;
	const fetchImpl = (async () => {
		callCount += 1;
		if (callCount === 1) throw new Error("temporary connection failure");
		return {
			ok: true,
			json: async () => ({ choices: [{ message: { content: '{"verdict":"clean","findings":[]}' }, finish_reason: "stop" }] }),
		} as Response;
	}) as typeof fetch;

	const result = await requestReview(config, "spec", "diff", undefined, fetchImpl);
	assert.equal(callCount, 2);
	assert.equal(result.outcome, "clean");
});

test("transient review failure is not retried again by settlement", async () => {
	const previousBaseUrl = process.env.AI_REVIEW_BASE_URL;
	const previousModel = process.env.AI_REVIEW_MODEL;
	const previousFetch = globalThis.fetch;
	process.env.AI_REVIEW_BASE_URL = "http://review/v1";
	process.env.AI_REVIEW_MODEL = "reviewer";
	let reviewRequests = 0;
	globalThis.fetch = async () => {
		reviewRequests += 1;
		throw new Error("temporary connection failure");
	};
	try {
		const branch = [{ id: "user-1", type: "message", message: { role: "user", content: "fix it" } }];
		const harness = new ExtensionHarness({
			branch,
			exec: ({ command, args }: ExecCall) => {
				if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "base\n", stderr: "", killed: false };
				if (command === "git" && args[0] === "diff") return { code: 0, stdout: "diff --git a/a.ts b/a.ts\n+changed\n", stderr: "", killed: false };
				return { code: 1, stdout: "", stderr: "", killed: false };
			},
		});
		reviewer(harness.api);
		await harness.emit({ type: "agent_start" } as any);
		await harness.emit({ type: "tool_result", toolCallId: "v1", toolName: "bash", input: { command: "make verify" }, content: [], details: {}, isError: false } as any);
		await new Promise((resolve) => setImmediate(resolve));
		await harness.emit({ type: "agent_end", messages: [] } as any);
		await harness.emit({ type: "agent_end", messages: [] } as any);
		assert.equal(reviewRequests, 2);
	} finally {
		if (previousBaseUrl === undefined) delete process.env.AI_REVIEW_BASE_URL;
		else process.env.AI_REVIEW_BASE_URL = previousBaseUrl;
		if (previousModel === undefined) delete process.env.AI_REVIEW_MODEL;
		else process.env.AI_REVIEW_MODEL = previousModel;
		globalThis.fetch = previousFetch;
	}
});

test("caller cancellation is not retried as a transient reviewer failure", async () => {
	const config = { enabled: true, kind: "independent-review" as const, baseUrl: "http://review/v1", model: "reviewer" };
	const controller = new AbortController();
	controller.abort();
	let callCount = 0;
	const fetchImpl = (async () => {
		callCount += 1;
		throw new DOMException("cancelled", "AbortError");
	}) as typeof fetch;

	const result = await requestReview(config, "spec", "diff", controller.signal, fetchImpl);
	assert.equal(callCount, 0);
	assert.equal(result.reason, "cancelled");
});

test("a permanent reviewer rejection is not retried", async () => {
	const config = { enabled: true, kind: "independent-review" as const, baseUrl: "http://review/v1", model: "reviewer" };
	let callCount = 0;
	const fetchImpl = (async () => {
		callCount += 1;
		return { ok: false, status: 400, json: async () => ({}) } as Response;
	}) as typeof fetch;

	const result = await requestReview(config, "spec", "diff", undefined, fetchImpl);
	assert.equal(callCount, 1);
	assert.equal(result.reason, "model-rejected");
});

test("a truncated first attempt retries once with a stricter brevity prompt and can recover", async () => {
	const config = { enabled: true, kind: "independent-review" as const, baseUrl: "http://review/v1", model: "reviewer" };
	let callCount = 0;
	const seenPrompts: string[] = [];
	const fetchImpl = (async (_url: string, init: RequestInit) => {
		callCount += 1;
		const body = JSON.parse(init.body as string);
		const prompt = body.messages[0].content as string;
		seenPrompts.push(prompt);
		// First call always truncates; only a prompt carrying the stricter
		// "at most 3 sentences" instruction gets a real verdict back --
		// this is the behavior a retry-with-the-same-prompt could never
		// produce at temperature 0.
		const truncating = !prompt.includes("at most 3 sentences");
		return {
			ok: true,
			json: async () => ({
				choices: [
					truncating
						? { message: { content: '{"analysis": "still going' }, finish_reason: "length" }
						: { message: { content: '{"analysis":"ok","verdict":"clean","findings":[]}' }, finish_reason: "stop" },
				],
			}),
		} as Response;
	}) as typeof fetch;

	const result = await requestReview(config, "spec", "diff", undefined, fetchImpl);
	assert.equal(callCount, 2);
	assert.equal(result.outcome, "clean");
	assert.ok(!seenPrompts[0].includes("at most 3 sentences"));
	assert.ok(seenPrompts[1].includes("at most 3 sentences"));
});

test("a truncated retry attempt is not retried a second time", async () => {
	const config = { enabled: true, kind: "independent-review" as const, baseUrl: "http://review/v1", model: "reviewer" };
	let callCount = 0;
	const fetchImpl = (async () => {
		callCount += 1;
		return {
			ok: true,
			json: async () => ({ choices: [{ message: { content: '{"analysis": "still going' }, finish_reason: "length" }] }),
		} as Response;
	}) as typeof fetch;

	const result = await requestReview(config, "spec", "diff", undefined, fetchImpl);
	assert.equal(callCount, 2);
	assert.equal(result.reason, "truncated-response");
});

test("the review request reserves headroom with an explicit max_tokens", async () => {
	const config = { enabled: true, kind: "independent-review" as const, baseUrl: "http://review/v1", model: "reviewer" };
	let sentMaxTokens: number | undefined;
	const fetchImpl = (async (_url: string, init: RequestInit) => {
		sentMaxTokens = JSON.parse(init.body as string).max_tokens;
		return { ok: true, json: async () => ({ choices: [{ message: { content: '{"analysis":"ok","verdict":"clean","findings":[]}' }, finish_reason: "stop" }] }) } as Response;
	}) as typeof fetch;
	await requestReview(config, "spec", "diff", undefined, fetchImpl);
	assert.equal(typeof sentMaxTokens, "number");
	assert.ok(sentMaxTokens! > 0);
});

test("every unavailable reviewer carries a distinguishable reason", async () => {
	const config = { enabled: true, kind: "independent-review" as const, baseUrl: "http://review/v1", model: "reviewer" };
	const respond = (init: { ok: boolean; status?: number; content?: string }) => async () => ({
		ok: init.ok,
		status: init.status ?? 200,
		json: async () => ({ choices: init.content === undefined ? [] : [{ message: { content: init.content } }] }),
	}) as Response;

	const disabled = await requestReview({ enabled: false, kind: "disabled" }, "spec", "diff");
	assert.equal(disabled.reason, "not-configured");

	// The exact shape of the stale-AI_REVIEW_MODEL incident: a 400 that used to
	// be indistinguishable from a reviewer that was never configured at all.
	const rejected = await requestReview(config, "spec", "diff", undefined, respond({ ok: false, status: 400 }));
	assert.equal(rejected.reason, "model-rejected");
	assert.equal(rejected.status, 400);

	assert.equal((await requestReview(config, "spec", "diff", undefined, respond({ ok: true }))).reason, "empty-response");
	assert.equal((await requestReview(config, "spec", "diff", undefined, async () => { throw new Error("down"); })).reason, "request-failed");

	// A real verdict must not carry an unavailability reason.
	assert.equal((await requestReview(config, "spec", "diff", undefined, respond({ ok: true, content: '{"verdict":"clean","findings":[]}' }))).reason, undefined);
});

test("a stale extension context during review does not crash the turn", async () => {
	const previousBaseUrl = process.env.AI_REVIEW_BASE_URL;
	const previousModel = process.env.AI_REVIEW_MODEL;
	process.env.AI_REVIEW_BASE_URL = "http://review/v1";
	process.env.AI_REVIEW_MODEL = "reviewer";
	try {
		const branch = [{ id: "user-1", type: "message", message: { role: "user", content: "fix it" } }];
		const harness = new ExtensionHarness({
			branch,
			exec: ({ command, args }: ExecCall) => {
				if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "base\n", stderr: "", killed: false };
				if (command === "git" && args[0] === "diff") throw new Error("This extension ctx is stale after session replacement or reload.");
				return { code: 1, stdout: "", stderr: "", killed: false };
			},
		});
		reviewer(harness.api);
		await harness.emit({ type: "agent_start" } as any);
		await assert.doesNotReject(
			harness.emit({ type: "tool_result", toolCallId: "v1", toolName: "bash", input: { command: "make verify" }, content: [], details: {}, isError: false } as any),
		);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(harness.entries.some((entry) => entry.type === "pi-harness-trace"), false);
	} finally {
		if (previousBaseUrl === undefined) delete process.env.AI_REVIEW_BASE_URL;
		else process.env.AI_REVIEW_BASE_URL = previousBaseUrl;
		if (previousModel === undefined) delete process.env.AI_REVIEW_MODEL;
		else process.env.AI_REVIEW_MODEL = previousModel;
	}
});

test("agent_end blocks until a pending review round finishes", async () => {
	const previousBaseUrl = process.env.AI_REVIEW_BASE_URL;
	const previousModel = process.env.AI_REVIEW_MODEL;
	const previousFetch = globalThis.fetch;
	process.env.AI_REVIEW_BASE_URL = "http://review/v1";
	process.env.AI_REVIEW_MODEL = "reviewer";
	let resolveFetch: ((value: unknown) => void) | undefined;
	globalThis.fetch = (() => new Promise((resolve) => { resolveFetch = resolve as (value: unknown) => void; })) as typeof fetch;
	try {
		const branch = [{ id: "user-1", type: "message", message: { role: "user", content: "fix it" } }];
		const harness = new ExtensionHarness({
			branch,
			exec: ({ command, args }: ExecCall) => {
				if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "base\n", stderr: "", killed: false };
				if (command === "git" && args[0] === "diff") return { code: 0, stdout: "diff", stderr: "", killed: false };
				return { code: 1, stdout: "", stderr: "", killed: false };
			},
		});
		reviewer(harness.api);
		await harness.emit({ type: "agent_start" } as any);
		await harness.emit({ type: "tool_result", toolCallId: "v1", toolName: "bash", input: { command: "make verify" }, content: [], details: {}, isError: false } as any);
		// let the tool_result handler's synchronous chain reach the still-pending fetch
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(harness.entries.length, 0, "review has not resolved yet");

		const settling = harness.emit({ type: "agent_end", messages: [] } as any);
		let settledFirst = false;
		settling.then(() => { settledFirst = true; });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(settledFirst, false, "agent_end must not resolve while the review is still pending");

		resolveFetch!({ ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"clean","findings":[]}' } }] }) });
		await settling;
		assert.equal(settledFirst, true);
		assert.equal(
			harness.entries.some((entry) => (entry.data as any)?.event === "review" && (entry.data as any)?.outcome === "clean"),
			true,
		);
	} finally {
		if (previousBaseUrl === undefined) delete process.env.AI_REVIEW_BASE_URL;
		else process.env.AI_REVIEW_BASE_URL = previousBaseUrl;
		if (previousModel === undefined) delete process.env.AI_REVIEW_MODEL;
		else process.env.AI_REVIEW_MODEL = previousModel;
		globalThis.fetch = previousFetch;
	}
});

test("agent_end fires a backstop review when the model never ran a broad verification command", async () => {
	// This is the local-model-bench shape from the todo item: the model does
	// real work but never runs a command the tool_result trigger recognizes
	// (it hides hidden tests until after pi exits), so without a settlement
	// backstop the reviewer would fire zero times all session.
	const previousBaseUrl = process.env.AI_REVIEW_BASE_URL;
	const previousModel = process.env.AI_REVIEW_MODEL;
	const previousFetch = globalThis.fetch;
	process.env.AI_REVIEW_BASE_URL = "http://review/v1";
	process.env.AI_REVIEW_MODEL = "reviewer";
	let reviewRequests = 0;
	globalThis.fetch = async () => {
		reviewRequests += 1;
		return { ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"clean","findings":[]}' } }] }) } as Response;
	};
	try {
		const branch = [{ id: "user-1", type: "message", message: { role: "user", content: "fix it" } }];
		const harness = new ExtensionHarness({
			branch,
			exec: ({ command, args }: ExecCall) => {
				if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "base\n", stderr: "", killed: false };
				if (command === "git" && args[0] === "diff") return { code: 0, stdout: "diff --git a/app.ts b/app.ts\n+changed\n", stderr: "", killed: false };
				if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "", killed: false };
				return { code: 1, stdout: "", stderr: "", killed: false };
			},
		});
		reviewer(harness.api);
		await harness.emit({ type: "agent_start" } as any);
		// No tool_result at all -- straight to settlement.
		await harness.emit({ type: "agent_end", messages: [] } as any);
		assert.equal(reviewRequests, 1);
		assert.equal(
			harness.entries.some((entry) => (entry.data as any)?.event === "review" && (entry.data as any)?.metadata?.trigger === "settlement"),
			true,
		);
	} finally {
		if (previousBaseUrl === undefined) delete process.env.AI_REVIEW_BASE_URL;
		else process.env.AI_REVIEW_BASE_URL = previousBaseUrl;
		if (previousModel === undefined) delete process.env.AI_REVIEW_MODEL;
		else process.env.AI_REVIEW_MODEL = previousModel;
		globalThis.fetch = previousFetch;
	}
});

// Same rationale as quality-gate.test.ts's matching guard tests: agent_end
// fires on internal retry/abort cycles too, not only on a genuine stop.
// Awaiting an already-in-flight tool_result review is still fine here (see
// cross-model-review.ts's comment on the ordering); what must not happen is
// *starting* a new backstop round against an aborted/errored run.
for (const stopReason of ["error", "aborted"] as const) {
	test(`agent_end does not start a backstop review when the run ended in ${stopReason}`, async () => {
		const previousBaseUrl = process.env.AI_REVIEW_BASE_URL;
		const previousModel = process.env.AI_REVIEW_MODEL;
		const previousFetch = globalThis.fetch;
		process.env.AI_REVIEW_BASE_URL = "http://review/v1";
		process.env.AI_REVIEW_MODEL = "reviewer";
		let reviewRequests = 0;
		globalThis.fetch = async () => {
			reviewRequests += 1;
			return { ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"clean","findings":[]}' } }] }) } as Response;
		};
		try {
			const branch = [{ id: "user-1", type: "message", message: { role: "user", content: "fix it" } }];
			const harness = new ExtensionHarness({
				branch,
				exec: ({ command, args }: ExecCall) => {
					if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "base\n", stderr: "", killed: false };
					if (command === "git" && args[0] === "diff") return { code: 0, stdout: "diff --git a/app.ts b/app.ts\n+changed\n", stderr: "", killed: false };
					if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "", killed: false };
					return { code: 1, stdout: "", stderr: "", killed: false };
				},
			});
			reviewer(harness.api);
			await harness.emit({ type: "agent_start" } as any);
			await harness.emit({
				type: "agent_end",
				messages: [{ role: "assistant", stopReason, content: [], api: "chat", provider: "test", model: "test", usage: {} }],
			} as any);
			assert.equal(reviewRequests, 0);
		} finally {
			if (previousBaseUrl === undefined) delete process.env.AI_REVIEW_BASE_URL;
			else process.env.AI_REVIEW_BASE_URL = previousBaseUrl;
			if (previousModel === undefined) delete process.env.AI_REVIEW_MODEL;
			else process.env.AI_REVIEW_MODEL = previousModel;
			globalThis.fetch = previousFetch;
		}
	});
}

test("agent_end does not spend a backstop review round on an empty diff", async () => {
	const previousBaseUrl = process.env.AI_REVIEW_BASE_URL;
	const previousModel = process.env.AI_REVIEW_MODEL;
	const previousFetch = globalThis.fetch;
	process.env.AI_REVIEW_BASE_URL = "http://review/v1";
	process.env.AI_REVIEW_MODEL = "reviewer";
	let reviewRequests = 0;
	globalThis.fetch = async () => {
		reviewRequests += 1;
		return { ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"clean","findings":[]}' } }] }) } as Response;
	};
	try {
		const branch = [{ id: "user-1", type: "message", message: { role: "user", content: "fix it" } }];
		const harness = new ExtensionHarness({
			branch,
			exec: ({ command, args }: ExecCall) => {
				if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "base\n", stderr: "", killed: false };
				if (command === "git" && args[0] === "diff") return { code: 0, stdout: "", stderr: "", killed: false };
				if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "", killed: false };
				return { code: 1, stdout: "", stderr: "", killed: false };
			},
		});
		reviewer(harness.api);
		await harness.emit({ type: "agent_start" } as any);
		await harness.emit({ type: "agent_end", messages: [] } as any);
		assert.equal(reviewRequests, 0);
	} finally {
		if (previousBaseUrl === undefined) delete process.env.AI_REVIEW_BASE_URL;
		else process.env.AI_REVIEW_BASE_URL = previousBaseUrl;
		if (previousModel === undefined) delete process.env.AI_REVIEW_MODEL;
		else process.env.AI_REVIEW_MODEL = previousModel;
		globalThis.fetch = previousFetch;
	}
});

test("a new top-level prompt (before_agent_start) resets lastReviewedDiff, so a repeated diff gets reviewed again", async () => {
	const previousBaseUrl = process.env.AI_REVIEW_BASE_URL;
	const previousModel = process.env.AI_REVIEW_MODEL;
	const previousFetch = globalThis.fetch;
	process.env.AI_REVIEW_BASE_URL = "http://review/v1";
	process.env.AI_REVIEW_MODEL = "reviewer";
	let reviewRequests = 0;
	globalThis.fetch = async () => {
		reviewRequests += 1;
		return { ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"clean","findings":[]}' } }] }) } as Response;
	};
	try {
		const branch = [{ id: "user-1", type: "message", message: { role: "user", content: "fix it" } }];
		const harness = new ExtensionHarness({
			branch,
			exec: ({ command, args }: ExecCall) => {
				if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "base\n", stderr: "", killed: false };
				if (command === "git" && args[0] === "diff") return { code: 0, stdout: "diff", stderr: "", killed: false };
				return { code: 1, stdout: "", stderr: "", killed: false };
			},
		});
		reviewer(harness.api);
		for (let run = 0; run < 2; run += 1) {
			await harness.emit({ type: "before_agent_start", prompt: "fix it", systemPrompt: "", systemPromptOptions: {} } as any);
			await harness.emit({ type: "agent_start" } as any);
			await harness.emit({ type: "tool_result", toolCallId: `verify-${run}`, toolName: "bash", input: { command: "make verify" }, content: [], details: {}, isError: false } as any);
			await new Promise((resolve) => setImmediate(resolve));
		}
		assert.equal(reviewRequests, 2);
	} finally {
		if (previousBaseUrl === undefined) delete process.env.AI_REVIEW_BASE_URL;
		else process.env.AI_REVIEW_BASE_URL = previousBaseUrl;
		if (previousModel === undefined) delete process.env.AI_REVIEW_MODEL;
		else process.env.AI_REVIEW_MODEL = previousModel;
		globalThis.fetch = previousFetch;
	}
});

// A caller that knows the real ticket boundary (build_app.py's
// --review-base-sha, threaded from ticket_runner.py's prior-ticket commit)
// can pin baseSha instead of the default "HEAD when this process starts".
// Without this, a process retried against work an earlier, interrupted
// process already committed sees an empty diff and can never get a decisive
// review verdict for a diff nobody actually reviewed -- see PR #25.
test("AI_REVIEW_BASE_SHA anchors the reviewer's diff target instead of HEAD-at-process-start", async () => {
	const previousBaseUrl = process.env.AI_REVIEW_BASE_URL;
	const previousModel = process.env.AI_REVIEW_MODEL;
	const previousReviewBaseSha = process.env.AI_REVIEW_BASE_SHA;
	const previousFetch = globalThis.fetch;
	process.env.AI_REVIEW_BASE_URL = "http://review/v1";
	process.env.AI_REVIEW_MODEL = "reviewer";
	process.env.AI_REVIEW_BASE_SHA = "deadbeef";
	globalThis.fetch = async () =>
		({ ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"clean","findings":[]}' } }] }) }) as Response;
	try {
		const branch = [{ id: "user-1", type: "message", message: { role: "user", content: "fix it" } }];
		let revParseCalled = false;
		let diffTarget: string | undefined;
		const harness = new ExtensionHarness({
			branch,
			exec: ({ command, args }: ExecCall) => {
				if (command === "git" && args[0] === "rev-parse") {
					revParseCalled = true;
					return { code: 0, stdout: "head-at-process-start\n", stderr: "", killed: false };
				}
				if (command === "git" && args[0] === "diff") {
					diffTarget = args[args.length - 1];
					return { code: 0, stdout: "diff --git a/a.ts b/a.ts\n+changed\n", stderr: "", killed: false };
				}
				return { code: 1, stdout: "", stderr: "", killed: false };
			},
		});
		reviewer(harness.api);
		await harness.emit({ type: "agent_start" } as any);
		await harness.emit({ type: "tool_result", toolCallId: "v1", toolName: "bash", input: { command: "make verify" }, content: [], details: {}, isError: false } as any);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(revParseCalled, false, "the env-provided base sha must short-circuit the git rev-parse HEAD lookup");
		assert.equal(diffTarget, "deadbeef");
	} finally {
		if (previousBaseUrl === undefined) delete process.env.AI_REVIEW_BASE_URL;
		else process.env.AI_REVIEW_BASE_URL = previousBaseUrl;
		if (previousModel === undefined) delete process.env.AI_REVIEW_MODEL;
		else process.env.AI_REVIEW_MODEL = previousModel;
		if (previousReviewBaseSha === undefined) delete process.env.AI_REVIEW_BASE_SHA;
		else process.env.AI_REVIEW_BASE_SHA = previousReviewBaseSha;
		globalThis.fetch = previousFetch;
	}
});

// Decoupled 2026-08-19: a flagged verdict is pure telemetry now, never a
// queued follow-up (see the file-top comment on cross-model-review.ts for
// why). This replaces the old round-cap test -- there is no cap to test
// anymore, since nothing is being capped; what matters instead is that
// review keeps firing independently for every materially distinct diff
// across repeated agent_end cycles, and that no message is ever queued.
test("a flagged verdict never queues a follow-up, and review has no round cap", async () => {
	const previousBaseUrl = process.env.AI_REVIEW_BASE_URL;
	const previousModel = process.env.AI_REVIEW_MODEL;
	const previousFetch = globalThis.fetch;
	process.env.AI_REVIEW_BASE_URL = "http://review/v1";
	process.env.AI_REVIEW_MODEL = "reviewer";
	let reviewRequests = 0;
	globalThis.fetch = async () => {
		reviewRequests += 1;
		return {
			ok: true,
			json: async () => ({
				choices: [{ message: { content: '{"verdict":"flagged","findings":[{"file":"a.go","severity":"bug","issue":"still broken"}]}' } }],
			}),
		} as Response;
	};
	try {
		const branch = [{ id: "user-1", type: "message", message: { role: "user", content: "fix it" } }];
		let diffRound = 0;
		const harness = new ExtensionHarness({
			branch,
			exec: ({ command, args }: ExecCall) => {
				if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "base\n", stderr: "", killed: false };
				// A distinct diff per round -- otherwise startReviewRound's own
				// `diff === lastReviewedDiff` check would (correctly) block a
				// same-content rerun, which isn't what this test is exercising.
				if (command === "git" && args[0] === "diff") return { code: 0, stdout: `diff --git a/a.go b/a.go\n+round ${diffRound}\n`, stderr: "", killed: false };
				if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "", killed: false };
				return { code: 1, stdout: "", stderr: "", killed: false };
			},
		});
		reviewer(harness.api);

		await harness.emit({ type: "before_agent_start", prompt: "fix it", systemPrompt: "", systemPromptOptions: {} } as any);
		await harness.emit({ type: "agent_start" } as any);
		for (let round = 1; round <= 5; round += 1) {
			diffRound = round;
			await harness.emit({ type: "agent_end", messages: [] } as any);
			await harness.emit({ type: "agent_start" } as any);
		}
		assert.equal(reviewRequests, 5, "every materially distinct diff gets reviewed, no cap");
		assert.equal(harness.messages.length, 0, "a flagged verdict never queues a follow-up message");
	} finally {
		if (previousBaseUrl === undefined) delete process.env.AI_REVIEW_BASE_URL;
		else process.env.AI_REVIEW_BASE_URL = previousBaseUrl;
		if (previousModel === undefined) delete process.env.AI_REVIEW_MODEL;
		else process.env.AI_REVIEW_MODEL = previousModel;
		globalThis.fetch = previousFetch;
	}
});

// Decoupled 2026-08-19: quality-gate's corrective follow-up is gone too
// (see quality-gate.ts's file-top comment). This replaces the old
// two-extension-interleaving round-cap test -- with neither extension
// queuing anything, there's nothing left to interleave or corrupt; what
// matters is that both extensions can react to the same repeated agent_end
// firings, independently, without ever sending a message.
test("quality-gate and the reviewer both react to repeated agent_end firings without queuing any message", async () => {
	const previousBaseUrl = process.env.AI_REVIEW_BASE_URL;
	const previousModel = process.env.AI_REVIEW_MODEL;
	const previousFetch = globalThis.fetch;
	process.env.AI_REVIEW_BASE_URL = "http://review/v1";
	process.env.AI_REVIEW_MODEL = "reviewer";
	let reviewRequests = 0;
	globalThis.fetch = async () => {
		reviewRequests += 1;
		return {
			ok: true,
			json: async () => ({
				choices: [{ message: { content: '{"verdict":"flagged","findings":[{"file":"a.go","severity":"bug","issue":"still broken"}]}' } }],
			}),
		} as Response;
	};
	try {
		const cwd = await mkdtemp(join(tmpdir(), "pi-gate-review-"));
		// Always fails, so quality-gate's own agent_end handler also records a
		// failing verification every round, alongside the reviewer's flag.
		await writeFile(join(cwd, "Makefile"), "verify:\n\t@false\n");
		const branch = [{ id: "user-1", type: "message", message: { role: "user", content: "fix it" } }];
		let diffRound = 0;
		const harness = new ExtensionHarness({
			cwd,
			branch,
			exec: ({ command, args }: ExecCall) => {
				if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "base\n", stderr: "", killed: false };
				if (command === "git" && args[0] === "diff") return { code: 0, stdout: `diff --git a/a.go b/a.go\n+round ${diffRound}\n`, stderr: "", killed: false };
				if (command === "git" && args[0] === "status") return { code: 0, stdout: " M a.go\n", stderr: "", killed: false };
				if (command === "bash") return { code: 1, stdout: "", stderr: "", killed: false };
				return { code: 1, stdout: "", stderr: "", killed: false };
			},
		});
		reviewer(harness.api);
		qualityGate(harness.api);

		await harness.emit({ type: "before_agent_start", prompt: "fix it", systemPrompt: "", systemPromptOptions: {} } as any);
		await harness.emit({ type: "agent_start" } as any);
		for (let round = 1; round <= 6; round += 1) {
			diffRound = round;
			await harness.emit({ type: "agent_end", messages: [] } as any);
			await harness.emit({ type: "agent_start" } as any);
		}

		assert.equal(reviewRequests, 6, "reviewer keeps firing for every materially distinct diff, no cap");
		assert.equal(harness.messages.length, 0, "neither extension ever queues a message");
	} finally {
		if (previousBaseUrl === undefined) delete process.env.AI_REVIEW_BASE_URL;
		else process.env.AI_REVIEW_BASE_URL = previousBaseUrl;
		if (previousModel === undefined) delete process.env.AI_REVIEW_MODEL;
		else process.env.AI_REVIEW_MODEL = previousModel;
		globalThis.fetch = previousFetch;
	}
});
