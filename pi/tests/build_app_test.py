import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_app.py"
SPEC = importlib.util.spec_from_file_location("build_app", SCRIPT)
assert SPEC and SPEC.loader
build_app = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = build_app
SPEC.loader.exec_module(build_app)


def pi_output(review_outcome: str, findings: str = "") -> str:
	metadata = {"trigger": "settlement"}
	if findings:
		metadata["findings"] = findings
	events = [
		{"type": "entry_appended", "entry": {"customType": "pi-harness-trace", "data": {
			"extension": "reviewer", "event": "startup", "outcome": "pass", "metadata": {},
		}}},
		{"type": "entry_appended", "entry": {"customType": "pi-harness-trace", "data": {
			"extension": "reviewer", "event": "review", "outcome": review_outcome, "metadata": metadata,
		}}},
	]
	return "\n".join(json.dumps(event) for event in events)


class BuildAppTests(unittest.TestCase):
	def test_pi_invocation_inherits_thinking_unless_explicitly_overridden(self):
		base = dict(
			workspace=Path("/tmp/work"), prompt="do it", session_dir=Path("/tmp/session"),
			containment=False, continue_session=False,
		)
		inherited = build_app.pi_invocation(**base, thinking=None)
		overridden = build_app.pi_invocation(**base, thinking="xhigh")
		self.assertNotIn("--thinking", inherited)
		self.assertEqual(overridden[overridden.index("--thinking") + 1], "xhigh")

	def test_resolve_verify_command_falls_back_when_tsx_is_missing(self):
		# Regression for a Codex PR #22 review finding: a fresh checkout where
		# `npm install` was never run (pi/node_modules is gitignored, tsx is a
		# devDependency, install.sh doesn't install it) must still resolve a
		# real verify command instead of silently reporting none exists.
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			(root / "Makefile").write_text("verify:\n\t@true\ntest:\n\t@true\n")
			with mock.patch.object(build_app, "TSX", Path("/nonexistent/tsx")):
				self.assertEqual(build_app.resolve_verify_command(root), "make verify")

	def test_resolve_verify_command_trusts_a_clean_tsx_resolver_with_no_command(self):
		# The fallback must not override a real resolver run that cleanly
		# determined there's nothing to verify -- that's a more accurate
		# answer than the fallback's shallow root-only scan, not a failure.
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			(root / "Makefile").write_text("verify:\n\t@true\n")
			clean_no_command = subprocess.CompletedProcess(args=[], returncode=0, stdout=json.dumps({"command": None}), stderr="")
			with mock.patch.object(build_app, "TSX", Path(__file__)):
				with mock.patch.object(build_app, "sh", return_value=clean_no_command):
					self.assertIsNone(build_app.resolve_verify_command(root))

	def test_shared_verifier_rejects_a_failure_in_either_nested_component(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			for name in ("api", "client"):
				component = root / name
				component.mkdir()
				(component / "Makefile").write_text("verify:\n\t@test -f ok\n")
				(component / "ok").touch()

			command, passed, _timed_out, _output = build_app.run_verification(root)
			self.assertTrue(passed)
			self.assertIn("api", command)
			self.assertIn("client", command)

			(root / "api" / "ok").unlink()
			self.assertFalse(build_app.run_verification(root)[1])
			(root / "api" / "ok").touch()
			(root / "client" / "ok").unlink()
			self.assertFalse(build_app.run_verification(root)[1])

	def test_correctness_signals_block_success_and_degraded_policy_is_explicit(self):
		traces = build_app.parse_pi_traces("\n".join([
			pi_output("flagged", "cache.go: evicts by value"),
			json.dumps({"type": "entry_appended", "entry": {"customType": "pi-stall-trace", "data": {
				"outcome": "stall-timeout", "stallTimeout": True,
			}}}),
		]))
		blockers, review = build_app.round_blockers(
			verify_passed=True, pi_failed=False, pi_timed_out=False,
			traces=traces, review_policy="required",
		)
		self.assertEqual(review.outcome, "flagged")
		self.assertIn("stall-timeout", blockers)
		self.assertIn("reviewer flagged the current diff", blockers)

		# The reviewer intentionally records an unchanged settlement as blocked
		# after its decisive verdict. Keep the verdict for the current diff.
		unchanged = build_app.parse_pi_traces("\n".join([
			pi_output("clean"),
			json.dumps({"type": "entry_appended", "entry": {
				"customType": "pi-harness-trace", "data": {
					"extension": "reviewer", "event": "review", "outcome": "blocked",
					"metadata": {"reason": "unchanged-since-last-review"},
				},
			}}),
		]))
		self.assertEqual(build_app.review_signal(unchanged).outcome, "clean")

		# A bounded transient retry is followed by a blocked settlement marker;
		# preserve the original transport failure so the outer runner can retry.
		transient_retry_exhausted = build_app.parse_pi_traces("\n".join([
			json.dumps({"type": "entry_appended", "entry": {"customType": "pi-harness-trace", "data": {
				"extension": "reviewer", "event": "review", "outcome": "transient",
				"metadata": {"reason": "request-failed"},
			}}}),
			json.dumps({"type": "entry_appended", "entry": {"customType": "pi-harness-trace", "data": {
				"extension": "reviewer", "event": "review", "outcome": "blocked",
				"metadata": {"reason": "transient-retry-exhausted"},
			}}}),
		]))
		self.assertEqual(build_app.review_signal(transient_retry_exhausted).detail, "request-failed")

		blockers, review = build_app.round_blockers(
			verify_passed=True, pi_failed=False, pi_timed_out=False,
			traces=[], review_policy="degraded",
		)
		self.assertEqual(review.outcome, "unavailable")
		self.assertEqual(blockers, [])
		required_blockers, _review = build_app.round_blockers(
			verify_passed=True, pi_failed=False, pi_timed_out=False,
			traces=[], review_policy="required",
		)
		self.assertEqual(required_blockers, ["review unavailable (no-review-verdict)"])

	def test_empty_diff_always_blocks_required_review_even_with_passing_verify(self):
		# An empty diff means the reviewer genuinely had nothing to look at --
		# with --review-base-sha anchoring the reviewer to the ticket's real
		# start (not just this process's start), that can only mean nothing
		# has changed since the ticket began. A passing `make verify` is not
		# a substitute for the independent review this policy exists to
		# require (Codex review on PR #25: silently accepting verify-passed
		# as a proxy for "reviewed" defeats required review exactly where it
		# matters most -- already-committed, never-reviewed work).
		empty_diff = build_app.parse_pi_traces(json.dumps({"type": "entry_appended", "entry": {
			"customType": "pi-harness-trace", "data": {
				"extension": "reviewer", "event": "review", "outcome": "blocked",
				"metadata": {"reason": "empty-diff"},
			},
		}}))
		blockers, review = build_app.round_blockers(
			verify_passed=True, pi_failed=False, pi_timed_out=False,
			traces=empty_diff, review_policy="required",
		)
		self.assertEqual(review.detail, "empty-diff")
		self.assertEqual(blockers, ["review unavailable (empty-diff)"])

	def test_empty_diff_fails_fast_instead_of_burning_the_round_budget(self):
		# No amount of retrying turns an empty diff non-empty, so this is a
		# NON_RETRYABLE_REVIEW_FAILURES entry: stop after round 1 with an
		# honest "never reviewed" halt rather than looping to max_rounds.
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			spec = root / "spec.md"
			spec.write_text("Already-done ticket")
			output = json.dumps({"type": "entry_appended", "entry": {
				"customType": "pi-harness-trace", "data": {
					"extension": "reviewer", "event": "review", "outcome": "blocked",
					"metadata": {"reason": "empty-diff"},
				},
			}})
			with (
				mock.patch.object(build_app, "ensure_git_repo"),
				mock.patch.object(build_app, "run_verification", return_value=("make verify", True, False, "")),
				mock.patch.object(build_app, "sh", return_value=subprocess.CompletedProcess([], 0, output, "")) as run,
			):
				result = build_app.run_build(
					root, spec, max_rounds=6, containment=False, timeout_minutes=1,
				)
		self.assertFalse(result.succeeded)
		self.assertEqual(len(result.rounds), 1)
		self.assertEqual(run.call_count, 1)
		self.assertIn("empty-diff", result.stopped_reason)

	def test_review_base_sha_is_threaded_to_the_pi_invocation_env(self):
		# ticket_runner.py passes its prior-ticket-boundary commit here so the
		# reviewer anchors to the ticket's real start instead of "HEAD when
		# this process happens to start" -- see cross-model-review.ts's
		# AI_REVIEW_BASE_SHA handling.
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			spec = root / "spec.md"
			spec.write_text("Fix the cache")
			with (
				mock.patch.object(build_app, "ensure_git_repo"),
				mock.patch.object(build_app, "run_verification", return_value=("make verify", True, False, "")),
				mock.patch.object(build_app, "sh", return_value=subprocess.CompletedProcess([], 0, pi_output("clean"), "")) as run,
			):
				build_app.run_build(
					root, spec, max_rounds=1, containment=False, timeout_minutes=1,
					review_base_sha="deadbeef",
				)
			self.assertEqual(run.call_args.kwargs["env"]["AI_REVIEW_BASE_SHA"], "deadbeef")

	def test_flagged_review_drives_a_corrective_round(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			spec = root / "spec.md"
			spec.write_text("Fix the cache")
			completed = [
				subprocess.CompletedProcess([], 0, pi_output("flagged", "cache.go: evicts by value"), ""),
				subprocess.CompletedProcess([], 0, pi_output("clean"), ""),
			]
			with (
				mock.patch.object(build_app, "ensure_git_repo"),
				mock.patch.object(build_app, "run_verification", return_value=("make verify", True, False, "")),
				mock.patch.object(build_app, "sh", side_effect=completed),
			):
				result = build_app.run_build(
					root, spec, max_rounds=2, containment=False, timeout_minutes=1,
				)
		self.assertTrue(result.succeeded)
		self.assertEqual(len(result.rounds), 2)
		self.assertIn("cache.go: evicts by value", result.rounds[1].command[-1])

	def test_missing_required_reviewer_fails_fast_without_burning_local_rounds(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			spec = root / "spec.md"
			spec.write_text("Fix the cache")
			output = json.dumps({"type": "entry_appended", "entry": {
				"customType": "pi-harness-trace", "data": {
					"extension": "reviewer", "event": "startup", "outcome": "blocked",
					"metadata": {"reason": "missing-configuration"},
				},
			}})
			with (
				mock.patch.object(build_app, "ensure_git_repo"),
				mock.patch.object(build_app, "run_verification", return_value=("make verify", True, False, "")),
				mock.patch.object(build_app, "sh", return_value=subprocess.CompletedProcess([], 0, output, "")) as run,
			):
				result = build_app.run_build(
					root, spec, max_rounds=6, containment=False, timeout_minutes=1,
				)
		self.assertFalse(result.succeeded)
		self.assertEqual(len(result.rounds), 1)
		self.assertEqual(run.call_count, 1)
		self.assertIn("missing-configuration", result.stopped_reason)

	def test_opt_in_sonnet_fallback_runs_once_after_local_budget(self):
		with tempfile.TemporaryDirectory() as directory:
			root = Path(directory)
			spec = root / "spec.md"
			spec.write_text("Fix the cache")
			completed = [
				subprocess.CompletedProcess([], 0, pi_output("flagged", "cache.go: evicts by value"), ""),
				subprocess.CompletedProcess([], 0, json.dumps({"usage": {}, "total_cost_usd": 0.1}), ""),
			]
			with (
				mock.patch.object(build_app, "ensure_git_repo"),
				mock.patch.object(build_app, "resolve_verify_command", return_value="make verify"),
				mock.patch.object(build_app, "run_verification", return_value=("make verify", True, False, "")),
				mock.patch.object(build_app, "sh", side_effect=completed),
			):
				result = build_app.run_build(
					root, spec, max_rounds=1, containment=False, timeout_minutes=1,
					sonnet_fallback=True,
				)
		self.assertTrue(result.succeeded)
		self.assertEqual([round.agent for round in result.rounds], ["pi-local", "claude-sonnet-5"])


if __name__ == "__main__":
	unittest.main()
