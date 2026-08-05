import assert from "node:assert/strict";
import test from "node:test";
import aiStack from "../extensions/ai-stack-local.ts";
import artifactGuard from "../extensions/artifact-guard.ts";
import coChange from "../extensions/co-change-suggest.ts";
import continuation from "../extensions/continuation-nudge.ts";
import reviewer from "../extensions/cross-model-review.ts";
import errorLeakGuard from "../extensions/error-leak-guard.ts";
import externalEffects from "../extensions/external-effects.ts";
import format from "../extensions/format-on-edit.ts";
import fullStack from "../extensions/full-stack-dev.ts";
import checkpoint from "../extensions/git-checkpoint.ts";
import gitSafety from "../extensions/git-safety.ts";
import guardrail from "../extensions/karpathy-guardrail.ts";
import makefileScaffoldNudge from "../extensions/makefile-scaffold-nudge.ts";
import newProjectScaffold from "../extensions/new-project-scaffold.ts";
import notify from "../extensions/notify.ts";
import planMode from "../extensions/plan-mode/index.ts";
import projectOverlay from "../extensions/project-skill-overlay.ts";
import protectedPaths from "../extensions/protected-paths.ts";
import qualityGate from "../extensions/quality-gate.ts";
import rtkRewrite from "../extensions/rtk-rewrite.ts";
import search from "../extensions/searxng-search.ts";
import stackRouter from "../extensions/stack-router.ts";
import todo from "../extensions/todo.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

test("every installed extension registers against the pinned public API", () => {
	const factories = [aiStack, artifactGuard, coChange, continuation, reviewer, errorLeakGuard, externalEffects, format, fullStack, checkpoint, gitSafety, guardrail, makefileScaffoldNudge, newProjectScaffold, notify, planMode, projectOverlay, protectedPaths, qualityGate, rtkRewrite, search, stackRouter, todo];
	for (const factory of factories) {
		const harness = new ExtensionHarness();
		assert.doesNotThrow(() => factory(harness.api), factory.name);
	}
});

test("the contract harness reconstructs lifecycle and preserves handler order", async () => {
	const harness = new ExtensionHarness();
	const seen: string[] = [];
	for (const event of ["session_start", "session_before_compact", "session_compact", "session_before_fork", "session_tree"] as const) {
		(harness.api as any).on(event, () => { seen.push(event); });
	}
	await harness.emit({ type: "session_start" } as any);
	await harness.emit({ type: "session_before_compact", preparation: {} } as any);
	await harness.emit({ type: "session_compact", compactionEntry: {} } as any);
	await harness.emit({ type: "session_before_fork", entryId: "x" } as any);
	await harness.emit({ type: "session_tree", entryId: "x" } as any);
	assert.deepEqual(seen, ["session_start", "session_before_compact", "session_compact", "session_before_fork", "session_tree"]);
});
