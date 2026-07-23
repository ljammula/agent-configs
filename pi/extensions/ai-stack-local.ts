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
        id: "/Users/kanna/code/ai-stack/models/Qwen3.6-27B-4bit",
        name: "Qwen3.6-27B-4bit",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 85000,
        maxTokens: 8192,
      },
    ],
  });
  pi.registerProvider("ai-stack-general", {
    name: "ai-stack general",
    baseUrl: `http://${host}:8081/v1`,
    apiKey: "dummy-key-not-checked",
    api: "openai-completions",
    models: [
      {
        id: "/Users/kanna/code/ai-stack/models/Qwen3.6-35B-A3B-5bit",
        name: "Qwen3.6-35B-A3B-5bit",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 85000,
        maxTokens: 8192,
      },
    ],
  });
}
