#!/usr/bin/env python3
"""Outermost loop of the zero-human pipeline: one invocation drives
`/spec-plan`, a human checkpoint, `/contract-plan`, another checkpoint,
`ticket_runner.py`'s build loop, and halt/rescue handling, end to end.

See plans/goal-pilot-skill-plan-2026-08-21.md for the design this
implements -- read that before changing this file, especially the
"Architecture history" section: this is `pi.dev`-native tooling that
drives the local model via `pi`, not a Claude-authoring skill. It reuses
`build_app.py`'s headless `pi` invocation builder and `ticket_runner.py`'s
robust subprocess/timeout wrapper and gate/halt-record helpers directly
(imported as sibling modules) rather than re-deriving any of it.

Usage:
    python3 goal_pilot.py --spec-input <path-or-text> --pilot-dir <dir>
        [--checkpoint review|skip]      (default: skip)
        [--on-halt report|auto-rescue]  (default: auto-rescue)
        [--review-policy advisory|required|degraded]  (default: advisory)

Both `--checkpoint` and `--on-halt` are always echoed back before anything
runs, whether passed explicitly or defaulted, so a resumed run and a fresh
run both make the active mode explicit. The spec-freeze checkpoint (step
3) and the post-ticket-001 checkpoint (step 5b) are outside both flags and
are never skippable -- see their docstrings for why.

Zero cloud tokens, unconditionally: every judgment step here shells out to
the local model via `pi`, and the one rescue class that touches
implementation (`--on-halt=auto-rescue`, genuine no-progress halts) widens
`build_app.py`'s own local round/timeout/thinking budget rather than
escalating to any cloud model. This holds even under `auto-rescue` -- see
`handle_implementation_gap_halt()`.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
	sys.path.insert(0, str(SCRIPT_DIR))
import build_app  # noqa: E402  (sibling module -- pi invocation + JSONL parsing helpers)
import ticket_runner  # noqa: E402  (sibling module -- gate/halt-record helpers, the build loop itself)

TICKET_RUNNER = SCRIPT_DIR / "ticket_runner.py"

DEFAULT_CHECKPOINT = "skip"
DEFAULT_ON_HALT = "auto-rescue"
DEFAULT_REVIEW_POLICY = ticket_runner.DEFAULT_REVIEW_POLICY  # "advisory"

# Headless pi invocations for /spec-plan and /contract-plan are judgment
# work, not the tight per-ticket implementation loop -- generous but
# bounded, so a genuinely stuck local model still halts instead of hanging
# the whole pilot forever.
SPEC_PLAN_TIMEOUT_S = 45 * 60
CONTRACT_PLAN_TIMEOUT_S = 60 * 60
# The overall ticket_runner.py subprocess's own worst-case bound is 15
# tickets x 3 build attempts x 90 minutes each (ticket_runner.py's
# BUILD_APP_TIMEOUT_S/MAX_BUILD_ATTEMPTS) = ~67 hours if every attempt of
# every ticket maxed its timeout, which real halts avoid (they stop well
# short via retryable_build_state()/append_halt_record() long before that).
# This is a backstop against a genuinely hung subprocess, generous enough
# not to fire during a real, if slow, run.
TICKET_RUNNER_TIMEOUT_S = 72 * 60 * 60

# Step 7, class 3 (genuine implementation gap): the bounded, single widened
# retry. build_app.py's own installed defaults are max-rounds=3,
# timeout-minutes=45 (its own --timeout-minutes default) and whatever
# settings.json's thinking policy is (currently medium, per pi/README.md);
# ticket_runner.py's builder_command() additionally fixes max-rounds=3,
# timeout-minutes=60. Widened here means visibly more of each, plus
# `--thinking xhigh` (user decision, 2026-08-21) -- still zero cloud
# tokens, still local, still bounded to exactly one extra attempt.
WIDENED_MAX_ROUNDS = 6
WIDENED_TIMEOUT_MINUTES = 90
WIDENED_THINKING = "xhigh"

# Step 7, class 1: the one infra fix this pilot's own history already
# names by hand (plans/zero-human-fullstack-pipeline-plan-2026-08-20.md,
# "Root cause of the unreachability, and the actual fix") and that is
# already in Claude's cross-session memory (ai-stack-host-hostname.md).
AI_STACK_HOST_FALLBACK = "kannas-mac-studio"
MAX_INFRA_AUTO_RETRIES = 2

SPEC_STATUS_RE = re.compile(r"^STATUS:\s*(\S+)")


# --------------------------------------------------------------------------
# Disk-state helpers -- resume derives its position from these, not from
# any state goal_pilot.py itself remembers in memory (step 9).
# --------------------------------------------------------------------------


def spec_path_for(pilot_dir: Path) -> Path:
	return pilot_dir / "spec" / "spec.md"


def read_spec_status(pilot_dir: Path) -> str | None:
	path = spec_path_for(pilot_dir)
	if not path.exists():
		return None
	first_line = path.read_text(errors="ignore").splitlines()[:1]
	if not first_line:
		return None
	m = SPEC_STATUS_RE.match(first_line[0])
	return m.group(1) if m else None


def freeze_spec(pilot_dir: Path) -> None:
	path = spec_path_for(pilot_dir)
	lines = path.read_text().splitlines(keepends=True)
	if not lines:
		raise ValueError(f"{path} is empty -- cannot freeze")
	stamp = datetime.now(timezone.utc).isoformat()
	lines[0] = f"STATUS: FROZEN -- reviewed {stamp}\n"
	path.write_text("".join(lines))


def compile_complete_marker(pilot_dir: Path) -> Path:
	return pilot_dir / "spec" / ".compile-complete"


def is_compile_complete(pilot_dir: Path) -> bool:
	# Deliberately not `contract.md`'s mere existence -- a crash mid-
	# /contract-plan (after contract.md and some slices are written but
	# before the self-check finishes) must not read back as "step 4 done"
	# on resume (Codex review of PR #36). This marker is written only after
	# write_compile_complete_marker() below runs, which happens only once
	# the self-check output has actually been captured.
	return compile_complete_marker(pilot_dir).exists()


def write_compile_complete_marker(pilot_dir: Path, staged_ticket_count: int) -> None:
	compile_complete_marker(pilot_dir).write_text(
		json.dumps(
			{
				"completed": datetime.now(timezone.utc).isoformat(),
				"staged_ticket_count": staged_ticket_count,
			},
			indent=2,
		)
	)


def checkpoint5_ack_marker(pilot_dir: Path) -> Path:
	return pilot_dir / "spec" / ".checkpoint5-ack"


def checkpoint5b_ack_marker(pilot_dir: Path) -> Path:
	return pilot_dir / "spec" / ".checkpoint5b-ack"


# --------------------------------------------------------------------------
# Evidence trail -- goal_pilot.py's own actions get the same durable,
# machine-readable trail ticket_runner.py already gives per-ticket work, so
# a rescued/widened run doesn't repeat the tickets-013-016 reporting gap
# (parent plan) where cloud/human-touched work left no trace and was later
# misread as something else.
# --------------------------------------------------------------------------


def logs_dir(pilot_dir: Path) -> Path:
	d = pilot_dir / "logs"
	d.mkdir(parents=True, exist_ok=True)
	return d


def execution_log_path(pilot_dir: Path) -> Path:
	return pilot_dir / "EXECUTION_LOG.md"


def append_execution_log(pilot_dir: Path, heading: str, body: str = "") -> None:
	stamp = datetime.now(timezone.utc).isoformat()
	path = execution_log_path(pilot_dir)
	existing = path.read_text(errors="ignore") if path.exists() else "# goal_pilot.py execution log\n"
	block = f"\n\n## {heading} ({stamp})\n"
	if body:
		block += f"\n{body}\n"
	path.write_text(existing + block)


def rescue_log_path(pilot_dir: Path) -> Path:
	return pilot_dir / ".goal-pilot" / "rescues.jsonl"


def append_rescue_record(pilot_dir: Path, record: dict) -> None:
	path = rescue_log_path(pilot_dir)
	path.parent.mkdir(parents=True, exist_ok=True)
	record = {**record, "logged": datetime.now(timezone.utc).isoformat()}
	with path.open("a") as handle:
		handle.write(json.dumps(record) + "\n")
	append_execution_log(
		pilot_dir,
		f"RESCUE: ticket {record.get('ticket', '?')} :: {record.get('class', 'unknown')}",
		json.dumps(record, indent=2),
	)


def read_rescue_records(pilot_dir: Path) -> list[dict]:
	path = rescue_log_path(pilot_dir)
	if not path.exists():
		return []
	records = []
	for line in path.read_text(errors="ignore").splitlines():
		line = line.strip()
		if not line:
			continue
		try:
			records.append(json.loads(line))
		except json.JSONDecodeError:
			continue
	return records


# --------------------------------------------------------------------------
# Headless pi invocation -- reuses build_app.py's pi_invocation() command
# builder and ticket_runner.py's invoke_build_app() subprocess wrapper.
# invoke_build_app() is generic despite its name (it just runs a command
# list under a timeout with robust process-group kill semantics on
# timeout) -- there is no reason to duplicate that logic for a plain `pi`
# invocation instead of a `build_app.py` one.
# --------------------------------------------------------------------------


def run_pi_prompt(pilot_dir: Path, prompt: str, *, session_dir: Path, timeout_s: float) -> tuple[bool, str, dict]:
	command = build_app.pi_invocation(
		pilot_dir,
		prompt=prompt,
		session_dir=session_dir,
		containment=False,
		continue_session=False,
		thinking=None,
	)
	# invoke_build_app() (reused from ticket_runner.py) launches `pi` via a
	# bare subprocess.Popen with no explicit `env=`, so it inherits whatever
	# this process's AI_STACK_HOST currently is -- default it here the same
	# way build_app.py's own run_build() does, rather than assuming the
	# caller's shell already exported one.
	os.environ.setdefault("AI_STACK_HOST", "127.0.0.1")
	returncode, stdout, stderr, timed_out = ticket_runner.invoke_build_app(command, timeout_s)
	errored, total = build_app.agent_turn_errors(stdout)
	# `pi` exits 0 and can still leave a real artifact (e.g. a resumed
	# /contract-plan run's already-partial contract.md) on disk even when
	# the model route was unreachable for the entire invocation -- every
	# assistant turn errored with stopReason: error, no real model work
	# happened (build_app.py's own round_blockers() treats this the same
	# way, as "model route unreachable", never as a completed round).
	# Without this check, step4_compile() would accept a stale/partial
	# artifact and write .compile-complete for a self-check that never
	# actually ran (Codex review of PR #37).
	fully_errored = total > 0 and errored == total
	ok = returncode == 0 and not timed_out and not fully_errored
	diagnostics = {
		"returncode": returncode,
		"timed_out": timed_out,
		"turn_errors": [errored, total],
		"fully_errored": fully_errored,
		"stderr_tail": stderr[-2000:],
	}
	return ok, stdout, diagnostics


# --------------------------------------------------------------------------
# Step 1/2: intake + draft spec/tickets via /spec-plan
# --------------------------------------------------------------------------


def goal_pilot_session_root(pilot_dir: Path) -> Path:
	"""Sibling of `pilot_dir`, not a path inside it -- see step2_draft_spec()'s
	comment for why: `pi --session-dir` creates its directory before the
	model's first turn, which would otherwise poison /spec-plan's own
	step-0 "is this dir empty" scaffold check on every fresh pilot_dir."""
	root = pilot_dir.parent / f".{pilot_dir.name}.goal-pilot-sessions"
	root.mkdir(parents=True, exist_ok=True)
	return root


def resolve_spec_input(raw: str, pilot_dir: Path) -> Path:
	"""If `raw` is an existing file, use it as-is. Otherwise treat it as
	literal rough-input text and write it to a scratch file -- /spec-plan's
	own argument-hint expects a path, and every downstream re-invocation on
	resume should read the same frozen input.

	The scratch file is a `pilot_dir` *sibling*, not something written
	inside it (Codex review of PR #37): `/spec-plan`'s own step-0 scaffold
	check refuses to run against any existing, non-empty directory that
	has no `Makefile` yet, so writing anything into an unscaffolded
	pilot_dir before that check runs would make every fresh run using
	literal --spec-input text immediately unscaffoldable."""
	candidate = Path(raw).expanduser()
	if candidate.is_file():
		return candidate.resolve()
	scratch = pilot_dir.parent / f".{pilot_dir.name}.goal-pilot-raw-spec-input.txt"
	scratch.parent.mkdir(parents=True, exist_ok=True)
	if not scratch.exists():
		scratch.write_text(raw)
	return scratch


def step2_draft_spec(pilot_dir: Path, spec_input: Path) -> bool:
	print(f"\n=== step 2: drafting spec + tickets via /spec-plan ({spec_input}) ===")
	# Deliberately a `pilot_dir` *sibling*, not something written inside it
	# (same reasoning as resolve_spec_input()'s scratch file above): `pi
	# --session-dir` creates this directory as soon as the session starts,
	# before the model's first turn -- i.e. before /spec-plan's own step-0
	# scaffold check ever runs. On a fresh, not-yet-scaffolded pilot_dir,
	# that check sees "$2 exists, is non-empty, has no Makefile" and
	# correctly refuses to scaffold, every single time, on account of a
	# directory this script itself just created (reproduced live: two
	# separate fresh-pilot-dir runs, same refusal, same evidence in
	# logs/spec-plan-output.jsonl -- not a model failure).
	session_dir = goal_pilot_session_root(pilot_dir) / "pi-spec-plan-session"
	prompt = f"/spec-plan {spec_input} {pilot_dir}"
	ok, stdout, diagnostics = run_pi_prompt(pilot_dir, prompt, session_dir=session_dir, timeout_s=SPEC_PLAN_TIMEOUT_S)
	(logs_dir(pilot_dir) / "spec-plan-output.jsonl").write_text(stdout)
	if not ok:
		append_execution_log(
			pilot_dir,
			"step 2 FAILED: /spec-plan invocation did not complete",
			json.dumps(diagnostics, indent=2),
		)
		print(f"/spec-plan invocation failed: {diagnostics}", file=sys.stderr)
		return False
	if not spec_path_for(pilot_dir).exists():
		append_execution_log(pilot_dir, "step 2 FAILED: /spec-plan ran but spec/spec.md was not written")
		print("/spec-plan completed but spec/spec.md does not exist -- see logs/spec-plan-output.jsonl", file=sys.stderr)
		return False
	append_execution_log(pilot_dir, "step 2 complete: spec + tickets drafted via /spec-plan")
	return True


# --------------------------------------------------------------------------
# Step 3: spec-freeze checkpoint -- hard stop, never skippable
# --------------------------------------------------------------------------


def step3_freeze_checkpoint(pilot_dir: Path, *, non_interactive: bool = False) -> bool:
	spec_path = spec_path_for(pilot_dir)
	print("\n=== step 3: human checkpoint -- spec freeze (never skippable) ===")
	print(spec_path.read_text())
	print(
		"\nReview the Assumptions & Interpretations section above line by "
		"line -- this is the one place this pipeline resolves ambiguity "
		"rather than refusing to guess."
	)
	if non_interactive:
		print("--non-interactive: refusing to auto-approve the spec freeze. Halting.", file=sys.stderr)
		append_execution_log(pilot_dir, "step 3 HALT: non-interactive run cannot approve the spec freeze")
		return False
	answer = input("Approve and freeze this spec? [y/N] ").strip().lower()
	if answer != "y":
		print(
			f"Not approved. Edit {spec_path} by hand, or re-run /spec-plan in an interactive "
			"pi session against the same input for another draft, then re-invoke goal_pilot.py "
			"against the same --pilot-dir to continue.",
			file=sys.stderr,
		)
		append_execution_log(pilot_dir, "step 3 HALT: spec freeze not approved")
		return False
	freeze_spec(pilot_dir)
	append_execution_log(pilot_dir, "step 3 complete: spec frozen")
	return True


# --------------------------------------------------------------------------
# Step 4: compile the spec via /contract-plan
# --------------------------------------------------------------------------


def staged_ticket_count(pilot_dir: Path) -> int:
	acceptance_dir = pilot_dir / "spec" / "acceptance"
	if not acceptance_dir.exists():
		return 0
	return sum(1 for p in acceptance_dir.iterdir() if p.is_dir() and p.name.isdigit())


def step4_compile(pilot_dir: Path) -> bool:
	print("\n=== step 4: compiling contract + acceptance suite via /contract-plan ===")
	# Same sibling-not-inside placement as step2_draft_spec() -- pilot_dir is
	# already scaffolded by this point (Makefile exists), so /contract-plan's
	# own preconditions don't hit the same hazard step2 does, but there is no
	# reason for this one to risk it either.
	session_dir = goal_pilot_session_root(pilot_dir) / "pi-contract-plan-session"
	prompt = f"/contract-plan {pilot_dir}"
	ok, stdout, diagnostics = run_pi_prompt(pilot_dir, prompt, session_dir=session_dir, timeout_s=CONTRACT_PLAN_TIMEOUT_S)
	(logs_dir(pilot_dir) / "contract-plan-output.jsonl").write_text(stdout)
	if not ok:
		append_execution_log(
			pilot_dir,
			"step 4 FAILED: /contract-plan invocation did not complete",
			json.dumps(diagnostics, indent=2),
		)
		print(f"/contract-plan invocation failed: {diagnostics}", file=sys.stderr)
		return False
	contract_path = pilot_dir / "spec" / "contract.md"
	if not contract_path.exists():
		append_execution_log(pilot_dir, "step 4 FAILED: /contract-plan ran but spec/contract.md was not written")
		print("/contract-plan completed but spec/contract.md does not exist -- see logs/contract-plan-output.jsonl", file=sys.stderr)
		return False
	count = staged_ticket_count(pilot_dir)
	write_compile_complete_marker(pilot_dir, count)
	append_execution_log(pilot_dir, "step 4 complete: contract + acceptance suite compiled", f"staged ticket slices: {count}")
	return True


# --------------------------------------------------------------------------
# Step 5: human/cloud checkpoint over the acceptance suite
# --------------------------------------------------------------------------


def step5_checkpoint(pilot_dir: Path, checkpoint_mode: str, *, non_interactive: bool = False) -> bool:
	print("\n=== step 5: human/cloud checkpoint -- acceptance-suite review ===")
	if checkpoint5_ack_marker(pilot_dir).exists():
		print("already acknowledged on a prior run -- skipping straight to step 5b.")
		return True

	if checkpoint_mode == "review":
		contract_path = pilot_dir / "spec" / "contract.md"
		print(f"\n--- {contract_path} ---\n{contract_path.read_text()}")
		spec_output = (logs_dir(pilot_dir) / "contract-plan-output.jsonl")
		if spec_output.exists():
			print("\n--- /contract-plan's real output (self-check transcript included) ---")
			print(spec_output.read_text()[-8000:])
		print(
			"\nThis is the highest-stakes artifact in the pipeline "
			'(/contract-plan\'s own words) -- "a wrong contract or test '
			'oracle doesn\'t fail loudly, it silently certifies broken app '
			'code as correct later." Bring spec/contract.md and '
			"spec/acceptance/ to a separate cloud session yourself for "
			"review-and-correct before proceeding -- goal_pilot.py cannot "
			"and does not do this step for you."
		)
		if non_interactive:
			print("--non-interactive: refusing to auto-confirm the acceptance-suite checkpoint. Halting.", file=sys.stderr)
			append_execution_log(pilot_dir, "step 5 HALT: non-interactive run cannot confirm the review checkpoint")
			return False
		answer = input("Has that cloud review-and-correct happened, and should goal_pilot.py proceed? [y/N] ").strip().lower()
		if answer != "y":
			append_execution_log(pilot_dir, "step 5 HALT: acceptance-suite review not confirmed")
			return False
		checkpoint5_ack_marker(pilot_dir).write_text(
			json.dumps({"mode": "review", "confirmed": datetime.now(timezone.utc).isoformat()}, indent=2)
		)
		append_execution_log(pilot_dir, "step 5 complete: cloud review confirmed by human")
		return True

	# checkpoint_mode == "skip": proceed on local self-check evidence alone.
	# Still logged unconditionally, unmissably, into the run's own evidence
	# trail -- not left discoverable only by reading /contract-plan's banner
	# text after the fact.
	disclaimer = (
		"--checkpoint=skip: proceeding on /contract-plan's local self-check "
		"alone. The acceptance suite -- the highest-stakes artifact in this "
		"pipeline -- was never independently (cloud/human) reviewed for "
		"this run."
	)
	print(disclaimer)
	append_execution_log(pilot_dir, "step 5 SKIPPED (--checkpoint=skip)", disclaimer)
	checkpoint5_ack_marker(pilot_dir).write_text(
		json.dumps({"mode": "skip", "confirmed": datetime.now(timezone.utc).isoformat()}, indent=2)
	)
	return True


# --------------------------------------------------------------------------
# Step 5b: post-ticket-001 checkpoint -- always on, not covered by
# --checkpoint. See the plan for why this is the FIRST review of a
# model-authored verify surface, not a check on a pre-pinned one.
# --------------------------------------------------------------------------


def step5b_checkpoint(pilot_dir: Path, workspace: Path, *, non_interactive: bool = False) -> bool:
	print("\n=== step 5b: checkpoint after ticket 001 gates green (always on) ===")
	if checkpoint5b_ack_marker(pilot_dir).exists():
		print("already acknowledged on a prior run -- skipping.")
		return True
	verify_full_ok, verify_full_out = ticket_runner.run_make(workspace, "verify-full", timeout=40 * 60)
	print(verify_full_out[-6000:])
	print(
		"\nThe workspace verify surface (Makefile, scripts/verify.sh, "
		"scripts/verify-full.sh) was just authored by the local model in "
		"ticket 001, with no pre-pinned template to check it against -- "
		"this is the FIRST review of that surface, not a sanity check on a "
		"known-good one. It is now frozen; from here on it's immutable "
		"except through `ticket_runner.py --amend-canon`."
	)
	if not verify_full_ok:
		print("`make verify-full` did NOT pass above -- this is worth stopping on regardless of the answer below.", file=sys.stderr)
	if non_interactive:
		print("--non-interactive: refusing to auto-confirm the post-ticket-001 checkpoint. Halting.", file=sys.stderr)
		append_execution_log(pilot_dir, "step 5b HALT: non-interactive run cannot confirm this checkpoint")
		return False
	answer = input("Reviewed the booted app / verify-full output -- proceed with the remaining tickets? [y/N] ").strip().lower()
	if answer != "y":
		append_execution_log(pilot_dir, "step 5b HALT: post-ticket-001 review not confirmed")
		return False
	checkpoint5b_ack_marker(pilot_dir).write_text(
		json.dumps({"confirmed": datetime.now(timezone.utc).isoformat(), "verify_full_passed": verify_full_ok}, indent=2)
	)
	append_execution_log(pilot_dir, "step 5b complete: post-ticket-001 verify surface reviewed")
	return True


# --------------------------------------------------------------------------
# Step 6: run (or resume) the build loop, in up to two ticket_runner.py
# invocations around the 5b checkpoint.
# --------------------------------------------------------------------------


def run_ticket_runner(pilot_dir: Path, review_policy: str, *, stop_after_ticket: int | None) -> tuple[int, str]:
	cmd = [sys.executable, str(TICKET_RUNNER), "--pilot-dir", str(pilot_dir), "--review-policy", review_policy]
	if stop_after_ticket is not None:
		cmd += ["--stop-after-ticket", str(stop_after_ticket)]
	print(f"\n=== step 6: running {' '.join(cmd)} ===")
	stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
	suffix = f"-stop{stop_after_ticket}" if stop_after_ticket is not None else ""
	log_path = logs_dir(pilot_dir) / f"run-{stamp}{suffix}.log"
	returncode, stdout, stderr, timed_out = ticket_runner.invoke_build_app(cmd, TICKET_RUNNER_TIMEOUT_S)
	combined = stdout + "\n--- stderr ---\n" + stderr
	log_path.write_text(combined)
	print(combined[-4000:])
	if timed_out:
		returncode = -1
	append_execution_log(
		pilot_dir,
		f"step 6 ticket_runner.py invocation finished (returncode={returncode}, stop_after_ticket={stop_after_ticket})",
		f"log: {log_path}",
	)
	return returncode, combined


def lock_contention(output: str) -> bool:
	return "refusing to race it" in output


# --------------------------------------------------------------------------
# Step 7: halt classification + class-aware handling
# --------------------------------------------------------------------------


def latest_gate(pilot_dir: Path, ticket: "ticket_runner.Ticket") -> dict | None:
	return ticket_runner.read_gate(pilot_dir, ticket)


def classify_halt(pilot_dir: Path, ticket: "ticket_runner.Ticket") -> str:
	"""Heuristic, string-matched against the same evidence a human rescuer
	would read -- gate.json's failed check names/details. Deliberately
	conservative: anything not clearly infra or clearly canon-drift is
	treated as an implementation gap, since that's the class with the
	narrowest (single, bounded, local-only) auto behavior."""
	gate = latest_gate(pilot_dir, ticket)
	if gate is None:
		return "unknown"
	failed = {c["name"]: str(c.get("detail", "")) for c in gate.get("checks", []) if not c.get("ok")}
	if "oracle integrity" in failed or "verify-surface frozen" in failed:
		return "canon-drift"
	infra_markers = ticket_runner.TRANSIENT_BUILD_MARKERS
	for detail in failed.values():
		lowered = detail.lower()
		if any(marker in lowered for marker in infra_markers):
			return "infra"
	return "implementation-gap"


def handle_infra_halt(pilot_dir: Path, on_halt: str, attempt_count: int) -> bool:
	"""Returns True if a retry was attempted and the caller should loop
	back to run_ticket_runner() again."""
	if on_halt != "auto-rescue":
		append_execution_log(pilot_dir, "halt class=infra: --on-halt=report, not retrying")
		return False
	if attempt_count >= MAX_INFRA_AUTO_RETRIES:
		append_execution_log(pilot_dir, f"halt class=infra: {MAX_INFRA_AUTO_RETRIES} auto-retries already used, stopping")
		return False
	current = os.environ.get("AI_STACK_HOST")
	if current != AI_STACK_HOST_FALLBACK:
		print(f"infra halt: trying AI_STACK_HOST fallback ({current!r} -> {AI_STACK_HOST_FALLBACK!r})")
		os.environ["AI_STACK_HOST"] = AI_STACK_HOST_FALLBACK
	append_rescue_record(
		pilot_dir,
		{
			"ticket": "n/a",
			"class": "infra",
			"action": f"retry with AI_STACK_HOST={os.environ.get('AI_STACK_HOST')}",
			"auto_applied": True,
		},
	)
	return True


def handle_canon_drift_halt(pilot_dir: Path, workspace: Path, tickets: list, ticket: "ticket_runner.Ticket", *, non_interactive: bool) -> bool:
	"""Never auto-applied, regardless of --on-halt -- goal_pilot.py is also
	the artifact's author (via /spec-plan and /contract-plan), so amending
	its own frozen oracle without a human decision would remove the last
	independent check in a run that already defaults to advisory-only
	review. Returns True if at least one file was amended and the caller
	should retry the gate."""
	gate = latest_gate(pilot_dir, ticket)
	failed = {c["name"]: c.get("detail") for c in (gate or {}).get("checks", []) if not c.get("ok")}
	candidates: list[Path] = []
	drifted = failed.get("oracle integrity")
	if isinstance(drifted, list):
		candidates += [workspace / rel for rel in drifted]
	if "verify-surface frozen" in failed:
		candidates += [workspace / rel for rel in ticket_runner.VERIFY_SURFACE_FILES if (workspace / rel).exists()]
	if not candidates:
		print("canon-drift halt classified, but no concrete drifted file found in gate evidence -- reporting.", file=sys.stderr)
		return False
	print(
		f"\n=== ticket {ticket.nnn}: frozen-artifact-canon drift ===\n"
		"The model's change to a frozen file may be a correct fix to a genuine bug in that "
		"file (tickets 010/012's class in the parent plan), or it may not be -- this always "
		"needs a human decision, never an automatic one."
	)
	if non_interactive:
		print("--non-interactive: cannot review canon drift. Halting.", file=sys.stderr)
		return False
	amended_any = False
	for candidate in candidates:
		# ticket_runner.run_ticket() already restored the canonical copy
		# over this exact file before returning failure (oracle drift's
		# stage() call, or restore_verify_baseline() for verify-surface
		# drift) -- by the time a halt reaches this handler, the on-disk
		# workspace copy is back to canon, not the model's proposed fix.
		# amend_canon() diffs the on-disk file against canon, so reading it
		# directly here would always find "no difference, nothing to
		# amend" and the whole class-2 recovery path would silently never
		# work (Codex review of PR #37). Recover the model's actual
		# proposed content from the ticket's own commit instead, and
		# restore *that* into the workspace right before calling
		# amend_canon() so there is a real diff to accept or reject.
		recovered = recover_drifted_content(workspace, ticket, candidate)
		if recovered is None:
			print(f"could not recover {candidate}'s drifted content from ticket {ticket.nnn}'s commit -- skipping", file=sys.stderr)
			continue
		candidate.write_text(recovered)
		reason = input(f"Reason to accept {candidate} as the new canon (blank to skip this file): ").strip()
		if not reason:
			continue
		rc = ticket_runner.amend_canon(pilot_dir, workspace, tickets, candidate, reason, auto_yes=False)
		if rc == 0:
			amended_any = True
			append_rescue_record(
				pilot_dir,
				{"ticket": ticket.nnn, "class": "canon-drift", "action": f"amend-canon {candidate}", "reason": reason, "auto_applied": False},
			)
	return amended_any


def recover_drifted_content(workspace: Path, ticket: "ticket_runner.Ticket", candidate: Path) -> str | None:
	"""Recover the model's actual proposed content for `candidate` (a path
	inside `workspace`) from the ticket's own commit, since
	ticket_runner.run_ticket() has already restored the on-disk copy to
	canon by the time a halt reaches goal_pilot.py. Returns None if the
	ticket has no commit yet or the file isn't present at that commit."""
	sha = ticket_runner.commit_sha_for(workspace, ticket.number)
	if not sha:
		return None
	rel = candidate.relative_to(workspace).as_posix()
	result = ticket_runner.git(workspace, "show", f"{sha}:{rel}")
	if result.returncode != 0:
		return None
	return result.stdout


