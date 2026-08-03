#!/usr/bin/env python3
"""Run a randomized nine-pair Pi harness screening battery.

The baseline arm is stock Pi with only the provider shim needed to reach the
local model. The harness arm is the currently installed ~/.pi/agent runtime.
Each pair uses the same hidden-test task and runs sequentially; pair order and
within-pair arm order are randomized from a recorded seed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import shutil
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PI_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PI_ROOT.parent
TASK_ROOT = REPO_ROOT.parent / "local-model-bench" / "tasks"
PROVIDER_EXTENSION = PI_ROOT / "extensions" / "ai-stack-local.ts"
INSTALLED_AGENT_DIR = Path.home() / ".pi" / "agent"
MODEL = "/Users/kanna/code/ai-stack/models/ThinkingCap-Qwen3.6-27B-MLX-8bit"
DEFAULT_SEED = 20260802

# Three difficulty strata, both primary languages, and both full-stack tasks.
# Repeats are intentional: a single result on a stochastic agent is anecdotal.
TASKS = [
    "go/lru-cache",
    "go/lru-cache",
    "dart/sequential-runner",
    "go/notes-api",
    "go/notes-api",
    "dart/task-manager",
    "dart/notes-app",
    "go-flutter/notes-app",
    "go-flutter/bookmarks-app",
]
ARMS = ("baseline", "harness")


@dataclass(frozen=True)
class ScheduledPair:
    pair: int
    task: str
    arm_order: tuple[str, str]


def run(
    args: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )


def schedule(seed: int) -> list[ScheduledPair]:
    rng = random.Random(seed)
    tasks = TASKS.copy()
    rng.shuffle(tasks)
    result: list[ScheduledPair] = []
    for index, task in enumerate(tasks, start=1):
        arms = list(ARMS)
        rng.shuffle(arms)
        result.append(ScheduledPair(index, task, (arms[0], arms[1])))
    return result


def copy_contents(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for child in source.iterdir():
        target = destination / child.name
        if child.is_dir():
            shutil.copytree(child, target, dirs_exist_ok=True)
        else:
            shutil.copy2(child, target)


def parse_usage(output: str) -> dict[str, Any] | None:
    for line in reversed(output.splitlines()):
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "agent_end":
            continue
        prompt_tokens = 0
        completion_tokens = 0
        assistant_messages = 0
        tool_calls = 0
        for message in event.get("messages", []):
            if message.get("role") != "assistant":
                continue
            assistant_messages += 1
            usage = message.get("usage") or {}
            prompt_tokens += sum(
                int(usage.get(field, 0) or 0)
                for field in ("input", "cacheRead", "cacheWrite")
            )
            completion_tokens += int(usage.get("output", 0) or 0)
            tool_calls += sum(
                1
                for content in message.get("content") or []
                if content.get("type") == "toolCall"
            )
        return {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "assistant_messages": assistant_messages,
            "tool_calls": tool_calls,
        }
    return None


def parse_traces(output: str) -> list[dict[str, Any]]:
    traces: list[dict[str, Any]] = []
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        entry = event.get("entry") or {}
        if (
            event.get("type") == "entry_appended"
            and entry.get("customType") == "pi-harness-trace"
        ):
            traces.append(entry.get("data") or {})
    return traces


def path_digest(path: Path) -> str | None:
    if not path.exists() and not path.is_symlink():
        return None
    digest = hashlib.sha256()
    resolved = path.resolve()
    if resolved.is_file():
        digest.update(resolved.read_bytes())
        return digest.hexdigest()
    for child in sorted(item for item in resolved.rglob("*") if item.is_file()):
        digest.update(str(child.relative_to(resolved)).encode())
        digest.update(b"\0")
        digest.update(child.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def installed_runtime_identity() -> dict[str, Any]:
    extensions_dir = INSTALLED_AGENT_DIR / "extensions"
    extensions = {}
    for item in sorted(extensions_dir.iterdir()):
        extensions[item.name] = {
            "resolved_path": str(item.resolve()),
            "sha256": path_digest(item),
        }
    return {
        "agent_dir": str(INSTALLED_AGENT_DIR),
        "global_instructions_sha256": path_digest(INSTALLED_AGENT_DIR / "AGENTS.md"),
        "settings_sha256": path_digest(INSTALLED_AGENT_DIR / "settings.json"),
        "skills_sha256": path_digest(INSTALLED_AGENT_DIR / "skills"),
        "extensions": extensions,
    }


def git_revision(path: Path) -> str | None:
    result = run(["git", "rev-parse", "HEAD"], cwd=path)
    return result.stdout.strip() if result.returncode == 0 else None


def model_identity(host: str) -> dict[str, Any]:
    result = run(
        ["curl", "-fsS", "--max-time", "5", f"http://{host}:8080/v1/models"]
    )
    if result.returncode != 0:
        raise RuntimeError(f"model endpoint unavailable: {result.stderr.strip()}")
    payload = json.loads(result.stdout)
    ids = [item.get("id") for item in payload.get("data", [])]
    if MODEL not in ids:
        raise RuntimeError(f"expected model {MODEL!r}; endpoint reported {ids!r}")
    return payload


def arm_command(
    arm: str, prompt: str, session_dir: Path, baseline_agent_dir: Path
) -> tuple[list[str], Path]:
    common = [
        "pi",
        "--print",
        "--mode",
        "json",
        "--provider",
        "ai-stack-local",
        "--model",
        MODEL,
        "--thinking",
        "off",
        "--session-dir",
        str(session_dir),
    ]
    if arm == "baseline":
        common.extend(
            [
                "--no-extensions",
                "-e",
                str(PROVIDER_EXTENSION),
                "--no-skills",
                "--no-prompt-templates",
            ]
        )
        return [*common, prompt], baseline_agent_dir
    if arm == "harness":
        return [*common, prompt], INSTALLED_AGENT_DIR
    raise ValueError(f"unknown arm: {arm}")


def execute_arm(
    pair: ScheduledPair,
    arm: str,
    artifact_root: Path,
    baseline_agent_dir: Path,
    host: str,
) -> dict[str, Any]:
    task_dir = TASK_ROOT / pair.task
    metadata = json.loads((task_dir / "meta.json").read_text())
    prompt = (task_dir / "spec.md").read_text()
    timeout_minutes = float(metadata.get("harness_timeout_minutes", 30))

    run_dir = Path(tempfile.mkdtemp(prefix=f"pi-screen-{pair.pair:02d}-{arm}-", dir="/tmp")).resolve()
    work_dir = run_dir / "work"
    session_dir = run_dir / "session"
    copy_contents(task_dir / "starter", work_dir)
    session_dir.mkdir()

    for command in (
        ["git", "init", "-q"],
        ["git", "add", "-A"],
        [
            "git",
            "-c",
            "user.email=bench@local",
            "-c",
            "user.name=bench",
            "commit",
            "-q",
            "-m",
            "starter",
        ],
    ):
        result = run(command, cwd=work_dir)
        if result.returncode != 0:
            raise RuntimeError(f"fixture git setup failed: {result.stderr.strip()}")

    command, agent_dir = arm_command(arm, prompt, session_dir, baseline_agent_dir)
    env = os.environ.copy()
    env["AI_STACK_HOST"] = host
    env["PI_CODING_AGENT_DIR"] = str(agent_dir)
    started = time.monotonic()
    timed_out = False
    try:
        pi_result = run(
            command,
            cwd=work_dir,
            env=env,
            timeout=timeout_minutes * 60,
        )
    except subprocess.TimeoutExpired as error:
        timed_out = True
        pi_result = subprocess.CompletedProcess(
            command,
            124,
            error.stdout or "",
            error.stderr or "",
        )
    harness_seconds = time.monotonic() - started

    (run_dir / "pi-output.jsonl").write_text(pi_result.stdout)
    (run_dir / "pi-stderr.log").write_text(pi_result.stderr)
    usage = parse_usage(pi_result.stdout)
    traces = parse_traces(pi_result.stdout)

    diff = run(["git", "diff", "--stat", "HEAD"], cwd=work_dir)
    diff_stat = diff.stdout.strip()

    setup_command = metadata.get("setup_cmd", "")
    setup_exit = 0
    setup_output = ""
    if setup_command:
        setup = run(
            ["bash", "-o", "pipefail", "-lc", setup_command],
            cwd=work_dir,
            timeout=20 * 60,
        )
        setup_exit = setup.returncode
        setup_output = setup.stdout + setup.stderr

    test_destination = work_dir / metadata.get("test_dest", ".")
    copy_contents(task_dir / "tests", test_destination)
    test_command = metadata["run_cmd"]
    tested = run(
        ["bash", "-o", "pipefail", "-lc", test_command],
        cwd=work_dir,
        timeout=20 * 60,
    )
    test_output = tested.stdout + tested.stderr
    (run_dir / "setup-output.log").write_text(setup_output)
    (run_dir / "hidden-test-output.log").write_text(test_output)

    extension_errors = sum(
        1 for line in pi_result.stderr.splitlines() if line.startswith("Extension error")
    )
    connection_error = "connection error" in (
        pi_result.stdout + pi_result.stderr
    ).lower()
    valid = (
        not timed_out
        and pi_result.returncode == 0
        and usage is not None
        and not connection_error
        and extension_errors == 0
        and setup_exit == 0
    )
    record = {
        "schema_version": 1,
        "pair": pair.pair,
        "task": pair.task,
        "arm": arm,
        "arm_position": pair.arm_order.index(arm) + 1,
        "valid": valid,
        "passed": valid and tested.returncode == 0,
        "pi_exit": pi_result.returncode,
        "timed_out": timed_out,
        "connection_error": connection_error,
        "extension_errors": extension_errors,
        "setup_exit": setup_exit,
        "hidden_test_exit": tested.returncode,
        "harness_seconds": round(harness_seconds, 3),
        "usage": usage,
        "trace_events": [
            {
                "extension": trace.get("extension"),
                "event": trace.get("event"),
                "outcome": trace.get("outcome"),
            }
            for trace in traces
        ],
        "diff_stat": diff_stat,
        "artifact_dir": str(run_dir),
    }
    with (artifact_root / "results.jsonl").open("a") as output:
        output.write(json.dumps(record, sort_keys=True) + "\n")
    return record


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--host", default=os.environ.get("AI_STACK_HOST", "192.168.1.233"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--plan", action="store_true", help="print the randomized schedule and exit")
    parser.add_argument("--max-pairs", type=int, default=len(TASKS), help="run a schedule prefix for runner validation")
    args = parser.parse_args()

    planned = schedule(args.seed)
    if args.plan:
        print(json.dumps([asdict(pair) for pair in planned], indent=2))
        return 0

    if not 1 <= args.max_pairs <= len(TASKS):
        parser.error(f"--max-pairs must be between 1 and {len(TASKS)}")
    model_payload = model_identity(args.host)
    pi_version = run(["pi", "--version"]).stdout.strip()
    if pi_version != "0.83.0":
        raise RuntimeError(f"expected Pi 0.83.0, found {pi_version!r}")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    artifact_root = (args.output or Path(tempfile.mkdtemp(prefix=f"pi-screening-{timestamp}-", dir="/tmp"))).resolve()
    artifact_root.mkdir(parents=True, exist_ok=True)
    baseline_agent_dir = artifact_root / "baseline-agent"
    baseline_agent_dir.mkdir()
    manifest = {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "seed": args.seed,
        "pi_version": pi_version,
        "agent_configs_revision": git_revision(REPO_ROOT),
        "model": MODEL,
        "model_endpoint": f"http://{args.host}:8080/v1",
        "model_response": model_payload,
        "baseline": "stock Pi; provider shim only; extensions, skills, and prompt templates disabled",
        "harness": str(INSTALLED_AGENT_DIR),
        "installed_runtime": installed_runtime_identity(),
        "security_scoring": "out of scope",
        "schedule": [asdict(pair) for pair in planned],
    }
    (artifact_root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"ARTIFACT_ROOT={artifact_root}", flush=True)

    records: list[dict[str, Any]] = []
    for pair in planned[: args.max_pairs]:
        print(
            f"PAIR={pair.pair}/9 TASK={pair.task} ORDER={','.join(pair.arm_order)}",
            flush=True,
        )
        for arm in pair.arm_order:
            record = execute_arm(
                pair, arm, artifact_root, baseline_agent_dir, args.host
            )
            records.append(record)
            print(
                f"PAIR={pair.pair} ARM={arm} VALID={record['valid']} "
                f"PASS={record['passed']} SECONDS={record['harness_seconds']}",
                flush=True,
            )

    valid_records = [record for record in records if record["valid"]]
    summary = {
        "runs_attempted": len(records),
        "valid_runs": len(valid_records),
        "invalid_runs": len(records) - len(valid_records),
        "valid_pairs": sum(
            1
            for pair in planned[: args.max_pairs]
            if sum(record["pair"] == pair.pair and record["valid"] for record in records) == 2
        ),
        "passes": {
            arm: sum(record["passed"] for record in valid_records if record["arm"] == arm)
            for arm in ARMS
        },
    }
    (artifact_root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, sort_keys=True), flush=True)
    return 0 if summary["invalid_runs"] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
