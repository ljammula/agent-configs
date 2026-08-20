# Harness-arm battery — seed 20260802, 2026-08-19

Full 9-pair harness-arm run against the seeded task schedule
(`run_screening.schedule(20260802)`), via `run_single_arm.py --arm harness`
per pair, `--host kannasmacstudio.lan`. Baseline arms were not rerun.
Default `progress-stall-guard.ts` settings throughout (10/20-minute
backstop, `ACTION_SAME_FAILURE_THRESHOLDS = [8, 25]`, intercept off) —
this is a coverage run, not the Recommendation-2 intercept-recovery trial
from earlier the same day (see `pi-harness-history.md`'s "Recommendation-2
intercept-recovery trial" entry for that one, which used pair 5 only with
temporarily lowered thresholds and is not part of this battery).

## Results

| Pair | Task | Valid | Passed | Time | Notes |
|---:|---|:---:|:---:|---:|---|
| 1 | `go-flutter/notes-app` | ✅ | ✅ | 1322.6s | Large dual-stack task; 78% of wall time was model decode (58 calls, 1035.8s, confirmed from `kannasmacstudio.lan`'s `qwen38.log`); 3 quality-gate fail rounds, 1 reviewer `blocked`→`clean` cycle before passing. |
| 2 | `go/notes-api` | ✅ | ✅ | 238.5s | Clean. |
| 3 | `dart/task-manager` | ✅ | ✅ | 276.0s | Clean. |
| 4 | `go-flutter/bookmarks-app` | ✅ | ❌ | 2554.4s | **Real bug**: `handleList` in `server/bookmarksapi.go` appends live `*Bookmark` pointers from the map into the response slice and releases the lock before sorting/encoding, while `handleVisit` mutates the same struct under lock elsewhere — data race, caught by the hidden test's `-race` flag (`TestConcurrentVisits`), missed by 2 reviewer `clean` verdicts and 8 local quality-gate rounds (none run with `-race`). Also flagged (benign, unrelated): `artifact-guard` caught 2 untracked Dart toolchain-cache files >1MB at settle time — tooling exhaust, not model-authored, excluded from this repo copy. **Rerun at `medium` thinking produced the correct fix but the harness still recorded it as failed — see "Follow-up" section below.** |
| 5 | `dart/sequential-runner` | ✅ | ✅ | 1320.9s | Passed clean this run — no stall, no backstop/intercept trace events. Another data point for this fixture's documented run-to-run variance (compare its stall history in `pi-harness-history.md`). |
| 6 | `dart/notes-app` | ✅ | ✅ | 1389.4s | Clean, but slow — largest evidence trace of the non-failing pairs (3.9MB `pi-output.jsonl`, comparable to pair 1). |
| 7 | `go/lru-cache` | ✅ | ❌ | 272.4s | **Recurrence of the well-documented key/value-confusion eviction bug**: `lru.go`'s eviction path deletes by `oldest.Value.(int)` (the cache value) instead of the map key — `delete(c.data, oldest.Value.(int))`. `TestEvictsByKeyNotValue` fails. The reviewer correctly flagged this twice (`blocked`, `blocked`) but the model settled without applying the fix — same failure shape as documented multiple times earlier in this investigation (see `pi-harness-history.md`'s `go/lru-cache` entries). **Rerun 2/2 clean with reasoning enabled — see "Follow-up" section below.** |
| 8 | `go/lru-cache` | ✅ | ✅ | 131.7s | Clean — same task as pair 7, different arm-order position in the schedule, no bug this time. |
| 9 | `go/notes-api` | ✅ | ✅ | 167.2s | Clean. |

**9/9 valid, 7/9 passed.** No stall-guard backstop or intercept activity in
any pair (`grep`-confirmed across all `pi-output.jsonl` evidence files
would show `pi-stall-trace`/`pi-harness-trace` entries with
`stallBackstop`/`stallTimeout` if any had fired — none did here); both
failures are genuine correctness gaps the model shipped past its own
verification, not harness-mechanism issues.

## Follow-up: pair 7 thinking-on trials, same day

Pair 7's failure above ran with reasoning disabled — `run_screening.py`'s
`arm_command()` hardcodes `--thinking off` for every battery run, which
this whole 9-pair battery inherited unmodified. Given pair 7's failure was
exactly the key/value-confusion eviction bug this investigation has
repeatedly linked to reasoning being off, `arm_command()` gained a
`PI_EVAL_THINKING_LEVEL` env override (defaults to `"off"`, unchanged for
every normal call) and pair 7's harness arm was rerun twice with
`PI_EVAL_THINKING_LEVEL=xhigh`:

| Run | Reasoning | Result | Time | Eviction line |
|---|---|:---:|---:|---|
| Original (table above) | off | ❌ failed | 272.4s | `delete(c.data, oldest.Value.(int))` (bug) |
| `pair7-xhigh-trial1` | xhigh | ✅ passed | 358.5s | `delete(c.data, oldest)` (correct) |
| `pair7-xhigh-trial2` | xhigh | ✅ passed | 436.7s | `delete(c.data, oldest)` (correct) |

