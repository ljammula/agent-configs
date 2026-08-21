#!/usr/bin/env python3
"""Outer loop over a ticket-decomposed spec: one fresh build_app.py
invocation per ticket, gated by machine-checked evidence only.

See plans/zero-human-fullstack-pipeline-plan-2026-08-20.md (Phase 2) for
the design this implements. In short: a "pilot dir" holds a frozen spec,
contract, ticket graph, and sliced acceptance-test oracle in `spec/`, and
the app under construction in `workspace/`. This script drives
`build_app.py` once per ticket, in order, and only advances past a ticket
when every one of six machine-checked conditions holds -- nothing the
agent *says* (including its own BUILD_REPORT.md prose beyond the one
parsed status line, and its PROGRESS.md entries) is trusted as evidence.

Position is derived from TWO sources together, not the git log alone
(regression fixed 2026-08-20 review: a ticket whose commit exists but
whose gate then FAILED -- verify-full red, oracle drift, state files
untouched -- was being silently treated as done on the next invocation,
because the old logic only checked for the commit. That breaks
stop-the-line across process restarts, which is this script's core
invariant). A ticket now counts as done only when BOTH hold: a commit
whose subject starts `ticket(NNN):` exists, AND
`reports/ticket-NNN/gate.json` records `passed: true`. If the commit
exists but the gate record is missing/failed, the ticket is re-gated
(the five/six checks re-run against current state) WITHOUT invoking
build_app.py again -- this is what makes the rescue flow below actually
work. There is still no separate "resume" mode: `--status` and a normal
run derive the same position, so crashing and rerunning is always safe.

When a build attempt stops before trustworthy report evidence, a normal
`make run` performs at most three total build attempts for that ticket,
persisting per-attempt logs under `reports/ticket-NNN/`. Real verification,
oracle-integrity, and frozen-surface failures remain stop-the-line failures;
they are never retried as infrastructure noise.

Rescue commits: if a ticket halts (this script exits non-zero) and a
human fixes it -- typically by running build_app.py by hand against the
ticket spec in a normal interactive session, or otherwise making the
same evidence hold -- that commit's message must still start with
`ticket(NNN):` (so position derivation still finds it) and should
additionally contain the literal tag `[rescued]` somewhere in the
subject or body, e.g. `ticket(004): onboarding screen [rescued]`. This
script counts rescued tickets separately in `--status` output -- it does
not treat them differently for gating (a rescued ticket must pass the
exact same six-check gate as every other ticket) or block on their
presence in any way. The next `make run` after a rescue commit finds the
commit already present, finds no passing gate record yet, and re-gates
it -- no flag or special invocation needed. Rescue is always a
human-invoked, out-of-band step; this script has no escalation path of
its own (Phase 3 of the plan).

Usage:
    python3 ticket_runner.py --pilot-dir /path/to/pilot [--status]
        [--review-policy advisory|required|degraded]

The ticket runner defaults to advisory review: the independent reviewer still
runs and its verdict is archived, but only canonical verification and the
runner's deterministic gates stop the ticket. Use `--review-policy required`
for a release-hardening run that requires clean independent review.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import signal
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
BUILD_APP = SCRIPT_DIR / "build_app.py"
STAGED_EXTENSIONS = {
	".go": "acceptance",
	".mod": "acceptance",
	".sum": "acceptance",
	".dart": "app/test",
}
TICKET_RE = re.compile(r"^(\d{3})-(.+)\.md$")
COMMIT_RE_TEMPLATE = r"^ticket\({nnn}\):"
BUILD_APP_TIMEOUT_S = 90 * 60
MAX_BUILD_ATTEMPTS = 3
MAX_BUILDER_ROUNDS = 3
BUILD_RETRY_BACKOFF_S = 30
DEFAULT_REVIEW_POLICY = "advisory"
REVIEW_POLICY_STRENGTH = {"advisory": 0, "degraded": 1, "required": 2}
TRANSIENT_BUILD_MARKERS = (
	"pi invocation timed out",
	"pi invocation failed",
	"stall-timeout",
	"review unavailable (request-failed)",
	"review unavailable (no-review-verdict)",
	# build_app.py's own outage short-circuit (agent_turn_errors()/
	# round_blockers() in build_app.py): every assistant turn in the round
	# errored out because the model route itself was unreachable, so no
	# implementation work was ever attempted. Without this marker,
	# retryable_build_state() treats an outage report exactly like a real
	# implementation failure and halts for human intervention instead of
	# using the bounded build-attempt retry this class of failure is meant
	# for (observed live: budget-pilot ticket 005, 2026-08-20 -- Codex
	# review of PR #28 flagged this gap).
	"model route unreachable",
)
# The Makefile and verify scripts are agent-writable but gate-trusted --
# nothing byte-checks them the way oracle_drift() byte-checks acceptance
# files, so a model could edit `make verify` to a no-op and pass checks 1-2
# vacuously (same threat class as editing a test). Ticket 001 is the one
# ticket allowed to shape these files (it's told to create them, with
# documented deviation latitude); once its gate passes, whatever it
# produced is frozen and every later ticket's gate checks the hashes
# haven't moved.
VERIFY_SURFACE_FILES = ["Makefile", "scripts/verify.sh", "scripts/verify-full.sh"]


def sh(args: list[str], *, cwd: Path | None = None, timeout: float | None = None) -> subprocess.CompletedProcess:
	return subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=timeout, check=False)


def git(workspace: Path, *args: str, timeout: float = 30) -> subprocess.CompletedProcess:
	return sh(["git", *args], cwd=workspace, timeout=timeout)


@dataclass
class Ticket:
	number: int
	slug: str
	path: Path

	@property
	def nnn(self) -> str:
		return f"{self.number:03d}"


def discover_tickets(spec_dir: Path) -> list[Ticket]:
	tickets = []
	for path in sorted((spec_dir / "tickets").glob("*.md")):
		m = TICKET_RE.match(path.name)
		if not m:
			continue
		tickets.append(Ticket(number=int(m.group(1)), slug=m.group(2), path=path))
	tickets.sort(key=lambda t: t.number)
	return tickets


def commit_sha_for(workspace: Path, number: int) -> str | None:
	"""Most recent commit whose subject matches `ticket(NNN):` for this
	ticket number, or None if there isn't one yet."""
	result = git(workspace, "log", "--format=%H\t%s")
	if result.returncode != 0:
		return None
	pattern = re.compile(COMMIT_RE_TEMPLATE.format(nnn=f"{number:03d}"))
	for line in result.stdout.splitlines():
		sha, _, subject = line.partition("\t")
		if pattern.match(subject):
			return sha
	return None


