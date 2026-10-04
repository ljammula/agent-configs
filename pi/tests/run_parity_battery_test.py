import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


FIXTURES = Path(__file__).resolve().parent / "fixtures" / "battery"
SCRIPT = Path(__file__).resolve().parents[1] / "evals" / "run_parity_battery.py"
SPEC = importlib.util.spec_from_file_location("run_parity_battery", SCRIPT)
assert SPEC and SPEC.loader
run_parity_battery = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = run_parity_battery
SPEC.loader.exec_module(run_parity_battery)


def read_rows(results: Path) -> list[dict]:
	if not results.exists():
		return []
	return [json.loads(line) for line in results.read_text().splitlines() if line.strip()]


def fake_record(artifact_dir: Path, passed: bool, timed_out: bool = False) -> dict:
	return {
		"valid": True, "passed": passed, "timed_out": timed_out,
		"usage": {"prompt_tokens": 1}, "artifact_dir": str(artifact_dir),
	}


class RunOneAttemptTests(unittest.TestCase):
	def test_appends_a_row_with_attempt_and_memory_aborts_fields(self):
		with tempfile.TemporaryDirectory() as d:
			out = Path(d) / "out"
			out.mkdir()
			results = out / "results.jsonl"
			artifact_dir = Path(d) / "artifact"
			artifact_dir.mkdir()
			(artifact_dir / "pi-output.jsonl").write_text(
				(FIXTURES / "pi-output-memory-abort.jsonl").read_text()
			)
			with mock.patch.object(
				run_parity_battery, "execute_arm",
				return_value=fake_record(artifact_dir, passed=False),
			):
				row = run_parity_battery.run_one_attempt(
					out, results, "go/lru-cache", "baseline", 1, attempt=1, host="127.0.0.1",
				)

			self.assertEqual(row["attempt"], 1)
			self.assertEqual(row["memory_aborts"], 1)
			self.assertFalse(row["passed"])
			rows = read_rows(results)
			self.assertEqual(len(rows), 1)
			self.assertEqual(rows[0]["task"], "go/lru-cache")

	def test_an_exception_from_execute_arm_is_recorded_not_raised(self):
		with tempfile.TemporaryDirectory() as d:
			out = Path(d) / "out"
			out.mkdir()
			results = out / "results.jsonl"
			with mock.patch.object(
				run_parity_battery, "execute_arm", side_effect=RuntimeError("model endpoint unavailable"),
			):
				row = run_parity_battery.run_one_attempt(
					out, results, "go/lru-cache", "baseline", 1, attempt=1, host="127.0.0.1",
				)

			self.assertIn("model endpoint unavailable", row["error"])
			self.assertIsNone(row["passed"])
			self.assertEqual(row["memory_aborts"], 0)


class RunWithAutoRetryTests(unittest.TestCase):
	def test_a_passing_first_attempt_is_not_retried(self):
		with tempfile.TemporaryDirectory() as d:
			out = Path(d) / "out"
			out.mkdir()
			results = out / "results.jsonl"
			artifact_dir = Path(d) / "artifact"
			artifact_dir.mkdir()
			(artifact_dir / "pi-output.jsonl").write_text(
				(FIXTURES / "pi-output-clean.jsonl").read_text()
			)
			with mock.patch.object(
				run_parity_battery, "execute_arm",
				return_value=fake_record(artifact_dir, passed=True),
			) as execute:
				run_parity_battery.run_with_auto_retry(
					out, results, "go/lru-cache", "baseline", 1, host="127.0.0.1", start_attempt=1,
				)
			self.assertEqual(execute.call_count, 1)
			rows = read_rows(results)
			self.assertEqual([r["attempt"] for r in rows], [1])

	def test_a_memory_aborted_failure_on_attempt_one_retries_once_automatically(self):
		with tempfile.TemporaryDirectory() as d:
			out = Path(d) / "out"
			out.mkdir()
			results = out / "results.jsonl"
			aborted_dir = Path(d) / "aborted"
			aborted_dir.mkdir()
			(aborted_dir / "pi-output.jsonl").write_text(
				(FIXTURES / "pi-output-memory-abort.jsonl").read_text()
			)
			clean_dir = Path(d) / "clean"
			clean_dir.mkdir()
			(clean_dir / "pi-output.jsonl").write_text((FIXTURES / "pi-output-clean.jsonl").read_text())

			with mock.patch.object(
				run_parity_battery, "execute_arm",
				side_effect=[fake_record(aborted_dir, passed=False), fake_record(clean_dir, passed=True)],
			) as execute:
				run_parity_battery.run_with_auto_retry(
					out, results, "go/lru-cache", "baseline", 1, host="127.0.0.1", start_attempt=1,
				)

			self.assertEqual(execute.call_count, 2)
			rows = read_rows(results)
			self.assertEqual([r["attempt"] for r in rows], [1, 2])
			self.assertFalse(rows[0]["passed"])
			self.assertTrue(rows[1]["passed"])

	def test_a_memory_aborted_failure_on_attempt_two_does_not_retry_again(self):
		# start_attempt=2 models resuming a run whose attempt-1 row already
		# needed a retry; the loop must not chain a third attempt even if
		# attempt 2 also aborts and fails.
		with tempfile.TemporaryDirectory() as d:
			out = Path(d) / "out"
			out.mkdir()
			results = out / "results.jsonl"
			aborted_dir = Path(d) / "aborted"
			aborted_dir.mkdir()
			(aborted_dir / "pi-output.jsonl").write_text(
				(FIXTURES / "pi-output-memory-abort.jsonl").read_text()
			)
			with mock.patch.object(
				run_parity_battery, "execute_arm", return_value=fake_record(aborted_dir, passed=False),
			) as execute:
				run_parity_battery.run_with_auto_retry(
					out, results, "go/lru-cache", "baseline", 1, host="127.0.0.1", start_attempt=2,
				)
			self.assertEqual(execute.call_count, 1)
			rows = read_rows(results)
			self.assertEqual([r["attempt"] for r in rows], [2])


