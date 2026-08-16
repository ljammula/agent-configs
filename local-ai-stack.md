# Local ai-stack model endpoints

Operational snapshot: 2026-08-16. The owning runtime repository is
`~/code/ai-stack`; its `PLAN.md`, launchers, exact package locks, and
`mlx-vlm-rollback.md` remain the source of truth. This file records only the
facts agent configurations need when choosing or calling a local route.

## Resident routes

| Route | Model and role | Runtime | Measured sustained decode |
|---|---|---|---:|
| `:8080/v1` | `Qwen3.8-27B-8bit`, coding, blind same-model review, and triage | mlx-vlm 0.6.8, APC + MTP block 3 | 51.1 tok/s median, short context (see table below) |
| `:8081/v1` | `gemma-4-26b-a4b-it(-4bit)`, dedicated reviewer for `cross-model-review.ts` (`AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` in `~/.zshenv`, previously `~/.zshrc` and `:8082`) | — | battery-tested 2026-08-05, 118.1 tok/s solo short-context (2026-08-16) |

**`:8080` decode throughput by context length (2026-08-16, 3 runs/point,
median shown, 256-token forced completions, temp 0, solo load):**

| Prompt tokens | Median decode tok/s |
|---:|---:|
| ~86 | 51.1 |
| ~2,036 | 49.3 |
| ~10,036 | 44.9 |
| ~30,036 | 41.2 |

Gradual degradation with context length (~19% from near-empty to 30K), not a
cliff -- consistent with attention-cost scaling rather than a KV-cache or MTP
regression. Roughly in line with the prior Qwen3.6-27B-8bit checkpoint's
short-context numbers (43.2-43.4 tok/s in ai-stack's PLAN.md at similar
settings, 51.76-51.95 tok/s under this repo's own methodology), so 3.8 is not
obviously slower or faster than 3.6 at the low end.

**Concurrent-load check (2026-08-16, short context, both routes fired
simultaneously, 2 runs):** `:8080` dropped from 51.1 to ~46.2 tok/s median
(-10%); `:8081` dropped from 118.1 to ~49.8 tok/s median (-58%). Both routes
still complete correctly under concurrency; this is the same single-GPU
time-slicing effect documented in ai-stack's PLAN.md for the prior checkpoint
pairing, not a regression specific to Qwen3.8.

The previous Qwen3.6 `:8080` rate came from sequential live requests using 256
generated tokens per sample. Those samples were 51.76-51.95 tok/s and are
consistent with, but do not by themselves establish, Qwen3.8 throughput --
see the measured table above. `:8081` has 15/15
planted-bug catches plus 9/9 correct-code controls (see
`pi-harness-validation-status.md`).

`AI_REVIEW_MODEL` briefly went stale after the `:8082`→`:8081` move: the
route's served model id gained a `-4bit` suffix and a full path
(`/Users/kanna/code/ai-stack/models/gemma-4-26b-a4b-it-4bit`), but
`~/.zshrc` still exported the short form. Every real review request 400'd
with `model_mismatch`, which `requestReview()` silently downgrades to
`{outcome: "transient"}` — no crash, no error, just a reviewer that never
actually reviewed anything. Fixed 2026-08-05 by exporting the full served
id. Client rules above (discover the model id from `/v1/models`) apply to
this static declaration too: whenever this route's checkpoint changes,
re-check `/v1/models` before assuming the configured id still matches.

## Client rules

- Shell clients should discover the current model id from `GET /v1/models`
  immediately before a request and send that exact id in `model`. Pi's provider
  API requires static model declarations instead; update
  `pi/extensions/ai-stack-local.ts`, `cross-model-review.ts`, and the documented
  Pi settings whenever a route changes. The public proxy returns HTTP 400
  `model_mismatch` for an omitted or stale id so mlx-vlm cannot dynamically
  replace the configured checkpoint.
- The route allows two active generations. Use `GET /proxy/health` to inspect
  activity, completed/rejected requests, queue timeouts, upstream failures, and
  request timeouts.
- APC is enabled. Preserve stable prefixes when practical; a repeated live
  check reused 41 prompt tokens and reduced 27B end-to-end latency from
  1.108s to 0.493s.
- Treat local-model output as evidence to review, not an authoritative result.
  The 8-bit code checkpoint improves the available signal but does not remove
  the existing judgment and logic-error limitations described by the skills.

The installed `local-review.sh` and `triage.sh` copies discover the route model
dynamically and therefore comply with the model-id guard. Aider-based local
dispatch remains intentionally removed from agent-configs after its negative
cost and latency benchmark.

## Review topology

There are now two resident inference models. Pi's primary provider calls
Qwen3.8-27B on `:8080`; `cross-model-review.ts` is configured
(via `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` in `~/.zshrc`) to call the
distinct, independently-trained Gemma reviewer on `:8081` instead, so it
resolves to genuine `independent-review` rather than same-model
`blind-self-review`. See `pi-harness-validation-status.md` for the current
adoption status and `pi-harness-history.md` for how that route moved from
`:8082` to `:8081`. If `AI_REVIEW_BASE_URL` is ever pointed back at `:8080`,
review reverts to same-model and must be labeled `blind-self-review`, not
cross-model.

The local-review scripts used by Claude and Codex are still cross-model in the
ordinary sense because their primary agent is a cloud model. When the same
script is invoked by Pi, it is a second pass by Pi's own model family and must
be described that way.

`cross-model-review.ts` enforces its verdict via `response_format` JSON
Schema against `:8081` (verified live to honor it correctly). Structured
output and speculative decoding are mutually exclusive on this stack —
`:8080` rejects a schema request outright with "Structured response_format
is not supported with speculative decoding" when serving with a draft
model. Gemma is therefore deliberately never run with `GEMMA_MTP=1`
(`serve_gemma.sh`'s MTP branch): doing so would make every reviewer request
fail as `model-rejected`, silently disabling the reviewer the same way the
stale `AI_REVIEW_MODEL` id once did. See `pi-harness-validation-status.md`'s
`cross-model-review.ts` entry for the full account.

## Runtime and rollback boundary

The resident Qwen launcher uses the exactly locked `mlx-vlm-venv` on 0.6.8.
The patched 0.6.3 `venv` remains intact for Qwen rollback and historical Gemma
OptiQ diagnostics; Gemma is not a current resident route and fails 0.6.8
validation because 356 vision parameters are missing from that checkpoint.

The 0.6.3 rollback runbook was corrected to stop the proxy and backend
listeners before kickstarting the actual `com.aistack.model` launchd job,
whose children otherwise survive because of `AbandonProcessGroup`. Its shell
syntax, installed job, boot mode, and live PID targeting were verified. The
disruptive 0.6.3-and-back cycle itself has not been executed, so agents must not
describe the rollback as live-proven.

The 0.6.8 promotion passed the ai-stack 30-test suite and live text, tool-call,
tool-result, vision, streaming, repeated-prefix APC, direct-agent, translator,
Open WebUI, SearXNG, Whisper, and compatible Gemma checks.
