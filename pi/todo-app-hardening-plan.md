# Pi harness hardening: gaps found via todo-app vs. personal-assistant

Status: **implemented** (see the Status section at the end for what
landed and how). Reviewed by Opus at each stage (see verdicts below).
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
directory the user intended as part of a parent repo. Safer: in
`before_agent_start` — the only hook that can mutate the system prompt
(the `karpathy-guardrail.ts`/`stack-router.ts` pattern) — check whether
`git rev-parse --show-toplevel` fails, and if so append a system-prompt
line instructing the model to `git init` + seed `.gitignore` itself. The
repo check and the prompt append must happen in the same
`before_agent_start` handler: an `agent_start` check is too late, since by
then the prompt has already been built and the model never sees the
instruction, leaving the gate un-activated exactly as before. Zero
autonomous filesystem writes from the extension; existing safety
extensions still cover whatever it does next.

**Unborn-HEAD gap (found in review):** `git init` alone does not make
`quality-gate.ts` activate for a brand-new project. `quality-gate.ts`
captures `baseSha` via `git rev-parse HEAD` in its own `agent_start`
handler, before the model has run any tools; in a freshly initialized repo
with no commits, `HEAD` is unborn, that `rev-parse` fails, and `baseSha`
stays `undefined`. `snapshotDiff()` then falls back to
`git diff --binary HEAD`, which also fails against an unborn HEAD, so the
snapshot stays `{ material: false }` and the gate never activates — the
same failure mode as the no-repo case, just one step later. The nudge must
therefore instruct **`git init` + `.gitignore` + an initial empty-ish
baseline commit** (not just `git init` and stop), so `HEAD` resolves by
the time `quality-gate.ts`'s `agent_start` handler runs. As a defense in
depth, `snapshotDiff()` should also handle unborn HEAD explicitly (e.g.
diff against the empty-tree hash instead of `HEAD` when `rev-parse HEAD`
fails) rather than depending solely on the model following the nudge.

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

1. **Prompt nudge for git-init**, implemented in `before_agent_start` (not
   `agent_start` — that hook runs after the prompt is built and can't
   change it), instructing `git init` + `.gitignore` + an initial baseline
   commit so `HEAD` is born before `quality-gate.ts`'s own `agent_start`
   handler captures `baseSha`. No autonomous `git init` from the extension
   itself. Defense in depth: `snapshotDiff()` in `verification.ts` should
   also handle an unborn `HEAD` explicitly (diff against the empty-tree
   hash) rather than relying solely on the model following the nudge. This
   is the fix that makes the existing quality gate and cross-model review
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

## Scope expansion: architecture, error taxonomy, DI, docs (everything except CI)

The original plan deliberately scoped OUT deeper discipline — layered
architecture, centralized domain errors, interface-based DI, and docs — as
"judgment-dependent, not a hard rule." The user asked to bake all of that
in except CI workflows. Draft D-G below, then re-reviewed by Opus.

### Draft (pre-review)

- **D.** Layered-architecture guidance for Go backends, scale-triggered:
  once a backend crosses a size/resource-count threshold, split into
  `cmd/`, `internal/domain`, `internal/handler`, `internal/<resource>`,
  mirroring personal-assistant's `internal/` layout.
- **E.** Centralized domain errors, bundled into D's trigger: sentinel
  errors in `domain/errors.go` instead of ad hoc strings/`err.Error()`
  leaked to HTTP responses.
- **F.** Interface-based DI, also bundled into D's trigger: `Clock`/`IDGen`
  seams via `domain/ports.go` once real persistence/time/ID generation
  exists.
- **G.** README scaffold: generate a minimal `README.md` (what the project
  is, how to run/test it) whenever none exists, for any project regardless
  of scale. `ARCHITECTURE.md` not auto-generated — only a byproduct of D
  actually firing.

### Opus review verdict: proceed, but restructured — D/E/F are a different
### tier of guarantee than 1-4, and mid-project triggering contradicts
### AGENTS.md

**1. This is fundamentally softer than fixes 1-4 — state that plainly.**
Fixes 1-4 are enforced in TypeScript (a regex, a diff scan, a precedence
order). D/E/F as drafted have no observer at all — nothing inspects a diff
for "is there a `domain` package." On a 96K local slot with AGENTS.md's
context-discipline and no-refactor rules already competing for attention,
prose-only architecture guidance is a hope, not a gate. The plan should
label these explicitly: **Tier 1** = deterministic extension checks (1-4),
**Tier 2** = prompt/scaffold guidance (D-G). Presenting them as equally
"baked in" was the main flaw in the draft.

