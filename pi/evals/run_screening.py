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
# Swapped 2026-08-21: :8080 now serves the mtplx runtime's
# Qwen3.8-27B-MTPLX-Optimized-Quality, not the prior dedicated 8-bit mlx-vlm
# instance -- see local-ai-stack.md's ":8080 swap to mtplx" section.
# AI_STACK_MODEL_ID overrides (must match extensions/ai-stack-local.ts).
MODEL = os.environ.get(
    "AI_STACK_MODEL_ID", "/Users/kanna/code/ai-stack/models/Qwen3.8-27B-MTPLX-Optimized-Quality"
)
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

# Per-task default --thinking level, applied when neither --thinking nor
# --thinking-override is given explicitly. There is no task with evidence
# that reasoning should stay off, so this is not yet a real per-task dial,
# just the table this repo's own thinking-per-task decisions actually rest
# on, made explicit instead of staying implicit in scattered doc prose:
#   - go/lru-cache: direct causal evidence. 0/4 passed with reasoning off
#     (same key/value-confusion eviction bug every time); 4/4 clean with
#     reasoning on (trials 6-9, at "medium"), plus a further 2/2 in the
#     seed-20260802 battery follow-up, run and recorded specifically at
#     "xhigh" (pair7-xhigh-trial1/2) -- set to "xhigh" here to match that
#     literal evidence rather than blur it with bookmarks-app's separately
#     recorded "medium" trial; behaviorally identical either way (see the
#     thinkingLevelMap note below). See pi-harness-validation-status.md's
#     "Post-migration claude-sonnet-5 comparison" and "That hypothesis is no
#     longer untested" entries.
#   - go-flutter/bookmarks-app: direct causal evidence. The reasoning-off
#     battery run shipped a real data race (handleList/handleVisit) past 2
#     reviewer "clean" verdicts and 8 quality-gate rounds; the reasoning-on
#     rerun found and fixed it correctly, confirmed twice (pair4-medium-rerun,
#     pair4-medium-rerun2-postfix). See the seed-20260802 battery README's
#     "Follow-up: pair 4 rerun at medium thinking" section.
#   - dart/sequential-runner, go/notes-api, dart/task-manager,
#     dart/notes-app, go-flutter/notes-app: no task-specific evidence either
#     way -- these passed clean with reasoning off in the original battery,
#     but that battery predates the 2026-08-17 hardening and was never a
#     controlled comparison. Set to "medium" to match the standing
#     system-wide default (pi/settings.json's defaultThinkingLevel, the live
#     config every non-eval invocation of this harness already runs under),
#     not left on the stale eval-script-only "off" default that only ever
#     existed because run_screening.py predates that hardening decision.
#     dart/sequential-runner in particular has a well-documented stall
#     history, but every stall reproduced so far was a tool-loop/verification
#     -masking issue independent of reasoning level (now handled by
#     progress-stall-guard.ts's wall-clock backstop, not by thinking level) --
#     there is no evidence reasoning makes it better or worse, so it follows
#     the same default as everything else rather than a special-cased "off".
# Correction (2026-08-20): the line that used to be here claimed "medium"/
# "xhigh" collapse to an identical request (no thinkingLevelMap entry for
# Qwen3.8, pi#6951) -- traced against the installed package source and
# found false for this repo's setup. ai-stack-local.ts's custom Qwen3.8
# registration declares its own thinkingLevelMap ({low, medium, xhigh}),
# which pi-ai's "qwen" thinkingFormat branch (openai-completions.js:571-576)
# does read: enable_thinking collapses to true for any non-"off" level, but
# reasoning_effort carries the literal level through unclamped ("medium" vs
# "xhigh", not the same string) -- a real, distinct dial the local proxy
# acts on. See pi-harness-validation-status.md's "Per-task --thinking level
# table" section for the full trace and citations. pi#6951 may still be a
# real upstream gap for models relying on pi-ai's bundled catalog; it does
# not apply here since this provider is fully custom-registered.
TASK_THINKING_LEVELS: dict[str, str] = {
    "go/lru-cache": "xhigh",
    "dart/sequential-runner": "medium",
    "go/notes-api": "medium",
    "dart/task-manager": "medium",
    "dart/notes-app": "medium",
    "go-flutter/notes-app": "medium",
    "go-flutter/bookmarks-app": "medium",
}


