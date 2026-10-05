import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


FIXTURES = Path(__file__).resolve().parent / "fixtures" / "battery"
SCRIPT = Path(__file__).resolve().parents[1] / "evals" / "battery_lib.py"
SPEC = importlib.util.spec_from_file_location("battery_lib", SCRIPT)
assert SPEC and SPEC.loader
battery_lib = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = battery_lib
SPEC.loader.exec_module(battery_lib)


def write_row(path: Path, **fields) -> None:
	with path.open("a") as f:
		f.write(json.dumps(fields) + "\n")


class CountMemoryAbortsTests(unittest.TestCase):
	def test_counts_one_abort_in_a_mixed_real_shaped_capture(self):
		count = battery_lib.count_memory_aborts(FIXTURES / "pi-output-memory-abort.jsonl")
		self.assertEqual(count, 1)

	def test_clean_output_has_zero_aborts(self):
		count = battery_lib.count_memory_aborts(FIXTURES / "pi-output-clean.jsonl")
		self.assertEqual(count, 0)

	def test_counts_two_real_aborts_ignoring_noise_and_malformed_lines(self):
		# This fixture also has: a non-JSON line (truncated/killed process),
		# and a stop="stop" message whose *text* happens to mention
		# "insufficient memory" in passing -- neither should count.
		count = battery_lib.count_memory_aborts(FIXTURES / "pi-output-two-aborts-and-noise.jsonl")
		self.assertEqual(count, 2)

	def test_missing_file_counts_as_zero_not_an_error(self):
		count = battery_lib.count_memory_aborts(Path("/nonexistent/pi-output.jsonl"))
		self.assertEqual(count, 0)


class ResolvePiOutputPathTests(unittest.TestCase):
	def test_follows_the_run_roots_inner_results_jsonl_to_the_real_artifact_dir(self):
		with tempfile.TemporaryDirectory() as d:
			run_root = Path(d) / "go__lru-cache__baseline__rep1"
			run_root.mkdir()
			real_artifact_dir = Path(d) / "tmp-run-dir"
			real_artifact_dir.mkdir()
			(real_artifact_dir / "pi-output.jsonl").write_text("{}\n")
			write_row(run_root / "results.jsonl", pair=1, artifact_dir=str(real_artifact_dir))

			resolved = battery_lib.resolve_pi_output_path(run_root)

			self.assertEqual(resolved, real_artifact_dir / "pi-output.jsonl")

	def test_returns_none_when_inner_results_jsonl_is_missing(self):
		with tempfile.TemporaryDirectory() as d:
			self.assertIsNone(battery_lib.resolve_pi_output_path(Path(d)))

	def test_returns_none_when_the_resolved_pi_output_file_does_not_exist(self):
		with tempfile.TemporaryDirectory() as d:
			run_root = Path(d) / "run"
			run_root.mkdir()
			write_row(run_root / "results.jsonl", pair=1, artifact_dir=str(Path(d) / "gone"))
			self.assertIsNone(battery_lib.resolve_pi_output_path(run_root))

	def test_uses_the_last_line_when_several_are_present(self):
		# execute_arm's own results.jsonl is append-only; a resumed/retried
		# run_root could in principle accumulate more than one line (though
		# the driver names attempts into distinct run_roots) -- the *last*
		# one is always the authoritative artifact_dir.
		with tempfile.TemporaryDirectory() as d:
			run_root = Path(d) / "run"
			run_root.mkdir()
			stale_dir = Path(d) / "stale"
			stale_dir.mkdir()
			(stale_dir / "pi-output.jsonl").write_text("{}\n")
			real_dir = Path(d) / "real"
			real_dir.mkdir()
			(real_dir / "pi-output.jsonl").write_text("{}\n")
			write_row(run_root / "results.jsonl", pair=1, artifact_dir=str(stale_dir))
			write_row(run_root / "results.jsonl", pair=1, artifact_dir=str(real_dir))

			resolved = battery_lib.resolve_pi_output_path(run_root)

			self.assertEqual(resolved, real_dir / "pi-output.jsonl")