**Reasoning was verified as actually active**, not a silent no-op from
Qwen3.8 having no `thinkingLevelMap` entry in Pi's model registry (a real,
open gap — see [pi#6951](https://github.com/earendil-works/pi/issues/6951)):
both trials' `pi-output.jsonl` contain real `{"type": "thinking", ...}`
content blocks in the message stream (16 blocks / 13,714 chars in trial 1),
versus zero in the original off run. Because Pi has no level mapping for
this model, `xhigh` and any other non-`off` value produce an identical
`enable_thinking: true` request — the model then reasons at its own
chat-template default, which is `xhigh` by default per Qwen3.8's own docs.
So this trial establishes "reasoning on vs. off," not a genuine dial
between medium/high/xhigh.

n=2 clean passes isn't proof against this task's known run-to-run
variance (pair 8, also reasoning-off, passed clean in the same battery)
— but 2/2 passes on the exact bug class this investigation keeps flagging,
consistent with the earlier `defaultThinkingLevel` finding (0/4 → 3/3 after
enabling thinking on this same task), is a real positive signal. Cost:
~1.3-1.6x wall time per run from the added reasoning tokens, and much
larger session traces (29-37MB vs. ~3MB for the reasoning-off run) from
streamed per-token thinking deltas.

**Open question, not resolved by this trial**: whether `run_screening.py`'s
hardcoded `--thinking off` should change for future battery runs. Not
changed here — the override is opt-in via env var, default behavior is
unchanged.

## Follow-up: pair 4 rerun at `medium` thinking, same day

Pair 4's failure above ran with reasoning disabled, same as every pair in
this battery. `run_screening.py`/`run_single_arm.py` gained real per-pair
thinking control (`ScheduledPair.thinking_level`, a
`--thinking-override PAIR=LEVEL` flag on `run_screening.py`, and a
`--thinking`/`--timeout-minutes` override on `run_single_arm.py`) and pair
4's harness arm was rerun once at `--thinking medium` with a 90-minute
timeout ceiling (the stock 45-minute budget had no headroom left — the
`off` run above already used 42.6 of it).

**Result: the fix was correct, but the harness recorded it as failed for
an unrelated reason.**

- By ~24 minutes in, `handleList` had been rewritten to copy each
  `Bookmark` value into the response slice while still holding the lock
  (`list = append(list, *bm)` inside `s.mu.Lock()`/`Unlock()`) — the
  correct fix for the race. Verified directly: `go test -race ./...`
  reported `ok bookmarksapi 1.411s` (no `FAIL`, no `DATA RACE`), all 37
  Dart tests passed.
- After the fix was already complete, the model ran a manual smoke test —
  `go run /tmp/bm_main.go 2>&1 | head -3`, where `bm_main.go` calls
  `http.ListenAndServe(...)`, a call that never returns and never prints.
  Piped through `head -3`, the shell call hung indefinitely. This burned
  the remaining ~83 minutes with zero further progress until the outer
  `--timeout-minutes 90` kill (`pi_exit: 124`) finally reaped it.
- `progress-stall-guard.ts` correctly *detected* this exact pattern — its
  `SCRATCH_EXECUTION_PATTERNS` regex matches `go run /tmp/...` — and its
  independent wall-clock timer fired a soft backstop at the 12-minute mark
  (`stallElapsedMs: 723021` in the session trace). The model's own
  `thinking` block dismissed it as "a false positive — I'm in the middle
  of a task" (reasonably, since it was) and continued, before hitting the
  actual unrecoverable hang a few rounds later.
  **Correction to this section's first pass**: this is *not* the
  `PI_STALL_GUARD_INTERCEPT` gap. **Second correction (Opus review,
  2026-08-20)**: that env var gates *both* the streak intercept
  (`ACTION_SAME_FAILURE_THRESHOLDS`) and the cycle-detection intercept, not
  cycle-detection alone as the first correction said — doesn't change this
  section's conclusion, since neither intercept is what's at issue here;
  the **wall-clock hard backstop** — the mechanism meant to
  catch exactly this single-hung-tool-call case — calls `ctx.abort()`
  unconditionally, independent of that env var, default-on 20 minutes past
  the last source edit. The last real edit landed ~22:29:43 UTC; the
  process wasn't killed until ~70 minutes later (the outer 90-minute
  subprocess timeout) — 3x past the hard threshold, no `stall-timeout`
  trace event ever appeared. So the real finding is an **always-on
  backstop silently failing to fire**, not an opt-in one being left off.
  `isIdle()` misclassification was checked and ruled out (pi's
  `agent-session.js` defines it as `!_isAgentRunActive`, which stays
  `false` throughout an in-flight tool call). **Root cause found and
  fixed, same day**: `agent_end` fires per internal agent loop (retry,
  auto-compaction, queued continuation), not once per invocation, so it
  could stop the timer well before the run was over; `startTimer()` was
  gated to only the true first `agent_start`, so the first such `agent_end`
  permanently killed the timer for the rest of the session. Fixed in
  `progress-stall-guard.ts` (`startTimer()` now runs unconditionally on
  every `agent_start`, idempotently) with a regression test that fails
  against the old code and passes against the fix. Confirmed directly
  against this pair's own `pi-output.jsonl`, not just plausible from the
  mechanism: exactly `agent_start`/`agent_end`/`agent_start` appear, no
  further `agent_end`, in an 8421-event run — the timer died at that
  `agent_end` and never restarted, matching the fix's premise exactly. An
  Opus review of the first-pass fix caught two further issues (a
  retry-boundary state-reset regression the fix itself introduced, and a
  narrower version of the same coverage gap from stopping on `agent_end`
  instead of the genuinely-once `agent_settled`), both fixed same day. See
  `pi-harness-history.md`'s matching entry and `progress-stall-guard.ts`'s
  file header ("Bug 5") for full detail.

