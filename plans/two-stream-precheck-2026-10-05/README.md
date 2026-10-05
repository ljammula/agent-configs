# Two concurrent Qwen build streams: pre-check (2026-10-05)

**Result: stopped at the pre-check, so no Run A or Run B builds.** The
2-stream memory budget does not fit with Colima at 8 GiB: the preflight
refuses on all three checks. Separately from memory, mtplx's 2-request path
makes concurrent Qwen *slower* than one stream on this workload, and it runs
with no memory guard. `max_parallel_jobs` stays at **1**.

The limiting resources are:
1. RAM: the 2-stream budget needs 106 GiB at the measured OS/apps.
2. mtplx's batch lane: no MTP, no prefix-cache reuse, no memory guard.

## 1. Do mtplx and kv-proxy serve 2 concurrent requests?

| Layer | Setting | Measured |
|---|---|---|
| kv-proxy `:8080` | `QWEN_MAX_CONCURRENT` = 1 (`proxy_config.py` default; the launchd job sets no override) | **Serialized.** 2 requests at once: `/proxy/health` `active` never above 1; the second waits (6.7 s, then 14.0 s) |
| mtplx `:18084` | `--scheduler-mode ar_batch --max-active-requests 2 --decode-batch-max 2` | **Concurrent, but on a different lane.** `Solo MTP bypassed for fair AR batching` |

Probe: [`probe/conc.py`](probe/conc.py), short prompts, thinking off.

| Run | Per stream | Aggregate |
|---|---|---|
| 1 request, solo MTP | 51–62 tok/s | 51–62 tok/s |
| 2 requests direct to mtplx (3 reps) | 14.7–18.2 tok/s (engine: 20.5) | **~33–34 tok/s** (0.55–0.65× solo) |
| 2 requests via proxy (serialized) | 60, then 28.5 incl. wait | **57 tok/s** |

When requests overlap, mtplx runs them on the `ar_batch` lane: plain
autoregressive decode, `mtp_disabled_reason=batch_size_gt_1`. Per its own
comment, MTP is "~4x faster per stream" (`mtplx/server/openai.py:29029`).

**Prefix cache under concurrency** ([`probe/prefix.py`](probe/prefix.py), two
~10.6K-token sessions, M5's median prompt was 11.6K):

| Case | Time to first token |
|---|---|
| Cold, solo | 33.4 s |
| Warm, solo (next turn) | **0.3 s** |
| Warm, both sessions at once | **65.1 s each** (= two cold prefills) |

The batch lane drops the restored session cache, because mtplx's paged KV
cache has no `merge()` (`cache_miss_reason=ar_batch_nonmergeable_history_cache`,
`openai.py:4608-4617`). Every concurrent agent turn therefore re-prefills its
whole prompt. In M5, the 128 Qwen requests averaged 11.6K prompt tokens with
~300 new tokens per turn. Turns that answer in under a second today would take
30–65 s.

## 2. Session bank and memory guard with 2 live sessions

From reading the mtplx 2.12 code (file:line refs, verified where marked):

- **The batch lane has no memory guard.** Admission shed, the per-chunk
  `_PrefillSystemGuard`, HTTP 507 refusal and `prefill_system_abort` exist
  only on the solo lane (`openai.py:31228-31248`).
  `_BatchedARGenerationService` (`openai.py:4387-5267`) has no guard call
  (verified by grep). Two concurrent prefills therefore run unguarded, and
  memory exhaustion would show as macOS compression, swap or jetsam, not as a
  logged guard abort. **"0 memory aborts" would not be evidence of safety in
  Run B.**
- **Guard sheds protect in-flight sessions**
  (`release_idle_sessions(keep_session_ids=in_flight)`, `openai.py:20796-20817`).
  The bank's own LRU cap eviction does not: with two active sessions and no
  idle entry, A's put can evict B's entries (`session_bank.py:3863-3946`).
  The 12G bank has no per-session cap below the bank size.
- **Per-request live KV:** mtplx charges 68 KiB/token (16 full-attention
  layers × 2 × 4 KV heads × 256 × 2 B + 4 KiB MTP history,
  `memory_plan.py:124-240`), plus a 3 GiB per-request transient.
- **Guard events:** `mtplx.log` lines carry no timestamp or request id. The
  per-request receipts in `~/.mtplx/logs/request-log-18084.jsonl`
  (`prefill_admission_shed`, `prefill_shed_before_abort`,
  `prefill_system_abort`) carry `request_id` and `logged_at_s`, and join to
  the flight recorder on `rid`. Batch-lane requests produce no receipts.

## 3. 2-stream memory budget

`memory_preflight.py --streams N` (ai-stack) sizes Qwen at its typical 44 GiB
+ N × 3.5 GiB session KV and reserves N × 12 GiB prefill headroom. The worst
case adds the extra streams on top of the proxy's 60 GiB ceiling, because that
ceiling is an idle-clear threshold and does not fire while requests are
active. Run with Colima at 8 GiB ([`preflight-2stream.txt`](preflight-2stream.txt);
1-stream for comparison in [`preflight-1stream.txt`](preflight-1stream.txt)):

```text
streams 2: qwen + 2 x session KV 3.5G, prefill 2 x 12G
need: qwen 51.0G, colima 8.0G, factory 2.0G; OS/apps 21.2G (measured, floor 8G)
[FAIL] typical: services 61.0 + OS 21.2 + prefill 24 = 106.2G <= 96G
[FAIL] worst case: qwen ceiling 60 + 1 more stream(s) 15.5 + others 10.0 + OS 21.2 + abort floor 2.8 = 109.5G <= 96G
[FAIL] live: available 22.8G >= not-yet-running 2.0 + session KV 7.0 + prefill 24 + floor 2.8 = 35.8G
```

The same machine passes with 1 stream (87.2 / 94.0 GiB). The shortfall
depends on how much memory OS/apps hold at run time:

| OS/apps | Typical (≤96) | Worst case (≤96) |
|---|---|---|
| 21.2 G (now) | 106.2 FAIL | 109.5 FAIL |
| 18.2 G (M5 night) | 103.2 FAIL | 106.5 FAIL |
| 8 G (preflight floor) | 93.0 ok | **96.3 FAIL** |

Even at the 8 G floor the worst case does not fit.

## Decision

- **max_parallel_jobs stays 1; QWEN_MAX_CONCURRENT stays 1.** True 2-way
  Qwen concurrency fails the memory budget. It would also lose MTP (about
  0.6× aggregate decode), lose the prefix cache (agent turns 0.3 s → 30–65 s)
  and run without mtplx's guard. Raising any of these limits is not worth a
  run until mtplx's batch lane keeps the session cache and is guarded.
- **Not measured, worth a separate run:** buildgate `max_parallel_jobs: 2`
  with the proxy left at 1. Qwen stays serialized and on solo MTP, and
  the second job overlaps the other's non-Qwen time. In M5, Qwen was busy only
  **22.5 of 98 min (23%)**; the rest was Codex review, sandbox setup and tests.
  This keeps Qwen's memory at single-stream size; the extra cost is a second
  sandbox in the 8 GiB VM (M5 containers peaked at 1.3 GiB) and a second
  session in the 12 G bank (M5 prompts ≤22K tokens ≈ 1.5 G each).
  - **Before running it:** check the proxy's 900 s queue timeout. M5's
    longest Qwen request took 50 s (p95 36 s), so a queued request should
    wait under a minute. Also check whether the bank evicts the other
    active session. Then rerun this README's Run A/B with that
    configuration.