class MemoryAbortsForRowTests(unittest.TestCase):
	def test_trusts_an_explicit_memory_aborts_field(self):
		row = {"memory_aborts": 3, "artifact_dir": "/should/not/be/read"}
		self.assertEqual(battery_lib.memory_aborts_for_row(row), 3)

	def test_falls_back_to_resolving_from_disk_when_the_field_is_absent(self):
		# Models the real 2026-10-04-parity-phase0 battery: rows recorded
		# before `memory_aborts` existed as a field at all.
		with tempfile.TemporaryDirectory() as d:
			run_root = Path(d) / "run"
			run_root.mkdir()
			real_dir = Path(d) / "real"
			real_dir.mkdir()
			(real_dir / "pi-output.jsonl").write_text(
				(FIXTURES / "pi-output-memory-abort.jsonl").read_text()
			)
			write_row(run_root / "results.jsonl", pair=1, artifact_dir=str(real_dir))
			row = {"task": "go/lru-cache", "arm": "baseline", "rep": 1, "artifact_dir": str(run_root)}

			self.assertEqual(battery_lib.memory_aborts_for_row(row), 1)

	def test_no_artifact_dir_and_no_field_is_zero(self):
		self.assertEqual(battery_lib.memory_aborts_for_row({"task": "x", "arm": "y", "rep": 1}), 0)


class NeedsRetryTests(unittest.TestCase):
	def test_first_attempt_failed_with_abort_needs_retry(self):
		row = {"attempt": 1, "passed": False, "memory_aborts": 1}
		self.assertTrue(battery_lib.needs_retry(row))

	def test_first_attempt_defaults_to_attempt_one_when_field_absent(self):
		row = {"passed": False, "memory_aborts": 1}
		self.assertTrue(battery_lib.needs_retry(row))

	def test_passed_run_never_needs_retry_even_with_an_abort(self):
		row = {"attempt": 1, "passed": True, "memory_aborts": 1}
		self.assertFalse(battery_lib.needs_retry(row))

	def test_failed_run_without_an_abort_does_not_need_retry(self):
		row = {"attempt": 1, "passed": False, "memory_aborts": 0}
		self.assertFalse(battery_lib.needs_retry(row))

	def test_attempt_two_never_needs_retry_even_if_it_also_aborted_and_failed(self):
		row = {"attempt": 2, "passed": False, "memory_aborts": 1}
		self.assertFalse(battery_lib.needs_retry(row))


class LoadLatestAttemptsTests(unittest.TestCase):
	def test_a_later_attempt_overrides_an_earlier_one_for_the_same_key(self):
		with tempfile.TemporaryDirectory() as d:
			results = Path(d) / "results.jsonl"
			write_row(results, task="t", arm="baseline", rep=1, attempt=1, passed=False, memory_aborts=1)
			write_row(results, task="t", arm="baseline", rep=1, attempt=2, passed=True, memory_aborts=0)

			latest = battery_lib.load_latest_attempts(results)

			self.assertEqual(latest[("t", "baseline", 1)]["attempt"], 2)
			self.assertTrue(latest[("t", "baseline", 1)]["passed"])

	def test_distinct_keys_are_tracked_independently(self):
		with tempfile.TemporaryDirectory() as d:
			results = Path(d) / "results.jsonl"
			write_row(results, task="t", arm="baseline", rep=1, passed=True)
			write_row(results, task="t", arm="harness", rep=1, passed=False)
			write_row(results, task="t", arm="baseline", rep=2, passed=False)

			latest = battery_lib.load_latest_attempts(results)

			self.assertEqual(len(latest), 3)

	def test_missing_file_returns_empty(self):
		self.assertEqual(battery_lib.load_latest_attempts(Path("/nonexistent/results.jsonl")), {})


