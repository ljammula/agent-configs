#!/usr/bin/env python3
"""Run one paired (baseline vs. harness) battery arm-pair for a single task.

Reuses run_screening.py's actual execute_arm() and scoring/trace-parsing
code — same fixture copy-in, same hidden-test scoring, same trace format —
instead of running the full randomized nine-task schedule. Use this to
recheck one specific pair (e.g. pair 4, go-flutter/bookmarks-app) without
re-spending hours re-running the other eight tasks' already-solid evidence.

Replicates run_screening.py main()'s full preflight (model identity check,
pinned pi version, isolated baseline_agent_dir, runtime manifest) plus one
addition run_screening.py itself doesn't do: a reviewer-route check, since
this script exists specifically to check whether cross-model-review.ts's
reviewer fires under real battery methodology.

Usage:
    python3 run_single_pair.py --seed 20260802 --pair 4 \
        [--arm-order baseline,harness] [--host kannasmacstudio.lan] [--output DIR]
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from run_screening import (
    ARMS,
    REPO_ROOT,
    execute_arm,
    git_revision,
    installed_runtime_identity,
    model_identity,
    run,
    schedule,
)


def check_reviewer_route() -> dict:
    base_url = os.environ.get("AI_REVIEW_BASE_URL")
    model = os.environ.get("AI_REVIEW_MODEL")
    if not base_url or not model:
        raise RuntimeError("AI_REVIEW_BASE_URL/AI_REVIEW_MODEL not set in the environment")
    result = run(["curl", "-fsS", "--max-time", "5", f"{base_url}/models"])
    if result.returncode != 0:
        raise RuntimeError(f"reviewer route unreachable: {result.stderr.strip()}")
    payload = json.loads(result.stdout)
    ids = [item.get("id") for item in payload.get("data", [])]
    if model not in ids:
        raise RuntimeError(f"AI_REVIEW_MODEL {model!r} not served by {base_url}; found {ids!r}")
    return {"base_url": base_url, "model": model, "response": payload}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--pair", type=int, required=True, help="1-indexed pair number from the seeded schedule")
    parser.add_argument("--host", default=os.environ.get("AI_STACK_HOST", "127.0.0.1"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    planned = schedule(args.seed)
    matches = [p for p in planned if p.pair == args.pair]
    if not matches:
        parser.error(f"pair {args.pair} not found in schedule for seed {args.seed} (1..{len(planned)})")
    pair = matches[0]

    reviewer = check_reviewer_route()
    model_payload = model_identity(args.host)
    pi_version = run(["pi", "--version"]).stdout.strip()
    if pi_version != "0.84.2":
        raise RuntimeError(f"expected Pi 0.84.2, found {pi_version!r}")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    artifact_root = (args.output or Path(tempfile.mkdtemp(prefix=f"pi-pair-{timestamp}-", dir="/tmp"))).resolve()
    artifact_root.mkdir(parents=True, exist_ok=True)
    baseline_agent_dir = artifact_root / "baseline-agent"
    baseline_agent_dir.mkdir()

    manifest = {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "seed": args.seed,
        "pair": pair.pair,
        "task": pair.task,
        "arm_order": list(pair.arm_order),
        "pi_version": pi_version,
        "agent_configs_revision": git_revision(REPO_ROOT),
        "model_endpoint": f"http://{args.host}:8080/v1",
        "model_response": model_payload,
        "reviewer_route": reviewer,
        "installed_runtime": installed_runtime_identity(),
    }
    (artifact_root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"ARTIFACT_ROOT={artifact_root}", flush=True)
    print(f"PAIR={pair.pair} TASK={pair.task} ORDER={','.join(pair.arm_order)}", flush=True)

    records = []
    for arm in pair.arm_order:
        record = execute_arm(pair, arm, artifact_root, baseline_agent_dir, args.host)
        records.append(record)
        print(
            f"PAIR={pair.pair} ARM={arm} VALID={record['valid']} "
            f"PASS={record['passed']} SECONDS={record['harness_seconds']}",
            flush=True,
        )

    valid_records = [r for r in records if r["valid"]]
    summary = {
        "runs_attempted": len(records),
        "valid_runs": len(valid_records),
        "invalid_runs": len(records) - len(valid_records),
        "passes": {arm: sum(r["passed"] for r in valid_records if r["arm"] == arm) for arm in ARMS},
        "reviewer_traces": [
            {"arm": r["arm"], **t}
            for r in records
            for t in r["trace_events"]
            if t.get("extension") == "reviewer"
        ],
    }
    (artifact_root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2, sort_keys=True), flush=True)
    return 0 if summary["invalid_runs"] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
