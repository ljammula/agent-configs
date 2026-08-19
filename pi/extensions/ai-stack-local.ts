import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const QWEN38_MODEL_ID = "/Users/kanna/code/ai-stack/models/Qwen3.8-27B-8bit";
// mlx-vlm's OpenAI-compatible server defaults unset sampling fields to
// greedy/no-op values (temperature 0.0, no top_p/top_k/presence_penalty
// clamp at all) whenever a request omits them, and pi-coding-agent has no
// CLI flags or settings.json fields for any of these (confirmed by grepping
// its dist/ for each field name -- zero hits), so every request from this
// harness was running fully greedy regardless of settings.json. mlx-vlm
// also does not respect the model's own generation_config.json (a known
// upstream bug, reported independently for the Gemma route on this same
// stack), so there is no server-side default to fix either -- these must be
// injected client-side.
//
// Values are Qwen3.8's own vendor-documented "precise coding" thinking
// preset (huggingface.co/Qwen/Qwen3.8-27B model card + unsloth.ai/docs/
// models/qwen3.8), confirmed 2026-08-19 to be a distinct, code-specific
// preset from both the general thinking default (temp 1.0/top_p 0.95/
// presence_penalty 0.0) and the non-thinking instruct default (temp 0.7/
// top_p 0.80/presence_penalty 1.5) -- not an analogy carried over from the
// 3.6 checkpoint's own "precise coding" preset, which happens to share the
// same temperature. Chosen over the general thinking default for lower
// variance on a coding-agent harness that also wants reproducible trial
// comparisons. See qwen38-agentic-coding-tuning-research.md's "Effective
// temperature during all trials, resolved" and "Vendor-recommended sampling
// parameters" sections for the full trace of how this was found.
const QWEN38_SAMPLING_PARAMS = {
  temperature: 0.6,
  top_p: 0.95,
  top_k: 20,
  presence_penalty: 0.0,
} as const;

export default function (pi: ExtensionAPI) {
  const host = process.env.AI_STACK_HOST || "127.0.0.1";

  // before_provider_request fires for every provider/model this harness
  // calls, not just this one -- so this must check the model id before
  // touching the payload. Mutates in place (same convention documented for
  // the sibling before_provider_headers hook); returning nothing is
  // intentional, not an oversight. Each field is injected independently and
  // only when the caller hasn't already set it, so an explicit per-call
  // override (e.g. a future eval script deliberately pinning temperature: 0)
  // still wins over this default.
  pi.on("before_provider_request", (event) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object" || payload.model !== QWEN38_MODEL_ID) {
      return;
    }
    for (const [key, value] of Object.entries(QWEN38_SAMPLING_PARAMS)) {
      if (payload[key] === undefined) {
        payload[key] = value;
      }
    }
  });

  pi.registerProvider("ai-stack-local", {
    name: "ai-stack local",
    baseUrl: `http://${host}:8080/v1`,
    apiKey: "dummy-key-not-checked",
    api: "openai-completions",
    models: [
      {
        id: "/Users/kanna/code/ai-stack/models/Qwen3.8-27B-8bit",
        name: "Qwen3.8-27B-8bit",
        // Was `reasoning: false`, which made pi send no thinking-control
        // field at all (every thinkingFormat branch in pi-ai's buildParams
        // is gated on model.reasoning) -- not an explicit "thinking off",
        // an unset one. Live-verified 2026-08-17 against :8080 directly
        // (see qwen38-agentic-coding-tuning-research.md "Step 1"): a bare
        // request with no thinking fields returns null reasoning_content
        // (2 completion tokens); `enable_thinking`/`reasoning_effort` sent
        // top-level (compat.thinkingFormat "qwen") returns a populated
        // reasoning_content block (40 completion tokens). The nested
        // `chat_template_kwargs` shape (the one that worked for GLM on this
        // same stack per pi-harness-history.md) was also tried live and did
        // NOT trigger thinking on this route -- do not switch to
        // "chat-template"/"qwen-chat-template" without re-verifying live.
        reasoning: true,
        compat: {
          thinkingFormat: "qwen",
          supportsReasoningEffort: true,
          // Without this, pi-ai's detectCompat defaults
          // supportsDeveloperRole to true for any generic openai-compatible
          // baseUrl once model.reasoning is true (openai-completions.js:793,
          // 1160), so pi sends the system prompt as role "developer"
          // instead of "system". This route's tokenizer rejects that
          // outright with a 503 "Unexpected message role" on every single
          // turn -- live-confirmed 2026-08-17 both via a direct curl and via
          // a real pi -p trial that produced a zero-diff, all-retries-
          // exhausted run (worse than the pre-thinking 0/4 baseline it was
          // meant to fix). Force it off.
          supportsDeveloperRole: false,
        },
        // Copied from pi-ai's bundled qwen3.8-max-preview entry
        // (providers/data/qwen-token-plan.json). Note the `null` entries do
        // NOT suppress those levels -- the "qwen" branch does
        // `thinkingLevelMap?.[level] ?? options.reasoningEffort`, so `??`
        // passes `"high"`/`"max"` through verbatim if ever selected. They're
        // listed as null only because the vendor's 3 core reasoning levels
        // are low/medium/xhigh; avoid selecting "high"/"max" via
        // defaultThinkingLevel rather than relying on this map to block them.
        thinkingLevelMap: {
          minimal: null,
          low: "low",
          medium: "medium",
          high: null,
          xhigh: "xhigh",
          max: null,
        },
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
