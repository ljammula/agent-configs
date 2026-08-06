/**
 * Reviewer reliability battery.
 *
 * Reproduces the 15-trial planted-bug / 9-trial false-positive-control run
 * recorded in pi-harness-validation-status.md for 2026-08-05, which until now
 * existed only as an ad-hoc invocation. It drives the real `requestReview()`
 * path against the configured live reviewer route, so it exercises prompt,
 * transport, and verdict parsing together -- the unit tests in
 * `tests/cross-model-review.test.ts` all use fake fetches and cannot catch a
 * regression in any of those three.
 *
 * Run:  npx tsx evals/reviewer-battery.ts
 * Exits non-zero if any planted bug is missed or any control false-positives.
 */
import { requestReview, resolveReviewerConfig } from "../extensions/cross-model-review.ts";

const PLANTED_TRIALS = 5;
const CONTROL_TRIALS = 3;

interface Case {
	name: string;
	spec: string;
	buggy: string;
	correct: string;
}

const CASES: Case[] = [
	{
		name: "clampToRange",
		spec: "Add clampToRange(value, min, max), which returns value constrained to the inclusive range [min, max].",
		buggy: "export function clampToRange(value: number, min: number, max: number): number {\n\tif (value < min) return min;\n\treturn value;\n}",
		correct: "export function clampToRange(value: number, min: number, max: number): number {\n\tif (value < min) return min;\n\tif (value > max) return max;\n\treturn value;\n}",
	},
	{
		name: "divide",
		spec: "Add divide(a, b), which returns a / b and throws a RangeError when b is zero.",
		buggy: "export function divide(a: number, b: number): number {\n\treturn a / b;\n}",
		correct: "export function divide(a: number, b: number): number {\n\tif (b === 0) throw new RangeError(\"division by zero\");\n\treturn a / b;\n}",
	},
	{
		name: "add",
		spec: "Add add(a, b), which returns the sum of its two arguments.",
		buggy: "export function add(a: number, b: number): number {\n\treturn a - b;\n}",
		correct: "export function add(a: number, b: number): number {\n\treturn a + b;\n}",
	},
];

/** Shapes a snippet as the added side of a unified diff, matching what the extension sends. */
function asDiff(name: string, body: string): string {
	const lines = body.split("\n");
	return [
		`diff --git a/src/${name}.ts b/src/${name}.ts`,
		"new file mode 100644",
		`--- /dev/null`,
		`+++ b/src/${name}.ts`,
		`@@ -0,0 +1,${lines.length} @@`,
		...lines.map((line) => `+${line}`),
	].join("\n");
}

async function main(): Promise<void> {
	const config = resolveReviewerConfig();
	if (!config.enabled) {
		console.error(`reviewer not enabled: ${config.reason ?? "unknown"}`);
		process.exit(2);
	}
	console.log(`route: ${config.baseUrl}\nmodel: ${config.model}\nkind:  ${config.kind}\n`);

	let catches = 0;
	let plantedTotal = 0;
	let falsePositives = 0;
	let controlTotal = 0;
	const unavailable: string[] = [];

	for (const testCase of CASES) {
		for (const [variant, source, trials] of [
			["planted", testCase.buggy, PLANTED_TRIALS],
			["control", testCase.correct, CONTROL_TRIALS],
		] as const) {
			for (let trial = 1; trial <= trials; trial += 1) {
				const result = await requestReview(config, testCase.spec, asDiff(testCase.name, source));
				const label = `${testCase.name}/${variant}/${trial}`;

				if (result.outcome === "transient") {
					// Distinguishable now: a route problem is not a review verdict, and
					// counting it as either would silently corrupt the battery's numbers.
					unavailable.push(`${label} (${result.reason ?? "unknown"}${result.status ? ` ${result.status}` : ""})`);
					console.log(`  ${label}: UNAVAILABLE ${result.reason ?? "unknown"}`);
					continue;
				}

				if (variant === "planted") {
					plantedTotal += 1;
					if (result.outcome === "flagged") catches += 1;
					else console.log(`  ${label}: MISS -- planted bug not caught`);
				} else {
					controlTotal += 1;
					if (result.outcome === "flagged") {
						falsePositives += 1;
						console.log(`  ${label}: FALSE POSITIVE -- ${result.text?.slice(0, 160)}`);
					}
				}
			}
		}
		console.log(`${testCase.name}: done`);
	}

	console.log(`\ncatches:         ${catches}/${plantedTotal}`);
	console.log(`false positives: ${falsePositives}/${controlTotal}`);
	if (unavailable.length > 0) console.log(`unavailable:     ${unavailable.length} (${unavailable.join(", ")})`);

	// An incomplete battery is not a pass: a route that fails every request would
	// otherwise report a clean 0/0 and look like a success.
	const complete = plantedTotal === CASES.length * PLANTED_TRIALS && controlTotal === CASES.length * CONTROL_TRIALS;
	const passed = complete && catches === plantedTotal && falsePositives === 0;
	console.log(passed ? "\nPASS" : "\nFAIL");
	process.exit(passed ? 0 : 1);
}

await main();
