/**
 * New-project scaffold nudge.
 *
 * Prompt-only (no autonomous filesystem writes): a `before_agent_start`
 * handler is the only hook that can change the system prompt (see
 * karpathy-guardrail.ts, stack-router.ts) -- a check in `agent_start` runs
 * after the prompt is already built and would never actually reach the
 * model, which is why this lives here rather than alongside the repo check
 * in quality-gate.ts.
 *
 * Covers three findings from the todo-app-hardening-plan.md comparison
 * (personal-assistant vs. a harness-generated project):
 *
 * 1. No git repo, no .gitignore. Beyond hygiene, this is load-bearing: both
 *    quality-gate.ts and cross-model-review.ts need a real git repository
 *    to activate at all -- neither can diff a directory git doesn't know
 *    about. `git init` alone is not sufficient for quality-gate.ts
 *    specifically: it captures baseSha via `git rev-parse HEAD` before the
 *    model runs any tool, and an unborn HEAD (no commits yet) fails that
 *    just like a missing repo does. The nudge therefore asks for an
 *    initial commit too, not just `git init`. (verification.ts's
 *    snapshotDiff and cross-model-review.ts's diff-target resolution both
 *    have a defense-in-depth fallback to the empty-tree hash for this same
 *    case, so gate/review activation doesn't depend solely on the model
 *    following this nudge.)
 * 2. No layered architecture / centralized errors / DI seams for a real Go
 *    backend. Deliberately scoped to project-init time only: a mid-project
 *    size threshold was considered and rejected (see
 *    todo-app-hardening-plan.md) because it would contradict this harness's
 *    own no-speculative-refactor rule and because "N resource types" is not
 *    a checkable trigger for an imperative-following model. Deciding once,
 *    before code exists, needs no threshold and costs nothing.
 * 3. No README. Narrowly scoped like the Makefile nudge in
 *    makefile-scaffold-nudge.ts: only suggested when one is actually
 *    missing, never generated with a stub if no verification command is
 *    known yet.
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isStaleContextError } from "./lib/stale-context.ts";

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

export default function newProjectScaffold(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const [repoCheck, hasReadme] = await Promise.all([
				pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 5000 }).catch(() => undefined),
				exists(join(ctx.cwd, "README.md")),
			]);
			const hasRepo = Boolean(repoCheck && repoCheck.code === 0);

			const notes: string[] = [];
			if (!hasRepo) {
				notes.push(
					"This directory is not a git repository yet. Before other changes, run `git init`, add a " +
						".gitignore appropriate to the project's language(s) (compiled binaries, .dart_tool/, " +
						"build/, IDE directories), and make an initial commit -- even a small one -- so HEAD is " +
						"not left unborn. This step is load-bearing, not just hygiene: this harness's quality " +
						"gate and cross-model review both need a real git repository to activate at all.",
				);
				notes.push(
					"If this new project is a Go backend that will do real persistence (a database, files, " +
						"external state), scaffold layered structure up front instead of starting from a single " +
						"main.go: `cmd/` for the entrypoint, `internal/domain` with sentinel errors in " +
						"`errors.go` and `Clock`/`IDGen`-style interfaces in `ports.go`, `internal/handler` for " +
						"HTTP, and one `internal/<resource>` package per resource for persistence. Decide this " +
						"once, before code exists -- do not retrofit this onto an existing single-file " +
						"prototype mid-task; that is a speculative refactor this harness's own guidelines " +
						"tell you not to do.",
				);
			}
			if (!hasReadme) {
				notes.push(
					"This project has no README.md. Once you know how to build, run, and test it, add a " +
						"minimal one covering exactly that -- using the project's real verification command, " +
						"not a placeholder. Skip this if a README genuinely isn't warranted yet (e.g. the task " +
						"itself is still exploratory).",
				);
			}

			if (!notes.length) return undefined;
			return { systemPrompt: `${event.systemPrompt}\n\n${notes.join("\n\n")}` };
		} catch (error) {
			if (isStaleContextError(error)) return undefined;
			throw error;
		}
	});
}
