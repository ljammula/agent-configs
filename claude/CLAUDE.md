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

Do not delegate code edits to a local model via Aider — benchmarked in
`~/code/local-model-bench`, that path (`sonnet-aider-local`) cost *more*
Anthropic tokens than editing solo and ran 5-10x slower, so the
`dispatch-local` skill was removed. Write the edit yourself.

The read-only local services are still worth using. The served HTTP
endpoints — code review (:8080), log triage (:8081), and SearXNG (:8888),
used by `before-done`/`self-review`/`local-summarize`/`local-search` — do
not have to be on this machine. Set `AI_STACK_HOST` to
the host serving them (e.g. `192.168.1.233` for a LAN box) and every
reachability check and script resolves there; unset, it defaults to
`127.0.0.1`. Set it once in the shell environment so all agents inherit it.

@RTK.md
