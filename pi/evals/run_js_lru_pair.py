#!/usr/bin/env python3
"""Run one paired (baseline vs. harness) battery arm-pair for the
javascript/lru-cache fixture -- the task added to close Task 7 of the
2026-08-18 hardening backlog (TS/JS stack-router coverage has no live
battery evidence yet). Not part of the seeded nine-pair `schedule()`, so
this constructs a one-off `ScheduledPair` directly and reuses
`execute_arm()`, mirroring `run_single_pair.py`'s structure.

Usage:
    python3 run_js_lru_pair.py [--host kannasmacstudio.lan] [--output DIR]
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
    ScheduledPair,
    execute_arm,
    git_revision,
    installed_runtime_identity,
    model_identity,
    run,
)
from run_single_pair import check_reviewer_route


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("AI_STACK_HOST", "127.0.0.1"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    pair = ScheduledPair(pair=0, task="javascript/lru-cache", arm_order=("baseline", "harness"))

    reviewer = check_reviewer_route()
    model_payload = model_identity(args.host)
    pi_version = run(["pi", "--version"]).stdout.strip()
    if pi_version != "0.83.0":
        raise RuntimeError(f"expected Pi 0.83.0, found {pi_version!r}")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    artifact_root = (args.output or Path(tempfile.mkdtemp(prefix=f"pi-js-lru-{timestamp}-", dir="/tmp"))).resolve()
    artifact_root.mkdir(parents=True, exist_ok=True)
    baseline_agent_dir = artifact_root / "baseline-agent"
    baseline_agent_dir.mkdir()

    manifest = {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
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
    print(f"TASK={pair.task} ORDER={','.join(pair.arm_order)}", flush=True)

    records = []
    for arm in pair.arm_order:
        record = execute_arm(pair, arm, artifact_root, baseline_agent_dir, args.host)
        records.append(record)
        print(
            f"ARM={arm} VALID={record['valid']} PASS={record['passed']} SECONDS={record['harness_seconds']}",
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
        "records": records,
    }
    (artifact_root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({k: v for k, v in summary.items() if k != "records"}, indent=2, sort_keys=True), flush=True)
    return 0 if summary["invalid_runs"] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
