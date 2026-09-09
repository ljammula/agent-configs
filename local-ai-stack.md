# Local ai-stack model endpoints

Operational snapshot: 2026-09-09 (`ai-stack` pulled to `8cd16f8`, superseding
the 2026-08-21 `d0ef43a` snapshot below). The owning runtime repository is
`~/code/ai-stack`; its `PLAN.md`, launchers, exact package locks, and
`mlx-vlm-rollback.md` remain the source of truth. This file records only the
facts agent configurations need when choosing or calling a local route.

**2026-08-21: `:8080` swapped from the dedicated 8-bit mlx-vlm route to the
mtplx runtime.** See "`:8080` swap to mtplx" below for the full account; the
decode-throughput tables further down in this file predate the swap and
describe the retired 8-bit route, kept for the rollback path and historical
comparison, not the currently-serving model.

**2026-09-07/08: `:8080` KV budget, concurrency, and idle-cache-clear TTL
retuned after a context-size sweep.** See "`:8080` context sweep and proxy
robustness fixes (2026-09-07/08)" below — supersedes the concurrency and KV
figures in the sections that follow it.

## Reaching this host

**Default `AI_STACK_HOST` is now the Tailscale MagicDNS short name**,
`kannas-mac-studio` (set in `~/.zshenv`:
`AI_STACK_HOST="${AI_STACK_HOST:-kannas-mac-studio}"`), not the LAN mDNS
name. Confirmed live 2026-09-09: `tailscale status --json` shows MagicDNS
enabled (`tailfb69fc.ts.net`), `dscacheutil` resolves the short name to
`kannas-mac-studio.tailfb69fc.ts.net` / `100.120.23.7`, and
`curl http://kannas-mac-studio:8080/v1/models` returns 200 — short-name
resolution works because Tailscale's own resolver (`100.100.100.100`) is
this Mac's active DNS nameserver, so the full `.tailfb69fc.ts.net` suffix
isn't required on this machine. On a client where MagicDNS isn't the active
resolver, use the full FQDN `kannas-mac-studio.tailfb69fc.ts.net` instead —
that always works regardless of local resolver config. Either form resolves
whether the caller is on the LAN or off it, as long as Tailscale is running
on both ends — one value works everywhere instead of switching hosts by
location. Tailscale routes all ports between tailnet devices by default (no
`tailscale serve`/funnel setup needed for tailnet-internal reachability), so
plain `http://<name>:8080/...` calls work the same as they would against
the LAN name — this is distinct from the separate HTTPS `/models/<name>/v1`
routes under "Tailnet HTTPS access" in `ai-stack`'s README, which go through
the `com.aistack.tailscale-serve` reverse-proxy LaunchAgent instead. The
tailnet name segment (`tailfb69fc`) is stable in practice but tied to the
Tailscale account/org identity, not guaranteed permanent -- re-verify with
`tailscale status` after any login/org change before trusting a hardcoded
copy of it.

`kannasmacstudio.lan` (the router-assigned LAN mDNS name) still works as a
fallback when Tailscale is down or not installed on the calling machine, but
only resolves on the local network — prefer the Tailscale name by default.

## Resident routes

| Route | Model and role | Runtime | Measured sustained decode |
|---|---|---|---:|
| `:8080/v1` | `Qwen3.8-27B-MTPLX-Optimized-Quality`, coding, blind same-model review, and triage (swapped 2026-08-21 from a dedicated `Qwen3.8-27B-8bit` mlx-vlm instance -- see below) | mtplx v2.9.0, native MTP draft head (depth 3), shared backend on internal port 18084 (also fronted `:8083` until that route was retired the same day) | ~46-49 tok/s decode on a 400-token story prompt under native `mtplx serve` (2026-08-21 native-runtime eval); the block-5 mlx-vlm table below is the retired 8-bit route's number, not this route's |
| `:8081/v1` | `gemma-4-26b-a4b-it(-4bit)`, dedicated reviewer for `cross-model-review.ts` (`AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` in `~/.zshenv`, previously `~/.zshrc` and `:8082`) | — | battery-tested 2026-08-05, 118.1 tok/s solo short-context (2026-08-16) |

## `:8080` context sweep and proxy robustness fixes (2026-09-07/08)

`ai-stack`'s `bench/context_sweep.py` swept prompt size against TTFT/prefill/
decode through the live `:8080` proxy, `bench/RESULTS.md` has the full data.
Three changes to `scripts/proxy_config.py` came out of it (commits `7f969a1`,
`32c9c36`, `8cd16f8`):

