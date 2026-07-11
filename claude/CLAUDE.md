# Global Claude Preferences

## GitHub Accounts

- **Primary**: `ljammula` (https://github.com/ljammula) — owner account, used for commits, pushes, and all default operations
- **Secondary**: `narsimha-j` (https://github.com/narsimha-j) — used for code reviews only

## Code Reviews

Always use the GitHub account **narsimha-j** (https://github.com/narsimha-j) when performing code reviews, submitting review comments, or any GitHub review-related actions. Always submit reviews as `APPROVE` (not `COMMENT`) when all issues are resolved.

### GitHub account permissions
- **narsimha-j** can: submit reviews, approve PRs, post comments
- **narsimha-j** cannot: push to repos it doesn't own, resolve review threads on others' repos
- For code reviews: switch to `narsimha-j` via `gh auth switch --user narsimha-j`, perform the review, then switch back with `gh auth switch --user ljammula`

## Commits

Commit using the global git config (ljammula). Do NOT add a `Co-Authored-By: Claude` trailer.

## Code Quality

Codex reviews all code written in any project. Write clean, well-structured code with no hacks or unclear logic — every change is subject to automated review.

## Coding Guidelines

Always apply the `karpathy-guidelines` skill when writing, reviewing, or refactoring code. Invoke it via the Skill tool at the start of any coding task.

## Local execution harness

Only applies on machines running a local model-serving stack (e.g.
`ai-stack`) with `~/code/ai-stack/scripts/dispatch_local.sh` present — check
it exists before relying on it, since this CLAUDE.md loads on every machine
regardless of whether that setup exists there.

If present: it dispatches a written spec to Aider + a locally-served model
for execution against any target repo, then prints the resulting diff for
review. Use the `dispatch-local` skill for the full workflow (spec →
dispatch → review). Good for mechanical, well-specified tasks
(boilerplate, scaffolding, pattern-following edits); it self-corrects
syntax/test-loop-catchable mistakes but not logic bugs, so always review the
diff rather than trusting a green run.

@RTK.md
