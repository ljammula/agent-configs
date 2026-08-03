import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { routeStackSkills } from "../extensions/stack-router.ts";

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