def committed_ticket_numbers(workspace: Path) -> dict[int, str]:
	"""Ticket number -> most recent matching commit subject, derived purely
	from git log. Empty dict on an unborn/missing repo -- that's ticket 1's
	starting state, not an error. Used for display/status only; gating
	position uses ticket_done() below, which also requires a passing gate
	record."""
	result = git(workspace, "log", "--format=%H\t%s")
	if result.returncode != 0:
		return {}
	found: dict[int, str] = {}
	for line in reversed(result.stdout.splitlines()):  # oldest first, so "most recent" overwrites
		if "\t" not in line:
			continue
		_sha, subject = line.split("\t", 1)
		m = re.match(r"^ticket\((\d{3})\):", subject)
		if m:
			found[int(m.group(1))] = subject
	return found


def read_gate(pilot_dir: Path, ticket: Ticket) -> dict | None:
	path = pilot_dir / "reports" / f"ticket-{ticket.nnn}" / "gate.json"
	if not path.exists():
		return None
	try:
		return json.loads(path.read_text())
	except (json.JSONDecodeError, OSError):
		return None


def failed_check_names(gate: dict | None) -> set[str]:
	if not gate:
		return set()
	return {
		str(check.get("name"))
		for check in gate.get("checks", [])
		if not check.get("ok")
	}


def gate_review_policy(gate: dict | None) -> str | None:
	"""Return the policy represented by gate evidence.

	Older gates predate the persisted policy field and were produced while
	`build_app.py` required clean review by default, so treat missing policy as
	`required` for backward-compatible, conservative evidence handling.
	"""
	if not gate:
		return None
	if "review_policy" not in gate:
		return "required"
	policy = gate.get("review_policy")
	return policy if policy in REVIEW_POLICY_STRENGTH else None


def gate_satisfies_review_policy(gate: dict | None, requested: str) -> bool:
	if not gate or gate.get("passed") is not True:
		return False
	recorded = gate_review_policy(gate)
	return recorded is not None and REVIEW_POLICY_STRENGTH[recorded] >= REVIEW_POLICY_STRENGTH[requested]


def _attempt_numbers(report_dir: Path, prefixes: tuple[str, ...]) -> list[int]:
	numbers = []
	for prefix in prefixes:
		for path in report_dir.glob(f"{prefix}-attempt-*"):
			match = re.search(r"-attempt-(\d+)(?:\.|$)", path.name)
			if match:
				numbers.append(int(match.group(1)))
	return numbers


