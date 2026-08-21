import importlib.util
import json
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
			pilot_dir = Path(d)
			resolved = goal_pilot.resolve_spec_input("a rough idea, not a path", pilot_dir)
			self.assertTrue(resolved.exists())
			self.assertEqual(resolved.read_text(), "a rough idea, not a path")

	def test_literal_text_is_not_rewritten_on_a_second_call(self):
		# Resume must keep reusing the same frozen input, not overwrite it
		# with whatever --spec-input happens to be passed on the resume
		# invocation.
		with tempfile.TemporaryDirectory() as d:
			pilot_dir = Path(d)
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


if __name__ == "__main__":
	unittest.main()
