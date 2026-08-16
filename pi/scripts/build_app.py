#!/usr/bin/env python3
"""Zero-human full-stack app builder on top of the pi harness.

Give it a spec file and a workspace directory; it drives `pi -p` through
however many corrective rounds it takes to get real, current-diff-bound
verification evidence passing -- no chat interaction, no human review step.

Why this exists rather than relying on quality-gate.ts's in-session
corrective loop alone: as of pi-harness-validation-status.md, whether a
`sendUserMessage(..., {deliverAs: "followUp"})` sent from agent_settled
reliably produces a second turn under `pi -p` is *unresolved* -- an
isolated test showed it working, a real multi-turn build session showed it
not firing at all, and the difference isn't explained. This script does not
depend on that mechanism working. It treats each `pi -p` invocation as
possibly final, runs the *real* verification command itself from the
outside once pi exits, and if that fails, starts a brand new `pi -p
--continue` round with the failure as the prompt. This is the same shape as
the already-proven `PiHarness.run()` bounded-follow-up fix in
local-model-bench (commits 8531917/dfe4620), generalized from
"context-budget-exceeded" endings to "verification still failing" endings.

Usage:
    python3 build_app.py --workspace /path/to/app --spec spec.md \
        [--max-rounds 6] [--timeout-minutes 45]

--containment currently refuses to run at all (see check_containment_can_
reach_model's docstring below): its network-denied Docker profile has no
path to this machine's LAN inference service, so passing it exits
immediately with no round attempted and no BUILD_REPORT.md written --
unlike every other failure mode this script handles, which always ends in
a report. That exception is deliberate, not an oversight.

Exit code 0 only if real verification evidence passes by the round budget.
A BUILD_REPORT.md is always written to the workspace on any full run,
whether it succeeded or the round budget ran out -- the point of
zero-human is that the report, not a chat transcript, is the record of
what happened.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

PI_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PI_ROOT.parent
CONTAINMENT_DIR = PI_ROOT / "containment"
MODEL = "/Users/kanna/code/ai-stack/models/Qwen3.8-27B-8bit"

# Tried in this order against the workspace root. Mirrors
# lib/verification.ts's makefileVerificationCommand priority (verify > test >
# check) plus its per-manifest fallbacks -- kept as a small, explicit list
# here rather than re-implementing the TS resolver in Python, since this
# script only needs "good enough to gate a corrective round", not the exact
# nested-manifest scan quality-gate.ts does inside the session.
VERIFY_CANDIDATES = [
	("Makefile", "verify", "make verify"),
	("Makefile", "test", "make test"),
	("Makefile", "check", "make check"),
	("go.mod", None, "go vet ./... && go test ./..."),
	("package.json", None, "npm test"),
	("pyproject.toml", None, "pytest"),
	("pubspec.yaml", None, "dart test"),
]


def sh(args: list[str], *, cwd: Path | None = None, timeout: float | None = None, env: dict | None = None) -> subprocess.CompletedProcess:
	return subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout, check=False)


def resolve_verify_command(workspace: Path) -> str | None:
	makefile = workspace / "Makefile"
	if makefile.exists():
		lines = makefile.read_text(errors="ignore").splitlines()
		targets = {line.split(":", 1)[0].strip() for line in lines if ":" in line and not line.startswith(("\t", " ", "#"))}
		for filename, target, command in VERIFY_CANDIDATES:
			if filename != "Makefile":
				continue
			if target in targets:
				return command
	for filename, _target, command in VERIFY_CANDIDATES:
		if filename == "Makefile":
			continue
		if (workspace / filename).exists():
			return command
	return None


def redact(output: str, limit: int = 3000) -> str:
	import re

	redacted = re.sub(r"(?i)(authorization:\s*bearer\s+)\S+", r"\1<redacted>", output)
	redacted = re.sub(r"(?i)\b(password|passwd|token|secret|api[_-]?key)\s*[=:]\s*[^\s]+", r"\1=<redacted>", redacted)
	redacted = re.sub(r"://([^\s:/]+):([^\s@]+)@", r"://\1:<redacted>@", redacted)
	return redacted.strip()[-limit:]


def parse_pi_traces(output: str) -> list[dict]:
	traces = []
	for line in output.splitlines():
		try:
			event = json.loads(line)
		except json.JSONDecodeError:
			continue
		entry = event.get("entry") or {}
		if event.get("type") == "entry_appended" and entry.get("customType") == "pi-harness-trace":
			traces.append(entry.get("data") or {})
	return traces


def parse_usage(output: str) -> dict | None:
	for line in output.splitlines():
		try:
			event = json.loads(line)
		except json.JSONDecodeError:
			continue
		if event.get("type") == "agent_end" and "usage" in event:
			return event["usage"]
	return None


@dataclass
class Round:
	index: int
	command: list[str]
	pi_returncode: int
	pi_usage: dict | None
	traces: list[dict]
	verify_command: str | None
	verify_passed: bool | None
	verify_timed_out: bool
	verify_output_tail: str
	duration_s: float


@dataclass
class BuildResult:
	workspace: Path
	spec_path: Path
	rounds: list[Round] = field(default_factory=list)
	succeeded: bool = False
	stopped_reason: str = ""


def pi_invocation(workspace: Path, *, prompt: str, session_dir: Path, containment: bool, continue_session: bool) -> list[str]:
	# Deliberately excludes the "pi" executable name itself: for a direct host
	# invocation it's prepended below, but for containment run-contained.sh's
	# "$@" is forwarded to container-entrypoint.sh, which already does
	# `exec pi "$@"`. Including "pi" here too used to produce `pi pi --print
	# ...` inside the container -- an extra positional argument pi rejects.
	pi_args = [
		"--print", "--mode", "json",
		"--provider", "ai-stack-local",
		"--model", MODEL,
		"--thinking", "off",
		"--session-dir", str(session_dir),
	]
	if continue_session:
		pi_args += ["--continue"]
	pi_args += [prompt]
	if not containment:
		return ["pi", *pi_args]
	run_contained = CONTAINMENT_DIR / "run-contained.sh"
	return [str(run_contained), str(workspace), *pi_args]


def ensure_git_repo(workspace: Path) -> None:
	if sh(["git", "rev-parse", "--show-toplevel"], cwd=workspace).returncode != 0:
		sh(["git", "init"], cwd=workspace)
		gitignore = workspace / ".gitignore"
		if not gitignore.exists():
			gitignore.write_text("node_modules/\ndist/\nbuild/\n.dart_tool/\n")

	# This orchestrator's own bookkeeping -- the session transcript and the
	# report it writes after the build -- is not app source and must never
	# land in the app's own history. Written before the first pi invocation
	# so the model's own `git add -A`/commit never picks these up; appending
	# even if a project .gitignore already exists, since a fresh scaffold's
	# .gitignore has no reason to know about this script.
	gitignore = workspace / ".gitignore"
	existing = gitignore.read_text() if gitignore.exists() else ""
	needed = [line for line in (".pi-build-session/", "BUILD_REPORT.md") if line not in existing]
	if needed:
		with gitignore.open("a") as handle:
			if existing and not existing.endswith("\n"):
				handle.write("\n")
			handle.write("\n".join(needed) + "\n")


def check_containment_can_reach_model(containment: bool) -> None:
	# containment/README.md documents this plainly: run-contained.sh's
	# network-denied profile (--network=none) cannot reach this machine's LAN
	# inference service, and this script only knows how to drive pi through
	# the ai-stack-local provider. Running --containment anyway doesn't fail
	# loudly -- pi just hangs or errors deep inside a round with no network,
	# which reads as a build failure rather than the actual "this mode isn't
	# wired for inference yet" cause. Fail fast here instead, before anything
	# else runs, until a reviewed relay exists (see the README's own todo).
	if not containment:
		return
	raise SystemExit(
		"--containment cannot currently reach the ai-stack-local model: "
		"run-contained.sh's network-denied profile (--network=none) has no "
		"path to this machine's LAN inference service, and no relay/proxy "
		"provider is wired into the container yet. See pi/containment/"
		"README.md's network-denied section. Refusing to start a build that "
		"cannot produce a real agent turn."
	)


def run_build(workspace: Path, spec_path: Path, *, max_rounds: int, containment: bool, timeout_minutes: int) -> BuildResult:
	workspace.mkdir(parents=True, exist_ok=True)
	ensure_git_repo(workspace)
	session_dir = workspace / ".pi-build-session"
	spec_text = spec_path.read_text()

	result = BuildResult(workspace=workspace, spec_path=spec_path)
	env = {**os.environ, "AI_STACK_HOST": os.environ.get("AI_STACK_HOST", "127.0.0.1")}
	prompt = spec_text

	for round_index in range(1, max_rounds + 1):
		continue_session = round_index > 1
		command = pi_invocation(
			workspace, prompt=prompt, session_dir=session_dir,
			containment=containment, continue_session=continue_session,
		)
		started = time.monotonic()
		try:
			completed = sh(command, cwd=workspace, timeout=timeout_minutes * 60, env=env)
			timed_out = False
		except subprocess.TimeoutExpired:
			completed = None
			timed_out = True
		duration = time.monotonic() - started
		stdout = completed.stdout if completed else ""

		verify_command = resolve_verify_command(workspace)
		verify_passed: bool | None = None
		verify_timed_out = False
		verify_tail = ""
		if verify_command:
			try:
				verify_result = sh(["bash", "-o", "pipefail", "-lc", verify_command], cwd=workspace, timeout=20 * 60)
				verify_passed = verify_result.returncode == 0
				verify_tail = redact(f"{verify_result.stdout}\n{verify_result.stderr}")
			except subprocess.TimeoutExpired as exc:
				# Record this as a failed round instead of letting the
				# exception propagate past write_report -- the orchestrator's
				# whole point is that a BUILD_REPORT.md always gets written,
				# success or failure, so a silent crash here would be exactly
				# the failure mode this script exists to avoid.
				verify_timed_out = True
				verify_passed = False
				verify_tail = redact(
					f"verification command timed out after 20 minutes: {verify_command}\n"
					f"{(exc.stdout or b'').decode(errors='ignore') if isinstance(exc.stdout, bytes) else (exc.stdout or '')}"
				)

		pi_returncode = completed.returncode if completed else -1
		# A nonzero pi exit means the CLI itself crashed, was invoked wrong, or
		# otherwise didn't complete a real agent turn -- verify_passed alone
		# can't be trusted as evidence of *this round's* work in that case,
		# since it just reruns whatever verification command already exists in
		# the workspace and would happily report "passed" against a tree pi
		# never touched. Success requires both: pi actually ran to completion
		# (returncode 0) and the real verification command passed.
		pi_failed = (not timed_out) and pi_returncode != 0

		rnd = Round(
			index=round_index,
			command=command,
			pi_returncode=pi_returncode,
			pi_usage=parse_usage(stdout),
			traces=parse_pi_traces(stdout),
			verify_command=verify_command,
			verify_passed=verify_passed,
			verify_timed_out=verify_timed_out,
			verify_output_tail=verify_tail,
			duration_s=duration,
		)
		result.rounds.append(rnd)

		if timed_out:
			result.stopped_reason = "pi invocation timed out"
			break
		if verify_command is None:
			result.stopped_reason = "no verification command resolvable (unconfigured)"
			break
		if verify_passed and not pi_failed:
			result.succeeded = True
			result.stopped_reason = "verification passed"
			break

		# Not passing yet and rounds remain: build the corrective follow-up
		# prompt ourselves, same content quality-gate.ts's in-session message
		# has, and start a fresh --continue round on top of the same session.
		if round_index == max_rounds:
			result.stopped_reason = (
				f"round budget ({max_rounds}) exhausted, pi exited {pi_returncode} on the last round"
				if pi_failed
				else f"round budget ({max_rounds}) exhausted, verification still failing"
			)
			break
		if pi_failed:
			prompt = (
				f"The previous `pi` invocation exited with code {pi_returncode} instead of "
				f"completing normally (attempt {round_index}/{max_rounds}); no completed turn "
				"can be trusted from that round. Continue the work from wherever it left off, "
				"make the smallest fix needed, and rerun the project's real verification "
				"command yourself before finishing this turn."
			)
		else:
			prompt = (
				f"The verification command `{verify_command}` did not pass "
				f"(attempt {round_index}/{max_rounds}).\n\n"
				f"Redacted failure excerpt:\n\n{verify_tail}\n\n"
				"Inspect the failure, make the smallest fix, and rerun it yourself "
				"before finishing this turn."
			)

	return result


def review_verdicts(rounds: list[Round]) -> list[dict]:
	verdicts = []
	for rnd in rounds:
		for trace in rnd.traces:
			if trace.get("event") == "review" and trace.get("outcome") in ("clean", "flagged"):
				verdicts.append({"round": rnd.index, **trace})
	return verdicts


def write_report(result: BuildResult) -> Path:
	report_path = result.workspace / "BUILD_REPORT.md"
	lines = [
		"# Zero-human build report",
		"",
		f"Generated: {datetime.now(timezone.utc).isoformat()}",
		f"Spec: `{result.spec_path}`",
		f"Outcome: {'SUCCEEDED' if result.succeeded else 'DID NOT SUCCEED'} -- {result.stopped_reason}",
		f"Rounds run: {len(result.rounds)}",
		"",
		"## Rounds",
		"",
	]
	for rnd in result.rounds:
		lines.append(f"### Round {rnd.index}")
		lines.append(f"- pi exit code: {rnd.pi_returncode}")
		if rnd.pi_usage:
			lines.append(f"- pi usage: {json.dumps(rnd.pi_usage)}")
		lines.append(f"- verify command: `{rnd.verify_command or '(none resolved)'}`")
		verify_status = "timed out" if rnd.verify_timed_out else str(rnd.verify_passed)
		lines.append(f"- verify passed: {verify_status}")
		lines.append(f"- duration: {rnd.duration_s:.1f}s")
		trace_summary = [f"{t.get('extension')}:{t.get('event')}={t.get('outcome')}" for t in rnd.traces]
		if trace_summary:
			lines.append(f"- extension traces: {', '.join(trace_summary)}")
		if rnd.verify_passed is False and rnd.verify_output_tail:
			lines.append("")
			lines.append("```")
			lines.append(rnd.verify_output_tail)
			lines.append("```")
		lines.append("")

	verdicts = review_verdicts(result.rounds)
	lines.append("## Independent review verdicts")
	lines.append("")
	if not verdicts:
		lines.append(
			"No review verdict was recorded in any round's trace log. Either the "
			"reviewer is not configured (AI_REVIEW_BASE_URL/AI_REVIEW_MODEL), or "
			"it never got a materially non-empty diff to review. Check "
			"`.pi-build-session` session JSONL for `reviewer` traces before "
			"trusting this build unreviewed."
		)
	else:
		for verdict in verdicts:
			lines.append(f"- round {verdict['round']}: **{verdict['outcome']}** ({verdict.get('metadata', {}).get('trigger', 'unknown trigger')})")
	lines.append("")

	report_path.write_text("\n".join(lines))
	return report_path


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--workspace", required=True, type=Path)
	parser.add_argument("--spec", required=True, type=Path)
	parser.add_argument("--max-rounds", type=int, default=6)
	parser.add_argument(
		"--containment", action="store_true",
		help="Currently refused unconditionally: the Docker containment launcher's network-denied "
		"profile cannot reach the ai-stack-local model, so no round could ever run. See "
		"pi/containment/README.md.",
	)
	parser.add_argument("--timeout-minutes", type=int, default=45)
	args = parser.parse_args()
	check_containment_can_reach_model(args.containment)

	result = run_build(
		args.workspace.resolve(), args.spec.resolve(),
		max_rounds=args.max_rounds, containment=args.containment,
		timeout_minutes=args.timeout_minutes,
	)
	report_path = write_report(result)
	print(f"Report written to {report_path}")
	print(f"Outcome: {'SUCCEEDED' if result.succeeded else 'DID NOT SUCCEED'} -- {result.stopped_reason}")
	return 0 if result.succeeded else 1


if __name__ == "__main__":
	sys.exit(main())