def next_build_attempt(pilot_dir: Path, ticket: Ticket) -> int:
	"""Return the durable one-based number for the next build invocation."""
	report_dir = pilot_dir / "reports" / f"ticket-{ticket.nnn}"
	if not report_dir.exists():
		return 1
	started = {
		int(match.group(1))
		for path in report_dir.glob("build-attempt-*.started.json")
		if (match := re.search(r"-attempt-(\d+)\.started\.json$", path.name))
	}
	completed = {
		int(match.group(1))
		for path in report_dir.glob("build-attempt-*.log")
		if (match := re.search(r"-attempt-(\d+)\.log$", path.name))
	}
	incomplete = started - completed
	if incomplete:
		# A process can die after reserving a slot but before archiving its
		# build log. Resume that same slot; the interruption did not create a
		# fourth build attempt and the immutable start marker remains evidence.
		return max(incomplete)
	numbers = _attempt_numbers(report_dir, ("build", "BUILD_REPORT"))
	if numbers:
		return max(numbers) + 1
	# Older runners created the directory before invoking the builder and wrote
	# only build.log after it returned. An empty directory is the interrupted
	# form observed in the live pilot. Gate-only evidence does not consume the
	# build budget.
	if (report_dir / "build.log").exists() or not any(report_dir.iterdir()):
		return 2
	return 1


def next_gate_attempt(pilot_dir: Path, ticket: Ticket) -> int:
	"""Return the durable one-based number for the next archived gate."""
	report_dir = pilot_dir / "reports" / f"ticket-{ticket.nnn}"
	if not report_dir.exists():
		return 1
	started = {
		int(match.group(1))
		for path in report_dir.glob("gate-attempt-*.started.json")
		if (match := re.search(r"-attempt-(\d+)\.started\.json$", path.name))
	}
	completed = {
		int(match.group(1))
		for path in report_dir.glob("gate-attempt-*.json")
		if not path.name.endswith(".started.json")
		and (match := re.search(r"-attempt-(\d+)\.json$", path.name))
	}
	incomplete = started - completed
	if incomplete:
		return max(incomplete)
	numbers = _attempt_numbers(report_dir, ("gate",))
	if numbers:
		return max(numbers) + 1
	return 2 if (report_dir / "gate.json").exists() else 1


def write_once(path: Path, content: str | bytes) -> None:
	"""Create immutable per-attempt evidence; never overwrite an old run."""
	mode = "xb" if isinstance(content, bytes) else "x"
	with path.open(mode) as handle:
		handle.write(content)


def retryable_build_state(pilot_dir: Path, workspace: Path, ticket: Ticket) -> bool:
	"""Return true when a prior build attempt stopped before report evidence.

	A missing report is recoverable infrastructure state. A gate with any real
	verification, oracle, state-file, or review-equivalent failure is not: the
	line must stop and require a human decision rather than silently repeating
	implementation work.
	"""
	report = workspace / "BUILD_REPORT.md"
	transient_report = False
	if report.exists():
		outcome_line = next(
			(
				line.strip().lower()
				for line in report.read_text(errors="ignore").splitlines()
				if line.startswith("Outcome:")
			),
			"",
		)
		transient_report = any(marker in outcome_line for marker in TRANSIENT_BUILD_MARKERS)
		if not transient_report:
			return False
	gate = read_gate(pilot_dir, ticket)
	if gate is None:
		# run_ticket creates this directory before invoking build_app.py. Its
		# existence distinguishes an interrupted prior build from a fresh pilot.
		return (pilot_dir / "reports" / f"ticket-{ticket.nnn}").exists()
	failed = failed_check_names(gate)
	if "BUILD_REPORT.md SUCCEEDED" not in failed:
		return False
	if transient_report:
		return not (failed & {"oracle integrity", "verify-surface frozen"})
	# A builder timeout/nonzero exit is sufficient to retry even if the
	# incomplete workspace also makes verification red. Oracle or frozen-surface
	# drift is never treated as transient infrastructure.
	if "build_app.py invocation" in failed:
		return not (failed & {"oracle integrity", "verify-surface frozen"})
	# This is the recovery shape produced when the outer runner was interrupted
	# before it could archive the builder's invocation result.
	return failed <= {"BUILD_REPORT.md SUCCEEDED"}


def ticket_done(
	pilot_dir: Path,
	workspace: Path,
	ticket: Ticket,
	review_policy: str = DEFAULT_REVIEW_POLICY,
) -> bool:
	if commit_sha_for(workspace, ticket.number) is None:
		return False
	gate = read_gate(pilot_dir, ticket)
	return gate_satisfies_review_policy(gate, review_policy)