@dataclass(frozen=True)
class ScheduledPair:
    pair: int
    task: str
    arm_order: tuple[str, str]
    thinking_level: str


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


def schedule(
    seed: int,
    skip_tasks: frozenset[str] = frozenset(),
    default_thinking: str | None = None,
    thinking_overrides: dict[int, str] | None = None,
) -> list[ScheduledPair]:
    # thinking_overrides keys are 1-based pair numbers, assigned *after*
    # shuffling below -- they target a position in the randomized schedule
    # (e.g. "rerun pair 7 with reasoning on"), not a task name, since the
    # same task can appear at a different pair number every seed. This is
    # the highest-precedence source: an explicit per-pair rerun request
    # always wins.
    #
    # default_thinking is a *forced uniform override* for the whole run
    # (e.g. --thinking off, to deliberately reproduce the legacy
    # pre-hardening baseline for comparison) -- None (the default) means
    # "no override," so each pair falls through to TASK_THINKING_LEVELS'
    # per-task default instead of one flat value for every task.
    overrides = thinking_overrides or {}
    rng = random.Random(seed)
    tasks = TASKS.copy()
    rng.shuffle(tasks)
    result: list[ScheduledPair] = []
    index = 0
    for task in tasks:
        arms = list(ARMS)
        rng.shuffle(arms)
        if task in skip_tasks:
            continue
        index += 1
        if index in overrides:
            thinking_level = overrides[index]
        elif default_thinking is not None:
            thinking_level = default_thinking
        else:
            thinking_level = TASK_THINKING_LEVELS.get(task, "medium")
        result.append(ScheduledPair(index, task, (arms[0], arms[1]), thinking_level))
    return result


def remove_prohibited_scratch_files(work_dir: Path, metadata: dict[str, Any]) -> list[str]:
    """Delete any file under work_dir matching one of the task's own
    forbidden_test_globs (meta.json), and return the paths removed.

    Exists because a model has twice now left an untracked scratch test
    file behind that its own task spec explicitly forbids creating (see
    pi-harness-validation-status.md's scratch-test/hidden-test collision
    and devcheck_test.dart findings) -- once causing a Go package-symbol
    redeclaration, once causing a Dart test-file load failure that failed
    the whole grading run despite every real hidden-test assertion
    passing. Both starter fixtures ship zero files matching these globs
    (verified directly, not assumed), so anything matching them in the
    working tree at this point -- after the model's session, before
    hidden-test injection -- is unambiguously model-authored, regardless
    of git tracked state. A no-op for any task whose meta.json doesn't
    declare forbidden_test_globs.
    """
    removed: list[str] = []
    for pattern in metadata.get("forbidden_test_globs", []):
        for match in sorted(work_dir.glob(pattern)):
            if match.is_file():
                match.unlink()
                removed.append(str(match.relative_to(work_dir)))
    return removed


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


# PI_* env vars known to actually change extension behavior for a given run
# without showing up anywhere else in the manifest ("G1", Opus review
# 2026-08-20: the two most consequential recent runs -- Recommendation 1's
# live validation and the Recommendation-2 threshold-lowering attempt -- were
# each defined by exactly one of these, and neither showed up in that run's
# own manifest). An allowlist, not "every PI_* var in the environment", so
# unrelated PI_* noise (an operator's own shell config, say) doesn't get
# captured as if it were part of the experiment; extend this list when a new
# override earns the same "this changes what ran" status. Sourced by
# grepping every `process.env.PI_*` read across pi/extensions/*.ts, not
# guessed -- PI_HARNESS_TIMEOUT_MINUTES (wall-clock-budget-nudge.ts) and
# PI_ALLOW_EXTERNAL_EFFECTS (external-effects.ts) added 2026-08-20 per a
# Codex PR #21 review that caught this list only covering the three vars
# from the Recommendation 1/2 trials, not every installed extension's own
# behavior-changing override.
ENV_OVERRIDE_ALLOWLIST = (
    "PI_STALL_GUARD_BACKSTOP_MINUTES",
    "PI_STALL_GUARD_INTERCEPT",
    "PI_EVAL_THINKING_LEVEL",
    "PI_HARNESS_TIMEOUT_MINUTES",
    "PI_ALLOW_EXTERNAL_EFFECTS",
)


