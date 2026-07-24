/**
 * Co-change file-suggestion extension.
 *
 * Ports the co-change ranking from ai-stack/scripts/suggest_read_files.py
 * (git co-change count^2 / total historical touch count, down-weighting
 * high-churn files) into pi, per ai-stack/local-quality-next-steps-plan.md
 * Phase 3. Retrospective-validated against the mood-streak dispatch: ranked
 * `contract_matrix_phase2_test.go` at #2 -- the exact file that dispatch
 * missed on identifier-grep alone.
 *
 * Only relevant for real repos with meaningful git history to mine
 * (personal-assistant-style feature dev). Fixture-sized repos with little
 * history have nothing to rank, so this is a no-op there by construction
 * (MIN_COMMITS_FOR_COCHANGE gate), not a separate scoping decision.
 *
 * Runs once per session, on the first user turn: extracts spec identifiers,
 * greps the repo for them, ranks co-changed files, and appends a suggested-
 * reading list to the system prompt. Suggestion only -- never auto-reads
 * anything.
 */
import type { ExtensionAPI, ExecOptions } from "@earendil-works/pi-coding-agent";

const MIN_COMMITS_FOR_COCHANGE = 20;
const TOP_N = 8;
const COCHANGE_LOG_LIMIT = 50;

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
	return pi.exec(cmd, args, opts).catch(() => undefined);
}

async function grepIdentifiers(pi: ExtensionAPI, cwd: string, identifiers: string[]): Promise<Map<string, number>> {
	const hits = new Map<string, number>();
	if (identifiers.length === 0) return hits;
	const pattern = identifiers.map((i) => i.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	const result = await run(pi, "git", ["grep", "-lIE", pattern], { cwd });
	if (!result || result.code > 1) return hits;
	for (const line of result.stdout.split("\n")) {
		const f = line.trim();
		if (!f) continue;
		hits.set(f, (hits.get(f) ?? 0) + 1);
	}
	return hits;
}

async function totalTouchCount(pi: ExtensionAPI, cwd: string, path: string): Promise<number> {
	const result = await run(pi, "git", ["log", "--follow", "--format=%H", "--", path], { cwd });
	if (!result || result.code !== 0) return 0;
	return result.stdout.split("\n").filter(Boolean).length;
}

async function cochangeRank(pi: ExtensionAPI, cwd: string, targetFiles: string[]): Promise<Map<string, number>> {
	const raw = new Map<string, number>();
	for (const target of targetFiles) {
		const log = await run(pi, "git", ["log", "--follow", `-${COCHANGE_LOG_LIMIT}`, "--format=%H", "--", target], { cwd });
		if (!log || log.code !== 0) continue;
		for (const sha of log.stdout.split("\n").filter(Boolean)) {
			const show = await run(pi, "git", ["show", "--name-only", "--pretty=format:", sha], { cwd });
			if (!show || show.code !== 0) continue;
			for (const f of show.stdout.split("\n").filter(Boolean)) {
				if (targetFiles.includes(f)) continue;
				raw.set(f, (raw.get(f) ?? 0) + 1);
			}
		}
	}

	const specificity = new Map<string, number>();
	for (const [f, coCount] of raw) {
		const total = await totalTouchCount(pi, cwd, f);
		if (total === 0) continue;
		specificity.set(f, coCount * (coCount / total));
	}
	return specificity;
}

export default function (pi: ExtensionAPI) {
	let announced = false;

	pi.on("session_start", () => {
		announced = false;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (announced) return;
		announced = true;

		const commitCountResult = await run(pi, "git", ["rev-list", "--count", "HEAD"], { cwd: ctx.cwd });
		if (!commitCountResult || commitCountResult.code !== 0) return;
		const commitCount = Number.parseInt(commitCountResult.stdout.trim(), 10) || 0;
		if (commitCount < MIN_COMMITS_FOR_COCHANGE) return;

		const idents = specIdentifiers(event.prompt);
		if (idents.length === 0) return;

		const grepHits = await grepIdentifiers(pi, ctx.cwd, idents);
		if (grepHits.size === 0) return;

		const seed = [...grepHits.keys()].slice(0, 5);
		const cochangeHits = await cochangeRank(pi, ctx.cwd, seed);
		if (cochangeHits.size === 0) return;

		const combined = new Map<string, number>();
		for (const [f, n] of grepHits) combined.set(f, (combined.get(f) ?? 0) + n);
		for (const [f, n] of cochangeHits) combined.set(f, (combined.get(f) ?? 0) + n * 2);

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