def next_ticket(
	tickets: list[Ticket],
	pilot_dir: Path,
	workspace: Path,
	review_policy: str = DEFAULT_REVIEW_POLICY,
) -> tuple[Ticket | None, str | None]:
	"""Returns (ticket, mode) where mode is "build" (no commit yet -- run
	build_app.py), "retry" (a previous build stopped before report evidence),
	or "regate" (a commit exists but no passing gate record -- re-run the gate
	only, e.g. after a rescue commit), or "policy" (a passing gate exists but
	was produced under a weaker review policy and must be rebuilt). (None, None)
	means every ticket is done."""
	for t in tickets:
		gate = read_gate(pilot_dir, t)
		if ticket_done(pilot_dir, workspace, t, review_policy):
			continue
		if commit_sha_for(workspace, t.number) is not None and gate and gate.get("passed") is True:
			return t, "policy"
		if retryable_build_state(pilot_dir, workspace, t):
			return t, "retry"
		mode = "regate" if commit_sha_for(workspace, t.number) is not None else "build"
		return t, mode
	return None, None


def prior_boundary_sha(workspace: Path, tickets: list[Ticket], ticket: Ticket) -> str | None:
	"""The commit this ticket's changes should be diffed against: the
	previous ticket's commit, or the repo's root commit if there is none
	(ticket 1, or every earlier ticket was somehow never committed).
	Deliberately NOT "current HEAD before invoking build_app.py" -- that
	was wrong for regate mode, where HEAD already includes this ticket's
	commit before the gate even starts."""
	idx = tickets.index(ticket)
	for prior in reversed(tickets[:idx]):
		sha = commit_sha_for(workspace, prior.number)
		if sha:
			return sha
	result = git(workspace, "rev-list", "--max-parents=0", "HEAD")
	if result.returncode == 0 and result.stdout.strip():
		return result.stdout.strip().splitlines()[0]
	return None


def staged_pairs(pilot_dir: Path, workspace: Path, upto: int) -> list[tuple[Path, Path]]:
	"""(canonical_path, staged_path) pairs for every slice activated up to
	and including ticket `upto`. Only .go/.mod/.sum/.dart files are staged
	-- MANIFEST.md and other slice documentation stays control-dir-only
	(every slice names it identically, so staging it would collide)."""
	pairs = []
	acceptance_dir = pilot_dir / "spec" / "acceptance"
	if not acceptance_dir.exists():
		return pairs
	for slice_dir in sorted(acceptance_dir.iterdir()):
		if not slice_dir.is_dir() or not slice_dir.name.isdigit():
			continue
		if int(slice_dir.name) > upto:
			continue
		for f in sorted(slice_dir.iterdir()):
			if not f.is_file() or f.suffix not in STAGED_EXTENSIONS:
				continue
			dest_root = STAGED_EXTENSIONS[f.suffix]
			pairs.append((f, workspace / dest_root / f.name))
	return pairs


def stage(pilot_dir: Path, workspace: Path, upto: int) -> None:
	for canon, staged in staged_pairs(pilot_dir, workspace, upto):
		staged.parent.mkdir(parents=True, exist_ok=True)
		shutil.copyfile(canon, staged)
	contract_dest = workspace / "spec" / "contract.md"
	contract_dest.parent.mkdir(parents=True, exist_ok=True)
	shutil.copyfile(pilot_dir / "spec" / "contract.md", contract_dest)


def oracle_drift(pilot_dir: Path, workspace: Path, upto: int) -> list[str]:
	drifted = []
	for canon, staged in staged_pairs(pilot_dir, workspace, upto):
		if not staged.exists() or staged.read_bytes() != canon.read_bytes():
			drifted.append(str(staged.relative_to(workspace)))
	return drifted


def sha256_of(path: Path) -> str | None:
	if not path.exists():
		return None
	return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_baseline_json(pilot_dir: Path) -> Path:
	return pilot_dir / "reports" / "ticket-001" / "verify-baseline.json"


def verify_baseline_dir(pilot_dir: Path) -> Path:
	return pilot_dir / "reports" / "ticket-001" / "verify-baseline"


def save_verify_baseline(pilot_dir: Path, workspace: Path) -> None:
	baseline_dir = verify_baseline_dir(pilot_dir)
	baseline_dir.mkdir(parents=True, exist_ok=True)
	hashes: dict[str, str | None] = {}
	for rel in VERIFY_SURFACE_FILES:
		src = workspace / rel
		hashes[rel] = sha256_of(src)
		if src.exists():
			(baseline_dir / rel.replace("/", "__")).write_bytes(src.read_bytes())
	verify_baseline_json(pilot_dir).write_text(json.dumps(hashes, indent=2))


def restore_verify_baseline(pilot_dir: Path, workspace: Path) -> None:
	baseline_dir = verify_baseline_dir(pilot_dir)
	for rel in VERIFY_SURFACE_FILES:
		src = baseline_dir / rel.replace("/", "__")
		if src.exists():
			dest = workspace / rel
			dest.parent.mkdir(parents=True, exist_ok=True)
			dest.write_bytes(src.read_bytes())


