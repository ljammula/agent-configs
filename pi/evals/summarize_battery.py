#!/usr/bin/env python3
"""Summarize a run_parity_battery.py results directory.

Reports two pass rates per arm:

- raw: every row ever recorded (every attempt), as-is.
- clean: the latest attempt per (task, arm, rep), excluding any row whose
  run had a memory abort (battery_lib.memory_aborts_for_row > 0) and
  excluding any task named via --exclude-task.

Also prints a per-task P/F/T grid (latest attempt per rep; P=passed,
F=failed, T=timed out, .=no row) so a reviewer can see at a glance which
tasks are driving a pass-rate gap between arms.

Read-only: never writes into --dir.

Usage:
  python3 summarize_battery.py --dir battery-results/2026-10-04-parity-phase0 \
      [--exclude-task real/pa-checklist-items ...]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import battery_lib  # noqa: E402


def raw_pass_rates(results_path: Path) -> dict[str, dict[str, int]]:
    """Every row ever recorded (every attempt), grouped by arm."""
    stats: dict[str, dict[str, int]] = {}
    if not results_path.exists():
        return stats
    for line in results_path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        arm = row.get("arm")
        bucket = stats.setdefault(arm, {"total": 0, "passed": 0})
        bucket["total"] += 1
        if row.get("passed"):
            bucket["passed"] += 1
    return stats


def clean_pass_rates(
    latest: dict[battery_lib.RunKey, dict[str, Any]], excluded_tasks: frozenset[str],
) -> dict[str, dict[str, int]]:
    """Latest attempt per (task, arm, rep), excluding memory-aborted runs
    and excluded tasks."""
    stats: dict[str, dict[str, int]] = {}
    for (task, arm, _rep), row in latest.items():
        if task in excluded_tasks:
            continue
        if battery_lib.memory_aborts_for_row(row) > 0:
            continue
        bucket = stats.setdefault(arm, {"total": 0, "passed": 0})
        bucket["total"] += 1
        if row.get("passed"):
            bucket["passed"] += 1
    return stats


def task_grid(latest: dict[battery_lib.RunKey, dict[str, Any]]) -> dict[str, dict[str, dict[int, str]]]:
    """task -> arm -> rep -> outcome_code, for the per-task P/F/T grid."""
    grid: dict[str, dict[str, dict[int, str]]] = {}
    for (task, arm, rep), row in latest.items():
        grid.setdefault(task, {}).setdefault(arm, {})[rep] = battery_lib.outcome_code(row)
    return grid


def format_rate_table(stats: dict[str, dict[str, int]]) -> str:
    lines = [f"{'arm':10} {'total':>6} {'passed':>7} {'pass_rate':>10}"]
    for arm in sorted(stats):
        bucket = stats[arm]
        rate = (bucket["passed"] / bucket["total"] * 100) if bucket["total"] else 0.0
        lines.append(f"{arm:10} {bucket['total']:>6} {bucket['passed']:>7} {rate:>9.1f}%")
    return "\n".join(lines)


def format_grid(grid: dict[str, dict[str, dict[int, str]]]) -> str:
    arms = sorted({arm for arm_map in grid.values() for arm in arm_map})
    all_reps = sorted({rep for arm_map in grid.values() for rep_map in arm_map.values() for rep in rep_map})
    header = f"{'task':40} " + " ".join(f"{arm:>{max(len(arm), len(all_reps) * 2)}}" for arm in arms)
    lines = [header]
    for task in sorted(grid):
        cells = []
        for arm in arms:
            rep_map = grid[task].get(arm, {})
            codes = "".join(rep_map.get(rep, ".") for rep in all_reps)
            cells.append(f"{codes:>{max(len(arm), len(all_reps) * 2)}}")
        lines.append(f"{task:40} " + " ".join(cells))
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", type=Path, required=True, help="a run_parity_battery.py --out directory")
    ap.add_argument(
        "--exclude-task", action="append", default=[],
        help="task id to exclude from the 'clean' pass rate and grid (repeatable)",
    )
    args = ap.parse_args()

    results_path = args.dir.resolve() / "results.jsonl"
    excluded = frozenset(args.exclude_task)

    raw = raw_pass_rates(results_path)
    latest = battery_lib.load_latest_attempts(results_path)
    clean = clean_pass_rates(latest, excluded)
    grid = task_grid(latest)

    print(f"Results: {results_path}")
    print(f"Rows (every attempt): {sum(b['total'] for b in raw.values())}")
    print(f"Latest-attempt (task, arm, rep) triples: {len(latest)}")
    if excluded:
        print(f"Excluded tasks: {', '.join(sorted(excluded))}")
    memory_aborted = sum(1 for row in latest.values() if battery_lib.memory_aborts_for_row(row) > 0)
    print(f"Latest-attempt rows with a memory abort: {memory_aborted}")
    print()
    print("=== Raw pass rates (every row, every attempt) ===")
    print(format_rate_table(raw))
    print()
    print("=== Clean pass rates (latest attempt, no memory aborts, no excluded tasks) ===")
    print(format_rate_table(clean))
    print()
    print("=== Per-task P/F/T grid (latest attempt per rep; P=passed F=failed T=timed_out .=no row) ===")
    print(format_grid(grid))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
