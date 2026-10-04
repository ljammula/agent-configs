import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "evals" / "laya_failure_triage_eval.py"
SPEC = importlib.util.spec_from_file_location("laya_failure_triage_eval", SCRIPT)
assert SPEC and SPEC.loader
laya_eval = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = laya_eval
SPEC.loader.exec_module(laya_eval)
# Importing the module must never import `laya` itself -- that package
# (torch/transformers) lives only in the separate .venv-laya, not here.
# `laya` is imported lazily inside run_laya(), which these tests never call.


def write_inner_results(run_root: Path, artifact_dir: Path) -> None:
	run_root.mkdir(parents=True, exist_ok=True)
	with (run_root / "results.jsonl").open("a") as f:
		f.write(json.dumps({"pair": 1, "artifact_dir": str(artifact_dir)}) + "\n")


class LoadFailedRowsTests(unittest.TestCase):
	def test_only_passed_false_rows_are_loaded(self):
		with tempfile.TemporaryDirectory() as d:
			results = Path(d) / "results.jsonl"
			results.write_text("\n".join([
				json.dumps({"task": "a", "passed": True}),
				json.dumps({"task": "b", "passed": False}),
				json.dumps({"task": "c", "passed": None}),
			]) + "\n")
			rows = laya_eval.load_failed_rows(results)
			self.assertEqual([r["task"] for r in rows], ["b"])

	def test_missing_file_is_empty(self):
		self.assertEqual(laya_eval.load_failed_rows(Path("/nonexistent.jsonl")), [])


class LabelRowTests(unittest.TestCase):
	def test_memory_abort_is_infrastructure(self):
		row = {"memory_aborts": 1, "timed_out": False, "passed": False}
		self.assertEqual(laya_eval.label_row(row), "infrastructure")

	def test_timed_out_is_infrastructure_even_without_an_abort(self):
		row = {"memory_aborts": 0, "timed_out": True, "passed": False}
		self.assertEqual(laya_eval.label_row(row), "infrastructure")

	def test_plain_failure_is_code(self):
		row = {"memory_aborts": 0, "timed_out": False, "passed": False}
		self.assertEqual(laya_eval.label_row(row), "code")


class PiErrorMessagesTests(unittest.TestCase):
	def test_extracts_error_messages_in_order(self):
		with tempfile.TemporaryDirectory() as d:
			path = Path(d) / "pi-output.jsonl"
			path.write_text("\n".join([
				json.dumps({"type": "message_end", "message": {"role": "assistant", "stopReason": "stop"}}),
				json.dumps({"type": "message_end", "message": {
					"role": "assistant", "stopReason": "error", "errorMessage": "insufficient memory: shed caches",
				}}),
				json.dumps({"type": "message_end", "message": {
					"role": "assistant", "stopReason": "error", "errorMessage": "insufficient memory: again",
				}}),
			]) + "\n")
			self.assertEqual(
				laya_eval.pi_error_messages(path),
				["insufficient memory: shed caches", "insufficient memory: again"],
			)

	def test_missing_or_none_path_returns_empty(self):
		self.assertEqual(laya_eval.pi_error_messages(None), [])
		self.assertEqual(laya_eval.pi_error_messages(Path("/nonexistent.jsonl")), [])