- **KV budget raised**: `DEFAULT_QWEN_MAX_KV_SIZE` 81920 → **147456**
  (128K usable at the default `max_tokens=16384`).
- **Concurrency dropped 2 → 1** (`DEFAULT_QWEN_MAX_CONCURRENT`) to
  compensate — at the new, larger KV size two concurrent generations no
  longer fit the memory budget, and mtplx already runs
  `--scheduler-mode serial` underneath (real concurrency was always 1
  regardless of what the proxy admitted), so this just makes the proxy's
  own admission limit match backend reality rather than losing capacity.
- **Admission boundary confirmed by probe: exactly 124,518 prompt tokens**
  at `max_tokens=16384` (124,519 gets a 400). The line is
  `0.95 × (max_kv_size − max_tokens)` and moves with the request's own
  `max_tokens` — a smaller `max_tokens` buys a higher prompt ceiling.
- **mtplx idle-cache-clear TTL raised 20s → 120s**
  (`DEFAULT_MTPLX_IDLE_CACHE_CLEAR_TTL_S`). A 2026-09-08 A/B
  (`bench/cache_ab_idle_clear.jsonl`) caught the bug directly: once mlx
  active memory crosses the 45GB soft threshold, the old 20s TTL cleared
  the prefix cache within one normal human-thinking pause between agent
  turns, turning what should be a 0.4s warm prefill into a ~190s cold one
  — silently, no error, just a slow turn. 120s covers realistic
  between-turn gaps while still reclaiming memory during genuine idle
  periods.
- **Backward-compatible model alias added** (`91918ca`): the proxy now
  accepts both the short stable ID `qwen38-mtplx-quality` and the full
  legacy filesystem-shaped ID
  (`/Users/kanna/code/ai-stack/models/Qwen3.8-27B-MTPLX-Optimized-Quality`)
  in the `model` field, rewriting either to the filesystem ID before
  forwarding. Discovering the id from `/v1/models` (see "Client rules"
  below) still works and is still the robust choice, but a hardcoded short
  id from before this change no longer 400s.

Practical read for agent use: **TTFT, not memory, is the real constraint**
near the raised ceiling — 11.7 minutes to first token at the 124,518-token
admission line, cost-per-1K-prompt-tokens nearly doubling across the range
(3.26 s/1K at 5K → 5.63 s/1K at 124.5K). None of this is a concern for an
agent loop that grows context incrementally, though — a warm, cached prefix
pays prefill only on the new tail (a repeat 50K prompt dropped from 188.3s
cold to 0.4s warm, ~470x, as long as the idle-cache-clear hasn't fired
since).

## `:8080` swap to mtplx (2026-08-21)

Full evaluation trail lives in `ai-stack` PR #20
(`eval/qwen38-mtplx-optimized-speed-plan.md`, commits `c1e6a27`..`d0ef43a`):
a bounded eval of `Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed`/`-Quality`
that started as an isolated oMLX load test, moved to the native `mtplx`
runtime (confirmed working vision/tools/JSON/long-context, unlike the oMLX
fallback), then four rounds of `pi` harness trials comparing the candidate
(fronted temporarily on `:8083`) against the production 8-bit route on
`:8080` -- single-run, then N=3 repeats, then a variant swap from
`-Optimized-Speed` to `-Optimized-Quality`, then a memory-only readout.

**Decision and rollout** (ai-stack commits `f226a5b`, `d0ef43a`): production
`:8080` traffic was repointed at the same shared mtplx backend (`18084`)
`:8083` had been using, on the memory case -- mtplx's session peak (~42GB)
came in well below the old 8-bit route's (~71GB), and four harness trials
found no correctness regression and a wash-to-slight speed edge. **Adopted
ahead of the plan doc's own item-5 quality-scoring gate**, which was never
run -- only pass/fail correctness was checked, not a scored quality
comparison against the old 8-bit route. That gap is open. `:8083`, now
redundant (a second public listener on the identical upstream), was retired
the same day.

Rollback path: the old dedicated `mlx_vlm.server` instance (`Qwen3.8-27B-8bit`
+ MTP-4bit draft, internal port `18080`, `com.aistack.qwen38` launchd job) is
unloaded, not deleted -- weights and launchd plist both still on disk.
`QWEN_UPSTREAM_PORT`/`QWEN_IDLE_CACHE_CLEAR_*_BY_PORT` entries keyed to
`18080` are now inert (no live route uses that upstream) but were left in
place rather than removed.