def check_verify_surface_frozen(pilot_dir: Path, workspace: Path) -> tuple[bool, str]:
	baseline_path = verify_baseline_json(pilot_dir)
	if not baseline_path.exists():
		return False, "no verify-baseline.json recorded yet -- ticket 001 must gate-pass first"
	try:
		baseline = json.loads(baseline_path.read_text())
	except (json.JSONDecodeError, OSError) as exc:
		return False, f"could not read verify-baseline.json: {exc}"
	changed = [f for f in VERIFY_SURFACE_FILES if baseline.get(f) != sha256_of(workspace / f)]
	if changed:
		return False, f"verify surface changed since ticket 001's frozen baseline: {changed}"
	return True, "unchanged since ticket 001"


def run_make(workspace: Path, target: str, timeout: float) -> tuple[bool, str]:
	try:
		result = sh(["make", target], cwd=workspace, timeout=timeout)
		return result.returncode == 0, (result.stdout + "\n" + result.stderr)[-6000:]
	except subprocess.TimeoutExpired as exc:
		out = (exc.stdout or "") + "\n" + (exc.stderr or "")
		return False, f"`make {target}` timed out after {timeout:.0f}s\n{out[-4000:]}"


def build_report_succeeded(
	workspace: Path,
	review_policy: str = DEFAULT_REVIEW_POLICY,
) -> tuple[bool, str]:
	report = workspace / "BUILD_REPORT.md"
	if not report.exists():
		return False, "BUILD_REPORT.md not found"
	text = report.read_text(errors="ignore")
	line = next((l for l in text.splitlines() if l.startswith("Outcome:")), "")
	if not line.startswith("Outcome: SUCCEEDED"):
		return False, line or "no Outcome line found"
	policy_line = next((l for l in text.splitlines() if l.startswith("Review policy:")), "")
	if not policy_line:
		recorded_policy = "required"
	else:
		match = re.fullmatch(r"Review policy: `([^`]+)`", policy_line)
		recorded_policy = match.group(1) if match and match.group(1) in REVIEW_POLICY_STRENGTH else None
	if recorded_policy is None:
		return False, f"unrecognized review policy evidence: {policy_line}"
	if REVIEW_POLICY_STRENGTH[recorded_policy] < REVIEW_POLICY_STRENGTH[review_policy]:
		return False, f"report review policy {recorded_policy!r} is weaker than requested {review_policy!r}"
	return True, line


def commit_and_state_files_ok(workspace: Path, ticket: Ticket, base_sha: str | None) -> tuple[bool, str]:
	commit_sha = commit_sha_for(workspace, ticket.number)
	if not commit_sha:
		return False, f"no commit found matching ^ticket({ticket.nnn}):"
	diff_range = f"{base_sha}..{commit_sha}" if base_sha else commit_sha
	diff = git(workspace, "diff", "--name-only", diff_range) if base_sha else git(workspace, "show", "--name-only", "--format=", commit_sha)
	if diff.returncode != 0:
		return False, f"could not diff {diff_range}: {diff.stderr}"
	touched = set(diff.stdout.splitlines())
	missing = {"ARCHITECTURE.md", "PROGRESS.md"} - touched
	if missing:
		return False, f"commit {commit_sha[:12]} did not touch {sorted(missing)}"
	return True, f"commit {commit_sha[:12]} ok"


def invoke_build_app(build_cmd: list[str], timeout: float) -> tuple[int, str, str, bool]:
	"""Returns (returncode, stdout, stderr, timed_out). A timeout is
	reported as a failed invocation, never an uncaught exception that
	would crash the runner with no gate archived and no halt recorded."""
	process = subprocess.Popen(
		build_cmd,
		text=True,
		stdout=subprocess.PIPE,
		stderr=subprocess.PIPE,
		start_new_session=True,
	)

	def text_output(value: str | bytes | None) -> str:
		if value is None:
			return ""
		if isinstance(value, bytes):
			return value.decode(errors="replace")
		return value

	try:
		stdout, stderr = process.communicate(timeout=timeout)
		return process.returncode, text_output(stdout), text_output(stderr), False
	except subprocess.TimeoutExpired as exc:
		stdout = exc.stdout
		stderr = exc.stderr
		try:
			os.killpg(process.pid, signal.SIGTERM)
		except ProcessLookupError:
			pass
		try:
			term_stdout, term_stderr = process.communicate(timeout=10)
			stdout = term_stdout or stdout
			stderr = term_stderr or stderr
		except subprocess.TimeoutExpired as term_exc:
			stdout = term_exc.stdout or stdout
			stderr = term_exc.stderr or stderr
		# The direct parent may exit promptly on SIGTERM while a nested agent or
		# command ignores it. Always address the original process group with
		# SIGKILL after the grace period before permitting a retry.
		try:
			os.killpg(process.pid, signal.SIGKILL)
		except ProcessLookupError:
			pass
		if process.poll() is None:
			try:
				kill_stdout, kill_stderr = process.communicate(timeout=5)
				stdout = kill_stdout or stdout
				stderr = kill_stderr or stderr
			except subprocess.TimeoutExpired:
				process.kill()
				kill_stdout, kill_stderr = process.communicate()
				stdout = kill_stdout or stdout
				stderr = kill_stderr or stderr
		return -1, text_output(stdout), text_output(stderr), True


