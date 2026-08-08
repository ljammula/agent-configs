---
name: resolving-merge-conflicts
description: Resolve an in-progress git merge or rebase conflict. Use when the user asks to resolve conflicts, or `git status` shows an unmerged path.
license: MIT
---

# Resolving Merge Conflicts

Adapted from https://github.com/mattpocock/skills for pi's single-agent, no-subagent harness.

1. **See the current state.** `git status`, `git log` on both sides, read the conflicting files.
2. **Find the primary sources for each conflict.** Read the commit messages on both sides. Understand what each change was actually trying to do before touching a single hunk.
3. **Resolve each hunk by intent**, not by picking a side mechanically. Preserve both intents where possible; where incompatible, pick the one matching the merge's stated goal and say what was traded off. Never invent new behavior to paper over a conflict. Always resolve — never `--abort`.
4. **Run the project's verification command** (`make verify`, or `go build ./... && go test ./...` / `flutter analyze && flutter test` per `AGENTS.md`). Fix anything the merge broke.
5. **Finish the operation.** Stage everything, commit. If rebasing, `git rebase --continue` until every commit is rebased — don't stop partway.
