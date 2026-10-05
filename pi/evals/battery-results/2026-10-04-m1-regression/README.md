# M1 regression run — 2026-10-04 (plan v2 milestone M1, done criterion 4)

**Plan:** `plans/local-execution-plan-v2-2026-10-04.md` §Measurement / M1.
**Driver:** `run_parity_battery.py --reps 3 --arms baseline` (stock pi only),
gated by ai-stack `scripts/overnight_run.sh --need qwen` (memory preflight +
per-minute memory log). 16:24–21:27 CDT, 30 runs, Qwen3.8-27B on mtplx 2.12
with the 12G RAM session bank as the new default; gemma, Whisper, Colima off.

## Result: zero memory aborts

| | Phase-0 (2026-10-03/04, stock pi) | This run |
|---|---|---|
| Memory aborts | 8 of the first 68 runs (both arms) | **0 / 30** |
| mtplx memory-guard actions (shed/refuse) | hundreds; prefill refusals | **0** since the 12G restart |
| Pass rate, as recorded by the driver | 69.7% clean | 28/30 = 93.3% |
| Pass rate, corrected (see false failure below) | — | **29/30 = 96.7%** |

`summarize_battery.py --dir .`:

```
go-flutter/bookmarks-app                      PPP
go/lru-cache                                  PPP
real/aistack-models-hide-offline              PPF   <- F is a checker false positive (hidden tests passed)
real/pa-habits-stable-order                   FPP   <- variance
real/pa-note-create-idempotent                PPP   <- spec corrected (F2): 0/6 in phase-0
real/pa-shared-reminder-rules                 PPP   <- spec corrected (F2): 0/6
real/pbs-latency-histogram                    PPP
real/sf-retry-stale-result                    PPP   <- phase-0 P/T
real/sf-ticketspec-fenced-verify              PPP
real/todo-durable-done-filter                 PPP   <- spec corrected (F2): F in phase-0
```

All four spec-corrected tickets passed 12/12 (aistack-models-hide-offline's
rep-3 "F" included): the phase-0 failures were spec gaps, not the model.

### False failure: `aistack-models-hide-offline` rep 3

`hidden_test_exit: 0`, but the run was marked `valid: false` because
`run_screening.py` flagged a "connection error" by substring over pi's whole
stdout — and the model's own summary of this task (hide models whose
upstream is unreachable) said "connection error → `[]`". Fixed in this
branch: `battery_lib.has_connection_error` only counts pi error events
(`stopReason: "error"` with a connection-error `errorMessage`) or stderr.
The capture is kept beside this README (`real__…__rep3/pi-output.jsonl`) and
covered by `pi/tests/battery_lib_test.py`.

## Memory (from `memory.csv`, 302 one-minute samples)

| | min | p5 | median | max |
|---|---|---|---|---|
| available (mtplx's definition), GiB | **7.1** | 10.1 | 22.3 | 40.9 |
| Qwen footprint, GiB | 36 | — | 48 | **56** |
| compressor, GiB | 0.5 | — | — | 2.7 |
| swap used, MiB | flat at the pre-run 1.7 GiB (left over from phase-0), never grew |

- Qwen no longer creeps (phase-0: 41 → 62 GB overnight). It rises within a
  task and falls back to 36–42 GiB between tasks.
- **Margin is thin at Qwen's peaks:** 44 of 302 minutes were below the
  preflight's live threshold (12 GiB prefill headroom + 2.4 GiB abort
  floor), 2 minutes below 8 GiB. No abort happened because each pi turn's
  prompt is ~95% cached, so the prefill it needs is small; a cold 30K+
  prefill at such a moment would be refused. The proxy's 54 GiB soft clear
  waits for 120 s idle, which never happens mid-task.
- "Everything else" (total − available − Qwen) was ~14 GiB before the run
  and ~29 GiB during it: kernel/wired memory plus the tasks' own Go/Flutter
  builds, test servers and pi. Desktop apps are only ~4–5 GiB (quitting
  Chrome freed 0.7 GiB).

## Cache

Last 32 requests at 21:2x: 95.1% of prompt tokens served from the RAM
session bank (30 RAM hits, 2 cold task starts), median TTFT 1.4 s. The 12G
bank is enough for one pi session at a time. The SSD tier logged zero
restores (every task is a fresh session) — write-only wear in batch runs.

## Tokens

29 runs with usage recorded: 22.6 M prompt + 0.52 M completion tokens, 700
turns, 810 tool calls (~$75 at Sonnet 5 list price; ~$20–30 with prompt
caching, which `token_savings.py` does not model).

## Follow-ups

- Lower Qwen's peak for batch runs or raise headroom before adding any
  service to an overnight run (gemma + Colima do not fit; see preflight).
  Candidate: proxy soft clear sooner/without the idle wait during batches;
  measure before changing.
- Turn the mtplx SSD session tier off for batch runs until the 2 TB NVMe
  is attached.
