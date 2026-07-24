# testflight-cut hardening — plan / status

**Status: all items below are fixed and pushed** in commit `7f64bb8` (following the
originally-committed, buggy version at `2705fbf`). This file is kept as the record of what
was found and why — see `git show 7f64bb8` for the actual diffs. Ported to `codex/` and
`pi/` and symlinked live in all three agent trees.

## Confirmed real bugs in `scripts/release-facts.sh` (from adversarial testing, workflow wf_0d455652-fc9) — FIXED in 7f64bb8

All reproduced with exact commands/output — see full detail in
`~/.claude/projects/-Users-kanna-code-agent-configs/d6f9e434-369e-48a6-8c77-2efe0df1a4ec/subagents/workflows/wf_0d455652-fc9/journal.jsonl`
(task `test:release-facts`, plus the raw output file at
`/private/tmp/claude-501/-Users-kanna-code-agent-configs/6298f324-eb68-43e2-b9a0-2c2c14935621/tasks/wfr67s4a0.output`).

1. **BLOCKER — fail-open state logic.** Line ~34: `grep -qx "$key" <<<"$defaults"`. When key
   extraction fails (empty `$key`) and `$defaults` is empty (the real, intentional current state),
   bash's herestring emits one empty line and the grep matches — a gated feature gets printed as
   "default ON". Reproduced end-to-end: a genuinely gated feature (`smart_lists`, added in the test
   clone) was reported as default ON. This is the exact failure mode the script exists to prevent
   (advertising a gated feature in App Store release notes).
   **Fix direction:** invert the default — unmatched/empty key must resolve to "NOT default", never
   "default ON". Treat unparseable rows as a hard error (non-zero exit), not a silent guess.

2. **BLOCKER — `habits` never appears in the table.** The key regex requires exactly one literal
   space around `=` (`^\s*$f = `). gofmt aligns the const block with multiple spaces
   (`FeatureHabits       = "habits"`), so the regex never matches for aligned constants. `habits` is
   currently ON via rollout-compatibility and disappears from the report entirely.
   **Fix direction:** match on `=` with `[[:space:]]*` on both sides, not a fixed single space.

3. **BLOCKER — phantom rows from substring matches.** `grep -oE 'Feature[A-Za-z]+ +='` is
   unanchored and also matches inside `var defaultFeatures =` and
   `var rolloutCompatibilityFeatures =` (both contain the substring `Features =`). Produces 11 rows
   for 9 real constants, 2 of them nameless, and both nameless rows get mislabeled
   "default ON (rollout compatibility)" via the same fail-open bug as #1.
   **Fix direction:** anchor the constant-extraction regex to the const-block indentation
   (e.g. tab-anchored `^\t`), not a bare substring search.

4. **MAJOR — no-tag path diffs the working tree, not history.** When no `t*` tag exists, range
   becomes `HEAD` and `git diff --name-only HEAD` compares against the *working tree*, not commit
   history — reports uncommitted dirty-tree files as "shipped surface," or nothing at all on a clean
   tree, contradicting the commit list shown just above it.
   **Fix direction:** for a tagless repo, diff against the empty tree (or the first commit) instead
   of using bare `HEAD` as a two-dot range endpoint.

5. **MAJOR — exit code is always 0, even on git fatals.** `set -uo pipefail` (no `-e`). A bad/no-op
   range makes both `git log` and `git diff` fatal to stderr while the script still prints the full
   feature table and exits 0. A caller branching on `$?` cannot tell a fully-failed run from a good
   one. Same issue when `feature.go` is missing — prints an advisory note and still exits 0.
   **Fix direction:** capture git command exit codes explicitly; non-zero on any git failure or
   missing `feature.go`.

6. **Also flagged (same session, truncated in notification):** the *current live state* of the real
   repo — `t0.1.4` is at `HEAD` — makes the default range empty, and the script silently prints two
   blank sections with no "nothing shipped since t0.1.4" marker. Needs an explicit empty-range message.

## What actually landed after the session-limit interruption

The workflow run recorded above (`wf_0d455652-fc9`) hit the session limit mid-flight. On
resume, the `test:check-version-sync`, `mine:user-history`, and `audit:skill-overlap` tasks
were recovered from its journal (they had completed before the limit hit) and independently
confirmed a more fundamental bug in `check-version-sync.sh`: it treated an already-existing
`v<version>` tag as a collision, but house convention tags `v` and `t` at the same version on
the same commit for a joint release — so the gate failed on every normal ship, not just the
edge cases. That bug plus items 1–6 above were all fixed in `7f64bb8`, along with a related
bug in `release/scripts/next-version.sh` (unfiltered tag lookup could emit a malformed
`vt0.2.0` tag on an iOS-only cut). Full diff and commit message: `git show 7f64bb8`.

The Karpathy/practitioner-research workflow (`wf_a48067ca-48d`) failed completely (0 results,
all 6 lenses hit the session limit) and was re-run from scratch as `wf_896310d0-59a`, which
completed cleanly. See `plans/karpathy-practice-research-plan.md` for that output.

## Next steps

1. Build the App Store Connect preflight check (Gap 3 in `karpathy-practice-research-plan.md`)
   — `testflight-cut` currently verifies against local git tags and pubspec only, not ASC's
   actual latest-build state. This is the highest-leverage gap the research surfaced.
2. Candidate gaps noted during this session, not yet evidence-checked or built:
   - `Stop` hook blocking turn-end on dirty/unpushed worktree (kills the "pushed to git?" /
     "PR created?" follow-up pattern seen repeatedly in history.jsonl)
   - `PostToolUse` hook on `gh pr create` that re-reads and prints the PR URL immediately
   - `pre-push` git hook running `check-version-sync.sh` so a bad tag can't be pushed
   - Sequence `before-done`'s steps explicitly (deterministic → local `:8080` review →
     `self-review`) — near-zero-cost doc edit, see Gap 4 in the research plan
