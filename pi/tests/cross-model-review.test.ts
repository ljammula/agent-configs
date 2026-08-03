import assert from "node:assert/strict";
import test from "node:test";
import {
	extractLastNonEmptyLine,
	normalizeForMarkerMatch,
	requestReview,
	resolveReviewerConfig,
} from "../extensions/cross-model-review.ts";

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
