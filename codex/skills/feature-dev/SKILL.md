---
name: feature-dev
description: >
  Ship a DayTrix feature end to end: locate the spec/roadmap item, branch, implement,
  localization sweep across all .arb files, wiring check, make verify, PR, self-review,
  then mark the roadmap item shipped. Trigger on: "implement roadmap X.Y", "build the
  feature from the spec", "start feature X", or any multi-file feature work that will
  need a PR.
---

# Feature Dev — spec to ship

The workflow this codifies (from real project history): a spec/roadmap doc lands first,
the feature PR references it, and the roadmap is marked shipped after merge. The recurring
failure mode is skipping a step in the middle — hardcoded strings that need l10n keys,
unformatted new test files, missed wiring — each of which has cost a follow-up `fix:` commit.

## 1. Spec first

```bash
ls docs/specs/ docs/*roadmap* 2>/dev/null
```

- If a spec or roadmap item exists for this feature, read it **before writing code** and
  treat it as the success criteria.
- If none exists and the feature is non-trivial (multi-file, new user-facing flow),
  propose writing a short spec doc first — in this project spec PRs precede feature PRs.
- State assumptions and scope before implementing (karpathy-guidelines applies).

For a new multi-file, user-visible, contract-changing, migration, authorization,
feature-grant, external-integration, or release change, start from
`docs/specs/_template.md`. Fill its requirements, non-goals, decisions, scenarios,
invariants, technical plan, tasks, and acceptance matrix. Do not silently turn an
open product decision into code: behavior-changing open questions must be zero and
the human must set `Status: ready` before implementation.

Run the deterministic gate from the repo root:

```bash
~/.codex/skills/feature-dev/scripts/check-spec-handoff.sh --ready docs/specs/<feature>.md
```

For high-risk work (auth, sharing fallback, billing, destructive actions, permissions,
migrations, data loss, or feature gates), obtain a separate read-only spec-critic pass
first. It reports only ambiguity, contradiction, missing negative cases, untestable
requirements, and scope creep; resolve behavior-changing findings before coding.

## 2. Branch

Multi-file changes require a branch and PR (GUIDELINES.md §5):

```bash
git switch main && git pull
git switch -c feat/<slug>     # or fix/, refactor/
```

## 3. Implement

- Surgical changes only; match existing patterns (BLoC vs ChangeNotifier per feature —
  see CLAUDE.md).
- If the feature is gated, follow the 4-step feature-grant wiring and run the
  `wiring-verify` skill after.
- List UIs with check-off/reorder behavior: write a test for ordering stability — list
  re-sort bugs have needed three separate fix commits in this project.

## 4. Localization sweep — before committing

Every user-facing string goes through l10n keys and must exist in **all** `.arb` files
(`en`, `hi`, `kn`, `ml`, `ta`, `te`). Hardcoded snackbar/error strings are a repeat
review finding.

Deterministic — the same script the `before-done` gate uses; the check lives there,
not duplicated here:

```bash
~/.codex/skills/before-done/scripts/check-l10n.sh
```

Exit 0 required before committing.

## 5. Verify

```bash
make verify    # fmt + lint + backend + frontend tests
```

`make verify` (not just `make lint`) — new test files that skip `dart format` have
broken CI before.

For a template-backed spec, update the acceptance matrix with the actual implementation
locations and evidence, set `Status: implemented`, then prove every `R-*` row has both
automated and reproducible manual evidence:

```bash
~/.codex/skills/feature-dev/scripts/check-spec-handoff.sh --complete docs/specs/<feature>.md
```

Do not mark a row PASS because a nearby test is green; its cited evidence must prove
that requirement.

## 6. PR and review

1. Push the branch and open the PR as `ljammula`; reference the spec/roadmap item in the body.
2. Run the `before-done` gate (CI, threads, worktree).
3. Run the `self-review` skill (review as `narsimha-j`, end as `ljammula`).

## 7. Close the loop — after merge

- Mark the roadmap item shipped in the roadmap doc (`docs:` commit), matching the
  existing "mark 1.x shipped" convention.
- If the spec drifted from what was built, update the spec in the same commit.

A feature is not done at merge — it is done when the roadmap reflects it.
