import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "goal_pilot.py"
SPEC = importlib.util.spec_from_file_location("goal_pilot", SCRIPT)
assert SPEC and SPEC.loader
goal_pilot = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = goal_pilot
SPEC.loader.exec_module(goal_pilot)

ticket_runner = goal_pilot.ticket_runner


def make_ticket(number=1, slug="workspace-scaffold"):
	return ticket_runner.Ticket(number, slug, Path(f"{number:03d}-{slug}.md"))


def write_gate(pilot_dir: Path, ticket, checks: list[dict], passed: bool = False):
	report_dir = pilot_dir / "reports" / f"ticket-{ticket.nnn}"
	report_dir.mkdir(parents=True, exist_ok=True)
	(report_dir / "gate.json").write_text(json.dumps({
		"ticket": ticket.nnn, "review_policy": "advisory", "passed": passed, "checks": checks,
	}))


class SpecStatusTests(unittest.TestCase):
	def test_missing_spec_has_no_status(self):
		with tempfile.TemporaryDirectory() as d:
			self.assertIsNone(goal_pilot.read_spec_status(Path(d)))

	def test_reads_draft_status(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			spec = pilot_dir / "spec"
			spec.mkdir()
			(spec / "spec.md").write_text("STATUS: DRAFT -- pending human review\n\nBody\n")
			self.assertEqual(goal_pilot.read_spec_status(pilot_dir), "DRAFT")

	def test_freeze_spec_rewrites_only_first_line(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			spec = pilot_dir / "spec"
			spec.mkdir()
			(spec / "spec.md").write_text("STATUS: DRAFT -- pending human review\n\nBody unchanged\n")
			goal_pilot.freeze_spec(pilot_dir)
			text = (spec / "spec.md").read_text()
			self.assertTrue(text.startswith("STATUS: FROZEN -- reviewed "))
			self.assertIn("Body unchanged", text)
			self.assertEqual(goal_pilot.read_spec_status(pilot_dir), "FROZEN")


class CompileCompleteMarkerTests(unittest.TestCase):
	def test_not_complete_when_only_contract_md_exists(self):
		# Codex review of PR #36: a crash mid-/contract-plan (contract.md
		# written, self-check never finished) must not read as step-4-done.
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			(pilot_dir / "spec").mkdir()
			(pilot_dir / "spec" / "contract.md").write_text("# contract\n")
			self.assertFalse(goal_pilot.is_compile_complete(pilot_dir))

	def test_complete_after_marker_written(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			(pilot_dir / "spec").mkdir()
			goal_pilot.write_compile_complete_marker(pilot_dir, staged_ticket_count=3)
			self.assertTrue(goal_pilot.is_compile_complete(pilot_dir))
			data = json.loads(goal_pilot.compile_complete_marker(pilot_dir).read_text())
			self.assertEqual(data["staged_ticket_count"], 3)


class ResolveSpecInputTests(unittest.TestCase):
	def test_existing_file_used_as_is(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d) / "pilot"
			pilot_dir.mkdir()
			existing = Path(d) / "notes.md"
			existing.write_text("rough idea")
			resolved = goal_pilot.resolve_spec_input(str(existing), pilot_dir)
			self.assertEqual(resolved, existing.resolve())

	def test_literal_text_written_to_scratch_file(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d) / "pilot"
			resolved = goal_pilot.resolve_spec_input("a rough idea, not a path", pilot_dir)
			self.assertTrue(resolved.exists())
			self.assertEqual(resolved.read_text(), "a rough idea, not a path")

	def test_scratch_file_is_a_sibling_not_written_inside_pilot_dir(self):
		# Codex review of PR #37: /spec-plan's own step-0 scaffold check
		# refuses to run against any existing, non-empty directory with no
		# Makefile yet. Writing the scratch file *inside* an unscaffolded
		# pilot_dir would make every fresh run using literal --spec-input
		# text immediately unscaffoldable. It must land outside pilot_dir.
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d) / "pilot"
			resolved = goal_pilot.resolve_spec_input("a rough idea, not a path", pilot_dir)
			self.assertFalse(resolved.is_relative_to(pilot_dir))
			self.assertFalse(pilot_dir.exists() and any(pilot_dir.iterdir()))

	def test_literal_text_is_not_rewritten_on_a_second_call(self):
		# Resume must keep reusing the same frozen input, not overwrite it
		# with whatever --spec-input happens to be passed on the resume
		# invocation.
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d) / "pilot"
			goal_pilot.resolve_spec_input("first idea", pilot_dir)
			resolved = goal_pilot.resolve_spec_input("second, different idea", pilot_dir)
			self.assertEqual(resolved.read_text(), "first idea")


class ClassifyHaltTests(unittest.TestCase):
	def test_unknown_when_no_gate_recorded(self):
		with tempfile.TemporaryDirectory() as d:
			self.assertEqual(goal_pilot.classify_halt(Path(d), make_ticket()), "unknown")

	def test_oracle_integrity_failure_is_canon_drift(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			ticket = make_ticket(2)
			write_gate(pilot_dir, ticket, [
				{"name": "make verify", "ok": True},
				{"name": "oracle integrity", "ok": False, "detail": ["acceptance/002_handler_test.go"]},
			])
			self.assertEqual(goal_pilot.classify_halt(pilot_dir, ticket), "canon-drift")

	def test_verify_surface_frozen_failure_is_canon_drift(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			ticket = make_ticket(3)
			write_gate(pilot_dir, ticket, [
				{"name": "verify-surface frozen", "ok": False, "detail": "verify surface changed"},
			])
			self.assertEqual(goal_pilot.classify_halt(pilot_dir, ticket), "canon-drift")

	def test_model_route_unreachable_is_infra(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			ticket = make_ticket(5)
			write_gate(pilot_dir, ticket, [
				{"name": "BUILD_REPORT.md SUCCEEDED", "ok": False, "detail": "model route unreachable (12/12 assistant turns errored)"},
			])
			self.assertEqual(goal_pilot.classify_halt(pilot_dir, ticket), "infra")

	def test_plain_verification_failure_is_implementation_gap(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			ticket = make_ticket(4)
			write_gate(pilot_dir, ticket, [
				{"name": "make verify", "ok": False, "detail": "FAIL: TestOnboarding"},
				{"name": "BUILD_REPORT.md SUCCEEDED", "ok": False, "detail": "Outcome: DID NOT SUCCEED"},
			])
			self.assertEqual(goal_pilot.classify_halt(pilot_dir, ticket), "implementation-gap")

	def test_canon_drift_takes_priority_over_infra_markers(self):
		# A ticket can fail both an infra-flavored check and oracle
		# integrity in the same gate; canon-drift must win, since it's the
		# class that must never be auto-applied.
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			ticket = make_ticket(6)
			write_gate(pilot_dir, ticket, [
				{"name": "oracle integrity", "ok": False, "detail": ["acceptance/006_x_test.go"]},
				{"name": "BUILD_REPORT.md SUCCEEDED", "ok": False, "detail": "stall-timeout"},
			])
			self.assertEqual(goal_pilot.classify_halt(pilot_dir, ticket), "canon-drift")


class InfraHaltRetryTests(unittest.TestCase):
	def test_report_mode_never_retries(self):
		with tempfile.TemporaryDirectory() as d:
			self.assertFalse(goal_pilot.handle_infra_halt(Path(d), "report", attempt_count=0))

	def test_auto_rescue_retries_until_bound(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			self.assertTrue(goal_pilot.handle_infra_halt(pilot_dir, "auto-rescue", attempt_count=0))
			self.assertTrue(goal_pilot.handle_infra_halt(pilot_dir, "auto-rescue", attempt_count=1))
			self.assertFalse(goal_pilot.handle_infra_halt(pilot_dir, "auto-rescue", attempt_count=goal_pilot.MAX_INFRA_AUTO_RETRIES))

	def test_auto_rescue_sets_ai_stack_host_fallback(self):
		with tempfile.TemporaryDirectory() as d:
			with mock.patch.dict("os.environ", {"AI_STACK_HOST": "kannasmacstudio.lan"}, clear=False):
				goal_pilot.handle_infra_halt(Path(d), "auto-rescue", attempt_count=0)
				import os
				self.assertEqual(os.environ["AI_STACK_HOST"], goal_pilot.AI_STACK_HOST_FALLBACK)


class ImplementationGapRescueBoundTests(unittest.TestCase):
	def test_report_mode_never_widens(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			ticket = make_ticket(4)
			result = goal_pilot.handle_implementation_gap_halt(pilot_dir, pilot_dir / "workspace", [ticket], ticket, "advisory", "report")
			self.assertFalse(result)

	def test_second_call_for_same_ticket_does_not_widen_again(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			ticket = make_ticket(4)
			goal_pilot.append_rescue_record(pilot_dir, {"ticket": ticket.nnn, "class": "implementation-gap", "action": "widened local retry"})
			result = goal_pilot.handle_implementation_gap_halt(pilot_dir, pilot_dir / "workspace", [ticket], ticket, "advisory", "auto-rescue")
			self.assertFalse(result)


def pi_output_with_turn_errors(errored: int, total: int) -> str:
	events = []
	for i in range(total):
		events.append({
			"type": "entry_appended",
			"entry": {"type": "message", "message": {"role": "assistant", "stopReason": "error" if i < errored else "end_turn"}},
		})
	return "\n".join(json.dumps(e) for e in events)


class RunPiPromptFullyErroredTests(unittest.TestCase):
	"""Regression coverage for Codex review of PR #37: `pi` exits 0 even
	when the model route was unreachable for an entire invocation (every
	assistant turn's stopReason is "error"), and a resumed /contract-plan
	run can leave a stale, already-partial contract.md on disk from a
	previous attempt -- without this check, step4_compile() would accept
	that stale artifact as if a real self-check had just run."""

	def test_ok_false_when_every_turn_errored(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			with mock.patch.object(
				goal_pilot.ticket_runner, "invoke_build_app",
				return_value=(0, pi_output_with_turn_errors(3, 3), "", False),
			):
				ok, _stdout, diagnostics = goal_pilot.run_pi_prompt(pilot_dir, "/contract-plan .", session_dir=pilot_dir / "s", timeout_s=60)
			self.assertFalse(ok)
			self.assertTrue(diagnostics["fully_errored"])

	def test_ok_true_when_some_turns_succeeded(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			with mock.patch.object(
				goal_pilot.ticket_runner, "invoke_build_app",
				return_value=(0, pi_output_with_turn_errors(1, 3), "", False),
			):
				ok, _stdout, diagnostics = goal_pilot.run_pi_prompt(pilot_dir, "/contract-plan .", session_dir=pilot_dir / "s", timeout_s=60)
			self.assertTrue(ok)
			self.assertFalse(diagnostics["fully_errored"])

	def test_ok_true_when_no_assistant_turns_recorded_at_all(self):
		# total == 0 must not be treated as "0/0 errored, i.e. fully
		# errored" -- that would misclassify an invocation whose output
		# simply doesn't parse as pi JSONL (e.g. a real, clean success).
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			with mock.patch.object(
				goal_pilot.ticket_runner, "invoke_build_app",
				return_value=(0, "not pi jsonl output at all", "", False),
			):
				ok, _stdout, diagnostics = goal_pilot.run_pi_prompt(pilot_dir, "/contract-plan .", session_dir=pilot_dir / "s", timeout_s=60)
			self.assertTrue(ok)
			self.assertFalse(diagnostics["fully_errored"])


class CanonDriftRecoveryTests(unittest.TestCase):
	"""Real git, no mocks: the bug guarded here is that
	ticket_runner.run_ticket() already restores the canonical copy over a
	drifted file before returning failure, so reading the workspace file
	directly at halt time always finds it already matching canon."""

	def _init_workspace_with_ticket_commit(self, workspace: Path, rel_path: str, committed_content: str) -> None:
		run = lambda *args: subprocess.run(["git", *args], cwd=workspace, check=True, capture_output=True)
		workspace.mkdir(parents=True, exist_ok=True)
		run("init")
		run("config", "user.email", "test@test")
		run("config", "user.name", "test")
		run("config", "commit.gpgsign", "false")
		run("config", "core.hooksPath", "/dev/null")
		target = workspace / rel_path
		target.parent.mkdir(parents=True, exist_ok=True)
		target.write_text(committed_content)
		run("add", "-A")
		run("commit", "-m", "ticket(002): drifted fix")

	def test_recovers_committed_content_even_after_workspace_was_restored_to_canon(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			workspace = pilot_dir / "workspace"
			rel = "acceptance/002_handler_test.go"
			self._init_workspace_with_ticket_commit(workspace, rel, "package acceptance // model's fix\n")
			# Simulate run_ticket()'s post-halt restore: the on-disk file no
			# longer matches what the model actually committed.
			(workspace / rel).write_text("package acceptance // canonical original\n")
			ticket = make_ticket(2, "handler")

			recovered = goal_pilot.recover_drifted_content(workspace, ticket, workspace / rel)

			self.assertEqual(recovered, "package acceptance // model's fix\n")

	def test_returns_none_when_ticket_has_no_commit_yet(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			workspace = pilot_dir / "workspace"
			self._init_workspace_with_ticket_commit(workspace, "acceptance/x_test.go", "content\n")
			ticket = make_ticket(9, "not-committed")

			recovered = goal_pilot.recover_drifted_content(workspace, ticket, workspace / "acceptance/x_test.go")

			self.assertIsNone(recovered)


class RescueLogTests(unittest.TestCase):
	def test_records_round_trip_as_jsonl(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			goal_pilot.append_rescue_record(pilot_dir, {"ticket": "003", "class": "infra", "action": "retry"})
			goal_pilot.append_rescue_record(pilot_dir, {"ticket": "004", "class": "implementation-gap", "action": "widened"})
			records = goal_pilot.read_rescue_records(pilot_dir)
			self.assertEqual([r["ticket"] for r in records], ["003", "004"])

	def test_missing_log_reads_as_empty(self):
		with tempfile.TemporaryDirectory() as d:
			self.assertEqual(goal_pilot.read_rescue_records(Path(d)), [])


class VerdictTests(unittest.TestCase):
	def test_verdict_reports_no_rescues_cleanly(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			path = goal_pilot.write_verdict(pilot_dir, [make_ticket()], "advisory", "skip", "auto-rescue")
			text = path.read_text()
			self.assertIn("None -- every ticket gated green", text)
			self.assertIn("--checkpoint=skip --on-halt=auto-rescue", text)

	def test_verdict_states_rescue_counts_by_class(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			goal_pilot.append_rescue_record(pilot_dir, {"ticket": "003", "class": "infra", "action": "retry"})
			goal_pilot.append_rescue_record(pilot_dir, {"ticket": "004", "class": "implementation-gap", "action": "widened"})
			path = goal_pilot.write_verdict(pilot_dir, [make_ticket()], "advisory", "skip", "auto-rescue")
			text = path.read_text()
			self.assertIn("infra: 1", text)
			self.assertIn("implementation-gap: 1", text)


class LockContentionTests(unittest.TestCase):
	def test_detects_lock_message(self):
		self.assertTrue(goal_pilot.lock_contention("another ticket_runner.py is already running against ...; refusing to race it"))

	def test_ignores_unrelated_output(self):
		self.assertFalse(goal_pilot.lock_contention("GATE PASSED for ticket 001"))


class Checkpoint5IdempotencyTests(unittest.TestCase):
	def test_skip_mode_writes_ack_marker_and_logs_disclaimer(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			(pilot_dir / "spec").mkdir()
			self.assertTrue(goal_pilot.step5_checkpoint(pilot_dir, "skip"))
			self.assertTrue(goal_pilot.checkpoint5_ack_marker(pilot_dir).exists())
			log = goal_pilot.execution_log_path(pilot_dir).read_text()
			self.assertIn("never independently (cloud/human) reviewed", log)

	def test_already_acked_run_does_not_reprompt(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			(pilot_dir / "spec").mkdir()
			goal_pilot.checkpoint5_ack_marker(pilot_dir).write_text("{}")
			# non_interactive=True would normally refuse to proceed -- if this
			# returns True anyway, the already-acked short-circuit fired
			# before any prompt/refusal logic ran.
			self.assertTrue(goal_pilot.step5_checkpoint(pilot_dir, "review", non_interactive=True))


class RunTicketRunnerInvocationTests(unittest.TestCase):
	def test_stop_after_ticket_is_threaded_into_the_command(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			with mock.patch.object(
				goal_pilot.ticket_runner, "invoke_build_app",
				return_value=(0, "GATE PASSED for ticket 001", "", False),
			) as invoked:
				goal_pilot.run_ticket_runner(pilot_dir, "advisory", stop_after_ticket=1)
			cmd = invoked.call_args[0][0]
			self.assertIn("--stop-after-ticket", cmd)
			self.assertEqual(cmd[cmd.index("--stop-after-ticket") + 1], "1")

	def test_no_stop_flag_when_not_requested(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			with mock.patch.object(
				goal_pilot.ticket_runner, "invoke_build_app",
				return_value=(0, "all tickets complete.", "", False),
			) as invoked:
				goal_pilot.run_ticket_runner(pilot_dir, "advisory", stop_after_ticket=None)
			cmd = invoked.call_args[0][0]
			self.assertNotIn("--stop-after-ticket", cmd)


class BuildLoopUntilSettledTests(unittest.TestCase):
	"""run_build_loop_until_settled() is shared by both the ticket-1-only
	phase (before the 5b checkpoint) and the remainder-of-the-run phase --
	regression coverage for a real bug caught during implementation review,
	where an earlier version gave up immediately on any ticket-1 halt
	instead of running it through the same class-aware handling every
	other ticket gets."""

	def test_returns_true_immediately_on_a_clean_run(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			with mock.patch.object(goal_pilot, "run_ticket_runner", return_value=(0, "all tickets complete.")):
				ok = goal_pilot.run_build_loop_until_settled(
					pilot_dir, pilot_dir / "workspace", [make_ticket()], "advisory", "auto-rescue",
					stop_after_ticket=None, non_interactive=False, infra_attempts={},
				)
			self.assertTrue(ok)

	def test_retries_when_handle_halt_says_to_and_eventually_settles(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			outcomes = iter([(1, "GATE FAILED"), (0, "all tickets complete.")])
			with mock.patch.object(goal_pilot, "run_ticket_runner", side_effect=lambda *a, **k: next(outcomes)), \
				mock.patch.object(goal_pilot, "handle_halt", return_value=True), \
				mock.patch.object(goal_pilot.time, "sleep"):
				ok = goal_pilot.run_build_loop_until_settled(
					pilot_dir, pilot_dir / "workspace", [make_ticket()], "advisory", "auto-rescue",
					stop_after_ticket=1, non_interactive=False, infra_attempts={},
				)
			self.assertTrue(ok)

	def test_stops_and_returns_false_when_handle_halt_says_not_to_retry(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			with mock.patch.object(goal_pilot, "run_ticket_runner", return_value=(1, "GATE FAILED")), \
				mock.patch.object(goal_pilot, "handle_halt", return_value=False):
				ok = goal_pilot.run_build_loop_until_settled(
					pilot_dir, pilot_dir / "workspace", [make_ticket()], "advisory", "report",
					stop_after_ticket=1, non_interactive=False, infra_attempts={},
				)
			self.assertFalse(ok)

	def test_lock_contention_stops_without_calling_handle_halt(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			with mock.patch.object(goal_pilot, "run_ticket_runner", return_value=(1, "refusing to race it")), \
				mock.patch.object(goal_pilot, "handle_halt") as halt_handler:
				ok = goal_pilot.run_build_loop_until_settled(
					pilot_dir, pilot_dir / "workspace", [make_ticket()], "advisory", "auto-rescue",
					stop_after_ticket=None, non_interactive=False, infra_attempts={},
				)
			self.assertFalse(ok)
			halt_handler.assert_not_called()

	def test_ticket_one_phase_passes_stop_after_ticket_through(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
			with mock.patch.object(goal_pilot, "run_ticket_runner", return_value=(0, "gate passed")) as runner:
				goal_pilot.run_build_loop_until_settled(
					pilot_dir, pilot_dir / "workspace", [make_ticket()], "advisory", "auto-rescue",
					stop_after_ticket=1, non_interactive=False, infra_attempts={},
				)
			runner.assert_called_once_with(pilot_dir, "advisory", stop_after_ticket=1)


class MainScaffoldOrderingTests(unittest.TestCase):
	"""Regression coverage for Codex review of PR #37: on a fresh,
	not-yet-scaffolded pilot_dir, goal_pilot.py must not write anything
	into it before /spec-plan's own step-0 scaffold-safety check runs --
	that check refuses any existing, non-empty directory with no Makefile
	yet, so an EXECUTION_LOG.md written first would make every fresh run
	immediately unscaffoldable."""

	def test_nothing_written_into_a_fresh_pilot_dir_before_spec_plan_runs(self):
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d) / "pilot"  # deliberately does not exist yet

			def fake_step2(pilot_dir_arg, spec_input):
				# Simulate what /spec-plan's own step 0 does: scaffold the
				# dir for real, including writing a Makefile -- and assert
				# nothing was written into it before this ran.
				self.assertFalse(pilot_dir_arg.exists() and any(pilot_dir_arg.iterdir()))
				pilot_dir_arg.mkdir(parents=True, exist_ok=True)
				(pilot_dir_arg / "Makefile").write_text("run:\n\t@true\n")
				(pilot_dir_arg / "spec").mkdir()
				(pilot_dir_arg / "spec" / "spec.md").write_text("STATUS: DRAFT -- pending review\n")
				return True

			argv = [
				"goal_pilot.py", "--spec-input", "a rough idea",
				"--pilot-dir", str(pilot_dir), "--non-interactive",
			]
			with mock.patch.object(sys, "argv", argv), \
				mock.patch.object(goal_pilot, "step2_draft_spec", side_effect=fake_step2), \
				mock.patch.object(goal_pilot, "step3_freeze_checkpoint", return_value=False):
				goal_pilot.main()

			# step3 was mocked to refuse (return False), so the run halts
			# right after step2 -- but step2 itself must have seen an empty
			# dir, and EXECUTION_LOG.md must exist by now (written once
			# scaffolding was confirmed).
			self.assertTrue((pilot_dir / "EXECUTION_LOG.md").exists())


if __name__ == "__main__":
	unittest.main()
