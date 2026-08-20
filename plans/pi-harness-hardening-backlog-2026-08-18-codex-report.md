# Pi harness hardening backlog — Codex report

Date: 2026-08-18

Historical report. Current implementation/status is in
`plans/pi-harness-hardening-backlog-2026-08-19.md` and
`pi-harness-validation-status.md`; the legacy `PI_STALL_GUARD_NUDGE` path
described below was later replaced by the synchronous intercept plus the
default-on wall-clock backstop.

Task 1 was skipped as instructed because the plan marks it superseded.

## Task 2 — progress-stall fingerprint gap

Status: partially implemented; live acceptance blocked.

Changed `progress-stall-guard.ts` so its diagnostic-activity classifier also
recognizes the observed `/tmp` scratch-file shapes (`cat`/`tee` writes and
`go`/`node`/`python`/`dart run` execution), retaining the existing unchanged
failure fingerprint and no non-test source edit conditions. Added a
deterministic three-round heredoc reproduction.

Evidence:

- `npm run typecheck`: exit 0.
- `npm test`: **189/189 passing**.
- New test observed `{sourcelessRounds:3,sameFailure:2,stalled:true,nudged:true}`
  with `PI_STALL_GUARD_NUDGE=1`.
- Live command: `python3 run_single_arm.py --seed 20260802 --pair 7 --arm harness --host "$AI_STACK_HOST" --output /tmp/pi-task2-stall-20260818`.
- Preflight reached both `:8080` and `:8081` model routes.
- Live result: `valid:false`, `passed:false`, `timed_out:true`,
  `harness_seconds:1800.036`; parsed harness traces contained one
  `stack-router` routing pass and zero `pi-stall-trace` entries.

Open: the runner did not expose the custom stall entries needed to prove
continued live firing. The nudge remains default-disabled and uses
`deliverAs: "followUp"`.

## Task 3 — quality-gate overhead

Status: investigation incomplete; no code change.

Evidence from checked-in records:

- `full-screening-2026-08-03.json`: median ratio
  `2.0031102096010818`, or `100.31102096010818%` runtime overhead, and
  `212.6%` prompt-token delta.
- `hardened-screening-2026-08-17.json`: ratio `4.12`, or `312%` overhead,
  across four fully valid thinking-enabled pairs; zero connection errors.
- Pair records contain total arm seconds only, not reviewer, settlement, or
  nested-manifest phase durations.

Open: no honest phase attribution, measured reduction, or threshold revision
can be claimed without instrumentation.

## Task 4 — thinking-enabled timeout budgets

Status: partially investigated; clean isolation not completed.

Evidence: seeded schedule pair 5 is `dart/sequential-runner`; its `meta.json`
has no `harness_timeout_minutes`, so the runner uses 30 minutes. The hardened
record says `timeout (1800s, diff present, hidden tests would have passed)`;
the older full screen records 143.934 seconds for that harness arm.

Open: no clean, uncontended `launchctl kickstart -k` rerun was completed, so
no timeout value was changed.

## Task 5 — background-process-kill root cause

Status: source-level mechanism identified; causal validation/fix open.

Evidence: Pi 0.83.0’s installed
`pi/node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js`
defines `DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000` and passes it to undici as
`bodyTimeout` and `headersTimeout`. `settings-manager.js` supplies that
default; `sdk.js` maps disabled to `2147483647`. This is a specific client
idle bound, not merely the prior generic hypothesis.

Open: server/proxy behavior and forced-compaction versus normal-compaction
reproductions were not completed; no source fix or permanent mitigation was
applied.

## Task 6 — co-change and continuation live validation

Status: not completed; both remain default-disabled.

Adoption bar set before trials: three live trials per extension, with the
message observed in the session trace, measurable beneficial behavior, zero
regressions, and no transport/runtime errors.

Evidence: no qualifying live trials were completed. Existing retrospective
or deterministic evidence was not counted as live field evidence.

## Task 7 — TypeScript/JavaScript fixture

Status: fixture implemented; live pair not completed.

Added `../local-model-bench/tasks/javascript/lru-cache` with `meta.json`,
`spec.md`, starter `package.json`/`cache.js`, and hidden tests. The starter
contains the plantable LRU recency bug and its package manifest exercises the
JavaScript stack-routing path.

Evidence: copying starter and tests into a runner-shaped temporary work
directory and running `npm test` produced 1 pass/1 fail; the failing test
reported `undefined !== 1` after accessing key `a` and then inserting `c`,
confirming the fixture is meaningful. The Pi suite after the fixture/docs
changes remained **189/189 passing**.

Open: no baseline-versus-harness live pair JSON was produced.

## Task 8 — session_compact reminder

Status: blocked by Task 5 in practice.

The existing unit test was not counted as acceptance evidence. No live goal
run reached a confirmed `session_compact` event, delivered reminder, and
post-compaction recovery, so no change was made.

## Verification and working-tree state

The final post-change verification was `npm run typecheck && npm test` inside
`pi/`: typecheck exited 0 and the test suite reported **189/189 passing**.
No commit was created.
