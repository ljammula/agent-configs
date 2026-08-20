import importlib.util
import json
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ticket_runner.py"
SPEC = importlib.util.spec_from_file_location("ticket_runner", SCRIPT)
assert SPEC and SPEC.loader
ticket_runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ticket_runner
SPEC.loader.exec_module(ticket_runner)


class TicketRunnerRetryTests(unittest.TestCase):
	def setUp(self):
		self.ticket = ticket_runner.Ticket(1, "workspace-scaffold", Path("001-workspace-scaffold.md"))

	def next_mode(self, pilot_dir, workspace, commit_sha=None):
		with mock.patch.object(ticket_runner, "commit_sha_for", return_value=commit_sha):
			return ticket_runner.next_ticket([self.ticket], pilot_dir, workspace)[1]

	def test_fresh_ticket_starts_a_build(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			self.assertEqual(self.next_mode(root, root / "workspace"), "build")

	def test_interrupted_build_retries_instead_of_regating(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			(root / "reports" / "ticket-001").mkdir(parents=True)
			self.assertEqual(self.next_mode(root, root / "workspace", "commit-sha"), "retry")

	def test_missing_report_gate_retries_only_infrastructure_failure(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			reports = root / "reports" / "ticket-001"
			reports.mkdir(parents=True)
			(reports / "gate.json").write_text(json.dumps({
				"passed": False,
				"checks": [
					{"name": "make verify", "ok": True},
					{"name": "BUILD_REPORT.md SUCCEEDED", "ok": False},
				],
			}))
			self.assertEqual(self.next_mode(root, root / "workspace", "commit-sha"), "retry")

	def test_builder_timeout_retries_even_when_incomplete_verify_is_red(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			reports = root / "reports" / "ticket-001"
			reports.mkdir(parents=True)
			(reports / "gate.json").write_text(json.dumps({
				"passed": False,
				"checks": [
					{"name": "build_app.py invocation", "ok": False},
					{"name": "make verify", "ok": False},
					{"name": "BUILD_REPORT.md SUCCEEDED", "ok": False},
				],
			}))
			self.assertTrue(ticket_runner.retryable_build_state(root, root / "workspace", self.ticket))

	def test_stall_report_retries_even_when_builder_wrote_failure_evidence(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			workspace = root / "workspace"
			workspace.mkdir()
			(workspace / "BUILD_REPORT.md").write_text(
				"Outcome: DID NOT SUCCEED -- stall-timeout while contacting model\n"
			)
			reports = root / "reports" / "ticket-001"
			reports.mkdir(parents=True)
			(reports / "gate.json").write_text(json.dumps({
				"passed": False,
				"checks": [
					{"name": "make verify", "ok": False},
					{"name": "BUILD_REPORT.md SUCCEEDED", "ok": False},
				],
			}))
			self.assertTrue(ticket_runner.retryable_build_state(root, workspace, self.ticket))

	def test_final_timeout_outcome_retries(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			workspace = root / "workspace"
			workspace.mkdir()
			(workspace / "BUILD_REPORT.md").write_text(
				"Outcome: DID NOT SUCCEED -- local round budget (6) exhausted; "
				"escalation required: pi invocation timed out, canonical verification failed\n"
			)
			reports = root / "reports" / "ticket-001"
			reports.mkdir(parents=True)
			(reports / "gate.json").write_text(json.dumps({
				"passed": False,
				"checks": [
					{"name": "make verify", "ok": False},
					{"name": "BUILD_REPORT.md SUCCEEDED", "ok": False},
				],
			}))
			self.assertTrue(ticket_runner.retryable_build_state(root, workspace, self.ticket))

	def test_build_attempt_numbers_survive_new_runner_processes(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			reports = root / "reports" / "ticket-001"
			reports.mkdir(parents=True)
			self.assertEqual(ticket_runner.next_build_attempt(root, self.ticket), 2)
			(reports / "build-attempt-02.started.json").write_text("{}")
			self.assertEqual(ticket_runner.next_build_attempt(root, self.ticket), 3)

	def test_three_build_attempts_exhaust_durable_budget(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			reports = root / "reports" / "ticket-001"
			reports.mkdir(parents=True)
			for attempt in range(1, 4):
				(reports / f"build-attempt-{attempt:02d}.started.json").write_text("{}")
			self.assertEqual(ticket_runner.next_build_attempt(root, self.ticket), 4)
			self.assertGreater(ticket_runner.next_build_attempt(root, self.ticket), ticket_runner.MAX_BUILD_ATTEMPTS)

	def test_regates_do_not_consume_build_attempt_budget(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			reports = root / "reports" / "ticket-001"
			reports.mkdir(parents=True)
			(reports / "build-attempt-01.started.json").write_text("{}")
			for attempt in range(1, 5):
				(reports / f"gate-attempt-{attempt:02d}.json").write_text("{}")
			self.assertEqual(ticket_runner.next_build_attempt(root, self.ticket), 2)
			self.assertEqual(ticket_runner.next_gate_attempt(root, self.ticket), 5)

	def test_fresh_no_commit_run_stops_after_three_durable_builds(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			with (
				mock.patch.object(sys, "argv", ["ticket_runner.py", "--pilot-dir", str(root)]),
				mock.patch.object(ticket_runner, "discover_tickets", return_value=[self.ticket]),
				mock.patch.object(ticket_runner, "next_ticket", return_value=(self.ticket, "build")),
				mock.patch.object(ticket_runner, "next_build_attempt", return_value=4),
				mock.patch.object(ticket_runner, "append_halt_record"),
				mock.patch.object(ticket_runner, "run_ticket") as run_ticket,
			):
				self.assertEqual(ticket_runner.main(), 1)
			run_ticket.assert_not_called()

	def test_regate_main_path_does_not_request_a_build_attempt(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			with (
				mock.patch.object(sys, "argv", ["ticket_runner.py", "--pilot-dir", str(root)]),
				mock.patch.object(ticket_runner, "discover_tickets", return_value=[self.ticket]),
				mock.patch.object(ticket_runner, "next_ticket", return_value=(self.ticket, "regate")),
				mock.patch.object(ticket_runner, "next_build_attempt") as next_build,
				mock.patch.object(ticket_runner, "next_gate_attempt", return_value=3),
				mock.patch.object(ticket_runner, "run_ticket", return_value=False) as run_ticket,
			):
				self.assertEqual(ticket_runner.main(), 1)
			next_build.assert_not_called()
			run_ticket.assert_called_once_with(
				root.resolve(),
				root.resolve() / "workspace",
				self.ticket,
				[self.ticket],
				skip_build=True,
				gate_attempt=3,
				build_attempt=None,
			)

	def test_per_attempt_evidence_is_append_only_and_regates_are_separate(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			workspace = root / "workspace"
			workspace.mkdir()
			report = workspace / "BUILD_REPORT.md"
			report.write_text("Outcome: DID NOT SUCCEED -- first build\n")
			gate = {"ticket": "001", "passed": False, "checks": []}
			ticket_runner.archive_evidence(
				root, self.ticket, gate, gate_attempt=1, build_attempt=1,
			)
			report.write_text("Outcome: DID NOT SUCCEED -- regate\n")
			ticket_runner.archive_evidence(
				root, self.ticket, gate, gate_attempt=2, build_attempt=None,
			)
			reports = root / "reports" / "ticket-001"
			self.assertEqual(
				(reports / "BUILD_REPORT-attempt-01.md").read_text(),
				"Outcome: DID NOT SUCCEED -- first build\n",
			)
			self.assertEqual(
				(reports / "BUILD_REPORT-regate-02.md").read_text(),
				"Outcome: DID NOT SUCCEED -- regate\n",
			)
			with self.assertRaises(FileExistsError):
				ticket_runner.archive_evidence(
					root, self.ticket, gate, gate_attempt=2, build_attempt=None,
				)

	def test_timeout_kills_process_group_even_when_parent_exits_on_term(self):
		process = mock.Mock(pid=4321, returncode=None)
		process.communicate.side_effect = [
			subprocess.TimeoutExpired(["builder"], 1, output="partial", stderr="partial error"),
			("terminated", "terminated error"),
		]
		process.poll.return_value = 0
		with (
			mock.patch.object(ticket_runner.subprocess, "Popen", return_value=process),
			mock.patch.object(ticket_runner.os, "killpg") as killpg,
		):
			result = ticket_runner.invoke_build_app(["builder"], 1)
		self.assertEqual(result, (-1, "terminated", "terminated error", True))
		self.assertEqual(
			killpg.call_args_list,
			[mock.call(4321, signal.SIGTERM), mock.call(4321, signal.SIGKILL)],
		)

	def test_old_transient_marker_does_not_retry_real_final_failure(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			workspace = root / "workspace"
			workspace.mkdir()
			(workspace / "BUILD_REPORT.md").write_text(
				"Round 1: agent timed out: true\n"
				"Outcome: DID NOT SUCCEED -- canonical verification failed\n"
			)
			reports = root / "reports" / "ticket-001"
			reports.mkdir(parents=True)
			(reports / "gate.json").write_text(json.dumps({
				"passed": False,
				"checks": [
					{"name": "make verify", "ok": False},
					{"name": "BUILD_REPORT.md SUCCEEDED", "ok": False},
				],
			}))
			self.assertFalse(ticket_runner.retryable_build_state(root, workspace, self.ticket))

	def test_real_gate_failure_remains_regate_only(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			reports = root / "reports" / "ticket-001"
			reports.mkdir(parents=True)
			(reports / "gate.json").write_text(json.dumps({
				"passed": False,
				"checks": [
					{"name": "make verify", "ok": False},
					{"name": "BUILD_REPORT.md SUCCEEDED", "ok": False},
				],
			}))
			self.assertEqual(self.next_mode(root, root / "workspace", "commit-sha"), "regate")


if __name__ == "__main__":
	unittest.main()
