/**
 * Co-change file-suggestion extension.
 *
 * Ports the co-change ranking from ai-stack/scripts/suggest_read_files.py
 * (git co-change count^2 / total historical touch count, down-weighting
 * high-churn files) into pi, per ai-stack/local-quality-next-steps-plan.md
 * Phase 3.
 *
 * Retrospective-validated (2026-07-24) against the real mood-streak dispatch
 * in personal-assistant: seeded with the files the real dispatch actually
 * touched (main.go + the mood handler/repository files), the co-change
 * ranking surfaces `contract_matrix_phase2_test.go` at #3 -- close to the
 * plan's claimed #2, confirming the core algorithm is sound. But the
 * *seed selection* (which files a bare task-description prompt maps to,
 * with no upstream `--files` input the way `suggest_read_files.py`
 * normally gets one from `dispatch_local.sh`) initially failed the same
 * retrospective case: identifier extraction pulled a generic token
 * (a lone parameter name) that matched 100+ unrelated files, and the old
 * one-OR'd-grep seed selection had no way to prefer files matching
 * multiple specific identifiers over files that only matched the generic
 * one. Fixed in `grepIdentifiers`/seed selection below -- see their
 * comments for detail. This is the one thing this port needed beyond a
 * straight translation of the python script's logic, precisely because pi
 * has no equivalent upstream target-file-selection step to seed from.
 *
 * Only relevant for real repos with meaningful git history to mine
 * (personal-assistant-style feature dev). Fixture-sized repos with little
 * history have nothing to rank, so this is a no-op there by construction
 * (MIN_COMMITS_FOR_COCHANGE gate), not a separate scoping decision.
 *
 * Runs on the first user turn whose prompt actually has grep-matchable
 * identifiers -- a greeting or clarification as the first message doesn't
 * consume the one-shot attempt, so a later real task prompt still gets
 * evaluated. Once the (potentially expensive) co-change mining actually
 * runs, it's capped at once per session regardless of outcome, both by
 * candidate/history-depth limits and by an overall wall-clock deadline
 * (MINING_DEADLINE_MS) on top of each git subprocess's own timeout, so a
 * slow repo can't block the first turn for more than a bounded amount of
 * time even if every individual call stays under its own cap.
 *
 * Note: `ctx.signal` is threaded through every git call below, but at
 * `before_agent_start` (this extension's only trigger) pi hasn't started the
 * run yet -- `ctx.signal` is `undefined` for the entire duration of this
 * handler (verified against pi's source: the agent run that would populate
 * it starts strictly after `before_agent_start` returns). So right now the
 * *only* thing actually bounding this pass is `MINING_DEADLINE_MS` combined
 * with each call's own timeout, not session-abort cancellation. The signal
 * is still threaded through defensively, in case a future pi version moves
 * when the run-scoped signal becomes available relative to this event --
 * but don't rely on Ctrl-C/abort actually cutting this pass short today.
 */