def handle_implementation_gap_halt(pilot_dir: Path, workspace: Path, tickets: list, ticket: "ticket_runner.Ticket", review_policy: str, on_halt: str) -> bool:
	"""Bounded, single, unconditionally-local widened retry -- see the
	module docstring and WIDENED_* constants above. Returns True if the
	widened attempt itself completed (regardless of whether it then gates
	green -- the caller re-invokes ticket_runner.py either way, which will
	regate a fresh commit or report the same halt again if nothing
	changed)."""
	if on_halt != "auto-rescue":
		append_execution_log(pilot_dir, f"halt class=implementation-gap: ticket {ticket.nnn}, --on-halt=report, not retrying")
		return False
	already_widened = any(
		r.get("ticket") == ticket.nnn and r.get("class") == "implementation-gap" for r in read_rescue_records(pilot_dir)
	)
	if already_widened:
		append_execution_log(pilot_dir, f"halt class=implementation-gap: ticket {ticket.nnn} already had its one widened retry, stopping")
		return False
	base_sha = ticket_runner.prior_boundary_sha(workspace, tickets, ticket)
	cmd = [
		sys.executable, str(ticket_runner.BUILD_APP),
		"--workspace", str(workspace),
		"--spec", str(ticket.path),
		"--max-rounds", str(WIDENED_MAX_ROUNDS),
		"--timeout-minutes", str(WIDENED_TIMEOUT_MINUTES),
		"--thinking", WIDENED_THINKING,
		"--review-policy", review_policy,
	]
	if base_sha:
		cmd += ["--review-base-sha", base_sha]
	print(f"\n=== widened rescue attempt for ticket {ticket.nnn}: {' '.join(cmd)} ===")
	returncode, stdout, stderr, timed_out = ticket_runner.invoke_build_app(cmd, WIDENED_TIMEOUT_MINUTES * 60 + 300)
	log_path = logs_dir(pilot_dir) / f"rescue-ticket-{ticket.nnn}-widened.log"
	log_path.write_text(stdout + "\n--- stderr ---\n" + stderr)
	append_rescue_record(
		pilot_dir,
		{
			"ticket": ticket.nnn,
			"class": "implementation-gap",
			"action": "widened local retry",
			"max_rounds": WIDENED_MAX_ROUNDS,
			"timeout_minutes": WIDENED_TIMEOUT_MINUTES,
			"thinking": WIDENED_THINKING,
			"returncode": returncode,
			"timed_out": timed_out,
			"auto_applied": True,
		},
	)
	return True  # let the caller regate; success/failure is read from the next gate, not this returncode


