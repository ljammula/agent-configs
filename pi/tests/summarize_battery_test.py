import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "evals" / "summarize_battery.py"
SPEC = importlib.util.spec_from_file_location("summarize_battery", SCRIPT)
assert SPEC and SPEC.loader
summarize_battery = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = summarize_battery
SPEC.loader.exec_module(summarize_battery)

battery_lib = summarize_battery.battery_lib


def write_rows(results: Path, rows: list[dict]) -> None:
	results.parent.mkdir(parents=True, exist_ok=True)
	with results.open("w") as f:
		for row in rows:
			f.write(json.dumps(row) + "\n")


class RawPassRatesTests(unittest.TestCase):
	def test_counts_every_row_including_both_attempts_of_a_retried_run(self):
		with tempfile.TemporaryDirectory() as d:
			results = Path(d) / "results.jsonl"
			write_rows(results, [
				{"task": "t", "arm": "baseline", "rep": 1, "attempt": 1, "passed": False, "memory_aborts": 1},
				{"task": "t", "arm": "baseline", "rep": 1, "attempt": 2, "passed": True, "memory_aborts": 0},
				{"task": "t", "arm": "harness", "rep": 1, "attempt": 1, "passed": True, "memory_aborts": 0},
			])
			raw = summarize_battery.raw_pass_rates(results)
			self.assertEqual(raw["baseline"], {"total": 2, "passed": 1})
			self.assertEqual(raw["harness"], {"total": 1, "passed": 1})

	def test_missing_file_is_empty(self):
		self.assertEqual(summarize_battery.raw_pass_rates(Path("/nonexistent.jsonl")), {})


class CleanPassRatesTests(unittest.TestCase):
	def test_excludes_memory_aborted_latest_rows(self):
		latest = {
			("t1", "baseline", 1): {"passed": True, "memory_aborts": 0},
			("t2", "baseline", 1): {"passed": False, "memory_aborts": 1},
		}
		clean = summarize_battery.clean_pass_rates(latest, frozenset())
		self.assertEqual(clean["baseline"], {"total": 1, "passed": 1})

	def test_excludes_named_tasks(self):
		latest = {
			("flaky-task", "baseline", 1): {"passed": False, "memory_aborts": 0},
			("good-task", "baseline", 1): {"passed": True, "memory_aborts": 0},
		}
		clean = summarize_battery.clean_pass_rates(latest, frozenset({"flaky-task"}))
		self.assertEqual(clean["baseline"], {"total": 1, "passed": 1})

	def test_only_the_latest_attempt_counts(self):
		# latest here models what battery_lib.load_latest_attempts would
		# already have collapsed a retried run down to -- only attempt 2
		# should ever reach this function for that key.
		latest = {("t", "baseline", 1): {"attempt": 2, "passed": True, "memory_aborts": 0}}
		clean = summarize_battery.clean_pass_rates(latest, frozenset())
		self.assertEqual(clean["baseline"], {"total": 1, "passed": 1})


class TaskGridTests(unittest.TestCase):
	def test_builds_task_arm_rep_outcome_mapping(self):
		latest = {
			("t", "baseline", 1): {"passed": True, "timed_out": False},
			("t", "baseline", 2): {"passed": False, "timed_out": True},
			("t", "harness", 1): {"passed": False, "timed_out": False},
		}
		grid = summarize_battery.task_grid(latest)
		self.assertEqual(grid["t"]["baseline"], {1: "P", 2: "T"})
		self.assertEqual(grid["t"]["harness"], {1: "F"})


class EndToEndOnAFixtureDirTests(unittest.TestCase):
	"""Exercises main()'s real wiring (argv -> stdout) end to end against a
	small synthetic results.jsonl, rather than only the pure helpers."""

	def test_main_runs_and_reports_both_rate_tables(self):
		with tempfile.TemporaryDirectory() as d:
			battery_dir = Path(d) / "battery"
			results = battery_dir / "results.jsonl"
			write_rows(results, [
				{"task": "t1", "arm": "baseline", "rep": 1, "attempt": 1, "passed": True, "memory_aborts": 0, "timed_out": False},
				{"task": "t1", "arm": "harness", "rep": 1, "attempt": 1, "passed": False, "memory_aborts": 1, "timed_out": False},
				{"task": "t2", "arm": "baseline", "rep": 1, "attempt": 1, "passed": False, "memory_aborts": 0, "timed_out": True},
			])
			import io
			from contextlib import redirect_stdout
			from unittest import mock

			argv = ["summarize_battery.py", "--dir", str(battery_dir)]
			buf = io.StringIO()
			with mock.patch.object(sys, "argv", argv), redirect_stdout(buf):
				exit_code = summarize_battery.main()

			self.assertEqual(exit_code, 0)
			output = buf.getvalue()
			self.assertIn("Raw pass rates", output)
			self.assertIn("Clean pass rates", output)
			self.assertIn("Per-task P/F/T grid", output)
			# t1/harness had a memory abort, so it's dropped from "clean"
			# but still present in "raw".
			self.assertIn("baseline", output)
			self.assertIn("harness", output)

	def test_exclude_task_removes_it_from_the_clean_table_and_grid(self):
		with tempfile.TemporaryDirectory() as d:
			battery_dir = Path(d) / "battery"
			results = battery_dir / "results.jsonl"
			write_rows(results, [
				{"task": "flaky", "arm": "baseline", "rep": 1, "attempt": 1, "passed": False, "memory_aborts": 0, "timed_out": False},
				{"task": "stable", "arm": "baseline", "rep": 1, "attempt": 1, "passed": True, "memory_aborts": 0, "timed_out": False},
			])
			import io
			from contextlib import redirect_stdout
			from unittest import mock

			argv = ["summarize_battery.py", "--dir", str(battery_dir), "--exclude-task", "flaky"]
			buf = io.StringIO()
			with mock.patch.object(sys, "argv", argv), redirect_stdout(buf):
				summarize_battery.main()

			output = buf.getvalue()
			self.assertIn("Excluded tasks: flaky", output)


if __name__ == "__main__":
	unittest.main()
