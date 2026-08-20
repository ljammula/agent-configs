#!/usr/bin/env python3
"""Run a single arm (baseline or harness) of one seeded pair.

Same preflight and execute_arm() reuse as run_single_pair.py, but runs only
one arm instead of the full pair -- mirroring the 2026-08-17 pair-4
clean-contention rerun's precedent (baseline reused as-is since it was
already established, only the harness arm rerun). Use when the other arm's
result for this exact pair is already solid evidence and re-running it
would just cost time without adding anything.

Usage:
    python3 run_single_arm.py --seed 20260802 --pair 7 --arm harness \
        [--host kannasmacstudio.lan] [--output DIR]
"""

from __future__ import annotations

import argparse
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from dataclasses import replace

from run_screening import (
    REPO_ROOT,
    execute_arm,
    git_revision,
    installed_runtime_identity,
    model_identity,
    run,
    schedule,
)
from run_single_pair import check_reviewer_route


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--pair", type=int, required=True, help="1-indexed pair number from the seeded schedule")
    parser.add_argument("--arm", required=True, choices=("baseline", "harness"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--thinking",
        default=None,
        help="override this pair's --thinking level for this ad-hoc run "
        "(e.g. medium, xhigh); default reproduces the seeded schedule's "
        "normal level unchanged.",
    )
    parser.add_argument(
        "--timeout-minutes",
        type=float,
        default=None,
        help="override the task fixture's harness_timeout_minutes for this "
        "run. Use when raising --thinking above the fixture's normal level "
        "-- higher reasoning effort adds wall time the fixture's stock "
        "budget wasn't sized for.",
    )
    args = parser.parse_args()

    planned = schedule(args.seed)
    matches = [p for p in planned if p.pair == args.pair]
    if not matches:
        parser.error(f"pair {args.pair} not found in schedule for seed {args.seed} (1..{len(planned)})")
    pair = matches[0]
    if args.arm not in pair.arm_order:
        parser.error(f"arm {args.arm!r} not scheduled for pair {args.pair} (order: {pair.arm_order})")
    if args.thinking is not None:
        pair = replace(pair, thinking_level=args.thinking)

    reviewer = check_reviewer_route()
    model_payload = model_identity(args.host)
    pi_version = run(["pi", "--version"]).stdout.strip()
    if pi_version != "0.84.2":
        raise RuntimeError(f"expected Pi 0.84.2, found {pi_version!r}")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    artifact_root = (args.output or Path(tempfile.mkdtemp(prefix=f"pi-arm-{timestamp}-", dir="/tmp"))).resolve()
    artifact_root.mkdir(parents=True, exist_ok=True)
    baseline_agent_dir = artifact_root / "baseline-agent"
    baseline_agent_dir.mkdir()

    manifest = {
        "schema_version": 2,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "seed": args.seed,
        "pair": pair.pair,
        "task": pair.task,
        "arm_order": list(pair.arm_order),
        "arm_run": args.arm,
        "thinking_level": pair.thinking_level,
        "timeout_minutes_override": args.timeout_minutes,
        "pi_version": pi_version,
        "agent_configs_revision": git_revision(REPO_ROOT),
        "model_endpoint": f"http://{args.host}:8080/v1",
        "model_response": model_payload,
        "reviewer_route": reviewer,
        "installed_runtime": installed_runtime_identity(),
    }
    (artifact_root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"ARTIFACT_ROOT={artifact_root}", flush=True)
    print(f"PAIR={pair.pair} TASK={pair.task} ARM={args.arm}", flush=True)

    record = execute_arm(
        pair, args.arm, artifact_root, baseline_agent_dir, args.host, args.timeout_minutes
    )
    print(
        f"PAIR={pair.pair} ARM={args.arm} VALID={record['valid']} "
        f"PASS={record['passed']} SECONDS={record['harness_seconds']}",
        flush=True,
    )

    summary = {
        "runs_attempted": 1,
        "valid_runs": 1 if record["valid"] else 0,
        "invalid_runs": 0 if record["valid"] else 1,
        "reviewer_traces": [{"arm": record["arm"], **t} for t in record["trace_events"] if t.get("extension") == "reviewer"],
        "record": record,
    }
    (artifact_root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"SUMMARY={artifact_root / 'summary.json'}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
