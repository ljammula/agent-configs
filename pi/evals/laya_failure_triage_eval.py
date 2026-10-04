#!/usr/bin/env python3
"""Laya triage eval: infrastructure vs code, over every FAILED run in a real
parity battery.

Laya (https://huggingface.co/convaiinnovations/laya) is a small,
non-generative typed-decision model -- a `choice` question in, a label plus
per-option probabilities out, ~20ms warm on CPU/MPS. This script builds a
labelled set straight from a real battery's results.jsonl and hidden
artifacts (no synthetic examples), asks Laya to classify each failure, and
compares it against a trivial regex baseline.

Labelling rule, applied to every row with passed == False:
  - "infrastructure" if the run's pi-output.jsonl shows a memory abort
    (battery_lib.memory_aborts_for_row > 0) or the row timed out
    (`timed_out: true` -- i.e. the harness killed the process before the
    agent's turn finished, so there is no real verdict to read).
  - "code" otherwise (the agent finished; verification/tests genuinely
    failed).

State text, per the same rule:
  - infrastructure: the actual pi error message(s) pulled out of
    pi-output.jsonl (stopReason "error" events) when there are any;
    otherwise (a plain timeout, no model-reported error) the raw tail of
    pi-output.jsonl, since that is the most informative evidence of what
    the agent was doing when it was killed.
  - code: the tail of hidden-test-output.log, where a real test failure's
    output lives.
  Either way, truncated to the last ~2,000 chars -- long enough to carry
  the failure signal, short enough that Laya's own max_len default has
  margin.

Run with the laya venv (torch/transformers live there, not in this repo's
default Python):

  ~/code/ai-stack/.venv-laya/bin/python pi/evals/laya_failure_triage_eval.py \
      [--dir ~/code/agent-configs/pi/evals/battery-results/2026-10-04-parity-phase0]

Read-only: never writes into --dir (or anywhere else).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

EVALS_DIR = Path(__file__).resolve().parent
if str(EVALS_DIR) not in sys.path:
    sys.path.insert(0, str(EVALS_DIR))

import battery_lib  # noqa: E402

DEFAULT_DIR = Path.home() / "code" / "agent-configs" / "pi" / "evals" / "battery-results" / "2026-10-04-parity-phase0"

TAIL_CHARS = 2000
LABELS = ("infrastructure", "code")

# Trivial regex baseline, exactly as specified: any of these substrings
# anywhere in the state text means "infrastructure".
REGEX_INFRA = re.compile(r"insufficient memory|ECONNREFUSED|timed out|Killed", re.IGNORECASE)

QUESTIONS = {
    "category": {
        "type": "choice",
        "instructions": "Why did this coding-agent run fail, based on `log`?",
        "criteria": {
            "infrastructure": "network, server unreachable, out of memory, timeout, killed process",
            "code": "test assertion failed, compile error, wrong behaviour",
        },
    },
}


def load_failed_rows(results_path: Path) -> list[dict[str, Any]]:
    if not results_path.exists():
        return []
    rows = []
    for line in results_path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("passed") is False:
            rows.append(row)
    return rows


def label_row(row: dict[str, Any]) -> str:
    if battery_lib.memory_aborts_for_row(row) > 0 or row.get("timed_out"):
        return "infrastructure"
    return "code"


def pi_error_messages(pi_output_path: Path | None) -> list[str]:
    """Every assistant message's errorMessage where stopReason == "error",
    in file order -- the real, model-reported error text(s) for this run."""
    if pi_output_path is None or not pi_output_path.exists():
        return []
    messages = []
    for line in pi_output_path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        message = event.get("message")
        if not isinstance(message, dict) or message.get("stopReason") != "error":
            continue
        error_message = message.get("errorMessage")
        if isinstance(error_message, str) and error_message.strip():
            messages.append(error_message.strip())
    return messages


def state_text_for_row(row: dict[str, Any], label: str) -> tuple[str, str]:
    """Returns (tail_text, source_description)."""
    artifact_dir = row.get("artifact_dir")
    inner_dir = battery_lib.resolve_inner_artifact_dir(Path(artifact_dir)) if artifact_dir else None

    if label == "infrastructure":
        pi_output = (inner_dir / "pi-output.jsonl") if inner_dir else None
        errors = pi_error_messages(pi_output)
        if errors:
            text, source = "\n".join(errors), "pi error message(s)"
        elif pi_output is not None and pi_output.exists():
            text, source = pi_output.read_text(errors="replace"), "pi-output.jsonl tail (timed out, no model-reported error)"
        else:
            text = f"run timed_out={row.get('timed_out')!r}, memory_aborts={battery_lib.memory_aborts_for_row(row)}; no pi-output.jsonl available on disk"
            source = "synthetic (artifact no longer on disk)"
    else:
        hidden_log = (inner_dir / "hidden-test-output.log") if inner_dir else None
        if hidden_log is not None and hidden_log.exists():
            text, source = hidden_log.read_text(errors="replace"), "hidden-test-output.log"
        else:
            text = f"no hidden-test-output.log available for {row.get('task')} {row.get('arm')} rep{row.get('rep')}"
            source = "synthetic (artifact no longer on disk)"

    return text[-TAIL_CHARS:], source


def build_examples(results_path: Path) -> list[dict[str, Any]]:
    examples = []
    for row in load_failed_rows(results_path):
        label = label_row(row)
        text, source = state_text_for_row(row, label)
        examples.append({
            "task": row.get("task"), "arm": row.get("arm"), "rep": row.get("rep"),
            "attempt": row.get("attempt", 1), "label": label, "state_text": text,
            "source": source, "artifact_dir": row.get("artifact_dir"),
        })
    return examples


def regex_predict(text: str) -> str:
    return "infrastructure" if REGEX_INFRA.search(text) else "code"


def run_laya(examples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from laya import Router  # deferred: only the laya venv has this installed

    router = Router()
    rows = []
    for example in examples:
        state = {"log": example["state_text"]}
        result = router.predict(state, QUESTIONS)
        answer = result["answers"]["category"]
        rows.append({
            **example,
            "laya_choice": answer["choice"],
            "laya_confidence": answer.get("answer_confidence", answer.get("confidence")),
            "laya_probabilities": answer.get("probabilities"),
        })
    return rows


def accuracy(rows: list[dict[str, Any]], pred_key: str) -> float:
    if not rows:
        return 0.0
    correct = sum(1 for row in rows if row[pred_key] == row["label"])
    return correct / len(rows)


def confusion_matrix(rows: list[dict[str, Any]], pred_key: str) -> dict[str, dict[str, int]]:
    matrix = {actual: {pred: 0 for pred in LABELS} for actual in LABELS}
    for row in rows:
        matrix[row["label"]][row[pred_key]] += 1
    return matrix


def mean_confidence(rows: list[dict[str, Any]], pred_key: str, conf_key: str, when_correct: bool) -> float | None:
    values = [
        row[conf_key] for row in rows
        if (row[pred_key] == row["label"]) == when_correct and row.get(conf_key) is not None
    ]
    return sum(values) / len(values) if values else None


def print_matrix(matrix: dict[str, dict[str, int]]) -> None:
    corner = "actual / predicted"
    header = f"{corner:22}" + "".join(f"{label:>16}" for label in LABELS)
    print(header)
    for actual in LABELS:
        print(f"{actual:22}" + "".join(f"{matrix[actual][pred]:>16}" for pred in LABELS))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", type=Path, default=DEFAULT_DIR, help="a run_parity_battery.py --out directory")
    args = ap.parse_args()

    results_path = args.dir.resolve() / "results.jsonl"
    examples = build_examples(results_path)
    print(f"Results: {results_path}")
    print(f"Failed runs (labelled set): {len(examples)}")
    print(f"Label distribution: {dict(Counter(e['label'] for e in examples))}")
    print(f"State-text source distribution: {dict(Counter(e['source'] for e in examples))}")
    print()

    regex_rows = [{**e, "regex_choice": regex_predict(e["state_text"])} for e in examples]
    print("=== Regex baseline (insufficient memory|ECONNREFUSED|timed out|Killed) ===")
    print(f"Accuracy: {accuracy(regex_rows, 'regex_choice'):.1%} (n={len(regex_rows)})")
    print_matrix(confusion_matrix(regex_rows, "regex_choice"))
    print()

    laya_rows = run_laya(examples)
    print("=== Laya ===")
    print(f"Accuracy: {accuracy(laya_rows, 'laya_choice'):.1%} (n={len(laya_rows)})")
    print_matrix(confusion_matrix(laya_rows, "laya_choice"))
    mean_correct = mean_confidence(laya_rows, "laya_choice", "laya_confidence", True)
    mean_wrong = mean_confidence(laya_rows, "laya_choice", "laya_confidence", False)
    print(f"Mean confidence when correct: {mean_correct}")
    print(f"Mean confidence when wrong: {mean_wrong}")
    print()

    mistakes = [row for row in laya_rows if row["laya_choice"] != row["label"]]
    print(f"=== Laya mistakes ({len(mistakes)}) ===")
    for row in mistakes:
        print(
            f"- {row['task']} {row['arm']} rep{row['rep']} attempt{row['attempt']}: "
            f"actual={row['label']} predicted={row['laya_choice']} "
            f"confidence={row['laya_confidence']} source={row['source']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
