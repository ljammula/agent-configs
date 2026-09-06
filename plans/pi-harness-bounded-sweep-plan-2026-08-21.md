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
of candidate configs against a fixed task subset, one candidate's battery
run at a time (see the Mechanics note on why candidates can't run
concurrently against this backend), and reports pass/fail + timing deltas
with the same verified-vs-assumed rigor the existing docs use. It stops at
the report. A human (or a follow-up Claude Code turn) reads the report and
decides whether to hand-edit `pi/settings.json`/`ai-stack-local.ts` and
commit — exactly as today, minus the one-candidate-at-a-time legwork.

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
- Not a replacement for `run_screening.py`. The workflow calls it as a
  subprocess per candidate; it does not reimplement grading, scoring, or
  the existing fixture-hygiene cleanup (`remove_prohibited_scratch_files()`).
  `run_single_pair.py` is not used by this plan — its `--help` exposes only
  `--seed`, `--pair`, `--host`, and `--output`, no `--thinking`, so it
  cannot apply a candidate's config; see Mechanics item 1 for the
  `run_screening.py`-only invocation this plan uses instead.
- No temperature sweeping in this version. Neither `run_screening.py` nor
  `run_single_pair.py` exposes a temperature flag — it's hardcoded in
  `pi/extensions/ai-stack-local.ts`, which the non-goal above already
  forbids editing. Adding a `--temperature` override to the runner (so a
  future sweep could vary it as a genuine per-call override rather than a
  config-file edit) is a separate, later change, not part of this plan.
- Does not touch the reviewer route (`cross-model-review.ts`) or the
  `:8080` model swap history — orthogonal to this sweep.

## Design

### Inputs (per invocation, via `Workflow`'s `args`)

- `candidates`: list of `{label, thinking_level}` — the configs to
  compare. Kept small by convention (2-4 candidates) since each one is a
  real battery subprocess. Temperature is not a candidate field in this
  version — see the Non-goals entry above.
- `pairs`: which task pairs to run, defaulting to a fixed small subset
  (e.g. the existing pair-1/pair-4 pairing already used for reruns in
  `pi-harness-validation-status.md`) rather than the full battery, to keep
  a single sweep invocation bounded. `run_screening.py`'s `--max-pairs`
  selects a schedule *prefix*, not an arbitrary subset, so targeting a
  non-prefix pairing like {1, 4} means passing every other scheduled
  task's id to `--skip-task` (repeatable) rather than relying on
  `--max-pairs` alone.
- `seed`: fixed seed, reused across candidates so the task/prompt content
  is identical between arms — only the config under test varies. Reusing
  a seed only pins which tasks and prompts are scheduled; it does not pin
  model output (see the Acceptance criteria note on reproducibility).

### Mechanics

1. For each candidate, the workflow spawns one agent whose job is to
   invoke `run_screening.py` with that candidate's `--thinking` (or
   per-pair `--thinking-override PAIR=LEVEL`) setting, the shared seed,
   and `--skip-task` for every task outside the chosen `pairs` subset, and
   report back the run's own result record (pass/fail, seconds, any
   `removed_prohibited_scratch_files` entries, hidden-test exit code) —
   not its own summary or judgment of what the numbers mean.
   `run_single_pair.py` is deliberately not used here (see the Non-goals
   entry above); a later plan adding `--thinking` to it could simplify
   this back down to one pair per invocation.
2. Candidates run one at a time, in sequence, not through `pipeline()`.
   `local-ai-stack.md` documents that the `:8080` backend runs with
   `--scheduler-mode serial` (real concurrency there is 1 regardless of
   how many requests are admitted), and this repo's own
   `pi-harness-history.md` already records queue contention inflating a
   run's wall-clock timing and turning otherwise-valid runs into
   timeouts. Since each candidate's `harness_seconds` and timeout are
   both wall-clock, running candidates concurrently against this backend
   would contaminate exactly the timing deltas this workflow exists to
   report. A later version could reintroduce `pipeline()` if it also adds
   real backend-queue-time instrumentation to strip from each candidate's
   reported seconds — out of scope here.
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
  config (no change) invokes `run_screening.py` with the same effective
  arguments (seed, thinking level/overrides, skipped tasks) as the most
  recent manual run of the same pair/seed in
  `pi-harness-validation-status.md`, and its manifest and fixture
  identity match. This is *not* required to reproduce the same pass/fail
  verdict: temperature is fixed at 0.6, not 0, and inference is not
  seeded (`seed` only pins task/prompt scheduling, per the Inputs note
  above), so the same config can validly ship a different verdict between
  runs — `pi-harness-validation-status.md` already records exactly this
  for the pair-4 fixture (a clean run followed by a differently-shaped
  race on rerun). Use invocation/manifest equivalence, not exact-verdict
  matching, as the trust gate before comparative sweeps; if a pass/fail
  smoke test is still wanted here, run enough repeated trials to
  characterize expected variance rather than asserting on one.
- Total wall-clock and candidate count for a single invocation stay bounded
  and visible up front (the workflow logs the full candidate × pair matrix
  size before starting), so a sweep's cost is known before it runs, not
  discovered after.

## Follow-up (explicitly out of scope for this plan)

- Adding a `--temperature` override to `run_screening.py`/`run_single_pair.py`
  (plumbed through to the `ai-stack-local.ts` sampling-params hook as a
  per-call override, not a config-file edit) so a later sweep could vary
  temperature the same way this plan varies `--thinking`.
- Adding `--thinking` (and ideally `--pair`-style multi-target selection)
  to `run_single_pair.py`, so a single-pair sweep could invoke it directly
  instead of this plan's `run_screening.py` + `--skip-task` workaround.
- Whether to fold the sweep report format back into
  `qwen38-agentic-coding-tuning-research.md`'s existing tables, or keep it
  as a separate artifact under `pi/evals/battery-results/` — decide once
  the first real sweep report exists to look at.
- Any move beyond "human reads report, hand-edits config" — e.g. a
  proposed-diff step the human approves inline — is a candidate for a
  later plan, not this one, and should only be considered after this
  bounded version has run enough times to show the report format and cost
  are trustworthy.
