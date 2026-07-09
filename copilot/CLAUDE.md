# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

Source: [Andrej Karpathy Skills](https://github.com/forrestchang/andrej-karpathy-skills)

---

## Before Done Gate

Do not say "done", "complete", "all good", or "looks good" until every applicable check passes.

**After any code change:**
1. Run lint: `make lint` (or `dart analyze` / `golangci-lint run` scoped)
2. Check for a spec doc: `ls docs/specs/ && cat docs/specs/<feature>.md` — run the bash step, don't recall from memory
3. For UI changes: scan for duplicate buttons/FABs/actions on the same screen
4. Run adjacent tests: `cd frontend && flutter test --concurrency=4`
5. For Flutter UI changes: `make serve-local` + Playwright smoke before sharing a URL

**After any git/GitHub action:**
- Verify the commit exists: `git log --oneline -3` + `git status`
- PR created: return the URL — do not report "PR created" without it
- CI: poll `gh run view <run-id> --json status,conclusion,jobs` until `"status":"completed"`
- Review threads: check with GraphQL; report count — 0 unresolved = done

**⚠️ REQUIRES EXPLICIT USER APPROVAL before executing:**
- `git push --force` (rebase conflict recovery)
- `gh auth switch --user narsimha-j` + `resolveReviewThread` mutation

**Output format:**
```
✓ Lint passes
✓ Spec verified / no spec found
✓ No redundant UI
✓ Tests pass (N/N, --concurrency=4)
✓ Commit abc1234 — worktree clean
✓ PR #N — https://github.com/.../pull/N
✓ CI: all jobs success
✓ Review threads: 0 unresolved
```
If any item is `✗`, do not say "done." Fix it or surface it explicitly.

---

## Wiring Verify

After adding any feature with a documented N-step pattern (feature flags, routes, middleware, controllers, widgets, constants), verify every step is present in code.

1. Read `CLAUDE.md` / `ARCHITECTURE.md` to extract the wiring checklist for the pattern
2. For each step, grep the codebase — use all name variants (snake_case, camelCase, PascalCase, SCREAMING, `Enabled` getter, `Feature` constant)
3. Report a `[✓]/[✗]` checklist with file:line evidence
4. For each `[✗]`, generate the exact code stub to add (match existing style)
5. Run `make lint` after applying stubs

Trigger when: "check the wiring for X", "did I wire everything for X", or after adding a feature that has a multi-step checklist in the project docs.

---

## Release

Deploy path: tag `vX.Y.Z` → GitHub Actions `deploy.yml` → Cloud Run. Any ✗ = release not done.

1. Preflight: `git switch main && git pull`; worktree clean; `make verify` passes
2. Version: patch by default, minor if any `feat:` since last tag, major only on explicit request — state the reasoning
3. Tag as ljammula: `git tag vX.Y.Z && git push origin vX.Y.Z`
4. Watch: `gh run watch <run-id> --exit-status` on the deploy workflow. On failure: do NOT delete/re-push the tag — report and stop
5. Smoke: `make test-e2e` against production

---

## Self-Review

Two-account flow: `ljammula` authors, `narsimha-j` reviews. Invariant: session ends with `ljammula` active — every exit path restores it.

1. `gh auth switch --user narsimha-j`
2. Review `gh pr diff <N>`: correctness bugs → surgical scope → simplicity → project conventions
3. Post findings as inline comments; submit as `COMMENT` while findings are open
4. When clean or all findings fixed: `gh pr review <N> --approve` (always APPROVE, never bare COMMENT)
5. Unconditional: `gh auth switch --user ljammula` and confirm with `gh auth status` — even after errors
