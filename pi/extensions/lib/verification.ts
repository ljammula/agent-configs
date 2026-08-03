// Shared support module; the installed lib directory is not an extension entry point.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const BROAD_VERIFICATION_PATTERNS = [
	/\bmake verify\b/i,
	/\bnpm (?:run )?(?:test|verify)\b/i,
	/\b(?:pnpm|yarn) (?:test|verify)\b/i,
	/\bgo test \.\/\.\.\.(?:\s|$)/i,
	/\bpytest\b/i,
	/\bflutter test\b/i,
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

async function documentedCommand(cwd: string): Promise<string | undefined> {
	for (const name of ["AGENTS.md", "README.md"]) {
		const body = await readFile(join(cwd, name), "utf8").catch(() => "");
		const match = body.match(/(?:verification|verify|test)(?: command)?[^\n`]*`([^`]+)`/i);
		if (match && isBroadVerificationCommand(match[1])) return match[1];
	}
	return undefined;
}

export async function resolveVerificationCommand(cwd: string): Promise<string | undefined> {
	if (await exists(join(cwd, "Makefile"))) {
		const makefile = await readFile(join(cwd, "Makefile"), "utf8");
		if (/^verify\s*:/m.test(makefile)) return "make verify";
	}
	const documented = await documentedCommand(cwd);
	if (documented) return documented;
	if (await exists(join(cwd, "go.mod"))) return "go test ./...";
	if (await exists(join(cwd, "pyproject.toml"))) return "pytest";
	if (await exists(join(cwd, "pubspec.yaml"))) return "flutter test";
	if (await exists(join(cwd, "Cargo.toml"))) return "cargo test";
	if (await exists(join(cwd, "package.json"))) return "npm test";
	return undefined;
}

export async function snapshotDiff(pi: ExtensionAPI, cwd: string, baseSha?: string): Promise<DiffSnapshot> {
	const diffArgs = baseSha ? ["diff", "--binary", baseSha] : ["diff", "--binary", "HEAD"];
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
