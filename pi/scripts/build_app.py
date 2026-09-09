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
        [--max-rounds 3] [--timeout-minutes 45] [--sonnet-fallback]

The installed Pi thinking policy is inherited by default. Independent review
is required for unattended success unless `--review-policy degraded` or
`--review-policy advisory` is chosen explicitly. Advisory review still runs
and is recorded, but only canonical verification blocks completion. The
`--sonnet-fallback` flag authorizes one billed Sonnet pass only after the local
corrective-round budget is exhausted.

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
import hashlib
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
# Unset by default: pi_invocation() below omits --provider/--model entirely
# unless these are set, so the installed settings.json (or ~/.pi/agent's
# `/model` selection) applies -- same "omit the flag, let the configured
# default apply" pattern already used for --thinking. Set PI_HARNESS_PROVIDER
# and PI_HARNESS_MODEL to pin a specific route instead.
PROVIDER = os.environ.get("PI_HARNESS_PROVIDER")
MODEL = os.environ.get("PI_HARNESS_MODEL")
SONNET_MODEL = "claude-sonnet-5"
VERIFY_RESOLVER = PI_ROOT / "scripts" / "resolve-verification.ts"
TSX = PI_ROOT / "node_modules" / ".bin" / "tsx"
NON_RETRYABLE_REVIEW_FAILURES = {
	"missing-configuration",
	"invalid-configuration",
	"same-primary",
	"no-task-spec",
	# With --review-base-sha threading the true ticket boundary through to
	# the reviewer (see run_build), an empty diff means literally nothing
	# has changed since the ticket started -- not "this round found nothing
	# new" (that's "unchanged-since-last-review", still retryable). No
	# amount of re-prompting can produce a decisive verdict for zero
	# changes, so fail fast instead of burning the full round budget.
	"empty-diff",
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
		elif outcome == "blocked" and metadata.get("reason") in {
			"unchanged-since-last-review", "transient-retry-exhausted",
		} and decisive:
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
	turn_errors: tuple[int, int] = (0, 0),
	no_changes: bool = False,
) -> tuple[list[str], ReviewSignal]:
	blockers: list[str] = []
	if no_changes:
		# See workspace_fingerprint's docstring: verify passing against
		# an untouched workspace is not evidence of anything this round did.
		blockers.append("no changes made to the workspace")
	if pi_timed_out:
		blockers.append("pi invocation timed out")
	elif pi_failed:
		blockers.append("pi invocation failed")
	errored, total = turn_errors
	if total and errored == total:
		# Every assistant turn in this round errored out (e.g. the model
		# route was unreachable) -- pi still exits 0 and verify still
		# legitimately fails, so without this the round is indistinguishable
		# from the model actually trying and failing (observed live:
		# budget-pilot ticket 005, 2026-08-20).
		blockers.append(f"model route unreachable ({errored}/{total} assistant turns errored)")
	if any(trace.get("outcome") == "stall-timeout" or trace.get("stallTimeout") is True for trace in traces):
		blockers.append("stall-timeout")
	if verify_passed is not True:
		blockers.append("canonical verification failed")
	review = review_signal(traces)
	if review.outcome == "flagged" and review_policy != "advisory":
		blockers.append("reviewer flagged the current diff")
	elif review.outcome != "clean" and review_policy == "required":
		blockers.append(f"review unavailable ({review.detail})")
	return blockers, review


