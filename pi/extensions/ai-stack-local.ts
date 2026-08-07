import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const host = process.env.AI_STACK_HOST || "127.0.0.1";
  pi.registerProvider("ai-stack-local", {
    name: "ai-stack local",
    baseUrl: `http://${host}:8080/v1`,
    apiKey: "dummy-key-not-checked",
    api: "openai-completions",
    models: [
      {
        id: "/Users/kanna/code/ai-stack/models/ThinkingCap-Qwen3.6-27B-MLX-8bit",
        name: "ThinkingCap-Qwen3.6-27B-MLX-8bit",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // contextWindow is the proxy's real admission budget (max_kv_size 65536
        // - maxTokens 16384 = 49152; see ~/code/ai-stack/scripts/proxy_config.py
        // on kannasmacstudio.lan), not the model's max_kv_size itself. Was 96000
        // (an ungrounded guess), which let Pi's auto-compaction trigger
        // (contextTokens > contextWindow - reserveTokens) sit at 79616 -- well
        // past the proxy's real ~46694-49152 rejection line, so compaction never
        // fired before a 400 context_length_budget_exceeded. See
        // local-model-bench/STATUS.md's 2026-08-07 entry for the failure this
        // caused and pi-harness-validation-status.md's context-budget-awareness
        // finding.
        contextWindow: 49152,
        maxTokens: 16384,
      },
    ],
  });
}
