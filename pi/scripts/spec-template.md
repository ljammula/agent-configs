# Zero-human build spec template

Copy this into its own `spec.md` (kept **outside** the target `--workspace`
— see `pi/scripts/README.md`) for each new `build_app.py` run, fill in the
bracketed sections, and delete these instructions before passing it in.

Every "Required changes" item should be something a test or a build
command can actually confirm passed — "make it nice" isn't verifiable,
"X returns Y" / "flutter build web exits 0" / "this endpoint returns 403
for an unauthenticated request" is.

---

This is an existing repo. Read README.md and ARCHITECTURE.md (where
present) before changing anything, and preserve all existing functionality
and passing tests -- this is an extension, not a rewrite.

## Goal

<ONE OR TWO SENTENCES: what you want built or extended, and why>

## Constraints / things you already know won't work

<Anything about THIS environment the agent can't fix itself -- missing
SDKs, no prod credentials, no real payment processor, etc. Tell it not to
retry those and instead document them as deferred with a reason, rather
than spin rounds on an unfixable gap.>

## Required changes

1. <concrete, verifiable requirement>
2. <concrete, verifiable requirement>
3. ...

## Verification

- Make sure `make verify` (or add one if missing) covers everything above
  and stays fast enough to run every corrective round -- don't put slow
  platform/integration builds inside it.
- Separately run and confirm any slow builds/integration checks at least
  once during the session, not gated by `make verify`.

## Commit

Commit once `make verify` passes and everything above is independently
confirmed. Clear commit message, no filler.

Do this autonomously end to end. Do not ask any questions. If a step is
infeasible for a reason other than what's listed under "Constraints"
above, document exactly what you tried, why it failed, and what would
unblock it -- rather than silently skipping it.

---

## Command to run it

```bash
python3 ~/code/agent-configs/pi/scripts/build_app.py \
  --workspace /path/to/your/repo \
  --spec /path/to/spec.md \
  --max-rounds 3 \
  --timeout-minutes 60
```

- Bump `--max-rounds`/`--timeout-minutes` up for bigger asks; a real
  multi-round corrective loop (something failing verification on round 1)
  hasn't been battery-tested yet, so budget generously.
- Add `--containment` to sandbox the run (Docker, no network/host access)
  — skip it for tasks needing host toolchains (Xcode/simulators, etc.).
- Always read the resulting `BUILD_REPORT.md` and spot-check any flagged
  independent-review verdicts yourself afterward. "SUCCEEDED" only means
  verification passed, not that every flagged finding was actually
  resolved along the way.
