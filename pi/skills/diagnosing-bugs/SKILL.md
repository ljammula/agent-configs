---
name: diagnosing-bugs
description: Disciplined diagnosis loop for hard bugs and performance regressions. Use when the user says "diagnose"/"debug this", or reports something broken, throwing, failing, or slow.
license: MIT
---

# Diagnosing Bugs

Adapted from https://github.com/mattpocock/skills for pi's single-agent, no-subagent harness. Skip a phase only with an explicit, stated reason.

**Redact every secret** in anything you show (commands, output, artifacts) — write `<REDACTED>` in its place.

## 1. Build a feedback loop — this is the skill

Everything after this is mechanical. Find or build **one command** that goes red on this exact bug and green once fixed: a failing test at the nearest seam, a curl/CLI invocation diffed against a known-good snapshot, a replayed captured trace, or a minimal throwaway harness. Try them roughly in that order. Then tighten it — faster, sharper signal, more deterministic (pin time, seed RNG, isolate filesystem) — until it's a command you'd trust to run unattended.

If you cannot build one: stop, say so, list what you tried, and ask for repro access, a redacted artifact, or permission to add temporary instrumentation. Do not hypothesize without a loop.

## 2. Reproduce and minimise

Confirm the loop reproduces the **user's exact symptom**, not a nearby different failure. Then shrink the repro one cut at a time (inputs, callers, config), re-running after each cut, until every remaining element is load-bearing.

## 3. Hypothesise

List 3-5 ranked, falsifiable hypotheses before testing any ("if X is the cause, changing Y makes it disappear"). Show the user the ranked list — don't block on their reply.

## 4. Instrument

One probe per hypothesis, one variable at a time. Tag every debug log with a unique prefix (`[DEBUG-xxxx]`) so cleanup is a single grep. For perf regressions: measure first (timing harness/profiler), then bisect — logs are usually wrong there.

## 5. Fix + regression test

Write the regression test **before** the fix, at a seam that exercises the real bug pattern. If no correct seam exists, say so — that gap is itself a finding. Re-run the phase-1 loop against the original scenario after the fix.

## 6. Cleanup

Before declaring done: original repro no longer reproduces, regression test passes, all `[DEBUG-...]` logs removed (grep the prefix), throwaway harnesses deleted. State the root cause in the commit message.