import type { ExecOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MIN_COMMITS_FOR_COCHANGE = 20;
const TOP_N = 8;
const COCHANGE_LOG_LIMIT = 20;
const MAX_SEEDS = 5;
const MAX_RAW_CANDIDATES = 20; // cap totalTouchCount calls to this many raw co-change hits
const EXEC_TIMEOUT_MS = 5000; // per-call cap
const MINING_DEADLINE_MS = 15_000; // overall cap across the whole cochangeRank pass

const IDENTIFIER_RE = /\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g;
const STOPWORDS = new Set([
	"the", "and", "for", "that", "this", "with", "from", "should", "must",
	"add", "new", "existing", "same", "not", "does", "when", "than", "each",
	"endpoint", "handler", "service", "route", "test", "tests", "file",
	"files", "spec", "code", "return", "returns", "using", "into", "also",
	"used", "user", "data", "value", "such", "way", "one", "all", "any",
	"see", "her", "his", "its", "their", "our", "your", "these", "those",
]);

function specIdentifiers(specText: string): string[] {
	const seen: string[] = [];
	for (const match of specText.matchAll(IDENTIFIER_RE)) {
		const tok = match[0];
		const low = tok.toLowerCase();
		if (STOPWORDS.has(low)) continue;
		const hasUpperAfterFirst = [...tok.slice(1)].some((c) => c === c.toUpperCase() && c !== c.toLowerCase());
		if (!hasUpperAfterFirst && !tok.includes("_")) continue;
		if (!seen.includes(tok)) seen.push(tok);
	}
	return seen;
}

async function run(pi: ExtensionAPI, cmd: string, args: string[], opts: ExecOptions) {
	return pi.exec(cmd, args, { timeout: EXEC_TIMEOUT_MS, ...opts }).catch(() => undefined);
}

async function grepIdentifiers(
	pi: ExtensionAPI,
	cwd: string,
	identifiers: string[],
	signal: AbortSignal | undefined,
): Promise<Map<string, number>> {
	// One grep per identifier (not one OR'd grep across all of them) so the
	// count reflects how many DISTINCT identifiers each file matches, not
	// just "matched something." A single combined grep gives every matched
	// file the same count (1), which makes seed selection (below) equivalent
	// to "first N files in git's listing order" -- no actual relevance
	// signal. Verified against a real retrospective case
	// (personal-assistant's mood-streak dispatch, see
	// ai-stack/local-quality-next-steps-status.md): a generic identifier
	// like a lone "userID" parameter name matches 100+ files across an
	// unrelated codebase and drowned out the one truly relevant seed file
	// under the old one-OR'd-grep behavior; per-identifier counting fixes
	// this by letting files that match multiple specific identifiers
	// outrank files that only match one generic one.
	const hits = new Map<string, number>();
	for (const ident of identifiers) {
		const pattern = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const result = await run(pi, "git", ["grep", "-lIE", pattern], { cwd, signal });
		if (!result || result.code > 1) continue;
		for (const line of result.stdout.split("\n")) {
			const f = line.trim();
			if (!f) continue;
			hits.set(f, (hits.get(f) ?? 0) + 1);
		}
	}
	return hits;
}

async function totalTouchCount(pi: ExtensionAPI, cwd: string, path: string, signal: AbortSignal | undefined): Promise<number> {
	const result = await run(pi, "git", ["log", "--follow", "--format=%H", "--", path], { cwd, signal });
	if (!result || result.code !== 0) return 0;
	return result.stdout.split("\n").filter(Boolean).length;
}

async function cochangeRank(
	pi: ExtensionAPI,
	cwd: string,
	targetFiles: string[],
	signal: AbortSignal | undefined,
): Promise<Map<string, number>> {
	// Overall deadline across the whole mining pass, independent of the
	// per-call EXEC_TIMEOUT_MS: up to ~120 sequential git subprocesses can
	// otherwise still add minutes in a slow repo even with each call capped.
	// Combined with ctx.signal so both cancel in-flight calls and stop the
	// loop from starting new ones once either fires.
	const deadline = Date.now() + MINING_DEADLINE_MS;
	const deadlineSignal = AbortSignal.any([AbortSignal.timeout(MINING_DEADLINE_MS), ...(signal ? [signal] : [])]);

	const raw = new Map<string, number>();
	outer: for (const target of targetFiles) {
		if (Date.now() >= deadline) break;
		const log = await run(pi, "git", ["log", "--follow", `-${COCHANGE_LOG_LIMIT}`, "--format=%H", "--", target], { cwd, signal: deadlineSignal });
		if (!log || log.code !== 0) continue;
		for (const sha of log.stdout.split("\n").filter(Boolean)) {
			if (Date.now() >= deadline) break outer;
			const show = await run(pi, "git", ["show", "--name-only", "--pretty=format:", sha], { cwd, signal: deadlineSignal });
			if (!show || show.code !== 0) continue;
			for (const f of show.stdout.split("\n").filter(Boolean)) {
				if (targetFiles.includes(f)) continue;
				raw.set(f, (raw.get(f) ?? 0) + 1);
			}
		}
	}

	// Cap the (expensive, one-git-log-each) specificity pass to the
	// highest-raw-co-count candidates rather than every file ever seen.
	const capped = [...raw.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_RAW_CANDIDATES);

	const specificity = new Map<string, number>();
	for (const [f, coCount] of capped) {
		if (Date.now() >= deadline) break;
		const total = await totalTouchCount(pi, cwd, f, deadlineSignal);
		if (total === 0) continue;
		specificity.set(f, coCount * (coCount / total));
	}
	return specificity;
}

export default function (pi: ExtensionAPI) {
	let mined = false;

	pi.on("session_start", () => {
		mined = false;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (mined) return;

		const idents = specIdentifiers(event.prompt);
		if (idents.length === 0) return; // e.g. a greeting -- don't consume the attempt

		const commitCountResult = await run(pi, "git", ["rev-list", "--count", "HEAD"], { cwd: ctx.cwd, signal: ctx.signal });
		if (!commitCountResult || commitCountResult.code !== 0) return;
		const commitCount = Number.parseInt(commitCountResult.stdout.trim(), 10) || 0;
		if (commitCount < MIN_COMMITS_FOR_COCHANGE) return;

		const grepHits = await grepIdentifiers(pi, ctx.cwd, idents, ctx.signal);
		if (grepHits.size === 0) return; // cheap so far -- still don't consume the attempt

		// About to do the expensive co-change mining -- bound total git
		// subprocess cost to at most one mining pass per session.
		mined = true;

		const seed = [...grepHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SEEDS).map(([f]) => f);
		const cochangeHits = await cochangeRank(pi, ctx.cwd, seed, ctx.signal);
		if (cochangeHits.size === 0) return;

		const combined = new Map<string, number>();
		for (const [f, n] of grepHits) combined.set(f, (combined.get(f) ?? 0) + n);
		for (const [f, n] of cochangeHits) combined.set(f, (combined.get(f) ?? 0) + n * 2);
		// Drop the grep-matched seed files themselves -- the point is
		// surfacing files the spec didn't name, not echoing back files
		// already found by identifier grep (matches suggest_read_files.py,
		// which pops its seed set from the final candidates).
		for (const f of seed) combined.delete(f);

		const top = [...combined.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N);
		if (top.length === 0) return;

		const suggestion = [
			"Suggested files to read before editing, ranked by git co-change history",
			"with files matching identifiers in this task (suggestion only, verify",
			"relevance before reading -- not auto-applied):",
			...top.map(([f, score]) => `  - ${f} (score=${score.toFixed(2)}${cochangeHits.has(f) ? ", co-change" : ", grep"})`),
		].join("\n");

		return { systemPrompt: `${event.systemPrompt}\n\n${suggestion}` };
	});
}