class StateTextForRowTests(unittest.TestCase):
	def test_infrastructure_prefers_the_real_error_message(self):
		with tempfile.TemporaryDirectory() as d:
			run_root = Path(d) / "run"
			inner = Path(d) / "inner"
			inner.mkdir()
			(inner / "pi-output.jsonl").write_text(json.dumps({
				"type": "message_end",
				"message": {"role": "assistant", "stopReason": "error", "errorMessage": "insufficient memory: boom"},
			}) + "\n")
			write_inner_results(run_root, inner)
			row = {"artifact_dir": str(run_root)}

			text, source = laya_eval.state_text_for_row(row, "infrastructure")

			self.assertIn("insufficient memory: boom", text)
			self.assertEqual(source, "pi error message(s)")

	def test_infrastructure_falls_back_to_pi_output_tail_without_an_explicit_error(self):
		with tempfile.TemporaryDirectory() as d:
			run_root = Path(d) / "run"
			inner = Path(d) / "inner"
			inner.mkdir()
			(inner / "pi-output.jsonl").write_text(json.dumps({
				"type": "message_end",
				"message": {"role": "assistant", "stopReason": "pending"},
			}) + "\n")
			write_inner_results(run_root, inner)
			row = {"artifact_dir": str(run_root), "timed_out": True}

			text, source = laya_eval.state_text_for_row(row, "infrastructure")

			self.assertIn("pending", text)
			self.assertIn("timed out", source)

	def test_infrastructure_with_no_artifact_on_disk_is_synthetic(self):
		row = {"artifact_dir": "/nonexistent/run", "timed_out": True, "memory_aborts": 0}
		text, source = laya_eval.state_text_for_row(row, "infrastructure")
		self.assertIn("no pi-output.jsonl available", text)
		self.assertEqual(source, "synthetic (artifact no longer on disk)")

	def test_code_uses_hidden_test_output_log(self):
		with tempfile.TemporaryDirectory() as d:
			run_root = Path(d) / "run"
			inner = Path(d) / "inner"
			inner.mkdir()
			(inner / "hidden-test-output.log").write_text("--- FAIL: TestThing\nwant 1, got 2\n")
			write_inner_results(run_root, inner)
			row = {"artifact_dir": str(run_root)}

			text, source = laya_eval.state_text_for_row(row, "code")

			self.assertIn("FAIL: TestThing", text)
			self.assertEqual(source, "hidden-test-output.log")

	def test_tail_is_truncated_to_the_configured_length(self):
		with tempfile.TemporaryDirectory() as d:
			run_root = Path(d) / "run"
			inner = Path(d) / "inner"
			inner.mkdir()
			(inner / "hidden-test-output.log").write_text("x" * (laya_eval.TAIL_CHARS * 2))
			write_inner_results(run_root, inner)
			row = {"artifact_dir": str(run_root)}

			text, _source = laya_eval.state_text_for_row(row, "code")

			self.assertEqual(len(text), laya_eval.TAIL_CHARS)


class RegexPredictTests(unittest.TestCase):
	def test_matches_each_documented_pattern(self):
		for text in ["insufficient memory", "ECONNREFUSED", "the process timed out", "Killed"]:
			self.assertEqual(laya_eval.regex_predict(text), "infrastructure", text)

	def test_ordinary_failure_text_is_code(self):
		self.assertEqual(laya_eval.regex_predict("--- FAIL: TestThing\nwant 1, got 2"), "code")


class MetricsTests(unittest.TestCase):
	def test_accuracy_and_confusion_matrix(self):
		rows = [
			{"label": "infrastructure", "pred": "infrastructure"},
			{"label": "infrastructure", "pred": "code"},
			{"label": "code", "pred": "code"},
			{"label": "code", "pred": "code"},
		]
		self.assertEqual(laya_eval.accuracy(rows, "pred"), 0.75)
		matrix = laya_eval.confusion_matrix(rows, "pred")
		self.assertEqual(matrix["infrastructure"], {"infrastructure": 1, "code": 1})
		self.assertEqual(matrix["code"], {"infrastructure": 0, "code": 2})

	def test_accuracy_of_empty_rows_is_zero(self):
		self.assertEqual(laya_eval.accuracy([], "pred"), 0.0)

	def test_mean_confidence_splits_correct_from_wrong(self):
		rows = [
			{"label": "infrastructure", "pred": "infrastructure", "conf": 0.9},
			{"label": "infrastructure", "pred": "code", "conf": 0.6},
			{"label": "code", "pred": "code", "conf": 0.7},
		]
		self.assertAlmostEqual(laya_eval.mean_confidence(rows, "pred", "conf", True), 0.8)
		self.assertAlmostEqual(laya_eval.mean_confidence(rows, "pred", "conf", False), 0.6)

	def test_mean_confidence_with_no_matching_rows_is_none(self):
		rows = [{"label": "code", "pred": "code", "conf": 0.7}]
		self.assertIsNone(laya_eval.mean_confidence(rows, "pred", "conf", False))


if __name__ == "__main__":
	unittest.main()