def parse_usage(output: str) -> dict | None:
	"""Sum token usage across every assistant message a round's own
	agent_end event carries.

	Found live, 2026-09-09 (the notes-app-ticket-013 doctor/pip hardening
	pass, closing CLAIMS.md's "usage is null on every real run" remaining
	gap): a real `pi --print --mode json` agent_end event has no
	top-level "usage" key at all -- a live capture shows one against a
	real ai-stack-local invocation with `"messages": [...]` instead,
	usage living per-message inside each assistant entry's own "usage"
	dict. `"usage" in event` could therefore never be true against a real
	invocation; this function has silently returned None on every real
	round on record since it was written, the exact class of bug
	agent_turn_errors' own doc comment already found and fixed for a
	different function against the same real wire shape.

	Summed across every assistant message with a usage dict, not just the
	last: a round can carry more than one assistant turn (tool calls
	interleaved with text) before this round's own agent_end event fires,
	and the round's real total consumption is what the caller (this
	round's own BUILD_EVIDENCE.json entry) needs, not just its final
	turn's. Only numeric top-level fields (input/output/cacheRead/
	cacheWrite/reasoning/totalTokens in a real capture) are summed; the
	nested "cost" sub-object is intentionally left out of the summed
	result rather than incorrectly flattened or overwritten -- it was
	all-zero in every real capture this fix was checked against (a local,
	uncosted model), and correctly summing a nested dict is more
	complexity than that field's own current usefulness here justifies.
	"""
	totals: dict[str, int | float] = {}
	for line in output.splitlines():
		try:
			event = json.loads(line)
		except json.JSONDecodeError:
			continue
		if event.get("type") != "agent_end":
			continue
		for message in event.get("messages") or []:
			if message.get("role") != "assistant":
				continue
			usage = message.get("usage")
			if not isinstance(usage, dict):
				continue
			for key, value in usage.items():
				if isinstance(value, (int, float)) and not isinstance(value, bool):
					totals[key] = totals.get(key, 0) + value
	return totals or None


def agent_turn_errors(output: str) -> tuple[int, int]:
	"""Count assistant turns whose model call errored out (e.g. the local
	route being unreachable, or the local model's own context budget
	exhausted) vs. the total assistant turns in this round.

	`pi -p` exits 0 and `verify` legitimately fails in this case -- from
	round_blockers' other signals alone this is indistinguishable from the
	model actually trying and producing bad code, which silently burns
	real round budget against an outage instead of surfacing it distinctly
	(observed live: budget-pilot ticket 005, 2026-08-20).

	Found live, 2026-09-07 (notes-app ticket 007): this function's own
	entry_appended-wrapped shape assumption never matches real `pi --print
	--mode json` stdout -- a live capture against an actually-installed pi
	binary shows every message-lifecycle event (message_start, message_end,
	turn_start, turn_end, agent_start, agent_end) emitted as its own flat
	top-level event, never wrapped in `{"type": "entry_appended", "entry":
	...}`. That wrapper shape is real, but only for the *custom* trace
	events pi-harness's own extensions emit (parse_pi_traces above, which
	does see them) -- not for native message events. The practical result:
	`total` was always 0 in production, `if total and errored == total`
	(round_blockers' own route-unreachable short-circuit) could never
	fire, and a real model-route outage -- including a local model's
	context budget getting exhausted mid-round, which then makes every
	`--continue` round after it error out immediately with zero tokens --
	silently counted as ordinary "no changes" rounds all the way to
	max_rounds instead of being surfaced distinctly, exactly the failure
	mode this function exists to catch. `message_end` (not `message_start`,
	which fires before `stopReason` is known, and not `turn_end`, which
	duplicates the same assistant message and would double-count) is the
	one event per real assistant turn this function now keys off."""
	total = 0
	errored = 0
	for line in output.splitlines():
		try:
			event = json.loads(line)
		except json.JSONDecodeError:
			continue
		if event.get("type") != "message_end":
			continue
		message = event.get("message") or {}
		if message.get("role") != "assistant":
			continue
		total += 1
		if message.get("stopReason") == "error":
			errored += 1
	return errored, total


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
	turn_errors: tuple[int, int] = (0, 0)


