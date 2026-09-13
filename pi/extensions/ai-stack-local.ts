import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// :8080 swapped 2026-08-21 (ai-stack commits f226a5b/d0ef43a, following the
// eval on PR #20/eval/qwen38-mtplx-optimized-speed-plan.md) from a dedicated
// mlx_vlm.server instance of Qwen3.8-27B-8bit (internal port 18080,
// com.aistack.qwen38 launchd job) to the mtplx runtime's
// Qwen3.8-27B-MTPLX-Optimized-Quality artifact, served through the same
// shared mtplx backend (internal port 18084) that the since-retired :8083
// candidate route used. Driven by memory footprint (mtplx's session peak
// ~42GB vs the old 8-bit route's ~71GB) plus 4 harness trials showing no
// correctness regression and a wash-to-slight speed edge; adopted ahead of
// the plan doc's own quality-scoring gate (item 5), which was never run --
// that comparison is still open. The old mlx_vlm.server route/model stay on
// disk with the launchd plist just unloaded, not deleted, for rollback.
//
// :8083 (the separate "candidate" route this file used to register
// alongside :8080 for head-to-head comparison) was retired the same day
// once :8080 pointed at the identical mtplx/18084 backend -- two public
// listeners fronting one upstream served no purpose. Do not re-add it
// without a corresponding live route in ai-stack's proxy_config.py.
const QWEN38_MODEL_ID = "/Users/kanna/code/ai-stack/models/Qwen3.8-27B-MTPLX-Optimized-Quality";
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
// parameters" sections for the full trace of how this was found. Carried
// over unchanged onto the mtplx route -- not independently re-verified
// against this specific backend yet.
const QWEN38_SAMPLING_PARAMS = {
  temperature: 0.6,
  top_p: 0.95,
  top_k: 20,
  presence_penalty: 0.0,
} as const;

export default function (pi: ExtensionAPI) {
  const host = process.env.AI_STACK_HOST || "127.0.0.1";

  // cross-model-review.ts's resolveReviewerConfig() needs AI_PRIMARY_MODEL
  // to detect a same-model (blind-self-review) reviewer; the public
  // extension deliberately carries no hardcoded fallback id (nothing there
  // is "the" primary model repo-wide) and fails safe toward
  // independent-review without it. This machine's primary model is exactly
  // the one this file registers, so set it here rather than reintroducing a
  // personal model path into the public extension. `??=` so an explicit
  // override (a different eval's own env) still wins.
  process.env.AI_PRIMARY_MODEL ??= QWEN38_MODEL_ID;

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
        id: QWEN38_MODEL_ID,
        name: "Qwen3.8-27B-MTPLX-Optimized-Quality",
        // Was `reasoning: false`, which made pi send no thinking-control
        // field at all (every thinkingFormat branch in pi-ai's buildParams
        // is gated on model.reasoning) -- not an explicit "thinking off",
        // an unset one. Live-verified 2026-08-17 against the old 8-bit
        // route on :8080 (see qwen38-agentic-coding-tuning-research.md
        // "Step 1"): a bare request with no thinking fields returns null
        // reasoning_content (2 completion tokens); `enable_thinking`/
        // `reasoning_effort` sent top-level (compat.thinkingFormat "qwen")
        // returns a populated reasoning_content block (40 completion
        // tokens). The nested `chat_template_kwargs` shape (the one that
        // worked for GLM on this same stack per pi-harness-history.md) was
        // also tried live and did NOT trigger thinking on this route -- do
        // not switch to "chat-template"/"qwen-chat-template" without
        // re-verifying live. Carried over onto the mtplx route on the
        // strength of ai-stack PR #20's confirmation that this route
        // returns exact text + a correctly structured tool call under the
        // same generic mlx server loader -- not independently re-derived
        // for this specific backend the way the above trace was.
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
        // contextWindow is the proxy's real admission budget (max_kv_size
        // 147456 - maxTokens 16384 = 131072; see
        // ~/code/ai-stack/scripts/proxy_config.py on kannasmacstudio.lan),
        // not the model's max_kv_size itself. proxy_config.py derives
        // :8080's budget the same way regardless of which model backs it,
        // so this was unaffected by the mtplx swap itself -- it moved only
        // because DEFAULT_QWEN_MAX_KV_SIZE was separately raised 65536 ->
        // 81920 on 2026-08-21 (ai-stack commit 8007af0), taking this from
        // 49152 to 65536, and again 81920 -> 147456 on 2026-09-07 (ai-stack
        // commit 7f969a1). Corrected 131072 -> 124518 on 2026-09-08: the
        // proxy does not reject at the budget, it rejects at
        // BUDGET_THRESHOLD (0.95) x budget, so 131072 sat 6554 tokens ABOVE
        // the real rejection line. Nothing broke only because reserveTokens
        // happens to be 16384, which kept the compaction trigger under it --
        // the safety came from an unrelated constant, not the derivation.
        // Derive it, do not copy it:
        //   python3 ~/code/ai-stack/scripts/proxy_config.py qwen_context_window
        // and ai-stack's tests/test_serve_launchers.py now fails on drift. That last raise also
        // dropped the route to concurrency 1 to pay for the KV. The old
        // ~46694-49152 empirical rejection line has not been re-measured at
        // either new budget; the proxy's own soft threshold now sits at
        // 124518, and with reserveTokens 16384 Pi compacts at 114688, below
        // it. Before all that: was 96000
        // (an ungrounded guess), which let Pi's auto-compaction trigger
        // (contextTokens > contextWindow - reserveTokens) sit at 79616 --
        // well past the proxy's real rejection line, so compaction never
        // fired before a 400 context_length_budget_exceeded. See
        // local-model-bench/STATUS.md's 2026-08-07 entry for the failure
        // this caused and pi-harness-validation-status.md's
        // context-budget-awareness finding.
        contextWindow: 124518,
        maxTokens: 16384,
      },
    ],
  });
}