def builder_command(
	workspace: Path,
	ticket: Ticket,
	base_sha: str | None,
	review_policy: str = DEFAULT_REVIEW_POLICY,
) -> list[str]:
	cmd = [
		sys.executable, str(BUILD_APP),
		"--workspace", str(workspace),
		"--spec", str(ticket.path),
		"--max-rounds", str(MAX_BUILDER_ROUNDS),
		"--timeout-minutes", "60",
		"--review-policy", review_policy,
	]
	# Anchors the independent reviewer's diff scope to this ticket's real
	# starting commit rather than build_app.py's own default of "HEAD when
	# this process happens to start" -- without it, a retried invocation
	# against work an earlier, interrupted attempt already committed sees an
	# empty diff and can never get a decisive review verdict for a diff
	# nobody actually reviewed. base_sha is None only for ticket 1 in a repo
	# with no root commit yet; build_app.py's own fallback covers that.
	if base_sha:
		cmd += ["--review-base-sha", base_sha]
	return cmd


def append_halt_record(workspace: Path, ticket: Ticket, reasons: list[str]) -> None:
	progress = workspace / "PROGRESS.md"
	existing = progress.read_text(errors="ignore") if progress.exists() else ""
	stamp = datetime.now(timezone.utc).isoformat()
	block = (
		f"\n\n## [runner-written] HALT at ticket {ticket.nnn} ({stamp})\n\n"
		f"ticket_runner.py stopped the line here. Gate failures:\n"
		+ "".join(f"- {r}\n" for r in reasons)
		+ "\nThis section is written by the runner, not the agent, and is "
		"never trusted as ticket-completion evidence -- it exists only as "
		"a human-readable record alongside the archived gate log.\n"
	)
	progress.write_text(existing + block)


def archive_evidence(
	pilot_dir: Path,
	ticket: Ticket,
	gate_result: dict,
	*,
	gate_attempt: int,
	build_attempt: int | None,
) -> None:
	dest = pilot_dir / "reports" / f"ticket-{ticket.nnn}"
	dest.mkdir(parents=True, exist_ok=True)
	report = pilot_dir / "workspace" / "BUILD_REPORT.md"
	if report.exists():
		shutil.copyfile(report, dest / "BUILD_REPORT.md")
		report_name = (
			f"BUILD_REPORT-attempt-{build_attempt:02d}.md"
			if build_attempt is not None
			else f"BUILD_REPORT-regate-{gate_attempt:02d}.md"
		)
		write_once(dest / report_name, report.read_bytes())
	(dest / "gate.json").write_text(json.dumps(gate_result, indent=2))
	log_lines = [
		f"# Gate log -- ticket {ticket.nnn}",
		f"review policy: {gate_result.get('review_policy', 'unknown')}",
		f"passed: {gate_result['passed']}",
		"",
	]
	for check in gate_result["checks"]:
		log_lines.append(f"## {check['name']}: {'PASS' if check['ok'] else 'FAIL'}")
		if check.get("detail"):
			log_lines.append("```")
			log_lines.append(str(check["detail"])[:4000])
			log_lines.append("```")
	log_text = "\n".join(log_lines)
	(dest / "gate.log").write_text(log_text)
	write_once(dest / f"gate-attempt-{gate_attempt:02d}.json", json.dumps(gate_result, indent=2))
	write_once(dest / f"gate-attempt-{gate_attempt:02d}.log", log_text)


