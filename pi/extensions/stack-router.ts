import { opendir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendHarnessTrace } from "./lib/harness-telemetry.ts";
import { isStaleContextError } from "./lib/stale-context.ts";

export type StackSkill =
	| "go-service"
	| "python-service"
	| "flutter-app"
	| "typescript-service"
	| "postgres-change"
	| "kafka-processing"
	| "temporal-go"
	| "gcp-deploy";

async function body(cwd: string, name: string): Promise<string> {
	return readFile(join(cwd, name), "utf8").catch(() => "");
}

async function fileNames(cwd: string): Promise<string[]> {
	const names: string[] = [];
	const pending = [""];
	const ignored = new Set([".dart_tool", ".git", ".next", "build", "coverage", "dist", "node_modules", "out", "target", "vendor"]);
	for (let cursor = 0; cursor < pending.length && names.length < 5000; cursor += 1) {
		const relativeDir = pending[cursor]!;
		const directory = await opendir(join(cwd, relativeDir)).catch(() => undefined);
		if (!directory) continue;
		for await (const entry of directory) {
			if (entry.isDirectory() && ignored.has(entry.name)) continue;
			const name = join(relativeDir, entry.name);
			names.push(name);
			if (entry.isDirectory()) pending.push(name);
			if (names.length >= 5000) break;
		}
	}
	return names;
}

// Reads every manifest of `manifestName` found anywhere in `names` (not just
// the repo root), so a monorepo's `backend/go.mod` / `frontend/pubspec.yaml`
// are found the same way a root-level one would be. Concatenates all matches
// -- a monorepo can have more than one Go module, and a false-negative here
// (missing the skill) is worse than the false-positive of reading a couple
// of harmless extra manifests.
async function manifestBodies(cwd: string, names: string[], manifestName: string): Promise<string[]> {
	const paths = names.filter((name) => name === manifestName || name.endsWith(`/${manifestName}`)).slice(0, 20);
	return Promise.all(paths.map((path) => body(cwd, path)));
}

export async function routeStackSkills(cwd: string): Promise<StackSkill[]> {
	const names = await fileNames(cwd);
	const [goModBodies, pyprojectBodies, pubspecBodies, packageJsonBodies] = await Promise.all([
		manifestBodies(cwd, names, "go.mod"),
		manifestBodies(cwd, names, "pyproject.toml"),
		manifestBodies(cwd, names, "pubspec.yaml"),
		manifestBodies(cwd, names, "package.json"),
	]);
	const goMod = goModBodies.join("\n");
	const dependencyText = `${goMod}\n${pyprojectBodies.join("\n")}\n${packageJsonBodies.join("\n")}`.toLowerCase();
	const skills: StackSkill[] = [];
	if (goModBodies.some(Boolean)) skills.push("go-service");
	if (pyprojectBodies.some(Boolean)) skills.push("python-service");
	if (pubspecBodies.some(Boolean)) skills.push("flutter-app");
	if (packageJsonBodies.some(Boolean)) skills.push("typescript-service");
	if (/go\.temporal\.io\/sdk/.test(goMod)) skills.push("temporal-go");
	if (/kafka|confluent/.test(dependencyText)) skills.push("kafka-processing");
	const hasMigrations = names.some((name) => /(^|\/)(migrations?|schema)(\/|$)/i.test(name));
	const hasPostgresDriver = /postgres|postgresql|pgx|psycopg|asyncpg|lib\/pq|\"pg\"/.test(dependencyText);
	if (hasMigrations && hasPostgresDriver) skills.push("postgres-change");
	const gcpFiles = names.some((name) => /(^|\/)(cloudbuild\.ya?ml|app\.ya?ml|service\.ya?ml)$/i.test(name));
	const terraformBodies = await Promise.all(
		names.filter((name) => name.endsWith(".tf")).slice(0, 100).map((name) => body(cwd, name)),
	);
	if (gcpFiles || terraformBodies.some((text) => /google_(cloud_run|project|service_account)/.test(text))) {
		skills.push("gcp-deploy");
	}
	return skills;
}

export default function stackRouter(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const skills = await routeStackSkills(ctx.cwd);
			appendHarnessTrace(pi, {
				extension: "stack-router",
				diffHash: null,
				event: "routing",
				outcome: "pass",
				durationMs: 0,
				metadata: { skills: skills.join(",") },
			});
			if (skills.length === 0) return undefined;
			return {
				systemPrompt:
					event.systemPrompt +
					`\n\nStack evidence for this repository matches these project-agnostic skills: ${skills.join(", ")}. ` +
					"Load only the relevant skill instructions before changing that stack. This routing does not authorize deployments or external effects.",
			};
		} catch (error) {
			if (isStaleContextError(error)) return undefined;
			throw error;
		}
	});
}
