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
(task, arm, rep) already present in results.jsonl is skipped.

Usage:
  python3 run_parity_battery.py --out battery-results/2026-10-04-parity-phase0 \
      [--reps 3] [--tasks go/lru-cache real/sf-sandbox-group-zero ...] [--host 127.0.0.1]
Requires AI_REVIEW_BASE_URL / AI_REVIEW_MODEL for the harness arm's reviewer.
"""
from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from run_screening import TASK_ROOT, TASK_THINKING_LEVELS, ScheduledPair, execute_arm

BENCH_TASKS = [
    "go/lru-cache", "go/notes-api", "dart/sequential-runner", "dart/task-manager",
    "dart/notes-app", "go-flutter/notes-app", "go-flutter/bookmarks-app",
]


def default_tasks() -> list[str]:
    real = sorted(f"real/{p.name}" for p in (TASK_ROOT / "real").iterdir() if (p / "meta.json").exists())
    return BENCH_TASKS + real


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--tasks", nargs="*")
    ap.add_argument("--arms", nargs="*", default=["baseline", "harness"])
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    tasks = args.tasks or default_tasks()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    results = out / "results.jsonl"
    done = set()
    if results.exists():
        for line in results.read_text().splitlines():
            r = json.loads(line)
            done.add((r["task"], r["arm"], r["rep"]))

    plan = []
    for rep in range(1, args.reps + 1):
        for i, task in enumerate(tasks):
            arms = args.arms if (rep + i) % 2 else list(reversed(args.arms))
            plan += [(task, arm, rep) for arm in arms]
    todo = [p for p in plan if p not in done]
    print(f"{len(plan)} runs planned, {len(plan) - len(todo)} already done, {len(todo)} to go", flush=True)

    for n, (task, arm, rep) in enumerate(todo, 1):
        thinking = TASK_THINKING_LEVELS.get(task, "medium")
        pair = ScheduledPair(pair=n, task=task, arm_order=(arm,), thinking_level=thinking)
        slug = f"{task.replace('/', '__')}__{arm}__rep{rep}"
        root = out / slug
        root.mkdir(parents=True, exist_ok=True)
        agent_dir = root / "baseline-agent"
        agent_dir.mkdir(exist_ok=True)
        started = time.time()
        try:
            record = execute_arm(pair, arm, root, agent_dir, args.host)
            error = None
        except Exception as exc:  # recorded, never silently dropped
            record, error = {}, f"{type(exc).__name__}: {exc}"[:500]
        row = {
            "ts": datetime.now(timezone.utc).isoformat(), "task": task, "arm": arm, "rep": rep,
            "thinking": thinking, "seconds": round(time.time() - started, 1),
            "valid": record.get("valid"), "passed": record.get("passed"),
            "timed_out": record.get("timed_out"), "usage": record.get("usage"), "error": error,
            "artifact_dir": str(root),
        }
        with results.open("a") as f:
            f.write(json.dumps(row) + "\n")
        print(f"[{n}/{len(todo)}] {task:40} {arm:8} rep{rep}  passed={row['passed']} valid={row['valid']} "
              f"{row['seconds']:.0f}s{'  ERROR ' + error if error else ''}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
