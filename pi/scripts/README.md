# `build_app.py` — zero-human full-stack build orchestrator

Give it a spec and an empty (or existing) workspace directory; it drives
`pi -p` through as many corrective rounds as it takes to get real,
current-diff-bound verification evidence passing, with the installed pi
harness (quality-gate, cross-model-review, git-safety, protected-paths,
stack-router, new-project-scaffold, etc. — whatever `~/.pi/agent` has
installed) doing the in-session hardening. No chat interaction at any
point; the record of what happened is `BUILD_REPORT.md`, written into the
workspace whether the build succeeded or the round budget ran out.

## Why an outer orchestrator, not just `pi -p` once

`quality-gate.ts`'s in-session corrective-follow-up loop is explicitly
**unresolved** under `pi -p` — see `pi-harness-validation-status.md`. An
isolated test showed a `sendUserMessage(..., {deliverAs: "followUp"})`
producing a genuine second turn; a real multi-turn build session showed
zero follow-up and zero second turn for the identical mechanism, and the
difference isn't explained. A zero-human pipeline can't depend on an
open question. `build_app.py` doesn't: it treats every `pi -p` invocation
as possibly final, runs the *real* verification command itself once pi
exits, and if that fails, starts a fresh `pi -p --continue` round with the
failure as the prompt — the same shape as the already-proven
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
  --max-rounds 6 \
  --timeout-minutes 45 \
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
- Exit code 0 only if real verification evidence passes within the round
  budget. Non-zero (with a `BUILD_REPORT.md` explaining why) if the round
  budget is exhausted, pi times out, or no verification command could be
  resolved at all (`unconfigured` — same failure mode quality-gate traces
  under this name).

## Known gaps (carried over from the harness's own validation status)

- Verification-command resolution here is a short fixed list (Makefile
  `verify`/`test`/`check`, then per-manifest fallbacks for Go/Node/Python/
  Dart), not `lib/verification.ts`'s full nested-manifest scan. Good
  enough to gate a corrective round; do not assume parity with
  quality-gate.ts's in-session resolution.
- Review coverage depends on `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` being
  set correctly (see `pi-harness-validation-status.md` for how silently
  this has broken before). `BUILD_REPORT.md` states plainly when no
  review verdict was recorded, rather than treating silence as "clean".
- One real end-to-end smoke run so far (2026-08-09, Go/net-http/health-
  endpoint task, no `--containment`): round 1 succeeded outright —
  `quality-gate` verified, `cross-model-review` fired via its
  `tool_result` trigger and returned `clean`, git commit made. That's a
  single confirming repro, not a battery. Multi-round corrective recovery,
  `--containment`, and non-Go stacks are still unexercised.
