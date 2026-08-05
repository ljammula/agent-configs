// Shared support module; the installed lib directory is not an extension entry point.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, opendir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

// go test accepts flags before the package pattern (`go test -race ./...`).
// Only non-narrowing flags are allowlisted here: unlike -run/-short/-list,
// none of these can make the command exercise less than the full suite, so
// matching them still means "the whole suite ran," not "some of it did."
const GO_TEST_FLAG = /-race|-v|-count=\d+|-timeout(?:=\S+|\s+\S+)|-parallel(?:=\d+|\s+\d+)/;

export const BROAD_VERIFICATION_PATTERNS = [
	/\bmake (?:verify|test|check)\b/i,
	/\bnpm (?:run )?(?:test|verify)\b/i,
	/\b(?:pnpm|yarn) (?:test|verify)\b/i,
	new RegExp(`\\bgo test\\b(?:\\s+(?:${GO_TEST_FLAG.source}))*\\s+\\.\\/\\.\\.\\.(?:\\s|$)`, "i"),
	/\bpytest\b/i,
	/\bflutter test\b/i,
	/\bdart test\b/i,
	/\bcargo test\b/i,
];

const PIPEFAIL_PATTERN = /\b(?:set\s+-[a-z]*o\s+pipefail|setopt\s+pipefail)\b/i;

export interface VerificationEvidence {
	command: string;
	diffHash: string;
	startedAt: number;
	endedAt: number;
	exitCode: number;
	truncated: boolean;
}

export interface DiffSnapshot {
	hash: string;
	material: boolean;
}

function unquotedShellSyntax(command: string): string {
	const syntax = [...command];
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < syntax.length; i += 1) {
		const char = syntax[i];
		if (quote) {
			syntax[i] = " ";
			if (char === "\\" && quote === '"') {
				i += 1;
				if (i < syntax.length) syntax[i] = " ";
			} else if (char === quote) quote = null;
		} else if (char === "'" || char === '"') {
			quote = char;
			syntax[i] = " ";
		} else if (char === "\\") {
			syntax[i] = " ";
			i += 1;
			if (i < syntax.length) syntax[i] = " ";
		}
	}
	return syntax.join("");
}

