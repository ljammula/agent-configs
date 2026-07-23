---
name: self-review
description: >
  Review one of ljammula's PRs using the narsimha-j reviewer account, then guarantee
  the switch back to ljammula. Trigger on: "self review", "review the PR", "review PR #N",
  "approve the PR", or any review action that needs the narsimha-j account.
---

# Self-Review

Two-account flow: `ljammula` authors, `narsimha-j` reviews. The invariant that must
never break: **the session ends with `ljammula` active**, even if the review fails
midway. Every exit path goes through step 5.

## 1. Record and switch

```bash
gh auth status                        # note the active account
gh auth switch --user narsimha-j
```

Account permissions: `narsimha-j` can submit reviews, approve, comment, and resolve
threads on ljammula-owned repos. It cannot push.

## 2. Review the diff

```bash
gh pr view <N> --repo ljammula/<repo>
gh pr diff <N> --repo ljammula/<repo>
```

**Optional local second opinion first** — on machines that can reach the ai-stack local model, localhost or a LAN host via `AI_STACK_HOST` (check: `curl -sf --max-time 2 "http://${AI_STACK_HOST:-127.0.0.1}:8080/v1/models" >/dev/null`):

```bash
gh pr diff <N> --repo ljammula/<repo> | ~/.codex/skills/before-done/scripts/local-review.sh
```

Treat its output as candidates to check, not confirmed findings — verify each against the actual diff yourself before posting. It's a differently-trained pass that costs no cloud tokens, not a substitute for your own review. If the port isn't reachable, note it in one line (e.g. `local ai-stack model unreachable - skipping local second opinion`) and proceed with your own review.

Apply the karpathy-guidelines criteria, in priority order:
1. Correctness bugs (logic, error handling, concurrency, edge cases)
2. Surgical scope — changed lines that don't trace to the PR's stated purpose
3. Simplicity — speculative abstractions, dead configurability
4. Project conventions (CLAUDE.md patterns: feature wiring, l10n coverage, sentinel errors)

## 3. Post findings

For each real issue, post an inline comment anchored to the file/line:

```bash
gh api repos/ljammula/<repo>/pulls/<N>/comments \
  -f body="..." -f commit_id=<head-sha> -f path=<file> -F line=<line>
```

If there are open findings, submit the review as `COMMENT` with a summary.
Do not approve with unresolved findings.

## 4. Approve when clean

When there are no findings, or all previous findings are fixed and re-verified:

```bash
gh pr review <N> --repo ljammula/<repo> --approve --body "..."
```

Always `APPROVE`, never a bare `COMMENT`, once all issues are resolved.

## 5. Switch back — unconditional

```bash
gh auth switch --user ljammula
gh auth status    # confirm ljammula is active before reporting done
```

Run this even if an earlier step errored or the review was abandoned. A report that
does not show `ljammula` active is not a completion report.

## Report

```
✓ Reviewed PR #N as narsimha-j — M findings posted / approved
✓ Review state: COMMENT (M open) | APPROVED
✓ Account restored: ljammula active
```
