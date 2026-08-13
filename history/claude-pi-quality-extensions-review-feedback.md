# Remaining review feedback — Pi quality extensions and validation harness

Updated 2026-07-24. All prior code-level review findings have been addressed
in `agent-configs` commit `8a7589b` and the preceding fixes in `04d72d5`.

> **Historical snapshot.** This document does not evaluate the 2026-08-02
> deployed configuration. Use `pi-harness-validation-status.md` for current
> status, including the finding that Pi's enabled reviewer now uses the same
> Qwen model and `:8080` route as its primary agent.

**Resolved, 2026-07-26**: the "empirical validation remains incomplete"
claim below, and the specific `results.tsv`-is-empty observation it's
based on, describe a snapshot mid-run. The batch this section is
describing as not-yet-started is the same one that went on to complete
cleanly (27/27 runs, zero connection errors, zero `ext_errors`) — see
`ai-stack/local-quality-next-steps-status.md`'s "Fifth attempt superseded"
section and the consolidated cross-repo summary in
`agent-configs/pi-harness-validation-status.md`. This file was left
untracked (never committed) when that resolution happened; committing it
now for the historical record rather than deleting it, since the
deterministic-extension-check results below are still accurate.

## Empirical validation remains incomplete

The focused deterministic extension checks pass locally:

- the continuation nudge queues exactly one `followUp` message;
- the reviewer uses its captured base SHA, preserves its retry opportunity on
  an empty diff, and queues a flagged finding as a `followUp`;
- exact `NO_ISSUES_FOUND` suppresses a follow-up, while a near-match remains a
  finding.

The full benchmark comparison is still required. At this review point,
`/Users/kanna/code/ai-stack/scratch-phase-validate/results.tsv` has only its
header, `batch.log` is empty, and there is no active batch or Pi process. The
status document says the fourth re-run was launched, but the current artifacts
do not yet prove that it ran.

Complete the planned 27-run battery and retain the resulting `results.tsv`.
Report `TEST_EXIT`, `NUDGED`, `REVIEWED`, and `EXT_ERRORS` for every arm. The
full Phase 2 seeded-fixture battery and Phase 3 real-history validation remain
separate plan-level work, as documented in
`ai-stack/local-quality-next-steps-status.md`.

## Verification performed for this update

- Re-ran `/tmp/pi-mock-check/check-nudge.mjs` and
  `/tmp/pi-mock-check/check-review.mjs`; every assertion passed.
- Inspected commits `04d72d5`, `e8931c5`, and `8a7589b`.
- Confirmed `git diff --check` passes for both worktrees.
- Confirmed the current scratch batch has no completed rows or active process.
