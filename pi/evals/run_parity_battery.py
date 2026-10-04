#!/usr/bin/env python3
"""Phase-0 parity battery: stock pi vs the current harness, n reps per task.

Plan: plans/sonnet-parity-deterministic-pipeline-plan-2026-10-03.md, §5/§6
(arms d = stock pi "baseline", e = current harness "harness"). Reuses
run_screening.execute_arm unchanged, so each record is comparable with
every earlier battery. Tasks are any directories under local-model-bench/
tasks (the 7 bench tasks plus tasks/real/*, built by
local-model-bench/scripts/build_real_task.py).

Order is interleaved (rep -> task -> arm, arms alternating first) so a
slow-down or outage mid-night hits both arms alike. Resumable: a
(task, arm, rep) already present in results.jsonl is skipped -- more
precisely, skipped once its *latest attempt* is terminal (see
battery_lib.done_keys).

Infrastructure aborts: the model server refused a prefill mid-run. Each
run's pi-output.jsonl is scanned for this (battery_lib.count_memory_aborts)
and the count recorded as `memory_aborts` on the row. A run that aborted
this way and did not pass is retried automatically, once, recording a
second row with `attempt: 2` (the first row stays `attempt: 1`). Already
settled runs with a leftover memory abort can be re-run after the fact with
--rerun-aborted.

Usage:
  python3 run_parity_battery.py --out battery-results/2026-10-04-parity-phase0 \
      [--reps 3] [--tasks go/lru-cache real/sf-sandbox-group-zero ...] [--host 127.0.0.1]
  python3 run_parity_battery.py --out battery-results/2026-10-04-parity-phase0 --rerun-aborted
Requires AI_REVIEW_BASE_URL / AI_REVIEW_MODEL for the harness arm's reviewer.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from run_screening import TASK_ROOT, TASK_THINKING_LEVELS, ScheduledPair, execute_arm  # noqa: E402
import battery_lib  # noqa: E402

BENCH_TASKS = [
    "go/lru-cache", "go/notes-api", "dart/sequential-runner", "dart/task-manager",
    "dart/notes-app", "go-flutter/notes-app", "go-flutter/bookmarks-app",
]


def default_tasks() -> list[str]:
    real = sorted(f"real/{p.name}" for p in (TASK_ROOT / "real").iterdir() if (p / "meta.json").exists())
    return BENCH_TASKS + real


def run_one_attempt(
    out: Path, results: Path, task: str, arm: str, rep: int, attempt: int, host: str, index: int = 0,
) -> dict:
    """Execute a single (task, arm, rep) attempt via run_screening.execute_arm,
    append its row to results.jsonl, and return the row. memory_aborts is
    computed directly from execute_arm's own returned record (it already
    carries the real pi-output.jsonl location in `artifact_dir`) -- no need
    to re-read anything back off disk. `index` is purely cosmetic: it feeds
    ScheduledPair.pair, which execute_arm uses only for its tmpdir prefix
    and its own internal (inner) results.jsonl record."""
    thinking = TASK_THINKING_LEVELS.get(task, "medium")
    pair = ScheduledPair(pair=index, task=task, arm_order=(arm,), thinking_level=thinking)
    slug = f"{task.replace('/', '__')}__{arm}__rep{rep}"
    root = out / slug
    root.mkdir(parents=True, exist_ok=True)
    agent_dir = root / "baseline-agent"
    agent_dir.mkdir(exist_ok=True)
    started = time.time()
    try:
        record = execute_arm(pair, arm, root, agent_dir, host)
        error = None
    except Exception as exc:  # recorded, never silently dropped
        record, error = {}, f"{type(exc).__name__}: {exc}"[:500]

    memory_aborts = 0
    artifact_dir = record.get("artifact_dir")
    if artifact_dir:
        pi_output = Path(artifact_dir) / "pi-output.jsonl"
        memory_aborts = battery_lib.count_memory_aborts(pi_output)

    row = {
        "ts": datetime.now(timezone.utc).isoformat(), "task": task, "arm": arm, "rep": rep,
        "attempt": attempt, "thinking": thinking, "seconds": round(time.time() - started, 1),
        "valid": record.get("valid"), "passed": record.get("passed"),
        "timed_out": record.get("timed_out"), "usage": record.get("usage"), "error": error,
        "memory_aborts": memory_aborts,
        "artifact_dir": str(root),
    }
    with results.open("a") as f:
        f.write(json.dumps(row) + "\n")
    print(f"{task:40} {arm:8} rep{rep} attempt{attempt}  passed={row['passed']} valid={row['valid']} "
          f"memory_aborts={memory_aborts} {row['seconds']:.0f}s{'  ERROR ' + error if error else ''}", flush=True)
    return row


def run_with_auto_retry(
    out: Path, results: Path, task: str, arm: str, rep: int, host: str, start_attempt: int, index: int = 0,
) -> dict:
    """Run one attempt; if it was a first attempt that aborted on memory
    pressure and did not pass, retry once (attempt 2) and return that row
    instead. A resumed attempt-2-only run (start_attempt=2) never retries
    again, matching battery_lib.needs_retry's attempt==1 restriction."""
    row = run_one_attempt(out, results, task, arm, rep, start_attempt, host, index)
    if start_attempt == 1 and battery_lib.needs_retry(row):
        print(f"  -> memory abort on attempt 1, retrying {task} {arm} rep{rep}", flush=True)
        row = run_one_attempt(out, results, task, arm, rep, 2, host, index)
    return row


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--tasks", nargs="*")
    ap.add_argument("--arms", nargs="*", default=["baseline", "harness"])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument(
        "--rerun-aborted", action="store_true",
        help="re-execute every (task, arm, rep) whose latest row has memory_aborts > 0 "
        "and passed false, appending an attempt+1 row for each. Ignores --reps/--tasks/--arms.",
    )
    args = ap.parse_args()

    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    results = out / "results.jsonl"

    if args.rerun_aborted:
        latest = battery_lib.load_latest_attempts(results)
        targets = battery_lib.rerun_aborted_targets(latest)
        print(f"{len(targets)} aborted-and-failed runs to rerun", flush=True)
        for n, ((task, arm, rep), next_attempt) in enumerate(sorted(targets.items()), 1):
            print(f"[{n}/{len(targets)}] rerunning {task} {arm} rep{rep} as attempt {next_attempt}", flush=True)
            run_with_auto_retry(out, results, task, arm, rep, args.host, next_attempt, index=n)
        return 0

    tasks = args.tasks or default_tasks()
    latest = battery_lib.load_latest_attempts(results)
    done = battery_lib.done_keys(latest)
    pending_retry = battery_lib.pending_retry_keys(latest)

    plan = []
    for rep in range(1, args.reps + 1):
        for i, task in enumerate(tasks):
            arms = args.arms if (rep + i) % 2 else list(reversed(args.arms))
            plan += [(task, arm, rep) for arm in arms]
    todo = [p for p in plan if p not in done]
    print(f"{len(plan)} runs planned, {len(plan) - len(todo)} already done, {len(todo)} to go", flush=True)

    for n, (task, arm, rep) in enumerate(todo, 1):
        start_attempt = 2 if (task, arm, rep) in pending_retry else 1
        print(f"[{n}/{len(todo)}] {task} {arm} rep{rep}", flush=True)
        run_with_auto_retry(out, results, task, arm, rep, args.host, start_attempt, index=n)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
