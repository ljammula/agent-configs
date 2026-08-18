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

test("findings render into the follow-up message the agent receives", () => {
	assert.equal(
		renderFindings([{ file: "a.ts", severity: "bug", issue: "missing upper clamp" }]),
		"- [bug] a.ts: missing upper clamp",
	);
});

test("review request classifies clean, flagged, malformed, and unreachable responses", async () => {
	const config = { enabled: true, kind: "independent-review" as const, baseUrl: "http://review/v1", model: "reviewer" };
	const response = (content?: string, ok = true) => async () => ({ ok, json: async () => ({ choices: content === undefined ? [] : [{ message: { content } }] }) }) as Response;
	assert.equal((await requestReview(config, "spec", "diff", undefined, response('{"verdict":"clean","findings":[]}'))).outcome, "clean");
	assert.equal((await requestReview(config, "spec", "diff", undefined, response('{"verdict":"flagged","findings":[{"file":"app.ts","severity":"bug","issue":"off by one"}]}'))).outcome, "flagged");
	// Prose where a schema response is required means the route is misconfigured,
	// not that the diff is clean.
	assert.equal((await requestReview(config, "spec", "diff", undefined, response("NO_ISSUES_FOUND"))).reason, "malformed-verdict");
	assert.equal((await requestReview(config, "spec", "diff", undefined, response(undefined))).outcome, "transient");
	assert.equal((await requestReview(config, "spec", "diff", undefined, async () => { throw new Error("down"); })).outcome, "transient");
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

test("a new top-level prompt (before_agent_start) resets a settled reviewer", async () => {
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

// agent_start fires again on every internal continuation this extension's
// own follow-up causes, not only on a genuinely new task (confirmed against
// pi-agent-core's runAgentLoopContinue). A plain "reset review state on
// every agent_start" would make MAX_REVIEW_ROUNDS (3) an ineffective cap:
// each round's own continuation would look indistinguishable from a fresh
// task and wipe reviewCount back to 0 -- reviewCount/lastReviewedDiff/
// settled are reset on `before_agent_start` instead (fires once per
// genuine top-level prompt, never on a continuation) specifically so
// `agent_start` alone doesn't need to make that distinction. This exercises
// the fix end to end: three flagged rounds against a changing diff, none
// preceded by `before_agent_start` (matching a real continuation), must
// still cap at 3 requests/3 follow-up messages and settle -- and a
// subsequent prompt that *is* preceded by `before_agent_start` must still
// reset it for a genuinely new task.
test("settlement review rounds are capped across the extension's own corrective continuations", async () => {
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
		for (let round = 1; round <= 3; round += 1) {
			diffRound = round;
			// Each of these agent_start calls simulates the continuation this
			// extension's own prior-round follow-up caused, not a fresh task --
			// exactly the case that must NOT reset reviewCount/settled.
			if (round > 1) await harness.emit({ type: "agent_start" } as any);
			await harness.emit({ type: "agent_end", messages: [] } as any);
		}
		assert.equal(reviewRequests, 3, "capped at MAX_REVIEW_ROUNDS despite three separate agent_start events");
		assert.equal(harness.messages.length, 3, "a follow-up was queued for every round up to the cap");

		// A fourth continuation (still this extension's own, from round 3's
		// follow-up) must not spend a fourth round -- settled should already
		// block it.
		await harness.emit({ type: "agent_start" } as any);
		diffRound = 4;
		await harness.emit({ type: "agent_end", messages: [] } as any);
		assert.equal(reviewRequests, 3, "settled after the cap -- no fourth round even though the diff changed again");
		assert.equal(harness.messages.length, 3);

		// A genuinely new task -- before_agent_start fires this time, unlike
		// every continuation above -- must still reset and review again.
		await harness.emit({ type: "before_agent_start", prompt: "fix it again", systemPrompt: "", systemPromptOptions: {} } as any);
		await harness.emit({ type: "agent_start" } as any);
		diffRound = 5;
		await harness.emit({ type: "agent_end", messages: [] } as any);
		assert.equal(reviewRequests, 4, "a genuine before_agent_start resets the cap");
	} finally {
		if (previousBaseUrl === undefined) delete process.env.AI_REVIEW_BASE_URL;
		else process.env.AI_REVIEW_BASE_URL = previousBaseUrl;
		if (previousModel === undefined) delete process.env.AI_REVIEW_MODEL;
		else process.env.AI_REVIEW_MODEL = previousModel;
		globalThis.fetch = previousFetch;
	}
});

// Both quality-gate.ts and cross-model-review.ts listen to agent_end and can
// each queue their own corrective follow-up in the same firing. The real
// runtime drains queued followUp messages one at a time (pi-agent-core's
// default followUpMode), so two extensions queuing in the same agent_end
// produces two separate continuation cycles (two agent_start events), not
// one -- confirmed in the 2026-08-18 Opus review. Neither extension's own
// continuation is ever preceded by before_agent_start (only a genuine
// top-level prompt fires that), so this is exactly why the reset moved
// there instead of staying on agent_start: it doesn't matter which
// extension's queued message caused a given agent_start, or how many fire
// between rounds -- only before_agent_start can reset either extension's
// state. This mounts both extensions on one harness and drives repeated
// agent_start/agent_end cycles (deliberately more than either extension's
// own round count, simulating the two-continuations-per-round shape)
// without ever re-emitting before_agent_start, and checks neither
// extension's cap gets corrupted by the other's activity.
test("two extensions queuing follow-ups off the same agent_end don't corrupt each other's round cap", async () => {
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
		// Always fails, so quality-gate's own agent_end handler also queues a
		// corrective follow-up every round, alongside the reviewer's.
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
		// Six rounds: more than either extension's own cap (3), and each
		// round fires agent_end once (both extensions react to the same
		// firing) followed by an uncorrelated agent_start standing in for
		// whichever extension's queued message the real runtime happened to
		// continue on first -- never before_agent_start.
		for (let round = 1; round <= 6; round += 1) {
			diffRound = round;
			await harness.emit({ type: "agent_end", messages: [] } as any);
			await harness.emit({ type: "agent_start" } as any);
		}

		assert.equal(reviewRequests, 3, "reviewer still caps at its own MAX_REVIEW_ROUNDS despite quality-gate's parallel activity");
		const reviewerMessages = harness.messages.filter((m) => /flagged a possible issue/.test(String(m.content)));
		const qualityGateMessages = harness.messages.filter((m) => /quality gate ran/.test(String(m.content)));
		assert.equal(reviewerMessages.length, 3);
		assert.equal(qualityGateMessages.length, 3, "quality-gate still caps at its own MAX_CORRECTIVE_FOLLOW_UPS");
	} finally {
		if (previousBaseUrl === undefined) delete process.env.AI_REVIEW_BASE_URL;
		else process.env.AI_REVIEW_BASE_URL = previousBaseUrl;
		if (previousModel === undefined) delete process.env.AI_REVIEW_MODEL;
		else process.env.AI_REVIEW_MODEL = previousModel;
		globalThis.fetch = previousFetch;
	}
});