def run_ticket(
	pilot_dir: Path,
	workspace: Path,
	ticket: Ticket,
	tickets: list[Ticket],
	*,
	skip_build: bool,
	gate_attempt: int,
	build_attempt: int | None,
	review_policy: str,
) -> bool:
	mode_label = "regate only" if skip_build else ("build retry" if build_attempt and build_attempt > 1 else "build")
	print(f"\n=== ticket {ticket.nnn}: {ticket.slug} ({mode_label}, gate {gate_attempt}) ===")
	stage(pilot_dir, workspace, ticket.number)
	base_sha = prior_boundary_sha(workspace, tickets, ticket)

	checks: list[dict] = []
	report_dir = pilot_dir / "reports" / f"ticket-{ticket.nnn}"
	report_dir.mkdir(parents=True, exist_ok=True)
	gate_started = report_dir / f"gate-attempt-{gate_attempt:02d}.started.json"
	if not gate_started.exists():
		write_once(
			gate_started,
			json.dumps({"ticket": ticket.nnn, "started": datetime.now(timezone.utc).isoformat()}),
		)

	if skip_build:
		print("commit already exists but no passing gate record -- re-gating only, not invoking build_app.py (rescue flow)")
	else:
		if build_attempt is None:
			raise ValueError("build_attempt is required when invoking build_app.py")
		# A stale BUILD_REPORT.md from a previous ticket/run must never be
		# able to satisfy THIS run's "reports SUCCEEDED" check -- e.g. if
		# build_app.py crashes or is killed by our own timeout below before
		# writing a fresh one.
		report_path = workspace / "BUILD_REPORT.md"
		if report_path.exists():
			report_path.unlink()

		build_cmd = builder_command(workspace, ticket, base_sha, review_policy)
		print(f"running: {' '.join(build_cmd)}")
		build_started = report_dir / f"build-attempt-{build_attempt:02d}.started.json"
		if not build_started.exists():
			write_once(
				build_started,
				json.dumps({"ticket": ticket.nnn, "started": datetime.now(timezone.utc).isoformat()}),
			)
		returncode, stdout, stderr, timed_out = invoke_build_app(build_cmd, BUILD_APP_TIMEOUT_S)
		print(stdout[-2000:])
		if timed_out:
			print(f"build_app.py timed out after {BUILD_APP_TIMEOUT_S}s", file=sys.stderr)
			checks.append({"name": "build_app.py invocation", "ok": False, "detail": f"timed out after {BUILD_APP_TIMEOUT_S}s"})
		elif returncode != 0:
			print(f"build_app.py exited {returncode}", file=sys.stderr)
			checks.append({"name": "build_app.py invocation", "ok": False, "detail": f"exited with code {returncode}"})
		build_log = (
			f"$ {' '.join(build_cmd)}\ntimed_out: {timed_out}\nreturncode: {returncode}\n\n"
			f"--- stdout ---\n{stdout}\n\n--- stderr ---\n{stderr}\n"
		)
		(report_dir / "build.log").write_text(build_log)
		write_once(report_dir / f"build-attempt-{build_attempt:02d}.log", build_log)

	verify_ok, verify_out = run_make(workspace, "verify", timeout=25 * 60)
	checks.append({"name": "make verify", "ok": verify_ok, "detail": verify_out})

	verify_full_ok, verify_full_out = (False, "skipped: make verify failed")
	if verify_ok:
		verify_full_ok, verify_full_out = run_make(workspace, "verify-full", timeout=40 * 60)
	checks.append({"name": "make verify-full", "ok": verify_full_ok, "detail": verify_full_out})

	drift = oracle_drift(pilot_dir, workspace, ticket.number)
	checks.append({"name": "oracle integrity", "ok": not drift, "detail": drift})

	frozen_ok = True
	if ticket.number != 1:
		frozen_ok, frozen_detail = check_verify_surface_frozen(pilot_dir, workspace)
		checks.append({"name": "verify-surface frozen", "ok": frozen_ok, "detail": frozen_detail})

	report_ok, report_detail = build_report_succeeded(workspace, review_policy)
	checks.append({"name": "BUILD_REPORT.md SUCCEEDED", "ok": report_ok, "detail": report_detail})

	commit_ok, commit_detail = commit_and_state_files_ok(workspace, ticket, base_sha)
	checks.append({"name": "ticket commit + state files", "ok": commit_ok, "detail": commit_detail})

	passed = all(c["ok"] for c in checks)

	if ticket.number == 1 and passed:
		save_verify_baseline(pilot_dir, workspace)

	gate_result = {
		"ticket": ticket.nnn,
		"review_policy": review_policy,
		"passed": passed,
		"checks": checks,
	}
	archive_evidence(
		pilot_dir,
		ticket,
		gate_result,
		gate_attempt=gate_attempt,
		build_attempt=build_attempt,
	)

	if not passed:
		reasons = [c["name"] for c in checks if not c["ok"]]
		recoverable = retryable_build_state(pilot_dir, workspace, ticket)
		if drift:
			print(f"oracle drift detected, restoring canonical copies: {drift}")
			stage(pilot_dir, workspace, ticket.number)
		if ticket.number != 1 and not frozen_ok:
			print("verify-surface drift detected, restoring ticket 001's frozen baseline")
			restore_verify_baseline(pilot_dir, workspace)
		if recoverable:
			print(
				f"recoverable build evidence failure for ticket {ticket.nnn}: "
				f"{', '.join(reasons)}",
				file=sys.stderr,
			)
		else:
			append_halt_record(workspace, ticket, reasons)
			print(f"GATE FAILED for ticket {ticket.nnn}: {', '.join(reasons)}", file=sys.stderr)
	else:
		print(f"GATE PASSED for ticket {ticket.nnn}")
	return passed