@dataclass
class BuildResult:
	workspace: Path
	spec_path: Path
	review_policy: str = "required"
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
		"--session-dir", str(session_dir),
	]
	# Omit these flags by default so the installed settings.json policy (or a
	# `/model` selection made through it) applies. An explicit override remains
	# available via PI_HARNESS_PROVIDER/PI_HARNESS_MODEL/--thinking for
	# controlled experiments and reproductions.
	if PROVIDER is not None:
		pi_args += ["--provider", PROVIDER]
	if MODEL is not None:
		pi_args += ["--model", MODEL]
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
	# Checking only the command's exit code is not enough: `git rev-parse
	# --show-toplevel` also succeeds -- resolving to an ancestor directory --
	# when `workspace` is merely a subdirectory of an already-git-tracked
	# directory one level up. That's exactly ticket_runner.py's own pilot
	# layout: `workspace/` starts as a plain subdirectory of the pilot dir's
	# control repo, by design (see pi/prompts/spec-plan.md's scaffold step --
	# the control repo's own .gitignore excludes `workspace/` precisely so it
	# can get its own separate repo here). Comparing the resolved toplevel
	# against `workspace` itself is what actually detects "workspace has no
	# repo of its own yet"; a bare exit-code check leaves this always-false
	# for every pilot ticket, and the model then has to work around the
	# missing repo by force-committing past the control repo's .gitignore
	# instead -- which breaks ticket_runner.py's own gate, since the commit's
	# paths end up prefixed with `workspace/` where it expects bare paths.
	toplevel = sh(["git", "rev-parse", "--show-toplevel"], cwd=workspace)
	# `Path("").resolve()` is the *process* cwd, which would read as a match
	# whenever this script happens to run from the workspace itself -- so an
	# empty stdout has to disqualify the match rather than be compared.
	has_own_repo = (
		toplevel.returncode == 0
		and bool(toplevel.stdout.strip())
		and Path(toplevel.stdout.strip()).resolve() == workspace.resolve()
	)
	if not has_own_repo:
		# Announced because --workspace is an arbitrary caller-supplied path:
		# a standalone run pointed at a subdirectory of an existing project
		# should not silently acquire a nested repo with no trace in the log.
		print(f"no git repo of its own in {workspace} -- initializing one")
		sh(["git", "init"], cwd=workspace)
		gitignore = workspace / ".gitignore"
		if not gitignore.exists():
			gitignore.write_text("node_modules/\ndist/\nbuild/\n.dart_tool/\n")

	# This orchestrator's own bookkeeping -- the session transcript, the
	# report it writes after the build, and the structured evidence file
	# alongside it -- is not app source and must never land in the app's
	# own history. Written before the first pi invocation so the model's
	# own `git add -A`/commit never picks these up; appending even if a
	# project .gitignore already exists, since a fresh scaffold's
	# .gitignore has no reason to know about this script. BUILD_EVIDENCE.json
	# is listed here too even though write_evidence_json() doesn't run
	# until main() returns -- it's a fixed, known filename, so there's no
	# reason to wait.
	gitignore = workspace / ".gitignore"
	existing = gitignore.read_text() if gitignore.exists() else ""
	needed = [line for line in (".pi-build-session/", "BUILD_REPORT.md", "BUILD_EVIDENCE.json") if line not in existing]
	if needed:
		with gitignore.open("a") as handle:
			if existing and not existing.endswith("\n"):
				handle.write("\n")
			handle.write("\n".join(needed) + "\n")


