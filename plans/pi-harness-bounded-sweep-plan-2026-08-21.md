# Bounded config-sweep plan for the pi.dev/Qwen3.8 harness

Status: proposed, not yet implemented

Date: 2026-08-21

Scope: implementation contract for a bounded, human-gated config sweep
around the existing `pi/evals/run_screening.py` battery. Runtime evidence
lands in `pi/evals/battery-results/`; ongoing findings go in
`pi-harness-history.md` and `pi-harness-validation-status.md` per the
existing convention.

## Origin and outcome

This followed from a conversation about whether the pi.dev/Qwen3.8 harness
tuning loop (currently: run the battery by hand, read results, hand-edit
`defaultThinkingLevel`/temperature/prompt in `pi/settings.json` and
`pi/extensions/ai-stack-local.ts`, rerun) should become a fully
self-improving, autonomous loop — the harness proposing and committing its
own tuning changes based on eval feedback.

**Decision: no to full autonomy.** Three reasons specific to this project's
own history, not hypothetical:

1. **Trials are slow.** The pair-4 `xhigh` rerun took 1745.7s for one task
   at one config (`pi-harness-validation-status.md`, 2026-08-20 entry). A
   real hyperparameter search needs many trials per candidate to clear
   noise — hours of compute per sweep, not something to run unattended.
2. **The eval is already known to be noisy.** The 36-arm `local-model-bench`
   trial (see `rtk-keep-as-is` memory) found a smaller, noisier effect than
   its first pass, and outright run-to-run flakiness independent of harness
   choice. Small-n pass/fail counts (`0/4`, `3/3`) are easy to overfit.
3. **The real findings so far came from skeptical review, not pass-rate
   chasing.** The Opus review that caught this doc's "thinking forced fully
   off at two layers" claim being backwards, and the discovery that
   `reasoning: 0` in usage lines is likely a structural null rather than
   evidence of no reasoning, would not have surfaced from an optimizer that
   only watches whether the battery passed.

**Outcome of this plan**: a `Workflow` script that runs a small, fixed set
of candidate configs against a fixed task subset in parallel, and reports
pass/fail + timing deltas with the same verified-vs-assumed rigor the
existing docs use. It stops at the report. A human (or a follow-up Claude
Code turn) reads the report and decides whether to hand-edit
`pi/settings.json`/`ai-stack-local.ts` and commit — exactly as today, minus
the one-candidate-at-a-time legwork.

## Non-goals

- No automatic editing of `pi/settings.json`, `pi/extensions/ai-stack-local.ts`,
  or any other live harness config. The workflow only reads config and
  writes a report; applying a change stays a separate, human-reviewed step.
- No continuous/scheduled sweeping. This runs on demand, invoked
  explicitly, because each run costs real wall-clock time on the local
  model.
- No expansion of the search space beyond what's explicitly listed in the
  sweep config for a given invocation — no "while we're at it, also try…"
  additions inside the script itself.
- Not a replacement for `run_screening.py`/`run_single_arm.py`. The
  workflow calls them as a subprocess per candidate; it does not
  reimplement grading, scoring, or the existing fixture-hygiene cleanup
  (`remove_prohibited_scratch_files()`).
- Does not touch the reviewer route (`cross-model-review.ts`) or the
  `:8080` model swap history — orthogonal to this sweep.

## Design

### Inputs (per invocation, via `Workflow`'s `args`)

- `candidates`: list of `{label, thinking_level, temperature?}` — the
  configs to compare. Kept small by convention (2-4 candidates) since each
  one is a real battery subprocess.
- `pairs` or `--max-pairs`: which task pairs to run, defaulting to a fixed
  small subset (e.g. the existing pair-1/pair-4 pairing already used for
  reruns in `pi-harness-validation-status.md`) rather than the full
  battery, to keep a single sweep invocation bounded.
- `seed`: fixed seed, reused across candidates so the task/prompt content
  is identical between arms — only the config under test varies.

### Mechanics

1. For each candidate, the workflow spawns one agent whose job is to
   invoke `run_screening.py` (or `run_single_arm.py` for a single pair)
   with that candidate's `--thinking`/temperature override and the shared
   seed, and report back the run's own result record (pass/fail, seconds,
   any `removed_prohibited_scratch_files` entries, hidden-test exit code)
   — not its own summary or judgment of what the numbers mean.
2. `pipeline()` over candidates × pairs, since candidates are independent
   of each other (no cross-candidate synchronization needed until the
   report stage) — this matches the "default to pipeline, only barrier
   when stage N needs all of stage N-1" guidance, and here it does: the
   report stage needs every candidate's result to build the comparison
   table.
3. A final report stage (single agent, or plain script code) assembles a
   table: candidate × pair → pass/fail, seconds, notes — mirroring the
   table format already used in `pi-harness-validation-status.md`, so the
   output slots into that doc without reformatting.
4. The workflow's return value is that table plus raw per-run paths under
   `pi/evals/battery-results/<date>-sweep-<label>/`, following the existing
   non-commit convention for raw evidence directories.

### What counts as a "verified" result vs. "assumed"

Following the existing doc convention (see the "Verified-vs-assumed table"
in `qwen38-agentic-coding-tuning-research.md`): the report must distinguish
"the run's own record says X" (verified) from "this implies the config
change caused X" (an inference, flagged as such, left for the human review
step rather than asserted by the workflow).

## Acceptance criteria

- Running the workflow with 2 candidates × 2 pairs produces one report
  containing per-cell pass/fail, timing, and raw result paths — no config
  file under `pi/` is modified by the run.
- The report explicitly separates run-record facts from interpretation,
  matching the rest of this project's documentation style.
- A dry run with `candidates` limited to the harness's *current* live
  config (no change) reproduces the same pass/fail as the most recent
  manual run of the same pair/seed in `pi-harness-validation-status.md`,
  confirming the workflow calls the runner the same way a human invocation
  does before it's trusted for comparative sweeps.
- Total wall-clock and candidate count for a single invocation stay bounded
  and visible up front (the workflow logs the full candidate × pair matrix
  size before starting), so a sweep's cost is known before it runs, not
  discovered after.

## Follow-up (explicitly out of scope for this plan)

- Whether to fold the sweep report format back into
  `qwen38-agentic-coding-tuning-research.md`'s existing tables, or keep it
  as a separate artifact under `pi/evals/battery-results/` — decide once
  the first real sweep report exists to look at.
- Any move beyond "human reads report, hand-edits config" — e.g. a
  proposed-diff step the human approves inline — is a candidate for a
  later plan, not this one, and should only be considered after this
  bounded version has run enough times to show the report format and cost
  are trustworthy.