class ResumeSelectionTests(unittest.TestCase):
	"""done_keys / pending_retry_keys together drive run_parity_battery.py's
	resume logic: a key is either done (skip outright), pending a retry
	(resume straight into attempt 2, never re-running attempt 1), or absent
	from both (never run at all -- the normal todo path)."""

	def test_a_clean_pass_is_done(self):
		latest = {("t", "baseline", 1): {"attempt": 1, "passed": True, "memory_aborts": 0}}
		self.assertEqual(battery_lib.done_keys(latest), {("t", "baseline", 1)})
		self.assertEqual(battery_lib.pending_retry_keys(latest), set())

	def test_a_plain_failure_with_no_abort_is_done_not_pending(self):
		# An ordinary code failure must not be treated as needing an
		# infrastructure retry -- only a memory-aborted failure does.
		latest = {("t", "baseline", 1): {"attempt": 1, "passed": False, "memory_aborts": 0}}
		self.assertEqual(battery_lib.done_keys(latest), {("t", "baseline", 1)})
		self.assertEqual(battery_lib.pending_retry_keys(latest), set())

	def test_an_aborted_first_attempt_failure_is_not_done_and_is_pending(self):
		latest = {("t", "baseline", 1): {"attempt": 1, "passed": False, "memory_aborts": 1}}
		self.assertEqual(battery_lib.done_keys(latest), set())
		self.assertEqual(battery_lib.pending_retry_keys(latest), {("t", "baseline", 1)})

	def test_an_already_recorded_attempt_two_is_done_even_if_it_also_failed(self):
		# The automatic retry is once-only: a resumed run must not try a
		# third time just because attempt 2 also aborted and failed.
		latest = {("t", "baseline", 1): {"attempt": 2, "passed": False, "memory_aborts": 1}}
		self.assertEqual(battery_lib.done_keys(latest), {("t", "baseline", 1)})
		self.assertEqual(battery_lib.pending_retry_keys(latest), set())


class RerunAbortedTargetsTests(unittest.TestCase):
	def test_selects_latest_rows_with_an_abort_and_a_failure(self):
		latest = {
			("a", "baseline", 1): {"attempt": 1, "passed": False, "memory_aborts": 1},
			("b", "baseline", 1): {"attempt": 1, "passed": True, "memory_aborts": 1},
			("c", "baseline", 1): {"attempt": 1, "passed": False, "memory_aborts": 0},
		}
		targets = battery_lib.rerun_aborted_targets(latest)
		self.assertEqual(targets, {("a", "baseline", 1): 2})

	def test_next_attempt_is_latest_attempt_plus_one_even_past_attempt_two(self):
		# Unlike the automatic once-only retry, --rerun-aborted has no
		# attempt==1 restriction: a run already rerun once by hand and
		# still aborting-and-failing can be rerun again.
		latest = {("a", "baseline", 1): {"attempt": 2, "passed": False, "memory_aborts": 1}}
		targets = battery_lib.rerun_aborted_targets(latest)
		self.assertEqual(targets, {("a", "baseline", 1): 3})


class OutcomeCodeTests(unittest.TestCase):
	def test_passed(self):
		self.assertEqual(battery_lib.outcome_code({"passed": True, "timed_out": False}), "P")

	def test_timed_out_wins_over_passed_false(self):
		self.assertEqual(battery_lib.outcome_code({"passed": False, "timed_out": True}), "T")

	def test_failed(self):
		self.assertEqual(battery_lib.outcome_code({"passed": False, "timed_out": False}), "F")

	def test_missing_row(self):
		self.assertEqual(battery_lib.outcome_code(None), ".")


if __name__ == "__main__":
	unittest.main()


class HasConnectionErrorTests(unittest.TestCase):
	def test_model_text_mentioning_connection_error_is_not_an_error(self):
		stdout = json.dumps({"type": "message_end", "message": {"role": "assistant", "stopReason": "stop",
			"content": [{"type": "text", "text": "upstream 503 -> [], connection error -> []"}]}})
		self.assertFalse(battery_lib.has_connection_error(stdout, ""))

	def test_error_event_with_connection_error_counts(self):
		stdout = json.dumps({"type": "message_end", "message": {"role": "assistant", "stopReason": "error",
			"errorMessage": "Connection error."}})
		self.assertTrue(battery_lib.has_connection_error(stdout, ""))

	def test_stderr_counts(self):
		self.assertTrue(battery_lib.has_connection_error("", "Error: Connection error."))

	def test_real_false_positive_capture(self):
		# The 2026-10-04 aistack-models-hide-offline rep3 run: hidden tests passed,
		# the model's summary said "connection error -> []".
		capture = Path("/private/tmp/pi-screen-27-baseline-lwe916d5/pi-output.jsonl")
		if not capture.exists():
			self.skipTest("capture not on this machine")
		self.assertFalse(battery_lib.has_connection_error(capture.read_text(errors="replace"), ""))