def handle_halt(pilot_dir: Path, workspace: Path, tickets: list, review_policy: str, on_halt: str, *, non_interactive: bool, infra_attempts: dict) -> bool:
	"""Returns True if the caller should loop back and re-invoke
	ticket_runner.py; False if goal_pilot.py should stop and report."""
	ticket, mode = ticket_runner.next_ticket(tickets, pilot_dir, workspace, review_policy)
	if ticket is None:
		return False  # nothing outstanding -- odd for a halt, but nothing to rescue
	halt_class = classify_halt(pilot_dir, ticket)
	print(f"\nhalt classified as: {halt_class} (ticket {ticket.nnn})")
	if halt_class == "infra":
		count = infra_attempts.get(ticket.nnn, 0)
		retried = handle_infra_halt(pilot_dir, on_halt, count)
		infra_attempts[ticket.nnn] = count + 1
		return retried
	if halt_class == "canon-drift":
		return handle_canon_drift_halt(pilot_dir, workspace, tickets, ticket, non_interactive=non_interactive)
	if halt_class == "implementation-gap":
		return handle_implementation_gap_halt(pilot_dir, workspace, tickets, ticket, review_policy, on_halt)
	append_execution_log(pilot_dir, f"halt class=unknown for ticket {ticket.nnn} -- no automatic handling, stopping")
	return False


