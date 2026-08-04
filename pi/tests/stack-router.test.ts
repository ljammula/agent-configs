import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import stackRouter, { routeStackSkills } from "../extensions/stack-router.ts";
import { ExtensionHarness } from "./extension-api-harness.ts";

async function fixture(files: Record<string, string>): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stack-"));
	for (const [name, content] of Object.entries(files)) {
		await mkdir(join(cwd, name, ".."), { recursive: true });
		await writeFile(join(cwd, name), content);
	}
	return cwd;
}

test("routes Go and Temporal from dependency evidence", async () => {
	const cwd = await fixture({ "go.mod": "module x\nrequire go.temporal.io/sdk v1.0.0\n" });
	assert.deepEqual(await routeStackSkills(cwd), ["go-service", "temporal-go"]);
});

test("routes Python, Kafka, and PostgreSQL migration evidence", async () => {
	const cwd = await fixture({
		"pyproject.toml": "dependencies = ['confluent-kafka', 'psycopg']\n",
		"migrations/001.sql": "create table x(id int);",
	});
	assert.deepEqual(await routeStackSkills(cwd), ["python-service", "kafka-processing", "postgres-change"]);
});

test("routes Flutter and advertises GCP without invoking it", async () => {
	const cwd = await fixture({ "pubspec.yaml": "name: app\n", "infra/main.tf": "resource \"google_cloud_run_v2_service\" \"app\" {}\n" });
	assert.deepEqual(await routeStackSkills(cwd), ["flutter-app", "gcp-deploy"]);
});

test("an unrelated backend directory receives no DayTrix or stack instruction", async () => {
	const cwd = await fixture({ "backend/readme.txt": "household feature-grant localization release account" });
	assert.deepEqual(await routeStackSkills(cwd), []);
});

test("routes TypeScript/JavaScript from package.json presence", async () => {
	const cwd = await fixture({ "package.json": "{\"name\": \"app\"}\n" });
	assert.deepEqual(await routeStackSkills(cwd), ["typescript-service"]);
});

test("skips dependency and build trees while collecting stack evidence", async () => {
	const cwd = await fixture({
		"pyproject.toml": "dependencies = ['psycopg']\n",
		"node_modules/package/migrations/001.sql": "create table x(id int);",
		"build/schema/001.sql": "create table y(id int);",
	});
	assert.deepEqual(await routeStackSkills(cwd), ["python-service"]);
});

test("a stale extension context after session replacement does not crash the turn", async () => {
	const cwd = await fixture({ "go.mod": "module x\n" });
	const harness = new ExtensionHarness({
		cwd,
		appendEntry: () => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
	});
	stackRouter(harness.api);
	const results = await harness.emit({ type: "before_agent_start", systemPrompt: "base" } as any);
	assert.deepEqual(results, [undefined]);
});
