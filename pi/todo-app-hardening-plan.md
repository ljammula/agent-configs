# Pi harness hardening: gaps found via todo-app vs. personal-assistant

Status: **plan only, not yet implemented.** Reviewed by Opus (see verdict below).
Source comparison: `~/code/test-bed/todo-app` (harness-generated) vs.
`~/code/personal-assistant` (target engineering discipline).

## Findings from direct inspection

1. **Dead/misleading code shipped.** `backend/main.go` has:
   ```go
   dbPath := "todos.db"
   if p := "file::memory:?cache=shared"; true {
       dbPath = p
   }
   ```
   This always silently forces in-memory storage — real persistence never
   works. This is exactly what `karpathy-guardrail.ts`'s "no dead code /
   simplicity" system-prompt instructions are supposed to prevent, but
   nothing actually inspects diff content for this kind of smell.

2. **Committed build artifact.** A 13MB compiled binary (`backend/backend`)
   sits in the working tree. There is no `.git` directory and no
   `.gitignore` anywhere in the project — nothing was ever git-initialized.

3. **Verification fallback is test-only.** `extensions/lib/verification.ts`
   resolves a command by preferring a Makefile target, else falling back
   per-language (bare `go.mod` → `go test ./...`). todo-app has no
   Makefile, so — on the surface — it looked like verification fell back to
   tests-only with no lint/vet. (Opus review found the real story is worse;
   see below.)

4. **No git-init/gitignore scaffolding.** `git-safety.ts` only blocks
   destructive commands on an *already-existing* repo; nothing in the
   extension set initializes a new project or seeds a `.gitignore`.

5. **No layered architecture** (domain/handler/repository split,
   centralized `errors.go`, `ports.go` interfaces) — present in
   personal-assistant, absent in todo-app's single 253-line `main.go`.
   Judged **scale-dependent**, not a hard rule: appropriate to demand on a
   real multi-feature backend, likely overkill to force onto every small
   prototype. Candidate for AGENTS.md guidance, not an extension.

## Original proposed fixes (pre-review)

- **A.** Scaffolding step: `git init` + seed a language-appropriate
  `.gitignore` at the start of a new project.
- **B.** Fold `go vet`/`gofmt -l` into the verification fallback so lint is
  part of the loop even without a Makefile.
- **C.** Generate a minimal Makefile (`test`/`lint`/`verify`) for new
  multi-component projects so the existing Makefile-first preference in
  `verification.ts` gets exercised.

## Opus review verdict: proceed with modifications — reprioritized

### Root cause was mis-diagnosed
`quality-gate.ts` gates everything on `snapshotDiff()` in
`verification.ts`, which returns `{hash: "unavailable", material: false}`
when `git diff`/`git status` fail. `agent_settled` returns early on
`!before.material`. **In a non-repo, the fallback verification never ran at
all** — `go test ./...` wasn't "too weak," it was never invoked by the gate.
Same for `cross-model-review.ts`: its `tool_result` handler bails on an
empty `git diff`, so the one extension that *is* a cleanliness/self-review
pass (distinct from tests) also never fired.

**Conclusion: A is not hygiene, it's the load-bearing fix.** B and C are
refinements to machinery that was inert the whole time.

### B is justified but would not have caught the motivating bug
`go vet` has no always-true-condition analyzer — finding #1's dead code
passes `go vet` cleanly. Only a `staticcheck`-class linter or a review pass
catches it. Additional issues:
- Drop `gofmt -l` from the gate — `format-on-edit.ts` already gofmt's every
  edited `.go` file, and `gofmt -l` exits 0 while merely listing files
  (needs `test -z "$(gofmt -l .)"` to actually gate), so it's redundant and
  a footgun as written.
- **Bypass hole:** `BROAD_VERIFICATION_PATTERNS` accepts a bare
  `go test ./...` as passing evidence. If the fallback becomes
  `go vet ./... && go test ./...`, an agent that runs plain
  `go test ./...` itself still satisfies `evidencePassesCurrentDiff`, so
  vet silently never runs unless the evidence-recognition pattern moves in
  lockstep with the fallback change.
- The false-negative-retry-loop risk (burning `MAX_CORRECTIVE_FOLLOW_UPS`
  on pre-existing vet failures in a repo the harness didn't create) is real
  but boundable — e.g. only escalate to vet when the pre-change tree is
  vet-clean, or scope vet to changed packages.

### C is the riskiest change, should be sequenced last
`resolveVerificationCommand` checks the root Makefile first and returns
immediately — a generated root Makefile **suppresses**
`nestedVerificationCommand` entirely. For a backend+frontend layout, a
generated `verify` that misses one component silently *shrinks* coverage
versus today's nested scan. Must be gated on: no Makefile, no
`documentedCommand`, and the generated `verify` assembled from the same
`manifestCommandForDir` results the nested scan would have produced.

### A: the extension should not run `git init` itself
Consistent with this harness's own caution norm (`git-safety.ts` blocks
rather than prompts, specifically because `-p` mode has no UI to confirm
through), autonomous `git init` on every run risks initializing inside a
directory the user intended as part of a parent repo. Safer: at
`agent_start`, if `git rev-parse --show-toplevel` fails, append a
`before_agent_start` system-prompt line (the `karpathy-guardrail.ts`
pattern) instructing the model to `git init` + seed `.gitignore` itself.
Zero autonomous filesystem writes from the extension; existing safety
extensions still cover whatever it does next.

### Missing from the original plan
- A cheap deterministic artifact check (untracked file >1MB, or a
  Mach-O/ELF executable in the diff) addresses finding #2 more directly
  than a `.gitignore` template — and matters for performance too:
  `hashUntrackedPath` currently sha256-streams that 13MB binary on every
  settle event.
- Actually configuring `cross-model-review.ts` (currently unconfigured /
  inert — no `AI_REVIEW_BASE_URL`/model set) would catch dead-code smells
  like finding #1 far more directly than A+B+C combined.

## Revised implementation sequence

1. **Prompt nudge for git-init** (no autonomous `git init` from the
   extension) — makes the existing quality gate and cross-model review
   activate at all.
2. **Artifact/binary-size check** — cheap, deterministic, directly targets
   the committed-binary problem and the `hashUntrackedPath` perf cost.
3. **Vet-only fallback**, with the evidence-recognition pattern updated in
   the same change so plain `go test ./...` can no longer satisfy the gate
   on its own. `gofmt -l` dropped as redundant with `format-on-edit.ts`.
4. **Makefile scaffold**, last, and only when no Makefile and no
   documented verification command exists; built from the same
   per-component commands the nested scan would already produce.

Separately (not sequenced, since it's config not code): get
`cross-model-review.ts` actually configured and firing.

### Files most relevant to implementation
- `extensions/lib/verification.ts`
- `extensions/quality-gate.ts`
- `extensions/cross-model-review.ts`
- `tests/verification.test.ts`
- `AGENTS.md`

## Status

Plan only. No extension code has been changed yet. Next step, pending
approval, is to implement step 1 (prompt nudge for git-init) and step 2
(artifact/binary-size check).
