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
| 4 | `go-flutter/bookmarks-app` | ✅ | ❌ | 2554.4s | **Real bug**: `handleList` in `server/bookmarksapi.go` appends live `*Bookmark` pointers from the map into the response slice and releases the lock before sorting/encoding, while `handleVisit` mutates the same struct under lock elsewhere — data race, caught by the hidden test's `-race` flag (`TestConcurrentVisits`), missed by 2 reviewer `clean` verdicts and 8 local quality-gate rounds (none run with `-race`). Also flagged (benign, unrelated): `artifact-guard` caught 2 untracked Dart toolchain-cache files >1MB at settle time — tooling exhaust, not model-authored, excluded from this repo copy. |
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

Not committed: the harness's own `/private/tmp/pi-screen-*` scratch dirs
this was copied from (ephemeral, already gone after the run).
