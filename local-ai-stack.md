# Local ai-stack model endpoints

Operational snapshot: 2026-08-02. The owning runtime repository is
`~/code/ai-stack`; its `PLAN.md`, launchers, exact package locks, and
`mlx-vlm-rollback.md` remain the source of truth. This file records only the
facts agent configurations need when choosing or calling a local route.

## Resident routes

| Route | Model and role | Runtime | Measured sustained decode |
|---|---|---|---:|
| `:8080/v1` | `ThinkingCap-Qwen3.6-27B-MLX-8bit`, coding, local review, and triage | mlx-vlm 0.6.8, APC + MTP block 3 | 51.9 tok/s median |

The rate came from sequential live requests using 256 generated tokens per
sample. The 27B samples were 51.76-51.95 tok/s. This is a workload-specific
observation, not a throughput SLA.

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

## Runtime and rollback boundary

The resident Qwen launcher uses the exactly locked `mlx-vlm-venv` on 0.6.8.
The patched 0.6.3 `venv` remains intact for Qwen rollback and the manual Gemma
OptiQ route; Gemma currently fails 0.6.8 validation because 356 vision
parameters are missing from that checkpoint.

The 0.6.3 rollback runbook was corrected to stop the proxy and backend
listeners before kickstarting the actual `com.aistack.model` launchd job,
whose children otherwise survive because of `AbandonProcessGroup`. Its shell
syntax, installed job, boot mode, and live PID targeting were verified. The
disruptive 0.6.3-and-back cycle itself has not been executed, so agents must not
describe the rollback as live-proven.

The 0.6.8 promotion passed the ai-stack 30-test suite and live text, tool-call,
tool-result, vision, streaming, repeated-prefix APC, direct-agent, translator,
Open WebUI, SearXNG, Whisper, and compatible Gemma checks.
