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
`dispatch-local` skill was removed. (It did win one task solo Sonnet
missed, but on a task later shown to be run-to-run flaky regardless of
harness — not enough signal to justify the added cost. See
`local-model-bench/STATUS.md` for the full data.) Write
the edit yourself.

The read-only local services are still worth using. The served HTTP
endpoints — code review and log triage (:8080), and SearXNG (:8888),
used by `before-done`/`self-review`/`local-summarize`/`local-search` — do
not have to be on this machine. Set `AI_STACK_HOST` to `kannas-mac-studio` (already the live default in
`~/.zshenv`) — this box's Tailscale MagicDNS short name, resolving via
Tailscale's own DNS (`100.100.100.100`) rather than the LAN. It works
whether the caller is on the LAN or off it, as long as Tailscale is running
on both ends, so one value works everywhere instead of switching by
location. Use the full FQDN `kannas-mac-studio.tailfb69fc.ts.net` on a
client where Tailscale's resolver isn't the active DNS nameserver — the
short form depends on that. Fall back to the LAN mDNS name
`kannasmacstudio.lan` only if Tailscale is down (never the raw DHCP IP —
that's changed on every reboot). Every reachability check and script
resolves through whatever `AI_STACK_HOST` is set to; unset, it defaults to
`127.0.0.1`. Set it once in the shell environment so all agents inherit it.

Current route details and performance are recorded in
`~/code/agent-configs/local-ai-stack.md`. In brief, `:8080` is the
Qwen3.8-27B code, review, and triage route — as of 2026-08-21 served via
the mtplx runtime (`Qwen3.8-27B-MTPLX-Optimized-Quality`), not the prior
dedicated 8-bit mlx-vlm instance. Clients must discover the current id from
`/v1/models` instead of hardcoding it because the public proxy rejects
stale or omitted model ids.

## Third-party skills

Before installing any third-party Claude Code skill that isn't already
vetted in this repo — from a marketplace, a project's own install flow,
or a README's `/skill-name` pitch — audit `SKILL.md` and any bundled
scripts for prompt injection or credential/data-exfiltration before it
lands in `~/.claude/skills/`. Not theoretical: Snyk's 2026 "ToxicSkills"
scan found injected payloads in 36% of skills tested (1,467 malicious
payloads across the ecosystem it covered). A skill's popularity (real
stars, real commit activity) is not a trust signal on its own — evaluated
`Graphify-Labs/graphify` on this basis in 2026-09: legitimate GitHub
activity, but `SKILL.md` becomes part of the assistant's system context
the moment it's installed, so it gets audited like any other supply-chain
dependency, not skipped because the repo looks credible.

## Parallel agent worktrees

When a task fans out into multiple concurrent agents each on their own
`git worktree` (e.g. under `.claude/worktrees/agent-<hash>/`), the
worktree and its local branch are not cleaned up automatically once the
branch merges. Found 13 merged-but-unpruned worktrees in
`personal-assistant` this way, holding 1.4GB. After confirming a
worktree's branch is merged (`git merge-base --is-ancestor <branch>
main`), remove it — `git worktree remove <path>` then `git branch -d
<branch>` — instead of leaving it for a later cleanup pass.

@RTK.md