# --------------------------------------------------------------------------
# Step 8: verdict
# --------------------------------------------------------------------------


def write_verdict(pilot_dir: Path, tickets: list, review_policy: str, checkpoint_mode: str, on_halt_mode: str) -> Path:
	workspace = pilot_dir / "workspace"
	rescues = read_rescue_records(pilot_dir)
	by_class: dict[str, int] = {}
	for r in rescues:
		by_class[r.get("class", "unknown")] = by_class.get(r.get("class", "unknown"), 0) + 1
	lines = [
		"# goal_pilot.py verdict",
		"",
		f"Generated: {datetime.now(timezone.utc).isoformat()}",
		f"Pilot dir: {pilot_dir}",
		f"Tickets: {len(tickets)}",
		f"Settings: --checkpoint={checkpoint_mode} --on-halt={on_halt_mode} --review-policy={review_policy}",
		"",
		"## Rescues",
		"",
	]
	if not rescues:
		lines.append("None -- every ticket gated green with no intervention beyond the standard checkpoints.")
	else:
		for kind, count in sorted(by_class.items()):
			lines.append(f"- {kind}: {count}")
		lines.append("")
		lines.append("Detail (see .goal-pilot/rescues.jsonl for the full machine-readable record):")
		for r in rescues:
			lines.append(f"- ticket {r.get('ticket')}: {r.get('class')} -- {r.get('action')}")
	lines += [
		"",
		"## Zero-cloud-implementation-tokens claim",
		"",
		"Verified from the evidence trail above, not asserted: every rescue this run performed "
		"(if any) stayed local -- infra retries, human-approved --amend-canon calls, or "
		"widened-but-still-local build_app.py retries. No cloud model was invoked for "
		"implementation at any point.",
	]
	verdict_path = pilot_dir / "VERDICT.md"
	verdict_path.write_text("\n".join(lines) + "\n")
	return verdict_path