export function verificationPipelineCanMaskFailure(command: string): boolean {
	const syntax = unquotedShellSyntax(command);
	const pipefail = PIPEFAIL_PATTERN.test(syntax);
	const ends = BROAD_VERIFICATION_PATTERNS.flatMap((pattern) =>
		[...syntax.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].map(
			(match) => ({ start: match.index, end: match.index + match[0].length }),
		),
	);
	return ends.some(({ start, end }) => {
		if (/(?:^|[;&|]\s*)!\s*$/.test(syntax.slice(0, start))) return true;
		for (let i = end; i < syntax.length; i += 1) {
			const char = syntax[i];
			const next = syntax[i + 1];
			if (char === "#") return false;
			if (char === "|" && next === "|") return true;
			if (char === "|" && !pipefail) return true;
			if (char === ";" || char === "\n") {
				return /\S/.test(syntax.slice(i + 1).replace(/#.*$/gm, ""));
			}
			if (
				char === "&" &&
				next !== "&" &&
				syntax[i - 1] !== "&" &&
				syntax[i - 1] !== ">" &&
				syntax[i - 1] !== "<"
			) return true;
		}
		return false;
	});
}

export function isBroadVerificationCommand(command: string): boolean {
	return BROAD_VERIFICATION_PATTERNS.some((pattern) => pattern.test(command));
}

// A command "looking broad" (matching BROAD_VERIFICATION_PATTERNS) is not
// the same as satisfying the project's actual canonical command: e.g. once
// the Go fallback becomes "go vet ./... && go test ./...", a bare
// `go test ./...` still matches the broad pattern but silently skips vet.
// Require every `&&`-joined segment of the canonical command to appear in
// what was actually run, so a partial command can no longer pass the gate.
function normalizeCommand(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function commandSatisfiesCanonical(observed: string, canonical: string): boolean {
	const normalizedCanonical = normalizeCommand(canonical);
	const normalizedObserved = normalizeCommand(observed);
	const segments = normalizedCanonical.split("&&").map(normalizeCommand).filter(Boolean);
	if (!segments.length) return false;
	// A single-segment canonical (e.g. "make verify") only needs to appear
	// in what was run -- extra flags are fine, and verificationPipelineCan-
	// MaskFailure already catches a trailing `|| true`-style neutralizer for
	// commands matching BROAD_VERIFICATION_PATTERNS.
	if (segments.length === 1) return normalizedObserved.includes(segments[0]!);
	// A compound canonical (the Go "go vet ./... && go test ./..." fallback,
	// or a monorepo's nested "(cd 'x' && ...) && (cd 'y' && ...)") must
	// match exactly. Segment-wise containment would let something like
	// "go vet ./... || true && go test ./..." satisfy every segment while
	// neutralizing vet's exit code -- exactly the bypass this function
	// exists to close -- and no single command a model would plausibly run
	// directly can satisfy a nested multi-component canonical anyway, so
	// falling back to a full rerun at settle is the correct, safe outcome.
	return normalizedObserved === normalizedCanonical;
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(() => true, () => false);
}

async function hashUntrackedPath(path: string): Promise<string> {
	try {
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink()) return `symlink:${await readlink(path)}`;
		if (!metadata.isFile()) return `special:${metadata.mode}`;
		const digest = createHash("sha256");
		for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
		return digest.digest("hex");
	} catch {
		return "unreadable";
	}
}

export async function documentedCommand(cwd: string): Promise<string | undefined> {
	for (const name of ["AGENTS.md", "README.md"]) {
		const body = await readFile(join(cwd, name), "utf8").catch(() => "");
		const match = body.match(/(?:verification|verify|test)(?: command)?[^\n`]*`([^`]+)`/i);
		if (match && isBroadVerificationCommand(match[1])) return match[1];
	}
	return undefined;
}

const NESTED_SCAN_IGNORED_DIRS = new Set([
	".dart_tool", ".git", ".next", "build", "coverage", "dist", "node_modules", "out", "target", "vendor",
]);

// A pubspec.yaml alone doesn't mean Flutter: a plain Dart package (e.g. a
// client library with no UI) has one too, and `flutter test` on it either
// fails outright or drags in the Flutter SDK's own pub cache/resolution for
// no reason. Only the `flutter` SDK dependency stanza actually means Flutter.
async function isFlutterPackage(dir: string): Promise<boolean> {
	const pubspec = await readFile(join(dir, "pubspec.yaml"), "utf8").catch(() => "");
	return /^\s*sdk:\s*flutter\s*$/m.test(pubspec);
}

// Preferred over `test`/`check` when present: `verify` is the convention
// this harness documents (pi/AGENTS.md, README.md) for "the complete
// acceptance gate," not just the test suite, so it's trusted first when a
// Makefile defines more than one of these targets.
const MAKEFILE_TARGET_PRIORITY = ["verify", "test", "check"] as const;

export async function makefileVerificationCommand(dir: string): Promise<string | undefined> {
	if (!(await exists(join(dir, "Makefile")))) return undefined;
	const makefile = await readFile(join(dir, "Makefile"), "utf8");
	for (const target of MAKEFILE_TARGET_PRIORITY) {
		if (new RegExp(`^${target}\\s*:`, "m").test(makefile)) return `make ${target}`;
	}
	return undefined;
}

// No Makefile means nothing bundles lint with tests, so the bare-go.mod
// fallback must do it itself -- go vet catches real defects (nil derefs,
// unreachable code, bad printf verbs) that `go test` alone won't surface.
const GO_FALLBACK_COMMAND = "go vet ./... && go test ./...";

async function manifestCommandForDir(dir: string): Promise<string | undefined> {
	const makefileCommand = await makefileVerificationCommand(dir);
	if (makefileCommand) return makefileCommand;
	if (await exists(join(dir, "go.mod"))) return GO_FALLBACK_COMMAND;
	if (await exists(join(dir, "pyproject.toml"))) return "pytest";
	if (await exists(join(dir, "pubspec.yaml"))) return (await isFlutterPackage(dir)) ? "flutter test" : "dart test";
	if (await exists(join(dir, "Cargo.toml"))) return "cargo test";
	if (await exists(join(dir, "package.json"))) return "npm test";
	return undefined;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

// A monorepo's runnable manifests can live below the root (e.g. go/ + flutter_app/
// siblings), so fall back to a bounded breadth-first scan for nested manifest
// directories and run each one's canonical command from its own directory.
async function nestedVerificationCommand(cwd: string, maxEntries = 3000): Promise<string | undefined> {
	const pending = [""];
	const manifestDirs: string[] = [];
	let visited = 0;
	for (let cursor = 0; cursor < pending.length && visited < maxEntries; cursor += 1) {
		const relativeDir = pending[cursor]!;
		const directory = await opendir(join(cwd, relativeDir)).catch(() => undefined);
		if (!directory) continue;
		const subdirs: string[] = [];
		for await (const entry of directory) {
			visited += 1;
			if (!entry.isDirectory() || NESTED_SCAN_IGNORED_DIRS.has(entry.name)) continue;
			subdirs.push(join(relativeDir, entry.name));
			if (visited >= maxEntries) break;
		}
		for (const subdir of subdirs.sort()) {
			if (await manifestCommandForDir(join(cwd, subdir))) manifestDirs.push(subdir);
			else pending.push(subdir);
		}
	}
	if (!manifestDirs.length) return undefined;
	const commands = await Promise.all(
		manifestDirs.sort().map(async (dir) => `(cd ${shellQuote(dir)} && ${await manifestCommandForDir(join(cwd, dir))} )`),
	);
	return commands.join(" && ");
}

export async function resolveVerificationCommand(cwd: string): Promise<string | undefined> {
	const makefileCommand = await makefileVerificationCommand(cwd);
	if (makefileCommand) return makefileCommand;
	const documented = await documentedCommand(cwd);
	if (documented) return documented;
	if (await exists(join(cwd, "go.mod"))) return GO_FALLBACK_COMMAND;
	if (await exists(join(cwd, "pyproject.toml"))) return "pytest";
	if (await exists(join(cwd, "pubspec.yaml"))) return (await isFlutterPackage(cwd)) ? "flutter test" : "dart test";
	if (await exists(join(cwd, "Cargo.toml"))) return "cargo test";
	if (await exists(join(cwd, "package.json"))) return "npm test";
	return nestedVerificationCommand(cwd);
}

// The canonical hash of an empty tree, valid in any git repository. Used as
// the diff base for a freshly `git init`'d repo, where HEAD is unborn (no
// commits yet) and `git diff --binary HEAD` fails outright -- without this,
// a brand-new project stays snapshot-unavailable/non-material forever, and
// quality-gate.ts's gate (and cross-model-review.ts) never activates.
export const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export async function resolveDiffTarget(pi: ExtensionAPI, cwd: string, baseSha?: string): Promise<string> {
	if (baseSha) return baseSha;
	const head = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd, timeout: 5000 }).catch(() => undefined);
	return head && head.code === 0 ? "HEAD" : EMPTY_TREE_HASH;
}

const MAX_UNTRACKED_DIFF_BYTES = 200_000;

function looksBinary(buffer: Buffer): boolean {
	return buffer.subarray(0, 8000).includes(0);
}

// cross-model-review.ts needs diff *text* to hand an LLM, not just the
// materiality hash snapshotDiff() computes below. A bare `git diff <target>`
// never shows untracked files' content -- `git diff` only ever compares
// tracked content against the target, regardless of what that target is --
// so a freshly `git init`'d project with nothing staged or committed yet
// (exactly the state new-project-scaffold.ts leaves a repo in, and exactly
// this harness's own state for the entire personal-budget-simplifier build,
// which made zero commits until the very end) always produces an empty
// diff, and the reviewer silently never has anything to review for the
// project's whole lifetime up to its first commit. Confirmed via the
// project's own session records: `startup` traces present in all 7 real
// build sessions, `review` traces in zero of them. See "Reopened: the
// cross-model-review untracked-file gap" in pi-harness-history.md.
//
// Build a synthetic diff block per untracked file instead of shelling out
// to `git add -N` (intent-to-add), which would mutate the index as a side
// effect of what should be a read-only review pass.
// Deliberately does not swallow exec rejections here (e.g. via `.catch(() =>
// undefined)`): a stale-context rejection must propagate to the caller's own
// `isStaleContextError` handling, same as the plain `pi.exec("git", ["diff",
// target])` call this replaced did. Only a *resolved* non-zero exit code is
// treated as "nothing to show" -- that is a normal, expected outcome, not an
// exceptional one.
export async function buildReviewDiff(pi: ExtensionAPI, cwd: string, target: string): Promise<string> {
	const [diffResult, statusResult] = await Promise.all([
		pi.exec("git", ["diff", "--binary", target], { cwd, timeout: 10_000 }),
		pi.exec(
			"git",
			[
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=all",
				"--",
				".",
				":(exclude)node_modules",
				":(exclude)build",
				":(exclude)dist",
				":(exclude).dart_tool",
			],
			{ cwd, timeout: 10_000 },
		),
	]);
	const trackedDiff = diffResult.code === 0 ? diffResult.stdout.trim() : "";
	if (statusResult.code !== 0) return trackedDiff;

	const untrackedPaths = statusResult.stdout
		.split(/[\0\n]/)
		.filter(Boolean)
		.filter((entry) => entry.startsWith("?? ") && !entry.startsWith("?? .pi/harness-traces/"))
		.map((entry) => entry.slice(3));

	const untrackedBlocks: string[] = [];
	for (const path of untrackedPaths.sort()) {
		try {
			const buffer = await readFile(join(cwd, path));
			if (buffer.length > MAX_UNTRACKED_DIFF_BYTES || looksBinary(buffer)) {
				untrackedBlocks.push(`diff --git a/${path} b/${path}\nnew file (binary or too large to inline, ${buffer.length} bytes)`);
				continue;
			}
			const lines = buffer.toString("utf8").split("\n").map((line) => `+${line}`);
			untrackedBlocks.push(
				[
					`diff --git a/${path} b/${path}`,
					"new file mode 100644",
					"--- /dev/null",
					`+++ b/${path}`,
					`@@ -0,0 +1,${lines.length} @@`,
					...lines,
				].join("\n"),
			);
		} catch {
			// Unreadable between status and read (deleted, permissions, a
			// symlink loop) -- skip rather than fail the whole review over it.
		}
	}
	return [trackedDiff, ...untrackedBlocks].filter(Boolean).join("\n\n");
}

export async function snapshotDiff(pi: ExtensionAPI, cwd: string, baseSha?: string): Promise<DiffSnapshot> {
	const diffTarget = await resolveDiffTarget(pi, cwd, baseSha);
	const diffArgs = ["diff", "--binary", diffTarget];
	const [diff, status] = await Promise.all([
		pi.exec("git", diffArgs, { cwd, timeout: 10_000 }).catch(() => undefined),
		pi.exec(
			"git",
			[
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=all",
				"--",
				".",
				":(exclude)node_modules",
				":(exclude)build",
				":(exclude)dist",
				":(exclude).dart_tool",
			],
			{ cwd, timeout: 10_000 },
		).catch(() => undefined),
	]);
	if (!diff || diff.code !== 0 || !status || status.code !== 0) {
		return { hash: "unavailable", material: false };
	}
	const statusText = status.stdout.trim();
	const statusEntries = statusText.split(/[\0\n]/).filter(Boolean);
	const materialEntries = statusEntries.filter((entry) => !entry.startsWith("?? .pi/harness-traces/"));
	const untrackedPaths = materialEntries
		.filter((line) => line.startsWith("?? "))
		.map((line) => line.slice(3));
	const material = diff.stdout.length > 0 || materialEntries.length > 0;
	const digest = createHash("sha256").update(diff.stdout).update("\0").update(materialEntries.join("\0"));
	for (const path of untrackedPaths.sort()) {
		digest.update("\0").update(path).update("\0").update(await hashUntrackedPath(join(cwd, path)));
	}
	const hash = digest.digest("hex");
	return { hash, material };
}

export function evidencePassesCurrentDiff(
	evidence: VerificationEvidence | undefined,
	snapshot: DiffSnapshot,
): boolean {
	return Boolean(
		snapshot.material &&
			evidence &&
			evidence.exitCode === 0 &&
			!evidence.truncated &&
			evidence.diffHash === snapshot.hash,
	);
}

export function execResultWasTruncated(result: ExecResult): boolean {
	return Boolean((result as ExecResult & { truncated?: boolean }).truncated);
}