def print_status(
	pilot_dir: Path,
	tickets: list[Ticket],
	workspace: Path,
	review_policy: str = DEFAULT_REVIEW_POLICY,
) -> None:
	done_commits = committed_ticket_numbers(workspace)
	rescued = sum(1 for subject in done_commits.values() if "[rescued]" in subject)
	nxt, mode = next_ticket(tickets, pilot_dir, workspace, review_policy)
	print(f"pilot dir: {pilot_dir}")
	print(f"tickets total: {len(tickets)}")
	print(f"tickets committed: {len(done_commits)} (of which rescued: {rescued})")
	if nxt is None:
		print("next ticket: (none -- all tickets complete)")
	else:
		print(f"next ticket: {nxt.nnn}-{nxt.slug} ({mode})")
	for t in tickets:
		done = ticket_done(pilot_dir, workspace, t, review_policy)
		has_commit = t.number in done_commits
		marker = "x" if done else ("~" if has_commit else " ")
		rescue_tag = " [rescued]" if has_commit and "[rescued]" in done_commits[t.number] else ""
		print(f"  [{marker}] {t.nnn}-{t.slug}{rescue_tag}")
	print("  ('x' = done -- commit + passing gate; '~' = commit exists but gate not passing yet)")
	report_dir = pilot_dir / "reports"
	if report_dir.exists():
		latest = sorted(report_dir.glob("ticket-*/gate.json"))
		if latest:
			last = json.loads(latest[-1].read_text())
			print(f"last gate outcome ({last['ticket']}): {'PASS' if last['passed'] else 'FAIL'}")


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--pilot-dir", required=True, type=Path)
	parser.add_argument("--status", action="store_true", help="Read-only position report; runs nothing.")
	parser.add_argument(
		"--review-policy",
		choices=("advisory", "required", "degraded"),
		default=DEFAULT_REVIEW_POLICY,
		help="Pass the review policy to build_app.py; advisory is the default, required is intended for release-hardening runs.",
	)
	args = parser.parse_args()

	pilot_dir = args.pilot_dir.resolve()
	spec_dir = pilot_dir / "spec"
	workspace = pilot_dir / "workspace"
	tickets = discover_tickets(spec_dir)
	if not tickets:
		print(f"no tickets found under {spec_dir / 'tickets'}", file=sys.stderr)
		return 1

	if args.status:
		print_status(pilot_dir, tickets, workspace, args.review_policy)
		return 0

	lock_path = pilot_dir / ".ticket_runner.lock"
	lock_handle = lock_path.open("w")
	try:
		fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
	except OSError:
		print(
			f"another ticket_runner.py is already running against {pilot_dir} "
			f"(lock held on {lock_path}); refusing to race it",
			file=sys.stderr,
		)
		return 1

	while True:
		t, mode = next_ticket(tickets, pilot_dir, workspace, args.review_policy)
		if t is None:
			print("\nall tickets complete.")
			return 0
		build_attempt: int | None = None
		if mode in ("build", "retry", "policy"):
			build_attempt = next_build_attempt(pilot_dir, t)
			if mode != "policy" and build_attempt > MAX_BUILD_ATTEMPTS:
				gate = read_gate(pilot_dir, t)
				reasons = sorted(failed_check_names(gate)) or ["build retry limit exhausted"]
				append_halt_record(workspace, t, reasons)
				print(
					f"build attempt limit ({MAX_BUILD_ATTEMPTS}) exhausted for ticket {t.nnn}; "
					"stopping with evidence",
					file=sys.stderr,
				)
				return 1
		if mode == "retry":
			retry_count = build_attempt - 1
			print(
				f"previous build attempt ended without report evidence; "
				f"retrying {retry_count}/{MAX_BUILD_ATTEMPTS - 1} after {BUILD_RETRY_BACKOFF_S}s",
				file=sys.stderr,
			)
			time.sleep(BUILD_RETRY_BACKOFF_S)
		gate_attempt = next_gate_attempt(pilot_dir, t)
		ok = run_ticket(
			pilot_dir,
			workspace,
			t,
			tickets,
			skip_build=(mode == "regate"),
			gate_attempt=gate_attempt,
			build_attempt=build_attempt,
			review_policy=args.review_policy,
		)
		if not ok:
			if mode in ("build", "retry", "policy") and retryable_build_state(pilot_dir, workspace, t):
				continue
			return 1


if __name__ == "__main__":
	sys.exit(main())
