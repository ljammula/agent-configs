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
        contextWindow: 96000,
        maxTokens: 16384,
      },
    ],
  });
}
