import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendHarnessTrace } from "./lib/harness-telemetry.ts";

export type EffectCategory =
	| "gcp"
	| "infrastructure"
	| "production-database"
	| "kafka-admin"
	| "kubernetes"
	| "git-publish";

interface EffectMatch {
	category: EffectCategory;
	description: string;
	alternative: string;
}

const EFFECTS: Array<EffectMatch & { pattern: RegExp; localContext?: RegExp }> = [
	{ category: "gcp", pattern: /\bgcloud\s+(?:run\s+(?:deploy|services\s+update-traffic)|projects\s+.*add-iam-policy-binding|secrets\s+(?:create|delete|versions\s+add))\b/i, description: "mutates Cloud Run, IAM, or secrets", alternative: "run a describe, diff, or validation command first" },
	{ category: "infrastructure", pattern: /\bterraform\s+(?:apply|destroy|import)\b/i, description: "mutates managed infrastructure", alternative: "run terraform plan and inspect the saved plan" },
	{ category: "production-database", pattern: /\b(?:drop\s+(?:database|schema|table)|truncate\s+table|psql\s+[^\n]*(?:prod|production)[^\n]*(?:-f|--file)|migrat\w*\s+[^\n]*(?:prod|production))\b/i, description: "can mutate or destroy production database state", alternative: "run against an ephemeral database or produce the migration plan" },
	{ category: "kafka-admin", pattern: /\b(?:kafka-topics[^\n]*(?:--delete|--alter)|kafka-configs[^\n]*--alter|kafka-consumer-groups[^\n]*--reset-offsets)\b/i, description: "mutates Kafka topics, configuration, or offsets", alternative: "describe the topic/group and produce the intended change" },
	{ category: "kubernetes", pattern: /\bkubectl\s+(?:apply|delete|replace|patch)\b/i, localContext: /(?:--context(?:=|\s+)(?:kind-|minikube|docker-desktop)|KUBECONFIG=[^\s]*(?:kind|minikube))/i, description: "mutates a Kubernetes cluster", alternative: "use --dry-run=server or target an explicit local kind/minikube context" },
	{ category: "git-publish", pattern: /\b(?:git\s+(?:push|tag\s+(?:-a|-s|--sign)|push[^\n]*--tags)|gh\s+(?:release\s+create|pr\s+create))\b/i, description: "publishes commits, tags, releases, or pull requests", alternative: "prepare the local commit/diff and request explicit publication authorization" },
];

export function classifyExternalEffect(command: string): EffectMatch | undefined {
	for (const effect of EFFECTS) {
		if (effect.pattern.test(command) && !effect.localContext?.test(command)) return effect;
	}
	return undefined;
}

function allowedCategories(): Set<string> {
	return new Set((process.env.PI_ALLOW_EXTERNAL_EFFECTS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
}

export default function externalEffects(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = event.input.command;
		if (typeof command !== "string") return undefined;
		const effect = classifyExternalEffect(command);
		if (!effect || allowedCategories().has(effect.category)) return undefined;
		appendHarnessTrace(pi, {
			extension: "external-effects",
			diffHash: null,
			event: "block",
			outcome: "blocked",
			durationMs: 0,
			metadata: { category: effect.category },
		});
		if (ctx.hasUI) ctx.ui.notify(`Blocked ${effect.category} command`, "warning");
		return {
			block: true,
			reason:
				`Blocked external effect (${effect.category}): this command ${effect.description}. ` +
				`${effect.alternative}. To authorize this exact workflow, restart Pi with ` +
				`PI_ALLOW_EXTERNAL_EFFECTS=${effect.category}; do not bypass the gate with aliases, chains, or subprocesses.`,
		};
	});
}
