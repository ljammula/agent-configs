#!/usr/bin/env python3
"""Shared pure-logic helpers for the parity battery driver and summarizer.

Kept separate from run_parity_battery.py (which also shells out to pi via
run_screening.execute_arm) and summarize_battery.py (reporting-only) so both
can unit-test these rules without executing pi or touching the model server
-- memory-abort detection, resume/retry selection, and the raw/clean split
are all plain dict/JSONL logic with no subprocess involved.

Infrastructure aborts: the model server refused a prefill. The run's
pi-output.jsonl then contains an assistant message with
`"stopReason":"error"` and an `errorMessage` starting `insufficient memory`.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

RunKey = tuple[str, str, int]  # (task, arm, rep)


def count_memory_aborts(pi_output_path: Path) -> int:
    """Scan a run's pi-output.jsonl for infrastructure-abort events: an
    assistant message with stopReason "error" whose errorMessage starts
    with "insufficient memory" (case-insensitive). Malformed/non-JSON
    lines are skipped rather than fatal -- a single truncated line (e.g. a
    run killed mid-write) must not hide a real count on every other line.
    """
    if not pi_output_path.exists():
        return 0
    count = 0
    for line in pi_output_path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        message = event.get("message")
        if not isinstance(message, dict):
            continue
        if message.get("stopReason") != "error":
            continue
        error_message = message.get("errorMessage")
        if isinstance(error_message, str) and error_message.strip().lower().startswith("insufficient memory"):
            count += 1
    return count


def has_connection_error(pi_stdout: str, pi_stderr: str) -> bool:
    """True when pi itself failed to reach the model: an assistant message
    with stopReason "error" whose errorMessage mentions a connection error,
    or the phrase on stderr (pi's own diagnostics; model text never goes
    there). Model-written text in stdout is ignored -- a raw substring
    check over stdout marked a passing aistack-models-hide-offline run
    invalid because the model's summary said "connection error -> []"
    (2026-10-04 M1 regression battery)."""
    if "connection error" in pi_stderr.lower():
        return True
    for line in pi_stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        message = event.get("message") if isinstance(event, dict) else None
        if not isinstance(message, dict) or message.get("stopReason") != "error":
            continue
        error_message = message.get("errorMessage")
        if isinstance(error_message, str) and "connection error" in error_message.lower():
            return True
    return False


def resolve_inner_artifact_dir(run_root: Path) -> Path | None:
    """<out>/<slug>/results.jsonl's last line carries the real, ephemeral
    artifact dir (under /tmp, written by run_screening.execute_arm) that
    holds pi-output.jsonl and hidden-test-output.log. Used as a fallback
    for rows recorded before `memory_aborts` existed as a field (the real
    phase-0 battery predates it) and by the Laya triage eval, which needs
    both logs -- the driver itself never needs this, since it already has
    execute_arm's returned record (and its artifact_dir) in hand."""
    results_path = run_root / "results.jsonl"
    if not results_path.exists():
        return None
    lines = [l for l in results_path.read_text().splitlines() if l.strip()]
    if not lines:
        return None
    try:
        inner = json.loads(lines[-1])
    except json.JSONDecodeError:
        return None
    artifact_dir = inner.get("artifact_dir")
    return Path(artifact_dir) if artifact_dir else None


def resolve_pi_output_path(run_root: Path) -> Path | None:
    inner_dir = resolve_inner_artifact_dir(run_root)
    if inner_dir is None:
        return None
    candidate = inner_dir / "pi-output.jsonl"
    return candidate if candidate.exists() else None


def memory_aborts_for_row(row: dict[str, Any]) -> int:
    """The row's own `memory_aborts` field when present (every row the
    driver writes from here on); otherwise re-derive it from disk via its
    artifact_dir (<out>/<slug>), for rows recorded before this field
    existed -- e.g. the real 2026-10-04-parity-phase0 battery."""
    if row.get("memory_aborts") is not None:
        return int(row["memory_aborts"])
    artifact_dir = row.get("artifact_dir")
    if not artifact_dir:
        return 0
    pi_output = resolve_pi_output_path(Path(artifact_dir))
    return count_memory_aborts(pi_output) if pi_output else 0


def row_key(row: dict[str, Any]) -> RunKey:
    return (row["task"], row["arm"], row["rep"])


def needs_retry(row: dict[str, Any]) -> bool:
    """A row needs an automatic retry iff it's a first attempt that failed
    with a memory abort. Attempt 2 (or later, via --rerun-aborted) is
    always terminal here -- the automatic once-only retry never chains."""
    return (
        row.get("attempt", 1) == 1
        and not row.get("passed")
        and memory_aborts_for_row(row) > 0
    )


def load_latest_attempts(results_path: Path) -> dict[RunKey, dict[str, Any]]:
    """The latest-attempt row recorded per (task, arm, rep), scanning the
    whole file in order so a later attempt always overrides an earlier one
    regardless of how the file was written."""
    latest: dict[RunKey, dict[str, Any]] = {}
    if not results_path.exists():
        return latest
    for line in results_path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        key = row_key(row)
        existing = latest.get(key)
        if existing is None or row.get("attempt", 1) >= existing.get("attempt", 1):
            latest[key] = row
    return latest


def done_keys(latest: dict[RunKey, dict[str, Any]]) -> set[RunKey]:
    """A (task, arm, rep) counts as done only once its latest recorded
    attempt is terminal -- i.e. does not itself still need a retry. An
    attempt-1 row that needed a retry but has no attempt-2 row yet (e.g.
    the process died between the two) is NOT done; resuming must re-enter
    at attempt 2, never re-run attempt 1."""
    return {key for key, row in latest.items() if not needs_retry(row)}


def pending_retry_keys(latest: dict[RunKey, dict[str, Any]]) -> set[RunKey]:
    """The complement of done_keys restricted to rows still needing a
    retry -- resuming one of these must start at attempt 2, not attempt 1."""
    return {key for key, row in latest.items() if needs_retry(row)}


def rerun_aborted_targets(latest: dict[RunKey, dict[str, Any]]) -> dict[RunKey, int]:
    """--rerun-aborted's selection: every (task, arm, rep) whose latest row
    has a memory abort and did not pass, mapped to the attempt number the
    rerun should record (latest attempt + 1) -- regardless of how many
    attempts already ran, unlike the automatic once-only retry."""
    targets: dict[RunKey, int] = {}
    for key, row in latest.items():
        if memory_aborts_for_row(row) > 0 and not row.get("passed"):
            targets[key] = row.get("attempt", 1) + 1
    return targets


def outcome_code(row: dict[str, Any] | None) -> str:
    """One-letter summary of a row's result for the per-task grid: P
    (passed), T (timed out), F (failed, not a timeout), or . (no row)."""
    if row is None:
        return "."
    if row.get("timed_out"):
        return "T"
    if row.get("passed"):
        return "P"
    return "F"