Concurrency note: `:8080` now shares one upstream process with what used to
be `:8083`'s traffic. mtplx runs `--scheduler-mode serial`, so real
concurrency through this backend is 1 regardless of how many requests the
proxy's own semaphore (`QWEN_MAX_CONCURRENT`) admits -- unlike the old
two-draft-stream `mlx_vlm.server` setup, concurrent requests queue at mtplx
itself rather than running in parallel.

`pi/extensions/ai-stack-local.ts` was updated in lockstep (same day): the
`ai-stack-local` provider's model id now points at
`Qwen3.8-27B-MTPLX-Optimized-Quality`, and the separate `ai-stack-local-mtplx`
provider that had fronted `:8083` for the head-to-head comparison was
removed along with the retired route. Sampling params and `thinkingFormat:
"qwen"` compat settings were carried over unchanged, verified only via PR
#20's exact-text/tool-call checks -- not independently re-derived against
this specific backend the way the old 8-bit route's settings were.

**`:8080` decode throughput by context length (2026-08-16, 3 runs/point,
median shown, 256-token forced completions, temp 0, solo load, MTP block 3
-- the default at the time):**

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

**MTP block-size re-sweep, 2026-08-19** (`ai-stack`'s
`qwen38-throughput-tuning-2026-08-19.md`; block 3 had carried over unexamined
from the 3.6 checkpoint's own A/B rather than being independently retuned for
3.8): `scripts/bench_qwen38_mtp_blocksize.sh` against the live `:8080` proxy
route, 3 runs/size, temp 0, fixed 400-token completion, short context.

| block size | median decode tok/s |
|---:|---:|
| 2 | 36.69 |
| 3 (old default) | 46.55 |
| 4 | 53.39 |
| **5 (new default)** | **54.51** |
| 6 | 44.04 |
| 7 | 37.75 |

Clean peak at 5 (+17% over the old default of 3). **Adopted** in
`scripts/serve_qwen38.sh` and confirmed live on the running process (not
just committed to the repo) -- see "Live vs. synthetic decode gap" below for
why this real win doesn't fully explain live turn latency.

## Live vs. synthetic decode gap (found 2026-08-19, unconfirmed root cause)

Pulled real per-request numbers straight from `kannasmacstudio.lan`'s
`qwen38.log` (`Request completed: ... prompt_tokens=... generated_tokens=...
decode=... tok/s`) for a live `pi -p` harness session (46 requests,
`dart/sequential-runner` pair-5 stall-backstop smoke test, 2026-08-19
13:13-13:18 local), confirmed running with MTP block 5 already live
(`--draft-block-size 5` in the process args, started 10:25AM, well before
this session):

| | context | generated tokens/call | decode tok/s |
|---|---:|---:|---:|
| Synthetic benchmark (block 5, forced 400-tok, short context) | short | 400 | 54.51 median |
| Live tool-calling session (block 5, real turns) | ~11,025 median (6,277-14,415) | 77 median (33-310) | **23.1 median** (20.7-35.6) |

Prefill is not the bottleneck -- APC is working as designed (`cached_tokens`
on each request is almost exactly the prior request's `prompt_tokens`, so
only ~100 genuinely new tokens get prefilled per turn; median prefill
12,616 tok/s). Not a concurrency artifact either: every request in the
window shows `in_flight=0`.

So live decode throughput is under half the current synthetic benchmark at
comparable context, even after the block-5 retune. Leading unconfirmed
hypothesis: the benchmark forces long (256-400 token) completions while
real tool-calling turns are short and bursty (33-310, median 77) --
per-request ramp-up cost (and, if MTP's speculative-token acceptance rate is
lower on structured tool-call-formatted output than on free text) amortizes
worse over a short burst. **Not yet verified** -- would need a live
benchmark using actual short, tool-call-shaped completions (not another
forced-256/400-token run) to isolate generation-length amortization from an
acceptance-rate effect. Flagged here rather than chased further; whoever
picks this up next should design that benchmark before assuming either
explanation.

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
- The route allows **one** active generation as of 2026-09-08 (dropped from
  two — see "`:8080` context sweep and proxy robustness fixes" above). Use
  `GET /proxy/health` to inspect activity, completed/rejected requests,
  queue timeouts, upstream failures, and request timeouts.
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