def workspace_fingerprint(workspace: Path) -> tuple | None:
	"""A comparable snapshot of the workspace's current git state: HEAD's
	sha, sorted `git status --porcelain` output (every untracked file
	listed individually, not collapsed into its parent directory), a
	patch of every tracked/staged change, and a content hash per
	untracked file. Two snapshots comparing equal means nothing in the
	workspace changed between them.

	The untracked-file hashes exist because `git status --porcelain`
	alone only reports *that* an untracked path exists, never its
	content -- a round that edits the same still-uncommitted new file a
	prior round already created (the common case before the ticket's
	final commit) would otherwise show an identical status line both
	times and read as a no-op.

	Deliberately scoped to *the moment this is called*, not the ticket's
	overall starting commit: an earlier version of this check compared
	against review_base_sha instead, which a real Codex review of PR #4
	caught as broken two ways -- ticket_runner.py's own stage() call runs
	before build_app.py is invoked at all, so newly staged
	acceptance/contract files already make a same-round no-op look
	"changed"; and any real work a *prior* round in this same build_app.py
	invocation did remains in the diff too, so a later no-op round (or an
	escalated Sonnet pass that itself does nothing) inherits that earlier
	round's credit and reports success for work it didn't do. Comparing
	round-start to round-end instead of ticket-start to round-end catches
	both: it needs no review_base_sha (so ticket 1, whose review base is
	intentionally None, is covered too) and correctly treats each round on
	its own.

	Returns None on any git error -- callers only use this to withhold
	success, never to force failure, so a git hiccup here should not
	itself block a real success.
	"""
	head = sh(["git", "rev-parse", "HEAD"], cwd=workspace)
	if head.returncode != 0:
		return None
	status = sh(["git", "status", "--porcelain", "--untracked-files=all"], cwd=workspace)
	if status.returncode != 0:
		return None
	diff = sh(["git", "diff", "HEAD"], cwd=workspace)
	if diff.returncode not in (0, 1):
		return None
	untracked_hashes = []
	for line in status.stdout.splitlines():
		if not line.startswith("?? "):
			continue
		rel_path = line[3:]
		try:
			content = (workspace / rel_path).read_bytes()
		except OSError:
			content = b""
		untracked_hashes.append((rel_path, hashlib.sha256(content).hexdigest()))
	return (
		head.stdout.strip(),
		"\n".join(sorted(status.stdout.splitlines())),
		diff.stdout,
		tuple(sorted(untracked_hashes)),
	)


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
	review_policy: str,
) -> str:
	parts = [
		f"The previous harness round did not earn completion (attempt {round_index}/{max_rounds}).",
		f"Blocking signals: {', '.join(blockers)}.",
	]
	if verify_command and verify_tail:
		parts += [f"Canonical command: `{verify_command}`", f"Redacted failure excerpt:\n\n{verify_tail}"]
	if review_policy != "advisory" and reviewer.outcome == "flagged" and reviewer.detail:
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
	review_base_sha: str | None = None,
) -> BuildResult:
	workspace.mkdir(parents=True, exist_ok=True)
	ensure_git_repo(workspace)
	session_dir = workspace / ".pi-build-session"
	spec_text = spec_path.read_text()

	result = BuildResult(workspace=workspace, spec_path=spec_path, review_policy=review_policy)
	env = {**os.environ, "AI_STACK_HOST": os.environ.get("AI_STACK_HOST", "127.0.0.1")}
	# Anchors the independent reviewer's diff scope to the ticket's true
	# starting commit (the caller's job to know -- ticket_runner.py passes
	# its own prior-ticket-boundary sha) instead of cross-model-review.ts's
	# own default of "HEAD when this OS process happened to start". Without
	# this, a build_app.py invocation retried against a ticket a prior,
	# interrupted process already finished and committed sees an empty diff
	# (nothing changed since *this* process's start) and can never get a
	# decisive review verdict for work that was, in fact, never reviewed by
	# anyone -- see PR #25 review discussion. Omitted for standalone
	# build_app.py usage with no known ticket boundary; the reviewer falls
	# back to its own HEAD-at-process-start default.
	if review_base_sha:
		env["AI_REVIEW_BASE_SHA"] = review_base_sha
	prompt = spec_text
	escalation_prompt = ""

	for round_index in range(1, max_rounds + 1):
		continue_session = round_index > 1
		command = pi_invocation(
			workspace, prompt=prompt, session_dir=session_dir,
			containment=containment, continue_session=continue_session,
			thinking=thinking,
		)
		# Captured immediately before the round's own agent invocation --
		# not the ticket's overall starting commit -- so the no-changes
		# check below only ever credits (or blames) *this* round. See
		# workspace_fingerprint's own docstring for why comparing against
		# the ticket boundary instead was wrong.
		fingerprint_before = workspace_fingerprint(workspace)
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
		# Snapshotted here, before run_verification() below -- verify/build
		# steps can leave untracked build artifacts in their wake (compiled
		# binaries, __pycache__, etc.) that would otherwise read as "the
		# round changed something" even when the agent itself touched
		# nothing.
		fingerprint_after = workspace_fingerprint(workspace)

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
		turn_errors = agent_turn_errors(stdout)
		# None on either side means the fingerprint itself couldn't be
		# trusted (a git hiccup) -- treated as "no confirmed change" rather
		# than guessing either way, which only ever costs an extra round,
		# never a false failure.
		no_changes = fingerprint_before is None or fingerprint_after is None or fingerprint_before == fingerprint_after
		blockers, reviewer = round_blockers(
			verify_passed=verify_passed,
			pi_failed=pi_failed,
			pi_timed_out=timed_out,
			traces=traces,
			review_policy=review_policy,
			turn_errors=turn_errors,
			no_changes=no_changes,
		)

		rnd = Round(
			index=round_index,
			agent="pi-local",
			command=command,
			pi_returncode=pi_returncode,
			pi_timed_out=timed_out,
			pi_usage=parse_usage(stdout),
			traces=traces,
			turn_errors=turn_errors,
			reviewer=reviewer,
			verify_command=verify_command,
			verify_passed=verify_passed,
			verify_timed_out=verify_timed_out,
			verify_output_tail=verify_tail,
			duration_s=duration,
		)
		result.rounds.append(rnd)

		errored, total = turn_errors
		if total and errored == total:
			# The model route was unreachable for every assistant turn this
			# round -- no code was ever produced for the agent to act on, so
			# further rounds against the same dead route would just repeat
			# this outcome and burn the rest of the round budget for nothing
			# (observed live: budget-pilot ticket 005 burned all 3 rounds this
			# way before the outage was noticed). Stop immediately instead of
			# looping to max_rounds; ticket_runner.py's own build-attempt
			# retry is the layer that should recover once the route is back
			# -- checked (and left with no escalation_prompt) before the
			# verify_command-is-None branch below, since a full route
			# outage produces that exact symptom (nothing got a chance to
			# create anything) and must not be spent as a billed Sonnet
			# pass that can only repeat the same outage (found via Codex
			# review of PR #5).
			result.stopped_reason = f"model route unreachable ({errored}/{total} assistant turns errored)"
			break
		# Deliberately no special early-break for verify_command is None
		# (a brand-new ticket 1 with nothing created yet, e.g.): unlike the
		# route-outage case just above, this is not unrecoverable, and this
		# module's own documented contract is that --sonnet-fallback only
		# runs "after the local corrective-round budget is exhausted" --
		# an unconditional break here after round 1 would spend a billed
		# Sonnet pass before that budget was used, contradicting it (found
		# via Codex review of PR #5). round_blockers already adds
		# "canonical verification failed" whenever verify_passed is not
		# True (None here, same as any other unresolvable/failing check),
		# so this falls through to the same corrective-prompt/max_rounds
		# flow as every other verify failure, and a Sonnet pass still gets
		# escalation_prompt (built fresh every round below) once that
		# budget really is exhausted.
		if not blockers:
			result.succeeded = True
			if reviewer.outcome == "clean":
				result.stopped_reason = "canonical verification passed and independent review was clean"
			elif review_policy == "advisory":
				result.stopped_reason = f"canonical verification passed; advisory review ({reviewer.outcome}: {reviewer.detail or 'no detail'})"
			else:
				result.stopped_reason = f"canonical verification passed; degraded review ({reviewer.detail})"
			break

		prompt = corrective_prompt(
			round_index=round_index,
			max_rounds=max_rounds,
			verify_command=verify_command,
			verify_tail=verify_tail,
			blockers=blockers,
			reviewer=reviewer,
			review_policy=review_policy,
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

	# Deliberately does not also require resolve_verify_command(workspace)
	# to already succeed here: that would make this unreachable in exactly
	# the "nothing exists yet" case above, where creating the verify
	# surface is itself part of what the Sonnet pass is being asked to do.
	# run_verification() a few lines down re-resolves fresh against
	# whatever this round actually produces, so a still-unresolvable
	# command after the Sonnet pass simply fails verify_passed normally.
	if not result.succeeded and sonnet_fallback and escalation_prompt:
		command = sonnet_invocation(escalation_prompt)
		# Same round-scoped comparison as the local rounds above: baseline
		# is the workspace as the sonnet round finds it (i.e. after
		# whatever the local rounds already did or didn't do), not the
		# ticket's overall starting commit.
		fingerprint_before = workspace_fingerprint(workspace)
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
		fingerprint_after = workspace_fingerprint(workspace)
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
		sonnet_no_changes = (
			fingerprint_before is None or fingerprint_after is None or fingerprint_before == fingerprint_after
		)
		if not timed_out and returncode == 0 and verify_passed is True and not sonnet_no_changes:
			result.succeeded = True
			result.stopped_reason = "Sonnet fallback passed canonical verification"
		elif sonnet_no_changes:
			result.stopped_reason = "Sonnet fallback made no changes to the workspace"
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
		f"Review policy: `{result.review_policy}`",
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
		errored, total = rnd.turn_errors
		if errored and errored == total:
			lines.append(f"- agent turns errored: {errored}/{total} (model route unreachable)")
		if rnd.pi_usage:
			lines.append(f"- agent usage: {json.dumps(rnd.pi_usage)}")
		lines.append(f"- reviewer outcome: {rnd.reviewer.outcome}{f' ({rnd.reviewer.detail})' if rnd.reviewer.detail else ''}")
		if rnd.reviewer.detail:
			lines.append("")
			lines.append("Reviewer comments:")
			lines.append("```")
			lines.append(rnd.reviewer.detail)
			lines.append("```")
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
		if result.review_policy == "advisory":
			lines.append(
				"No decisive clean/flagged verdict was recorded. Advisory policy "
				"allows success based on canonical verification; the unavailable "
				"reason appears in the round summary above."
			)
		elif result.review_policy == "degraded":
			lines.append(
				"No decisive clean/flagged verdict was recorded. Degraded policy "
				"allows labeled success when review is unavailable; the reason "
				"appears in the round summary above."
			)
		else:
			lines.append(
				"No decisive clean/flagged verdict was recorded. Required policy "
				"prevents local success in this state; the unavailable reason "
				"appears in the round summary above."
			)
	else:
		for verdict in verdicts:
			lines.append(f"- round {verdict['round']}: **{verdict['outcome']}** ({verdict.get('metadata', {}).get('trigger', 'unknown trigger')})")
	lines.append("")

	report_path.write_text("\n".join(lines))
	return report_path


def write_evidence_json(result: BuildResult) -> Path:
	"""Structured counterpart to write_report's own prose: the same
	per-round data (usage, reviewer verdict/detail, verify outcome,
	timing), shaped to match software-factory's own run.AgentEvidence/
	AgentEvidenceRound Go structs (internal/run/run.go) field-for-field
	so cmd/factoryd's loadAgentEvidence can json.Unmarshal this file
	directly, no translation layer on that side.

	Closes a real, currently-open gap (CLAIMS.md's Remaining gaps,
	`software-factory`): BUILD_EVIDENCE.json was never actually written by
	any version of this script on record, so run.AgentEvidence has been
	nil on every real accepted run to date -- loadAgentEvidence's own
	warning ("could not read BUILD_EVIDENCE.json") fires on every single
	run rather than only a build_app.py version genuinely too old to emit
	one, which is the only case that warning's own doc comment describes
	as expected.

	provider/model are always null here, matching AgentEvidence's own doc
	comment ("preserve JSON null when build_app.py inherited its
	configured defaults instead of explicitly pinning an identity") --
	this script has no --provider/--model flag of its own; only
	--sonnet-fallback pins a distinct identity, and that already shows up
	per-round via Round.agent (rnd.agent below), not as a single
	whole-build value.

	schema_version's literal value (1) must always equal
	software-factory's own run.AgentEvidenceSchemaVersion constant
	(internal/run/run.go) -- bump both together, in the same change, when
	this payload's shape changes. loadAgentEvidence warns (never fails a
	run on it -- this evidence is best-effort by design) on a mismatch,
	so a future shape drift on either side of this two-repo, unversioned-
	file contract surfaces as a visible warning on the very next real run
	instead of silently misparsing or dropping fields, the way two real
	bugs already did before this field existed.
	"""
	SCHEMA_VERSION = 1
	evidence_path = result.workspace / "BUILD_EVIDENCE.json"
	payload = {
		"schema_version": SCHEMA_VERSION,
		"generated": datetime.now(timezone.utc).isoformat(),
		"review_policy": result.review_policy,
		"provider": None,
		"model": None,
		"succeeded": result.succeeded,
		"stopped_reason": result.stopped_reason,
		"rounds": [
			{
				"index": rnd.index,
				"agent": rnd.agent,
				"pi_returncode": rnd.pi_returncode,
				"pi_timed_out": rnd.pi_timed_out,
				"usage": rnd.pi_usage,
				"reviewer_outcome": rnd.reviewer.outcome,
				"reviewer_detail": rnd.reviewer.detail,
				"verify_passed": rnd.verify_passed,
				"verify_timed_out": rnd.verify_timed_out,
				"duration_s": rnd.duration_s,
			}
			for rnd in result.rounds
		],
	}
	evidence_path.write_text(json.dumps(payload, indent=2) + "\n")
	return evidence_path


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--workspace", required=True, type=Path)
	parser.add_argument("--spec", required=True, type=Path)
	parser.add_argument("--max-rounds", type=int, default=3)
	parser.add_argument(
		"--thinking",
		choices=("off", "minimal", "low", "medium", "high", "xhigh"),
		default=None,
		help="Override Pi thinking for this build; omitted inherits installed settings.json (currently medium).",
	)
	parser.add_argument(
		"--review-policy",
		choices=("required", "degraded", "advisory"),
		default="required",
		help="Review policy: required blocks on unavailable/flagged review; degraded permits unavailable review; advisory records review but only canonical verification blocks success.",
	)
	parser.add_argument(
		"--sonnet-fallback",
		action="store_true",
		help="After local rounds are exhausted, authorize one billed claude-sonnet-5 corrective pass.",
	)
	parser.add_argument(
		"--review-base-sha",
		default=None,
		help="Commit the independent reviewer should diff against for the whole invocation, "
		"instead of HEAD when this process starts -- pass the true ticket-start boundary "
		"(e.g. ticket_runner.py's prior-ticket commit) so a retried invocation against "
		"already-committed work still gets reviewed rather than seeing an empty diff.",
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
		review_base_sha=args.review_base_sha,
	)
	report_path = write_report(result)
	print(f"Report written to {report_path}")
	evidence_path = write_evidence_json(result)
	print(f"Evidence written to {evidence_path}")
	print(f"Outcome: {'SUCCEEDED' if result.succeeded else 'DID NOT SUCCEED'} -- {result.stopped_reason}")
	return 0 if result.succeeded else 1


if __name__ == "__main__":
	sys.exit(main())