**2. The size/resource-count thresholds don't survive contact with an
imperative-follower.** "N resource types" requires the model to *infer*
what counts as a resource — the inferred-intent mode AGENTS.md says fails.
"M lines" is checkable but is the wrong signal (a 400-line single-resource
CRUD file may not need splitting). Worse, any mid-project size trigger
directly contradicts AGENTS.md rule 2 ("no refactors, no speculative
abstractions") — two rules that conflict at the exact moment the trigger
fires.

**Sharper mechanism: move D/F to project-init time, reusing fix 1's
trigger.** `git rev-parse --show-toplevel` failing already identifies "new
project" and already emits a `before_agent_start` nudge
(`karpathy-guardrail.ts` pattern). Extend that same nudge: when no repo
exists *and* the task describes a Go backend with persistence, instruct
scaffolding `cmd/`, `internal/domain` (with `errors.go` sentinels and
`ports.go` seams) up front. Deciding once, before code exists, costs
nothing and needs no threshold.

**3. Retrofit must never be autonomous.** A mid-project mass file move
blows up `snapshotDiff()`, feeds an oversized diff to
`cross-model-review.ts` on a 96K window, and can burn
`MAX_CORRECTIVE_FOLLOW_UPS` on churn unrelated to the actual task. If any
mid-project layering signal is kept at all, it must surface as a proposal
line in the prompt, never an autonomous write — consistent with
`git-safety.ts`'s existing caution norm.

**4. G is safe only if narrowed.** "Any project regardless of scale"
risks stomping intent on a mature repo that deliberately uses `docs/`,
`README.rst`, or no README. Gate it exactly like the Makefile scaffold
(fix 4): generate only when no repo/README exists (a new-project signal),
and populate run/test sections from `resolveVerificationCommand`'s actual
output — if no command resolves, emit nothing rather than a generic stub.

**5. Excluding CI stays defensible and consistent.** CI touches secrets,
external systems, and shared-repo merge behavior; D-G are purely local
file conventions. Worth one line in the plan so the scope boundary reads
as principled, not arbitrary.

### Revised shape for D-G

- **D + F → init-time scaffold nudge (Tier 2).** Extend the fix-1 nudge:
  when no repo exists yet and the task is a Go backend with persistence,
  instruct scaffolding `cmd/`, `internal/domain/errors.go`,
  `internal/domain/ports.go` up front — decided once, before code exists,
  never as a mid-project retrofit.
- **E → split into Tier 1 + Tier 2.** Prose guidance for sentinel errors
  (Tier 2, bundled into the D/F nudge), plus one genuinely deterministic
  Tier 1 check: flag `err.Error()` (or equivalent raw error string) written
  into an HTTP response body — this is grep-able and testable, unlike
  "is the architecture layered."
- **G → new-project-gated scaffold (Tier 2 but mechanically enforced like
  fix 4).** Generate `README.md` only when none exists; populate run/test
  sections from the actual resolved verification command; emit nothing if
  no command resolves rather than a generic stub. `ARCHITECTURE.md` stays
  a byproduct of D/F actually firing, never auto-generated on its own.

Sequenced after fixes 1-4, since Tier 1 (the deterministic gate actually
running at all) is the precondition every Tier 2 guidance step depends on
to have any enforcement teeth via `cross-model-review.ts`.

### Files most relevant to D-G implementation
- `pi/todo-app-hardening-plan.md` (this file)
- `extensions/lib/verification.ts`
- `extensions/karpathy-guardrail.ts`
- `AGENTS.md`
- `tests/verification.test.ts`

## Status

Implemented. All four Tier 1 fixes and Tier 2 items D-G landed in this
branch (`pi/todo-app-hardening-plan.md`'s own PR):

1. **Fix 1 (git-init nudge).** `new-project-scaffold.ts`, a
   `before_agent_start` nudge, instructs `git init` + `.gitignore` + an
   initial commit when no repo exists. `verification.ts`'s `snapshotDiff`
   also falls back to the empty-tree hash when `HEAD` is unborn, as
   defense in depth independent of the nudge.
2. **Fix 2 (artifact/binary-size check).** `artifact-guard.ts`, a
   deterministic `agent_settled` check, flags untracked files >1MB or
   bearing an ELF/Mach-O magic number and sends a corrective nudge.
3. **Fix 3 (vet-only fallback).** The bare-`go.mod` fallback in
   `verification.ts` is now `go vet ./... && go test ./...`. The bypass
   hole flagged in review is closed: `quality-gate.ts`'s `tool_result`
   handler now requires the observed command to satisfy every `&&`-joined
   segment of the resolved canonical command (`commandSatisfiesCanonical`)
   before accepting it as evidence, so a bare `go test ./...` can no longer
   silently skip vet. `gofmt -l` was not added, per review (redundant with
   `format-on-edit.ts`).
4. **Fix 4 (Makefile scaffold).** `makefile-scaffold-nudge.ts`, a
   `before_agent_start` nudge (not an autonomous write, for the same
   coverage-shrink reason the review flagged), hands the model the
   resolved verification command and asks it to wire `test`/`lint`/
   `verify` Makefile targets to it. Fires only when no Makefile and no
   documented command exist.
5. **D/F (architecture scaffold) + G (README scaffold).** Folded into
   `new-project-scaffold.ts`, gated on the same "no repo yet" signal as
   fix 1 (init-time, not a mid-project size threshold) plus a separate
   "no README yet" check.
6. **E (error taxonomy), deterministic slice.** `error-leak-guard.ts`
   scans added diff lines for `http.Error(w, err.Error(), ...)` and flags
   it. The prose half of E (sentinel errors in `domain/errors.go`) is
   folded into the D/F architecture-scaffold nudge as guidance, per the
   review's Tier 1/Tier 2 split.

All new/changed behavior is covered by `pi/tests/*.test.ts` (104 tests
passing, up from 78 before this branch) and `npm run typecheck` is clean.
None of it has live-trial evidence yet — see the README's validation-status
note added alongside these extensions.

### Implementation-review fixes (Opus reviewed the diff before push)

A second Opus pass, against the actual diff rather than the plan prose,
found and this branch fixed:

- **`commandSatisfiesCanonical` had its own bypass.** Segment-wise
  containment let `go vet ./... || true && go test ./...` satisfy a
  `go vet ./... && go test ./...` canonical while neutralizing vet's exit
  code — the exact class of hole fix 3 exists to close. Fixed: a compound
  (multi-`&&`-segment) canonical now requires an exact normalized match;
  only a single-segment canonical (e.g. `make verify`) still uses
  containment, protected from the same trick by the pre-existing
  `verificationPipelineCanMaskFailure` masking check. This also fixes a
  correctness gap the same change would otherwise have introduced for
  monorepo nested canonicals and multi-target Makefiles (`make test` is
  not actually equivalent to `make verify` when `verify` depends on `test`
  and adds more, per the harness's own test fixtures).
- **`error-leak-guard.ts` missed its own motivating case.** `git diff`
  never shows untracked files, so in the exact todo-app scenario (fresh
  project, files never `git add`ed) the guard was silent forever. Fixed:
  it now also reads untracked `.go` files' full content, not just the
  tracked diff, and attributes each finding to its file (parsed from the
  diff's `+++ b/<path>` header for tracked changes) instead of keying
  dedup on line text alone.
- **`artifact-guard.ts` only checked untracked entries.** A staged-but-
  uncommitted binary was invisible. Fixed: now also checks staged/modified
  (`A`/`M`) `git status` entries. A fully-committed-and-clean binary
  remains out of scope — that needs a tracked-tree history scan, a
  materially bigger feature than this fix; documented as a known
  limitation in the file's header comment rather than silently claimed as
  covered.
- **Both guards' dedup state was a single closure variable**, not
  namespaced by `cwd` — a long-running process touching a second project
  could suppress a real finding there if it happened to match a key
  already flagged elsewhere. Fixed: both now key dedup by `ctx.cwd`.
- **`cross-model-review.ts` drifted from the plan's own claim.**
  `new-project-scaffold.ts`'s nudge text says cross-model-review requires
  real git history to activate, but the reviewer's diff-fetch still used a
  bare `git diff`/`git diff <baseSha>` with no unborn-HEAD handling. Fixed:
  it now goes through the same `resolveDiffTarget` fallback
  `snapshotDiff()` uses, making the claim in the nudge text accurate and
  closing a real edge case (a bare `git diff` shows nothing if the model
  staged everything with `git add` before the reviewer's first tool_result
  fires).

Not changed, by deliberate choice: the review's suggestion to memoize
`resolveVerificationCommand(ctx.cwd)` in `quality-gate.ts`'s hot
`tool_result` path was not applied — a cache keyed by `cwd` risks staying
stale if a Makefile appears mid-session, and the underlying cost is a few
cheap `fs.access`/`fs.readFile` calls, not worth the staleness risk to
save.

### Final sign-off

A third Opus pass reviewed the fixed diff specifically against the five
items the second pass required and the one it flagged as non-blocking,
hand-tracing the `|| true` and nested-canonical examples rather than
trusting the tests existed. Verdict: **sign off, ship it** — all five
required items RESOLVED, the declined memoization accepted as reasoned.
Two non-blocking nits were fixed in the same push: the rename-entry test
fixture in `artifact-guard.test.ts` had the untracked-rename path order
backwards (git's `-z` format is new-path-then-old-path, not the reverse —
didn't affect the assertion either way, since both entries are correctly
excluded regardless of order, but the fixture wasn't a faithful
reproduction of real git output), and `new-project-scaffold.ts`'s doc
comment overstated cross-model-review.ts's requirement as needing "real
git history" when it only needs a git repository to exist (a repo with no
commits still diffs fine through the same empty-tree fallback).

CI workflow generation remains explicitly out of scope, per the review's
scope-boundary reasoning (CI touches secrets/external systems; everything
implemented here is local file conventions).