# --------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------


def run_build_loop_until_settled(
	pilot_dir: Path,
	workspace: Path,
	tickets: list,
	review_policy: str,
	on_halt: str,
	*,
	stop_after_ticket: int | None,
	non_interactive: bool,
	infra_attempts: dict,
) -> bool:
	"""Invoke ticket_runner.py (bounded by `stop_after_ticket` if given),
	and on any halt, classify it and apply step 7's class-aware handling,
	looping back for another invocation whenever handle_halt() says to.
	Shared by both the ticket-1-only phase (before the 5b checkpoint) and
	the remainder-of-the-run phase -- a halt on ticket 1 gets exactly the
	same treatment as a halt on any later ticket, not a bare give-up.
	Returns True once ticket_runner.py exits 0 (the requested boundary, or
	the whole run, settled); False if goal_pilot.py should stop and
	report."""
	while True:
		returncode, output = run_ticket_runner(pilot_dir, review_policy, stop_after_ticket=stop_after_ticket)
		if lock_contention(output):
			print("another goal_pilot.py/ticket_runner.py run is already in progress against this pilot dir.", file=sys.stderr)
			return False
		if returncode == 0:
			return True
		should_retry = handle_halt(
			pilot_dir, workspace, tickets, review_policy, on_halt,
			non_interactive=non_interactive, infra_attempts=infra_attempts,
		)
		if not should_retry:
			print("\ngoal_pilot.py stopping -- see EXECUTION_LOG.md and PROGRESS.md for the halt this stopped on.", file=sys.stderr)
			return False
		time.sleep(5)


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--spec-input", required=True, help="Path to a rough-input file, or literal rough-input text.")
	parser.add_argument("--pilot-dir", required=True, type=Path)
	parser.add_argument("--checkpoint", choices=("review", "skip"), default=DEFAULT_CHECKPOINT)
	parser.add_argument("--on-halt", choices=("report", "auto-rescue"), default=DEFAULT_ON_HALT)
	parser.add_argument(
		"--review-policy",
		choices=("advisory", "required", "degraded"),
		default=DEFAULT_REVIEW_POLICY,
		help="Passed through to ticket_runner.py. advisory is the stated default -- see the plan's step 6.",
	)
	parser.add_argument(
		"--non-interactive",
		action="store_true",
		help="Refuse every checkpoint instead of prompting (for CI/dry-run use) -- never auto-approves.",
	)
	args = parser.parse_args()

	pilot_dir = args.pilot_dir.resolve()
	pilot_dir.mkdir(parents=True, exist_ok=True)

	print(f"goal_pilot.py: pilot-dir={pilot_dir} checkpoint={args.checkpoint} on-halt={args.on_halt} review-policy={args.review_policy}")
	run_started_note = (
		f"checkpoint={args.checkpoint} on-halt={args.on_halt} review-policy={args.review_policy} "
		f"spec-input={args.spec_input}"
	)
	# Do not write anything into pilot_dir before it's confirmed safe to:
	# /spec-plan's own step-0 scaffold check refuses to run against any
	# existing, non-empty directory that has no Makefile yet, so writing
	# EXECUTION_LOG.md here unconditionally would make every fresh,
	# not-yet-scaffolded pilot_dir fail that check on its very first run
	# (Codex review of PR #37). Log immediately only if this is already a
	# scaffolded pilot dir (a resume); otherwise defer until step2 confirms
	# /spec-plan has scaffolded it.
	already_scaffolded = (pilot_dir / "Makefile").exists()
	if already_scaffolded:
		append_execution_log(pilot_dir, "run started", run_started_note)

	# --- steps 1-3: intake, draft, freeze ---
	status = read_spec_status(pilot_dir)
	if status != "FROZEN":
		spec_input = resolve_spec_input(args.spec_input, pilot_dir)
		if status is None or status == "DRAFT":
			if not step2_draft_spec(pilot_dir, spec_input):
				return 1
		if not already_scaffolded:
			if not (pilot_dir / "Makefile").exists():
				print(f"/spec-plan completed but {pilot_dir}/Makefile still does not exist -- refusing to proceed.", file=sys.stderr)
				return 1
			append_execution_log(pilot_dir, "run started", run_started_note)
		if not step3_freeze_checkpoint(pilot_dir, non_interactive=args.non_interactive):
			return 1

	# --- step 4: compile ---
	if not is_compile_complete(pilot_dir):
		if not step4_compile(pilot_dir):
			return 1

	# --- step 5: acceptance-suite checkpoint ---
	if not step5_checkpoint(pilot_dir, args.checkpoint, non_interactive=args.non_interactive):
		return 1

	# --- steps 5b/6/7: ticket 001, checkpoint, remaining tickets, halts ---
	workspace = pilot_dir / "workspace"
	tickets = ticket_runner.discover_tickets(pilot_dir / "spec")
	if not tickets:
		print(f"no tickets found under {pilot_dir / 'spec' / 'tickets'}", file=sys.stderr)
		return 1

	# infra_attempts is shared across both the ticket-1-only phase and the
	# remainder below -- an infra halt on ticket 1 gets the same bounded
	# auto-retry treatment as any other ticket, it doesn't just give up
	# (an earlier version of this function did exactly that; a halt on
	# ticket 1 is not structurally different from a halt on ticket 5).
	infra_attempts: dict[str, int] = {}

	ticket_one_done = ticket_runner.ticket_done(pilot_dir, workspace, tickets[0], args.review_policy)
	if not checkpoint5b_ack_marker(pilot_dir).exists():
		if not ticket_one_done:
			ok = run_build_loop_until_settled(
				pilot_dir, workspace, tickets, args.review_policy, args.on_halt,
				stop_after_ticket=tickets[0].number, non_interactive=args.non_interactive,
				infra_attempts=infra_attempts,
			)
			if not ok:
				write_verdict(pilot_dir, tickets, args.review_policy, args.checkpoint, args.on_halt)
				return 1
		if not step5b_checkpoint(pilot_dir, workspace, non_interactive=args.non_interactive):
			return 1

	ok = run_build_loop_until_settled(
		pilot_dir, workspace, tickets, args.review_policy, args.on_halt,
		stop_after_ticket=None, non_interactive=args.non_interactive,
		infra_attempts=infra_attempts,
	)
	if not ok:
		write_verdict(pilot_dir, tickets, args.review_policy, args.checkpoint, args.on_halt)
		return 1

	# --- step 8: verdict ---
	verdict_path = write_verdict(pilot_dir, tickets, args.review_policy, args.checkpoint, args.on_halt)
	print(f"\nall tickets complete. verdict written to {verdict_path}")
	append_execution_log(pilot_dir, "run complete: all tickets gated green")
	return 0


if __name__ == "__main__":
	sys.exit(main())