A planned `xhigh` follow-up (same task, mirroring the pair-7 precedent)
was launched, then deliberately killed at ~2 minutes in once the `medium`
result was understood — it couldn't test anything `medium` hadn't already
answered (the race was already fixed), and risked reproducing the same
non-reasoning stall for another ~75-minute budget. No code changes, no
artifact retained from that attempt.

**Verdict**: pair 4's race is fixable at `medium` thinking with no vendor
sampling-preset changes needed; the battery's pair-4 failure above was not
a thinking-level problem — it was `progress-stall-guard.ts`'s wall-clock
hard backstop dying after the first internal `agent_end`, now fixed. Full
working tree and evidence (including the 33MB `pi-output.jsonl` and full
session trace) in `pair4-medium-rerun/`. Full narrative:
`pi-harness-history.md`'s matching 2026-08-19 entry.

## Follow-up: pair 4 rerun again post-fix, same day

After the `progress-stall-guard.ts` timer fix (and its two Opus-review
follow-ups) landed, pair 4's harness arm was rerun a third time at
`--thinking medium` — same task, same seed, against the fixed extension
(confirmed live: the installed `~/.pi/agent/extensions/progress-stall-guard.ts`
symlink resolves to the patched file, matching `md5` with the repo copy)
and the task fixture's stock budget, now raised 45 → 75 minutes
(`local-model-bench` commit `44877d2`, done as part of the same hardening
pass).

**Result: clean pass.** `valid: true, passed: true, timed_out: false,
pi_exit: 0`, 1779.4s (29.7 min) — well inside the 75-minute budget, no
stall, no `pi-stall-trace` entry with `stalled: true`, hidden tests
(`go test -race` + `dart test`) both passed. Second independent
confirmation that `medium` thinking reliably produces the correct
`handleList`/`handleVisit` fix for this task.

**Honest caveat, not glossed over**: this run's session trace had **no**
`agent_start`/`agent_end`/`agent_settled` lifecycle events at all past the
initial start — it never hit an internal retry, auto-compaction, or
queued-continuation boundary, and never hung on anything. So it's a real
clean pass and a real "no regression" data point, but it did **not**
exercise the exact failure condition the fix addresses (an `agent_end`
mid-run, followed by a hang). That mechanism is still proven only by: (a)
the regression tests (mocked timers, verified to fail against the old
code and pass against the fix), and (b) reading the *original* incident's
own trace, which independently confirmed the exact
`agent_start`/`agent_end`/`agent_start`-with-no-further-`agent_end` shape
the fix's theory predicted. A live run that reproduces a real post-fix
hang and watches the guard successfully abort it would be stronger
evidence still, but wasn't obtained here — this was the honest result of
the attempt, not a manufactured one.

No working tree, logs, or session trace from this rerun are committed —
unlike the earlier `pair4-medium-rerun/` and `pair7-xhigh-trial1/2/`
evidence bundles in this directory (a pre-existing convention this repo
had before this finding), evidence-bundle commits going forward are
paused; this run's raw artifacts stayed local and were discarded once
this summary was written.

## Layout

Each `pairN/` contains:
- `code/` — the final working tree the hidden tests ran against, minus
  nested `.git/`, `.dart_tool/`, `build/`, `.pub-cache/`, `node_modules/`,
  and any file >1MB (toolchain build caches — regenerable, not part of
  what the model produced; see pair 4's note above for what got excluded
  there specifically).
- `evidence/` — `pi-output.jsonl` (full session/tool-call trace),
  `hidden-test-output.log`, `setup-output.log`, `pi-stderr.log`,
  `summary.json`, `results.jsonl`, `manifest.json` (model/reviewer route
  identity, Pi version, `agent-configs` revision at run time).
  `pair4-medium-rerun/evidence/` additionally has `session-trace.jsonl` —
  Pi's own on-disk session file (copied from `--session-dir`, not just
  stdout), used there to pull the `pi-stall-trace`/`thinking_level_change`
  custom events directly; not part of every pair's evidence set.

Not committed: the harness's own `/private/tmp/pi-screen-*` scratch dirs
this was copied from (ephemeral, already gone after the run).
