# `build_app.py` — zero-human full-stack build orchestrator

Give it a spec and an empty (or existing) workspace directory; it drives
`pi -p` through as many corrective rounds as it takes to get real,
current-diff-bound verification evidence and independent review passing, with the installed pi
harness (quality-gate, cross-model-review, git-safety, protected-paths,
stack-router, new-project-scaffold, etc. — whatever `~/.pi/agent` has
installed) doing the in-session hardening. No chat interaction at any
point; the record of what happened is `BUILD_REPORT.md`, written into the
workspace whether the build succeeded or the round budget ran out.

## Why an outer orchestrator, not just `pi -p` once

`quality-gate.ts` and `cross-model-review.ts` deliberately report their
settlement results without trying to inject in-band corrective turns. A
zero-human pipeline still needs to act on those results. `build_app.py`
does that outside the session: it treats every `pi -p` invocation as
possibly final, runs the same canonical verification resolver used by
`quality-gate.ts`, consumes reviewer and `stall-timeout` traces, and starts
a fresh `pi -p --continue` round when any required signal is not clean —
the same shape as the already-proven
`PiHarness.run()` bounded-follow-up fix in `local-model-bench`
(commits `8531917`/`dfe4620`), generalized from
"context-budget-exceeded" endings to "verification still failing"
endings.

The independent reviewer (`cross-model-review.ts`) now also fires a
settlement-time backstop round (added 2026-08-09) even if the model never
runs a broad verification command itself inside the session, so review
coverage doesn't silently depend on the model happening to run one.

## Usage

```bash
python3 pi/scripts/build_app.py \
  --workspace /path/to/app \
  --spec /path/to/spec.md \
  --max-rounds 3 \
  --timeout-minutes 45 \
  [--thinking off|minimal|low|medium|high|xhigh] \
  [--review-policy required|degraded] \
  [--sonnet-fallback] \
  [--containment]
```

- `--spec` should live **outside** `--workspace` (or be added to
  `--workspace`'s `.gitignore` before the first round) — the script writes
  its own `.pi-build-session/` and `BUILD_REPORT.md` into the workspace
  and gitignores those automatically, but it does not manage where you put
  the spec file itself.
- `--containment` is currently **unusable, by design, not a bug**: the
  script refuses it immediately (before any round runs, no
  `BUILD_REPORT.md` produced) because `run-contained.sh`'s network-denied
  profile (`--network=none`, live-proven 17/17 escape checks: workspace-
  only writes, no host creds/socket, no network, `/tmp` noexec, no-new-
  privileges) has no path to this machine's LAN inference service, and
  this script only knows how to drive `pi` through the `ai-stack-local`
  provider. Passing the flag today is guaranteed to exit before doing
  anything. See `pi/containment/README.md`'s network-denied section; this
  will become usable once a reviewed relay/proxy provider exists for the
  container, not before.
- Thinking inherits the installed `settings.json` policy when `--thinking`
  is omitted (currently `medium`). The flag is only an explicit experiment/
  reproduction override; the orchestrator no longer silently forces the
  correctness-regressing `off` setting.
- Independent review is required by default. A flagged verdict starts a
  corrective round; an unavailable verdict prevents success. Use
  `--review-policy degraded` only to opt into a clearly labeled success when
  review is unavailable. A concrete `flagged` verdict still blocks under
  either policy.
- `--sonnet-fallback` explicitly authorizes one billed
  `claude-sonnet-5` corrective pass after the bounded local rounds are
  exhausted. Without it, the report exits non-zero with `escalation
  required` rather than spending cloud tokens silently.
- Exit code 0 requires canonical verification plus the selected review
  policy, or a successful explicitly authorized Sonnet fallback. Non-zero
  includes exhausted corrective rounds, timeouts, unavailable required
  review, and an unresolvable canonical command.

## Current validation status and remaining gaps

- Verification resolution is no longer duplicated in Python:
  `resolve-verification.ts` calls `lib/verification.ts` directly, including
  nested manifests and Flutter-vs-Dart detection. A Python integration test
  proves that either of two nested components failing prevents acceptance.
- Review coverage still depends on `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL`,
  but missing/broken review now fails closed by default instead of being a
  report-only warning. The degraded policy is explicit and recorded.
- Reviewer flags, canonical verification failures, Pi failures/timeouts, and
  `stall-timeout` traces now all feed the bounded corrective loop. The
  optional Sonnet command path is deterministic-tested but has not yet been
  spent or live-validated by this change.
- One real end-to-end smoke run so far (2026-08-09, Go/net-http/health-
  endpoint task, no `--containment`): round 1 succeeded outright —
  `quality-gate` verified, `cross-model-review` fired via its
  `tool_result` trigger and returned `clean`, git commit made. That's a
  single confirming repro, not a battery. The new reviewer/stall-driven
  corrective policy and Sonnet fallback remain source/integration-tested,
  not live battery evidence; `--containment` and non-Go full builds remain
  unexercised.