def env_override_snapshot() -> dict[str, str]:
    return {name: os.environ[name] for name in ENV_OVERRIDE_ALLOWLIST if name in os.environ}


def extensions_dir_diff() -> str | None:
    # Env vars captured above change *behavior*; an uncommitted edit changes
    # the *code* -- same "this run's manifest doesn't describe what actually
    # ran" gap G1 flagged, for the other way a run can silently diverge from
    # its recorded agent_configs_revision (the 2026-08-19 Recommendation-2
    # trial's temporarily-lowered thresholds being the concrete precedent).
    # Scoped to extensions/ specifically, not the whole repo -- a dirty
    # working tree elsewhere (docs, this very script) doesn't change what the
    # harness run itself executed.
    #
    # Diffs against HEAD (not a bare `git diff`) so staged-but-uncommitted
    # changes are captured too, and separately lists untracked files under
    # extensions/ with their full content -- a bare `git diff` covers
    # neither case, so a newly added, not-yet-`git add`-ed extension file
    # used to silently produce a null diff here while agent_configs_revision
    # still pointed at code that didn't match what ran (Codex PR #21 review,
    # 2026-08-20).
    tracked = run(["git", "diff", "HEAD", "--", "extensions"], cwd=PI_ROOT)
    if tracked.returncode != 0:
        return None
    parts = [tracked.stdout] if tracked.stdout.strip() else []
    untracked = run(
        ["git", "ls-files", "--others", "--exclude-standard", "--", "extensions"],
        cwd=PI_ROOT,
    )
    if untracked.returncode == 0:
        for rel_path in untracked.stdout.splitlines():
            if not rel_path:
                continue
            try:
                content = (PI_ROOT / rel_path).read_text()
            except OSError as error:
                content = f"<unreadable: {error}>"
            parts.append(f"--- untracked: {rel_path} ---\n{content}")
    combined = "\n".join(parts)
    return combined if combined.strip() else None


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
        "env_overrides": env_override_snapshot(),
        "extensions_dir_dirty_diff": extensions_dir_diff(),
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
    arm: str, prompt: str, session_dir: Path, baseline_agent_dir: Path, thinking_level: str
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
        thinking_level,
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
    timeout_minutes_override: float | None = None,
) -> dict[str, Any]:
    task_dir = TASK_ROOT / pair.task
    metadata = json.loads((task_dir / "meta.json").read_text())
    prompt = (task_dir / "spec.md").read_text()
    # Override exists for ad-hoc reruns at a higher thinking level, where the
    # fixture's stock budget (sized for --thinking off) may not leave enough
    # headroom -- see run_single_arm.py's --timeout-minutes. Absent an
    # override, behavior is unchanged from the fixture's own metadata.
    timeout_minutes = (
        timeout_minutes_override
        if timeout_minutes_override is not None
        else float(metadata.get("harness_timeout_minutes", 30))
    )

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

    command, agent_dir = arm_command(
        arm, prompt, session_dir, baseline_agent_dir, pair.thinking_level
    )
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
        # TimeoutExpired.stdout/.stderr are captured as raw bytes even though
        # text=True was passed to subprocess.run() -- only the normal
        # CompletedProcess return path decodes them. Decode here so the later
        # Path.write_text(), JSON parsing, and string concatenation on
        # pi_result.stdout/.stderr don't raise TypeError on a timed-out arm.
        pi_result = subprocess.CompletedProcess(
            command,
            124,
            (error.stdout or b"").decode(errors="replace") if isinstance(error.stdout, bytes) else (error.stdout or ""),
            (error.stderr or b"").decode(errors="replace") if isinstance(error.stderr, bytes) else (error.stderr or ""),
        )
    harness_seconds = time.monotonic() - started

    (run_dir / "pi-output.jsonl").write_text(pi_result.stdout)
    (run_dir / "pi-stderr.log").write_text(pi_result.stderr)
    usage = parse_usage(pi_result.stdout)
    traces = parse_traces(pi_result.stdout)

    diff = run(["git", "diff", "--stat", "HEAD"], cwd=work_dir)
    diff_stat = diff.stdout.strip()

    removed_prohibited_scratch_files = remove_prohibited_scratch_files(work_dir, metadata)

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
        "schema_version": 2,
        "pair": pair.pair,
        "task": pair.task,
        "arm": arm,
        "arm_position": pair.arm_order.index(arm) + 1,
        "thinking_level": pair.thinking_level,
        "valid": valid,
        "passed": valid and tested.returncode == 0,
        "pi_exit": pi_result.returncode,
        "timed_out": timed_out,
        "connection_error": connection_error,
        "extension_errors": extension_errors,
        "setup_exit": setup_exit,
        "hidden_test_exit": tested.returncode,
        "harness_seconds": round(harness_seconds, 3),
        "timeout_minutes": timeout_minutes,
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
        "removed_prohibited_scratch_files": removed_prohibited_scratch_files,
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
    parser.add_argument("--max-pairs", type=int, default=None, help="run a schedule prefix for runner validation")
    parser.add_argument(
        "--skip-task",
        action="append",
        default=[],
        help="task id (e.g. go/lru-cache) to omit from the schedule; repeatable. "
        "Use for tasks with existing, separately-recorded evidence at the current "
        "runtime config so they aren't re-run from scratch.",
    )
    parser.add_argument(
        "--thinking",
        default=os.environ.get("PI_EVAL_THINKING_LEVEL"),
        help="force this --thinking level uniformly on every scheduled pair, "
        "ignoring TASK_THINKING_LEVELS; overridden per-pair by "
        "--thinking-override. Defaults to $PI_EVAL_THINKING_LEVEL, or unset "
        "(each pair uses its task's entry in TASK_THINKING_LEVELS instead of "
        "one flat value). Pass e.g. --thinking off to deliberately reproduce "
        "the legacy pre-2026-08-17 baseline for comparison.",
    )
    parser.add_argument(
        "--thinking-override",
        action="append",
        default=[],
        metavar="PAIR=LEVEL",
        help="per-pair thinking-level override, e.g. --thinking-override 7=xhigh; "
        "repeatable. PAIR is the 1-based position in the randomized schedule "
        "(printed by --plan), not a task name -- the same task lands at a "
        "different pair number under a different seed.",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="continue an interrupted run found at --output: reuse its manifest's "
        "seed and skipped tasks (ignoring --seed/--skip-task), and skip any "
        "(pair, arm) that already has a valid record in its results.jsonl instead "
        "of re-running or duplicating it.",
    )
    args = parser.parse_args()

    resumed_valid: set[tuple[int, str]] = set()
    if args.resume:
        if args.output is None:
            parser.error("--resume requires --output pointing at the run to continue")
        manifest_path = args.output / "manifest.json"
        results_path = args.output / "results.jsonl"
        if not manifest_path.exists():
            parser.error(f"--resume found no manifest at {manifest_path}")
        prior_manifest = json.loads(manifest_path.read_text())
        args.seed = prior_manifest["seed"]
        skip_tasks = frozenset(prior_manifest.get("skipped_tasks", []))
        # Ignore --thinking/--thinking-override too on resume, same rationale
        # as seed/skip-task above: a resumed run must reproduce the exact
        # schedule (including per-pair thinking levels) it started with.
        args.thinking = prior_manifest.get("default_thinking", args.thinking)
        thinking_overrides = {
            int(pair): level
            for pair, level in prior_manifest.get("thinking_overrides", {}).items()
        }
        if results_path.exists():
            for line in results_path.read_text().splitlines():
                record = json.loads(line)
                if record["valid"]:
                    resumed_valid.add((record["pair"], record["arm"]))
    else:
        skip_tasks = frozenset(args.skip_task)
        unknown_skips = skip_tasks - frozenset(TASKS)
        if unknown_skips:
            parser.error(f"--skip-task not in TASKS: {sorted(unknown_skips)}")
        thinking_overrides = {}
        for entry in args.thinking_override:
            pair_str, _, level = entry.partition("=")
            if not level or not pair_str.isdigit():
                parser.error(
                    f"--thinking-override must be PAIR=LEVEL with PAIR numeric, got {entry!r}"
                )
            thinking_overrides[int(pair_str)] = level

    planned = schedule(args.seed, skip_tasks, args.thinking, thinking_overrides)
    if args.max_pairs is None:
        args.max_pairs = len(planned)
    if args.plan:
        print(json.dumps([asdict(pair) for pair in planned], indent=2))
        return 0

    if not planned:
        parser.error("--skip-task removed every scheduled pair")
    if not 1 <= args.max_pairs <= len(planned):
        parser.error(f"--max-pairs must be between 1 and {len(planned)}")
    model_payload = model_identity(args.host)
    pi_version = run(["pi", "--version"]).stdout.strip()
    if pi_version != "0.84.2":
        raise RuntimeError(f"expected Pi 0.84.2, found {pi_version!r}")

    if args.resume:
        artifact_root = args.output.resolve()
        baseline_agent_dir = artifact_root / "baseline-agent"
        print(
            f"ARTIFACT_ROOT={artifact_root} RESUMED valid_so_far={len(resumed_valid)}",
            flush=True,
        )
    else:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        artifact_root = (args.output or Path(tempfile.mkdtemp(prefix=f"pi-screening-{timestamp}-", dir="/tmp"))).resolve()
        artifact_root.mkdir(parents=True, exist_ok=True)
        baseline_agent_dir = artifact_root / "baseline-agent"
        baseline_agent_dir.mkdir()
        manifest = {
            "schema_version": 2,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "seed": args.seed,
            "skipped_tasks": sorted(skip_tasks),
            "default_thinking": args.thinking,
            "thinking_overrides": {str(k): v for k, v in thinking_overrides.items()},
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
            f"PAIR={pair.pair}/{len(planned)} TASK={pair.task} ORDER={','.join(pair.arm_order)} "
            f"THINKING={pair.thinking_level}",
            flush=True,
        )
        for arm in pair.arm_order:
            if (pair.pair, arm) in resumed_valid:
                print(f"PAIR={pair.pair} ARM={arm} SKIPPED (already valid)", flush=True)
                continue
            record = execute_arm(
                pair, arm, artifact_root, baseline_agent_dir, args.host
            )
            records.append(record)
            print(
                f"PAIR={pair.pair} ARM={arm} VALID={record['valid']} "
                f"PASS={record['passed']} SECONDS={record['harness_seconds']}",
                flush=True,
            )

    # Summarize from the full results.jsonl, not just this invocation's `records`,
    # so a resumed run's summary reflects every pair/arm ever recorded for it.
    all_records = [
        json.loads(line) for line in (artifact_root / "results.jsonl").read_text().splitlines()
    ]
    valid_records = [record for record in all_records if record["valid"]]
    summary = {
        "runs_attempted": len(all_records),
        "valid_runs": len(valid_records),
        "invalid_runs": len(all_records) - len(valid_records),
        "valid_pairs": sum(
            1
            for pair in planned[: args.max_pairs]
            if sum(record["pair"] == pair.pair and record["valid"] for record in all_records) == 2
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
