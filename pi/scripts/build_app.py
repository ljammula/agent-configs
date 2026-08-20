#!/usr/bin/env python3
"""Zero-human full-stack app builder on top of the pi harness.

Give it a spec file and a workspace directory; it drives `pi -p` through
however many corrective rounds it takes to get real canonical verification
and independent-review evidence passing -- no chat interaction or human
review step.

Why this exists outside the extensions: `quality-gate.ts` and
`cross-model-review.ts` deliberately report settlement evidence without
injecting an in-band corrective turn. This script consumes that evidence
after each `pi -p` invocation, reruns the shared canonical verification
command, and starts a fresh `pi -p --continue` round when any required
signal fails. This is the same shape as
the already-proven `PiHarness.run()` bounded-follow-up fix in
local-model-bench (commits 8531917/dfe4620), generalized from
"context-budget-exceeded" endings to "verification still failing" endings.

Usage:
    python3 build_app.py --workspace /path/to/app --spec spec.md \
        [--max-rounds 6] [--timeout-minutes 45] [--sonnet-fallback]

The installed Pi thinking policy is inherited by default. Independent review
is required for unattended success unless `--review-policy degraded` is
chosen explicitly. `--sonnet-fallback` authorizes one billed Sonnet pass only
after the local corrective-round budget is exhausted.

--containment currently refuses to run at all (see check_containment_can_
reach_model's docstring below): its network-denied Docker profile has no
path to this machine's LAN inference service, so passing it exits
immediately with no round attempted and no BUILD_REPORT.md written --
unlike every other failure mode this script handles, which always ends in
a report. That exception is deliberate, not an oversight.

Exit code 0 only if canonical verification and the selected review policy
pass by the round budget (or an explicitly authorized Sonnet fallback passes).
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
SONNET_MODEL = "claude-sonnet-5"
VERIFY_RESOLVER = PI_ROOT / "scripts" / "resolve-verification.ts"
TSX = PI_ROOT / "node_modules" / ".bin" / "tsx"
NON_RETRYABLE_REVIEW_FAILURES = {
	"missing-configuration",
	"invalid-configuration",
	"same-primary",
	"no-task-spec",
}


def sh(args: list[str], *, cwd: Path | None = None, timeout: float | None = None, env: dict | None = None) -> subprocess.CompletedProcess:
	return subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout, check=False)


# Root-only fallback used when the TS resolver can't run at all -- e.g. a
# fresh checkout where `npm install` was never run (pi/node_modules is
# gitignored, tsx is a devDependency, and install.sh doesn't install it).
# Not nested-manifest aware like resolve-verification.ts; good enough to gate
# a corrective round, not a substitute for the real resolver. Found via a
# Codex PR #22 review, 2026-08-20: without this fallback, resolve_verify_command
# silently returned None on every fresh installation, so build_app.py stopped
# after its first round with "no canonical verification command resolvable"
# even against a workspace with a valid Makefile or manifest.
_FALLBACK_VERIFY_CANDIDATES = [
	("Makefile", "verify", "make verify"),
	("Makefile", "test", "make test"),
	("Makefile", "check", "make check"),
	("go.mod", None, "go vet ./... && go test ./..."),
	("package.json", None, "npm test"),
	("pyproject.toml", None, "pytest"),
	("pubspec.yaml", None, "dart test"),
]


def _resolve_verify_command_fallback(workspace: Path) -> str | None:
	makefile = workspace / "Makefile"
	if makefile.exists():
		lines = makefile.read_text(errors="ignore").splitlines()
		targets = {line.split(":", 1)[0].strip() for line in lines if ":" in line and not line.startswith(("\t", " ", "#"))}
		for filename, target, command in _FALLBACK_VERIFY_CANDIDATES:
			if filename != "Makefile":
				continue
			if target in targets:
				return command
	for filename, _target, command in _FALLBACK_VERIFY_CANDIDATES:
		if filename == "Makefile":
			continue
		if (workspace / filename).exists():
			return command
	return None


def resolve_verify_command(workspace: Path) -> str | None:
	"""Resolve through the exact TypeScript implementation used by
	quality-gate when it's available; falls back to a root-only heuristic
	scan when the TS resolver can't even run (tsx missing/erroring), rather
	than silently reporting no command exists. A clean run of the real
	resolver that itself finds nothing is trusted as-is -- that's a more
	accurate answer than the fallback's shallower scan, not a failure to
	paper over."""
	if TSX.exists():
		try:
			result = sh([str(TSX), str(VERIFY_RESOLVER), str(workspace)], cwd=PI_ROOT, timeout=30)
		except (OSError, subprocess.TimeoutExpired):
			result = None
		if result is not None and result.returncode == 0:
			try:
				command = json.loads(result.stdout).get("command")
			except (json.JSONDecodeError, AttributeError):
				command = None
			return command if isinstance(command, str) and command else None
	return _resolve_verify_command_fallback(workspace)


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
		custom_type = entry.get("customType")
		if event.get("type") == "entry_appended" and custom_type in ("pi-harness-trace", "pi-stall-trace"):
			trace = dict(entry.get("data") or {})
			trace["customType"] = custom_type
			if custom_type == "pi-stall-trace":
				trace.setdefault("extension", "progress-stall-guard")
				trace.setdefault("event", "stall")
			traces.append(trace)
	return traces


@dataclass(frozen=True)
class ReviewSignal:
	outcome: str
	detail: str = ""


def review_signal(traces: list[dict]) -> ReviewSignal:
	decisive: ReviewSignal | None = None
	startup_reason = ""
	for trace in traces:
		if trace.get("extension") != "reviewer":
			continue
		if trace.get("event") == "startup" and trace.get("outcome") == "blocked":
			startup_reason = str(trace.get("metadata", {}).get("reason") or "reviewer-disabled")
			continue
		if trace.get("event") != "review":
			continue
		outcome = str(trace.get("outcome") or "unavailable")
		metadata = trace.get("metadata") or {}
		if outcome in ("clean", "flagged"):
			decisive = ReviewSignal(outcome, str(metadata.get("findings") or ""))
		elif outcome == "blocked" and metadata.get("reason") == "unchanged-since-last-review" and decisive:
			continue
		else:
			decisive = ReviewSignal("unavailable", str(metadata.get("reason") or outcome))
	return decisive or ReviewSignal("unavailable", startup_reason or "no-review-verdict")


def round_blockers(
	*,
	verify_passed: bool | None,
	pi_failed: bool,
	pi_timed_out: bool,
	traces: list[dict],
	review_policy: str,
) -> tuple[list[str], ReviewSignal]:
	blockers: list[str] = []
	if pi_timed_out:
		blockers.append("pi invocation timed out")
	elif pi_failed:
		blockers.append("pi invocation failed")
	if any(trace.get("outcome") == "stall-timeout" or trace.get("stallTimeout") is True for trace in traces):
		blockers.append("stall-timeout")
	if verify_passed is not True:
		blockers.append("canonical verification failed")
	review = review_signal(traces)
	if review.outcome == "flagged":
		blockers.append("reviewer flagged the current diff")
	elif review.outcome != "clean" and review_policy == "required":
		blockers.append(f"review unavailable ({review.detail})")
	return blockers, review


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
	agent: str
	command: list[str]
	pi_returncode: int
	pi_timed_out: bool
	pi_usage: dict | None
	traces: list[dict]
	reviewer: ReviewSignal
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


def pi_invocation(
	workspace: Path,
	*,
	prompt: str,
	session_dir: Path,
	containment: bool,
	continue_session: bool,
	thinking: str | None,
) -> list[str]:
	# Deliberately excludes the "pi" executable name itself: for a direct host
	# invocation it's prepended below, but for containment run-contained.sh's
	# "$@" is forwarded to container-entrypoint.sh, which already does
	# `exec pi "$@"`. Including "pi" here too used to produce `pi pi --print
	# ...` inside the container -- an extra positional argument pi rejects.
	pi_args = [
		"--print", "--mode", "json",
		"--provider", "ai-stack-local",
		"--model", MODEL,
		"--session-dir", str(session_dir),
	]
	# Omit the flag by default so the installed settings.json policy applies
	# (currently medium). An explicit override remains available for controlled
	# experiments and reproductions.
	if thinking is not None:
		pi_args += ["--thinking", thinking]
	if continue_session:
		pi_args += ["--continue"]
	pi_args += [prompt]
	if not containment:
		return ["pi", *pi_args]
	run_contained = CONTAINMENT_DIR / "run-contained.sh"
	return [str(run_contained), str(workspace), *pi_args]


def sonnet_invocation(prompt: str) -> list[str]:
	return [
		"claude", "-p", prompt,
		"--model", SONNET_MODEL,
		"--permission-mode", "bypassPermissions",
		"--output-format", "json",
	]


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


def run_verification(workspace: Path) -> tuple[str | None, bool | None, bool, str]:
	command = resolve_verify_command(workspace)
	if not command:
		return None, None, False, ""
	try:
		completed = sh(["bash", "-o", "pipefail", "-lc", command], cwd=workspace, timeout=20 * 60)
		return command, completed.returncode == 0, False, redact(f"{completed.stdout}\n{completed.stderr}")
	except subprocess.TimeoutExpired as exc:
		output = (
			f"verification command timed out after 20 minutes: {command}\n"
			f"{(exc.stdout or b'').decode(errors='ignore') if isinstance(exc.stdout, bytes) else (exc.stdout or '')}"
		)
		return command, False, True, redact(output)


def corrective_prompt(
	*,
	round_index: int,
	max_rounds: int,
	verify_command: str | None,
	verify_tail: str,
	blockers: list[str],
	reviewer: ReviewSignal,
) -> str:
	parts = [
		f"The previous harness round did not earn completion (attempt {round_index}/{max_rounds}).",
		f"Blocking signals: {', '.join(blockers)}.",
	]
	if verify_command and verify_tail:
		parts += [f"Canonical command: `{verify_command}`", f"Redacted failure excerpt:\n\n{verify_tail}"]
	if reviewer.outcome == "flagged" and reviewer.detail:
		parts += [f"Independent reviewer findings:\n\n{reviewer.detail}"]
	parts.append("Inspect these concrete signals, make the smallest fix needed, and rerun the canonical verification before finishing.")
	return "\n\n".join(parts)


def parse_sonnet_usage(output: str) -> dict | None:
	try:
		payload = json.loads(output)
	except json.JSONDecodeError:
		return None
	usage = payload.get("usage")
	if not isinstance(usage, dict):
		return None
	return {**usage, "total_cost_usd": payload.get("total_cost_usd")}


def run_build(
	workspace: Path,
	spec_path: Path,
	*,
	max_rounds: int,
	containment: bool,
	timeout_minutes: int,
	thinking: str | None = None,
	review_policy: str = "required",
	sonnet_fallback: bool = False,
) -> BuildResult:
	workspace.mkdir(parents=True, exist_ok=True)
	ensure_git_repo(workspace)
	session_dir = workspace / ".pi-build-session"
	spec_text = spec_path.read_text()

	result = BuildResult(workspace=workspace, spec_path=spec_path)
	env = {**os.environ, "AI_STACK_HOST": os.environ.get("AI_STACK_HOST", "127.0.0.1")}
	prompt = spec_text
	escalation_prompt = ""

	for round_index in range(1, max_rounds + 1):
		continue_session = round_index > 1
		command = pi_invocation(
			workspace, prompt=prompt, session_dir=session_dir,
			containment=containment, continue_session=continue_session,
			thinking=thinking,
		)
		started = time.monotonic()
		try:
			completed = sh(command, cwd=workspace, timeout=timeout_minutes * 60, env=env)
			timed_out = False
		except subprocess.TimeoutExpired:
			completed = None
			timed_out = True
		except OSError as exc:
			completed = subprocess.CompletedProcess(command, 127, "", str(exc))
			timed_out = False
		duration = time.monotonic() - started
		stdout = completed.stdout if completed else ""

		verify_command, verify_passed, verify_timed_out, verify_tail = run_verification(workspace)

		pi_returncode = completed.returncode if completed else -1
		# A nonzero pi exit means the CLI itself crashed, was invoked wrong, or
		# otherwise didn't complete a real agent turn -- verify_passed alone
		# can't be trusted as evidence of *this round's* work in that case,
		# since it just reruns whatever verification command already exists in
		# the workspace and would happily report "passed" against a tree pi
		# never touched. Success requires both: pi actually ran to completion
		# (returncode 0) and the real verification command passed.
		pi_failed = timed_out or pi_returncode != 0
		traces = parse_pi_traces(stdout)
		blockers, reviewer = round_blockers(
			verify_passed=verify_passed,
			pi_failed=pi_failed,
			pi_timed_out=timed_out,
			traces=traces,
			review_policy=review_policy,
		)

		rnd = Round(
			index=round_index,
			agent="pi-local",
			command=command,
			pi_returncode=pi_returncode,
			pi_timed_out=timed_out,
			pi_usage=parse_usage(stdout),
			traces=traces,
			reviewer=reviewer,
			verify_command=verify_command,
			verify_passed=verify_passed,
			verify_timed_out=verify_timed_out,
			verify_output_tail=verify_tail,
			duration_s=duration,
		)
		result.rounds.append(rnd)

		if verify_command is None:
			result.stopped_reason = "no canonical verification command resolvable"
			break
		if not blockers:
			result.succeeded = True
			result.stopped_reason = (
				"canonical verification passed and independent review was clean"
				if reviewer.outcome == "clean"
				else f"canonical verification passed; degraded review ({reviewer.detail})"
			)
			break

		prompt = corrective_prompt(
			round_index=round_index,
			max_rounds=max_rounds,
			verify_command=verify_command,
			verify_tail=verify_tail,
			blockers=blockers,
			reviewer=reviewer,
		)
		escalation_prompt = "\n\n".join([
			"The local Pi harness exhausted its bounded corrective budget. Take one bounded corrective pass over the existing workspace.",
			f"Original task specification:\n\n{spec_text}",
			prompt,
		])
		if review_policy == "required" and reviewer.outcome == "unavailable" and reviewer.detail in NON_RETRYABLE_REVIEW_FAILURES:
			result.stopped_reason = f"review unavailable; escalation required: {reviewer.detail}"
			break
		if round_index == max_rounds:
			result.stopped_reason = f"local round budget ({max_rounds}) exhausted; escalation required: {', '.join(blockers)}"
			break

	if not result.succeeded and sonnet_fallback and escalation_prompt and resolve_verify_command(workspace):
		command = sonnet_invocation(escalation_prompt)
		started = time.monotonic()
		try:
			completed = sh(command, cwd=workspace, timeout=timeout_minutes * 60, env=env)
			timed_out = False
		except subprocess.TimeoutExpired:
			completed = None
			timed_out = True
		except OSError as exc:
			completed = subprocess.CompletedProcess(command, 127, "", str(exc))
			timed_out = False
		duration = time.monotonic() - started
		verify_command, verify_passed, verify_timed_out, verify_tail = run_verification(workspace)
		returncode = completed.returncode if completed else -1
		result.rounds.append(Round(
			index=len(result.rounds) + 1,
			agent=SONNET_MODEL,
			command=command,
			pi_returncode=returncode,
			pi_timed_out=timed_out,
			pi_usage=parse_sonnet_usage(completed.stdout if completed else ""),
			traces=[],
			reviewer=ReviewSignal("sonnet-fallback"),
			verify_command=verify_command,
			verify_passed=verify_passed,
			verify_timed_out=verify_timed_out,
			verify_output_tail=verify_tail,
			duration_s=duration,
		))
		if not timed_out and returncode == 0 and verify_passed is True:
			result.succeeded = True
			result.stopped_reason = "Sonnet fallback passed canonical verification"
		else:
			result.stopped_reason = "Sonnet fallback did not pass canonical verification"

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
		lines.append(f"- agent: {rnd.agent}")
		lines.append(f"- agent exit code: {rnd.pi_returncode}")
		lines.append(f"- agent timed out: {rnd.pi_timed_out}")
		if rnd.pi_usage:
			lines.append(f"- agent usage: {json.dumps(rnd.pi_usage)}")
		lines.append(f"- reviewer outcome: {rnd.reviewer.outcome}{f' ({rnd.reviewer.detail})' if rnd.reviewer.detail else ''}")
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
			"No decisive clean/flagged verdict was recorded. The default required "
			"policy prevents local success in this state; if degraded policy was "
			"selected, that choice and the unavailable reason appear in the round "
			"summary above."
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
		"--thinking",
		choices=("off", "minimal", "low", "medium", "high", "xhigh"),
		default=None,
		help="Override Pi thinking for this build; omitted inherits installed settings.json (currently medium).",
	)
	parser.add_argument(
		"--review-policy",
		choices=("required", "degraded"),
		default="required",
		help="Require a clean independent-review verdict for success, or explicitly permit labeled degraded success when review is unavailable.",
	)
	parser.add_argument(
		"--sonnet-fallback",
		action="store_true",
		help="After local rounds are exhausted, authorize one billed claude-sonnet-5 corrective pass.",
	)
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
		thinking=args.thinking, review_policy=args.review_policy,
		sonnet_fallback=args.sonnet_fallback,
	)
	report_path = write_report(result)
	print(f"Report written to {report_path}")
	print(f"Outcome: {'SUCCEEDED' if result.succeeded else 'DID NOT SUCCEED'} -- {result.stopped_reason}")
	return 0 if result.succeeded else 1


if __name__ == "__main__":
	sys.exit(main())
