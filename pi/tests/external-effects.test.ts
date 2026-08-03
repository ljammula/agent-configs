import assert from "node:assert/strict";
import test from "node:test";
import { classifyExternalEffect } from "../extensions/external-effects.ts";

const cases = [
	["gcloud run deploy app", "gcp"],
	["gcloud projects add-iam-policy-binding p --member=x", "gcp"],
	["terraform apply saved.tfplan", "infrastructure"],
	["terraform destroy", "infrastructure"],
	["psql postgresql://production/db -f migrations/1.sql", "production-database"],
	["echo x && kafka-topics --delete --topic events", "kafka-admin"],
	["/usr/local/bin/kafka-consumer-groups --reset-offsets --group g", "kafka-admin"],
	["kubectl apply -f deploy.yaml", "kubernetes"],
	["git push origin main", "git-publish"],
	["rtk git push --tags", "git-publish"],
	["bash -lc 'gh release create v1.0.0'", "git-publish"],
] as const;

for (const [command, category] of cases) {
	test(`classifies ${category}: ${command}`, () => {
		assert.equal(classifyExternalEffect(command)?.category, category);
	});
}

test("permits planning, reads, local Kubernetes, and ordinary tests", () => {
	for (const command of [
		"terraform plan",
		"gcloud run services describe app",
		"kubectl --context kind-test apply --dry-run=server -f x.yaml",
		"git status",
		"make verify",
	]) assert.equal(classifyExternalEffect(command), undefined, command);
});
