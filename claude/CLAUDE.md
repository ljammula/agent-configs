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

**Never build a commit message or PR body via inline `-m "..."`/`--body "..."` when the text contains backticks.** Bash performs command substitution on backtick-quoted spans inside a double-quoted string, even inside `git commit -m "..."`. Confirmed live (2026-09-11): a commit message with several `` `docker login` ``/`` `main` ``-style backtick spans got silently mangled — each span was replaced by the (failed, empty) output of trying to execute its contents as a shell command — and the corruption wasn't visible until reading the commit back with `git log`. Always write the message to a file first (e.g. under the job's own tmp dir) and pass it via `git commit -F <file>` / `gh pr create --body-file <file>`; delete the temp file after. Applies equally to `gh pr comment`/`gh pr review --body` when the text has backticks.

## Code Quality

Codex reviews all code written in any project. Write clean, well-structured code with no hacks or unclear logic — every change is subject to automated review.

### Review workflow (codex has a $20/mo budget, usually exhausted)

The user's Codex subscription (both the GitHub App reviewer and the local `codex` CLI — they share one account-wide budget) typically runs out of budget partway through a month. Confirmed live (2026-09-11): the GitHub App posted only a "reached your Codex usage limits" notice, never a real review, on 5 consecutive PRs in one session.

- **Default self-review before ever creating/pushing a PR: the `/code-review` skill, adversarial pass (`--level high`), not the local `codex` CLI.** Don't speculatively burn a local `codex review` invocation as routine self-review — assume the budget is gone unless the user says otherwise. Only invoke local `codex` when the user explicitly confirms budget is available for a specific high-stakes change.
- **`/code-review` is not a guaranteed substitute for Codex**, though — it has missed real P1 security bugs in an untrusted-actor-facing mechanism that Codex then caught (PR #61, software-factory, 2026-09-07). For anything a sandboxed worker or external/untrusted caller can influence, run the adversarial pass framed specifically as "how would this actor attack this exact channel," not just a general read of the diff.
- **Leave the GitHub App's auto-trigger enabled regardless** — it's free to let it try on every PR push. Don't wait on it or treat 5 minutes of silence as anything but "budget's gone this time"; don't block a merge on it.
- **When budget does happen to be available** (the user will confirm, or the App posts a real review instead of the quota notice): cap review-fix cycles at **2 rounds maximum**, stated explicitly up front. Tag `@codex` directly in the PR body or a PR comment with a short "Review budget" note: "Round 1 of 2. Two rounds maximum; nothing is triaged into a third. Report every real, high-confidence finding now — correctness, integration seams with existing flows, and adversarial cases — not just the top one." On the second pass (`@codex review` after fixes): "Round 2 of 2 (final): re-check the fixes and anything you deferred; this is the last pass before merge." Merge after round 2 regardless; record any further findings as follow-ups, not a reason to keep looping — this project's history has spiraled into 7-10 review rounds on a single change before.

### Model tier for subagent work

- **Implementation/debug loops** ("reproduce → read log → patch → rebuild → rerun"): delegate to a Sonnet agent with the exact commands, paths, symptom, and done criterion, and let it iterate.
- **Log summarization, status polling, simple mechanical/low-stakes subtasks**: Haiku is fine.
- **Adversarial code review, correctness-critical validation, merge-conflict resolution, final PR judgment**: keep at the main/Sonnet tier, do not downgrade. Their whole value is catching what a weaker model would plausibly miss — confirmed concretely (2026-09-11): Sonnet-tier `/code-review` passes on one feature caught a self-referential hash bug and a locale-dependent (`LC_COLLATE`) determinism bug in the same session, both real, both subtle.

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