class MainResumeAndRerunTests(unittest.TestCase):
	def _write_existing(self, results: Path, **fields) -> None:
		results.parent.mkdir(parents=True, exist_ok=True)
		with results.open("a") as f:
			f.write(json.dumps(fields) + "\n")

	def test_resume_skips_a_terminal_row_and_does_not_call_execute_arm_for_it(self):
		with tempfile.TemporaryDirectory() as d:
			out = Path(d) / "out"
			results = out / "results.jsonl"
			self._write_existing(
				results, ts="x", task="go/lru-cache", arm="baseline", rep=1, attempt=1,
				passed=True, memory_aborts=0, artifact_dir=str(out / "go__lru-cache__baseline__rep1"),
			)
			argv = [
				"run_parity_battery.py", "--out", str(out), "--reps", "1",
				"--tasks", "go/lru-cache", "--arms", "baseline",
			]
			with mock.patch.object(sys, "argv", argv), \
				mock.patch.object(run_parity_battery, "execute_arm") as execute:
				run_parity_battery.main()
			execute.assert_not_called()

	def test_resume_re_enters_a_pending_retry_at_attempt_two_not_attempt_one(self):
		with tempfile.TemporaryDirectory() as d:
			out = Path(d) / "out"
			results = out / "results.jsonl"
			self._write_existing(
				results, ts="x", task="go/lru-cache", arm="baseline", rep=1, attempt=1,
				passed=False, memory_aborts=1, artifact_dir=str(out / "go__lru-cache__baseline__rep1"),
			)
			artifact_dir = Path(d) / "resumed-attempt-2"
			artifact_dir.mkdir()
			(artifact_dir / "pi-output.jsonl").write_text((FIXTURES / "pi-output-clean.jsonl").read_text())
			argv = [
				"run_parity_battery.py", "--out", str(out), "--reps", "1",
				"--tasks", "go/lru-cache", "--arms", "baseline",
			]
			with mock.patch.object(sys, "argv", argv), \
				mock.patch.object(
					run_parity_battery, "execute_arm", return_value=fake_record(artifact_dir, passed=True),
				) as execute:
				run_parity_battery.main()

			self.assertEqual(execute.call_count, 1)
			rows = read_rows(results)
			self.assertEqual([r["attempt"] for r in rows], [1, 2])
			self.assertTrue(rows[1]["passed"])

	def test_rerun_aborted_targets_only_aborted_and_failed_latest_rows(self):
		with tempfile.TemporaryDirectory() as d:
			out = Path(d) / "out"
			results = out / "results.jsonl"
			self._write_existing(
				results, ts="x", task="go/lru-cache", arm="baseline", rep=1, attempt=1,
				passed=False, memory_aborts=1, artifact_dir=str(out / "go__lru-cache__baseline__rep1"),
			)
			self._write_existing(
				results, ts="x", task="go/notes-api", arm="baseline", rep=1, attempt=1,
				passed=False, memory_aborts=0, artifact_dir=str(out / "go__notes-api__baseline__rep1"),
			)
			artifact_dir = Path(d) / "rerun-result"
			artifact_dir.mkdir()
			(artifact_dir / "pi-output.jsonl").write_text((FIXTURES / "pi-output-clean.jsonl").read_text())
			argv = ["run_parity_battery.py", "--out", str(out), "--rerun-aborted"]
			with mock.patch.object(sys, "argv", argv), \
				mock.patch.object(
					run_parity_battery, "execute_arm", return_value=fake_record(artifact_dir, passed=True),
				) as execute:
				run_parity_battery.main()

			# Only the memory-aborted go/lru-cache row is rerun -- the
			# ordinary code failure on go/notes-api is left alone.
			self.assertEqual(execute.call_count, 1)
			rows = read_rows(results)
			lru_rows = [r for r in rows if r["task"] == "go/lru-cache"]
			notes_rows = [r for r in rows if r["task"] == "go/notes-api"]
			self.assertEqual([r["attempt"] for r in lru_rows], [1, 2])
			self.assertEqual(len(notes_rows), 1)


if __name__ == "__main__":
	unittest.main()
