---
name: tdd
description: Test-driven development, red-green loop. Use when building a feature or fixing a bug test-first, or the user says "TDD"/"red-green-refactor"/wants integration tests.
license: MIT
---

# TDD

Adapted from https://github.com/mattpocock/skills for pi's single-agent, no-subagent harness.

One **seam** (a public interface you can observe behavior through, never internals) at a time:

1. **Agree the seam.** State which public interface you're testing before writing anything. Don't test unconfirmed seams — testing everything dilutes effort away from the paths that matter.
2. **Red.** Write one failing test at that seam. Don't anticipate future tests.
3. **Green.** Write only enough code to pass it. No speculative extras.
4. **Repeat** — one seam, one test, one minimal implementation per cycle. Never write a batch of tests before any implementation ("horizontal slicing"): it tests imagined shape, not real behavior, and the tests go insensitive to change.
5. Refactoring is a separate pass after green, not part of this loop.

A good test: exercises the public interface, not internals; its expected value comes from an independent source (a known-good literal, a spec, a worked example) — never recomputed the way the code computes it, or it passes by construction and never disagrees with the code (tautological). If it breaks on a refactor where behavior didn't change, it's coupled to implementation, not behavior — fix the test, not the rule.

If `CONTEXT.md` exists, match its vocabulary in test names.
