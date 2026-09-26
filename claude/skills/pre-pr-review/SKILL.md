---
name: pre-pr-review
description: >
  Self-review a change before creating or pushing a PR, and cap post-PR review
  rounds. Use before `gh pr create` or the first push of any non-trivial change,
  and when reacting to PR review comments.
---

# Pre-PR review

Goal: the first push is already correct. Every post-PR review round that finds a
real bug is a gap in this process, not the normal path. Evidence behind each step
is in "Why" at the bottom.

## Steps

1. **Diff pass.** Run `/code-review --level high` on the change. Fix every
   finding with a concrete failure scenario. Done when a re-run finds nothing
   new of that kind.
2. **Subsystem pass.** When the change wires into existing code, review the
   touched files *as they now stand*, not just the diff. A delta-only review
   cannot find a bug in adjacent code nobody touched this time. Done when
   every function the change calls into or is called from has been read.
3. **Invariant pass.** For each invariant the codebase already documents
   (replay determinism, crash-safety ordering, fail-closed gates, versioning
   markers), re-derive it from first principles for *this* edit. "Looks like
   the existing pattern" is how the bugs got in.
4. **Untrusted-actor pass** — only when the change adds a mechanism an
   untrusted party can influence (sandboxed worker, API caller, uploaded
   content, anything the project's trust model treats as adversarial). Per
   mechanism, not per diff, ask:
   - What does the actor control on this exact path?
   - Can its legitimately echoed data (a request path, header, filename,
     free text) collide with the trusted signal's format? Mark the trusted
     signal unforgeably (e.g. a per-run nonce the actor never sees).
   - Can it inflate the volume the trusted reader processes (logs, responses,
     uploads) at the moment that reader consumes it? Bound it.
   - On a read/parse error, does the path fail closed?
   - Is the check enforced at *every* entry point that reaches the guarded
     action (CLI, daemon, API, scheduled job), not only the one you edited?
   - Read each boolean in an identity/permission guard aloud (`&&` vs `||`).
   - Is the same validation, default, or constant copied at more than two
     sites? Collapse it; partial updates to copies have shipped real gaps.
5. **Fix-regression pass.** Re-read your own fixes hunting one thing: did the
   fix for A introduce B.
6. Push only when steps 1-5 are clean.

## Triage rule

Spend fix effort on correctness bugs (state machine, races, data integrity,
security boundaries) and usability bugs (the user can't tell what happened, an
action does the wrong thing). A finding with no realistic trigger gets a minimal
mitigation or a follow-up note. Cosmetic findings get a quick fix and never
drive another round.

## Post-PR rounds

- **Two rounds maximum**, stated to the reviewer up front. Merge after round 2;
  anything later becomes a follow-up item.
- The Codex budget (GitHub App + local `codex` CLI, one shared $20/mo account)
  is usually gone. Leave the App's auto-trigger on, never wait on it or block a
  merge on it, and run the local `codex` CLI only when the user confirms budget
  for a specific change.
- When Codex is live, put this in the PR body: "Review budget — Round 1 of 2.
  Two rounds maximum; nothing is triaged into a third. Report every real,
  high-confidence finding now — correctness, integration seams with existing
  flows, and adversarial cases — not just the top one." After fixes,
  `@codex review` with: "Round 2 of 2 (final): re-check the fixes and anything
  you deferred; this is the last pass before merge."
- The App re-reviews on every push, so the cap only holds if you stop reacting
  after round 2.

## Why

- software-factory PR #33: four post-PR rounds; two of them fixed bugs that the
  previous round's own fix introduced (a reused Temporal `GetVersion` id).
- PR #42: five rounds of P1s, all in untouched adjacent code, missed because
  every local review after round 1 was delta-only.
- PR #61: one `/code-review --level high` pass missed two P1s in a new
  mechanism — a worker could forge the relay's spend log line and inflate the
  log unboundedly. `/code-review` is the best available pass, not a Codex
  equivalent; step 4 is what closes that gap.
- PR #52 review swarm (2026-09-05): a sandbox identity check ran only in the
  CLI, never in the daemon that executes; a `uid != 0 && gid != 0` guard
  rejected valid users; resource-limit defaults copied across six sites
  drifted twice.
- PR #23 ran seven Codex App rounds, and PR #133 four, mostly on the previous
  round's fixes. That is where the two-round cap comes from.
