import assert from "node:assert/strict";
import test from "node:test";
import {
	default as reviewer,
	extractLastNonEmptyLine,
	normalizeForMarkerMatch,
	requestReview,
	resolveReviewerConfig,
} from "../extensions/cross-model-review.ts";
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

test("clean marker tolerates reasoning and markdown fences only on the final line", () => {
	assert.equal(normalizeForMarkerMatch("**NO_ISSUES_FOUND**"), "NO_ISSUES_FOUND");
	assert.equal(extractLastNonEmptyLine("reasoning\n```\nNO_ISSUES_FOUND\n```"), "NO_ISSUES_FOUND");
	assert.notEqual(extractLastNonEmptyLine("NO_ISSUES_FOUND\nbut there is a bug"), "NO_ISSUES_FOUND");
});

test("review request classifies clean, flagged, malformed, and unreachable responses", async () => {
	const config = { enabled: true, kind: "independent-review" as const, baseUrl: "http://review/v1", model: "reviewer" };
	const response = (content?: string, ok = true) => async () => ({ ok, json: async () => ({ choices: content === undefined ? [] : [{ message: { content } }] }) }) as Response;
	assert.equal((await requestReview(config, "spec", "diff", undefined, response("NO_ISSUES_FOUND"))).outcome, "clean");
	assert.equal((await requestReview(config, "spec", "diff", undefined, response("bug in app.ts"))).outcome, "flagged");
	assert.equal((await requestReview(config, "spec", "diff", undefined, response(undefined))).outcome, "transient");
	assert.equal((await requestReview(config, "spec", "diff", undefined, async () => { throw new Error("down"); })).outcome, "transient");
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

test("agent_settled blocks until a pending review round finishes", async () => {
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

		const settling = harness.emit({ type: "agent_settled" } as any);
		let settledFirst = false;
		settling.then(() => { settledFirst = true; });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(settledFirst, false, "agent_settled must not resolve while the review is still pending");

		resolveFetch!({ ok: true, json: async () => ({ choices: [{ message: { content: "NO_ISSUES_FOUND" } }] }) });
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

test("a new agent run resets a settled reviewer", async () => {
	const previousBaseUrl = process.env.AI_REVIEW_BASE_URL;
	const previousModel = process.env.AI_REVIEW_MODEL;
	const previousFetch = globalThis.fetch;
	process.env.AI_REVIEW_BASE_URL = "http://review/v1";
	process.env.AI_REVIEW_MODEL = "reviewer";
	let reviewRequests = 0;
	globalThis.fetch = async () => {
		reviewRequests += 1;
		return { ok: true, json: async () => ({ choices: [{ message: { content: "NO_ISSUES_FOUND" } }] }) } as Response;
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
