# Independent review — all agent-configs customizations

Reviewer: Fable (advisory review), 2026-07-24. Scope: everything under
`agent-configs/` — `claude/` (hooks + skills), `pi/` (extensions, skills,
prompts, AGENTS.md), `codex/` (skills), `copilot/` (flat instruction files),
and `install.sh`.

Run as three parallel reviews to keep each pass focused, then combined here.
The three pi extensions built this session for
`ai-stack/local-quality-next-steps-plan.md`
(`continuation-nudge.ts`, `cross-model-review.ts`, `co-change-suggest.ts`)
were reviewed separately and in more depth — see
`ai-stack/fable-review-pi-quality-harness.md`. The `pi/` section below
covers everything else in that directory.

## Status update (2026-07-24, after this review)

At the user's direction, only **Part 2 (`pi/`) findings** were addressed in
this pass — Parts 1 (`claude/`) and 3 (`codex/`/`copilot/`) are still fully
open. Pushed to `agent-configs` main as `0371366`
("Fix pi-specific findings from Fable's advisory review"):

- **`git-checkpoint.ts` missing untracked files — fixed**, and a bigger
  latent bug found while verifying the fix: `git stash create` returns
  empty on a clean working tree (the common case), so the *original* code
  silently stored no checkpoint at all whenever a turn started clean —
  restore did nothing for tracked-file edits too, not just untracked ones.
  Rewritten to capture `baseSha` (`git rev-parse HEAD`) unconditionally and
  restore via `checkout baseSha -- .` first, then `stash apply` on top of
  any pre-existing dirty work, then untracked-file blobs. Verified against
  4 scenarios on real git repos (not mocks): clean-start revert,
  dirty-start-preserves-prior-work, untracked-content-restore, and the
  unchecked-`stash apply`-exit-code bug below.
- **`git-checkpoint.ts` restore reporting success unconditionally —
  fixed.** Both `checkout` and `stash apply` results are now checked;
  failure produces a distinct warning notification instead of a false
  "restored" message.
- **`plan-mode/utils.ts` dead code — fixed.** Deleted
  `DESTRUCTIVE_PATTERNS`/`SAFE_PATTERNS`/`isSafeCommand` (~95 lines, never
  imported anywhere).
- **`notify.ts`'s `require()` in an ESM module — fixed.** Replaced with a
  static `import`.
- **`web_search` tool vs. `local-search` skill redundancy — fixed** for pi
  specifically: removed `pi/skills/local-search/` (including the resulting
  dangling `~/.pi/agent/skills/local-search` symlink, which `install.sh`
  doesn't auto-prune) and the one remaining `plan-mode` system-prompt
  reference to it. Claude Code's copy of the skill is untouched — Claude
  Code has no competing built-in `web_search` tool, so it's still the right
  mechanism there.
- **`protected-paths.ts` gaps (bash bypass, no credential-file coverage),
  `ai-stack-local.ts` hardcoded paths, plan-mode README's tool-surface
  documentation gap — not addressed.** Documented in the review as known
  scope limits / low-priority doc drift, not urgent enough to bundle with
  the fixes above.
- **Everything in Part 1 (`claude/`) and Part 3 (`codex/`/`copilot/`) —
  not addressed**, including the two items this review's own "Suggested
  priority order" ranked #1 and #3: the `copilot/CLAUDE.md`
  thread-auto-resolve policy contradiction, and `settings.json`'s blind
  `index.lock` removal. Both are real, both are outside `pi/`, and both
  are still open.

The `cross-model-review.ts`/`co-change-suggest.ts` findings in Part 2 that
overlap with the separate, more detailed pi-quality-harness review (blocking
behavior, missing timeout, `ctx.signal` doc overclaim) are tracked in that
doc's own status section — see
`ai-stack/fable-review-pi-quality-harness.md`, not duplicated here.

---

## Part 1 — `claude/` (hooks + skills)

Scope: `hooks/rtk-rewrite.sh`, `hooks/format-on-edit.sh`, `settings.json`,
`CLAUDE.md`, `GUIDELINES.md`, all 13 skill dirs, `install.sh`. All scripts
referenced from `SKILL.md` files (by absolute `~/.claude/skills/...` path,
including cross-skill references) were verified to exist on disk — no
broken references found.

### Correctness bugs

**`settings.json:17` — the index.lock-removal hook is a race condition
waiting to happen.**
```
jq -r '.tool_input.command' | { read -r cmd; cmd="${cmd#rtk }"; echo "$cmd" | grep -qE '^git (commit|add)' && git_dir=$(git rev-parse --git-dir 2>/dev/null) && [ -n "$git_dir" ] && [ -f "$git_dir/index.lock" ] && rm -f "$git_dir/index.lock"; } 2>/dev/null || true
```
This unconditionally deletes `index.lock` before every `git commit`/`git
add`, with no check for whether a git process is *currently* holding that
lock legitimately. Given `settings.json:35-37` enables `worktree.bgIsolation:
"worktree"` and `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"` — i.e. this
setup expects multiple concurrent agents/background tasks — a second agent
(or even a slow background `git gc`/hook) holding the lock while this one
commits will have its lock ripped out from under it, risking index
corruption. The comment nowhere in the repo explains *why* this exists
(presumably to recover from a previously-crashed session's stale lock), but
as written it can't distinguish "stale lock from a dead process" from "live
lock from a running one." A `flock`-aware check or a PID-liveness check
(`fuser`/reading the lock's mtime with a generous staleness threshold) would
be the safer version of this same idea.

**`settings.json:17` — hook ordering assumption.** This is the *second*
hook in the same `PreToolUse`/`Bash` array, after `rtk-rewrite.sh`. It
strips a `rtk ` prefix assuming rtk-rewrite already ran and rewrote the
command — but Claude Code's hook contract is not guaranteed to chain
`updatedInput` from hook 1 into hook 2's `tool_input` (each PreToolUse hook
in the matcher array typically receives the same original payload unless
the harness explicitly threads `updatedInput` through). If that assumption
is wrong, the `${cmd#rtk }` strip is a no-op most of the time, which is
harmless here since the grep pattern still matches un-rewritten `git
commit`/`git add` — so functionally it degrades gracefully, but the
comment/design intent doesn't hold up to scrutiny and should be verified
rather than assumed.

**`hooks/rtk-rewrite.sh` and `hooks/format-on-edit.sh`** — both are solid.
`rtk-rewrite.sh` checks for `jq`/`rtk` presence, version-gates on
`>=0.23.0`, and fails open (`exit 0`, passthrough) on every unexpected
condition — malformed JSON, missing command, unknown exit code.
`format-on-edit.sh` doesn't check for `jq` explicitly but degrades safely:
if `jq` is missing, `$f` is empty and the `[ -n "$f" ] && ... || exit 0`
guard exits cleanly. No bugs found in either.

**`settings.json:4` — `CLAUDE_MODEL: "claude-sonnet-4-6"`.** This model id
looks stale relative to current naming (the live family is Sonnet 5 / Opus
4.8 / Haiku 4.5 per current model docs). If anything reads this env var to
pin a model, it may silently resolve to a retired/wrong model, or just be
dead config. Worth confirming whether anything still consumes this var — if
not, delete it; if so, update it.

### Security concerns

**Self-approval loop via a second account is real but appears
deliberate, not a bug.** `CLAUDE.md` sets up `ljammula` (owner/author) and
`narsimha-j` (reviewer) as two accounts both controlled by the same user,
and `self-review`/`before-done` always resolve to `APPROVE`, never leave a
`COMMENT`-only state once "issues are fixed." This is sock-puppet
self-approval on your own repos — fine for a solo project, but worth being
explicit that this produces GitHub history that *looks* like independent
review and isn't. Not a hook/skill bug, just worth flagging since it's
automated and easy to forget the optics of.

**No `permissions`/`deny` block anywhere in `settings.json`.** Combined
with `skipDangerousModePermissionPrompt: true` (`settings.json:44`), the
*only* gate on arbitrary Bash execution is `rtk-rewrite.sh`'s ask/deny
signals (exit codes 2/3) — and rtk-rewrite explicitly defers "deny" handling
to "Claude Code's native deny rule" (`rtk-rewrite.sh:61-62`), which doesn't
exist in this file. If `rtk rewrite`'s Rust registry is the only place
deny/ask rules are defined, that's a single external binary (versioned
outside this repo) now solely responsible for stopping dangerous commands —
worth confirming that registry is itself reviewed/tracked somewhere, since
this repo has no visibility into it.

**`pr-remediate` and `release` skills are correctly gated**
(`disable-model-invocation: true`, user-triggered only) given they end in
`git push --force` / a real prod deploy tag. Good practice, no issue.

### Design quality

**Triplicated Karpathy guidelines.** The exact same guideline text (Think
Before Coding / Simplicity First / Surgical Changes / Goal-Driven Execution)
appears in three places: `~/.claude/CLAUDE.md` → `RTK.md`'s neighbor
`GUIDELINES.md` (`claude/GUIDELINES.md`, full copy), and
`skills/karpathy-guidelines/SKILL.md` (identical full copy again).
`CLAUDE.md` instructs "Always apply... Invoke it via the Skill tool,"
meaning the skill copy is the one actually loaded at runtime —
`GUIDELINES.md` appears to be dead weight (nothing in `install.sh` symlinks
it, and only `feature-dev/SKILL.md:433` references it, only for "§5"
branch-naming convention, not the guidelines content). This is a drift
risk: if one copy is edited (e.g. after the user tells Claude "stop doing
X" in a session and this gets folded into guidelines) the other two go
stale silently.

**Good separation of deterministic vs. judgment steps.** The skill set
consistently separates "run this script, it's byte-for-byte deterministic"
from "now use judgment" (e.g. `docs-verify` link-check vs.
semantic-consistency pass, `before-done` script gates vs. AI spec-gap
detection). This is the strongest design trait across the whole set and is
applied consistently in all 13 skills — no skill skips straight to "trust
the model."

**`before-done` is doing a lot.** It's the de facto root of nearly every
other skill (`feature-dev`, `frontend-dev`, `backend-dev`, `wiring-verify`,
`testflight-cut` all terminate into it). That's appropriate centralization,
not redundancy — but it does mean a bug in `before-done`'s scripts has the
largest blast radius of anything in this repo. Its own scripts
(`verify-git.sh`, `check-ci.sh`, `check-threads.sh`, `check-l10n.sh`) were
spot-checked and are clean, small, `set -euo pipefail`, fail loudly on the
right conditions.

**`local-review.sh` / local-summarize/local-search** correctly frame
local-model output as "evidence to triage," never "ground truth" — both the
`SKILL.md` prose and the scripts' error handling reinforce this (fail-closed
messaging like "skip local review" rather than silently returning
empty/success). No overclaiming found.

### Unfinished / inconsistent / stale

- `claude/GUIDELINES.md` is very likely dead: not linked by `install.sh`,
  its content is superseded by the `karpathy-guidelines` skill, and it's
  referenced by name exactly once for an unrelated purpose (branch-naming
  section). Recommend either deleting it or repurposing the reference in
  `feature-dev` to point at wherever branch-naming conventions actually live
  now.
- `settings.json`'s `CLAUDE_MODEL` value looks like it wasn't updated
  across a model-family bump (see Correctness section) — low risk but worth
  a quick check for dead references.
- Everything else — install symlinking, script existence, cross-skill
  script sharing (e.g. `check-l10n.sh` shared by
  `before-done`/`feature-dev`/`frontend-dev`, `next-version.sh` shared by
  `release`/`testflight-cut`) — is consistent and correctly cross-referenced.
  No missing files, no skill pointing at a script that doesn't exist.

### Part 1 bottom line

The two things worth actually fixing: the blind `index.lock` removal in
`settings.json` (real corruption risk under the concurrent-agent setup this
config itself enables), and the dead/triplicated `GUIDELINES.md`. Everything
else is solid, consistently designed, and fails safe.

---

## Part 2 — `pi/` (extensions, skills, prompts, AGENTS.md)

Scope: everything in `pi/` except `continuation-nudge.ts`,
`cross-model-review.ts`, `co-change-suggest.ts` (reviewed separately, see
`ai-stack/fable-review-pi-quality-harness.md`).

### Correctness bugs

**`git-checkpoint.ts` — checkpoint silently misses new files.** `git stash
create` (like plain `git stash`) does **not** include untracked files
unless `--include-untracked`/`-u` is passed — and `stash create` doesn't
support that flag the way `stash push -u` does, so newly-created files are
never captured. Given this extension exists specifically to protect against
LLM edits, and a large fraction of coding turns *create* new files rather
than only editing existing ones, the checkpoint is silently incomplete for
exactly the case it's most needed. `git-checkpoint.ts:18`

**`git-checkpoint.ts` — restore reports success unconditionally.**
```ts
await pi.exec("git", ["stash", "apply", ref]);
ctx.ui.notify("Code restored to checkpoint", "info");
```
`git-checkpoint.ts:43-44`. The `apply` call's result is never checked. If it
fails (e.g. conflicts with changes made after the checkpoint), the user
still sees "Code restored to checkpoint" — a false success. Contrast with
the `stash create` call three lines above, which does check `result.code !==
0`.

**`plan-mode/utils.ts` — dead code.** `DESTRUCTIVE_PATTERNS`,
`SAFE_PATTERNS`, and `isSafeCommand()` (lines 6-101) are never imported or
called anywhere in `index.ts` — only `extractTodoItems` and
`markCompletedSteps` are imported (`index.ts:19`). Bash is unconditionally
disabled in plan mode instead (`PLAN_MODE_DISABLED_TOOLS`), which the README
correctly documents as the actual mechanism ("Bash is disabled because
shell syntax cannot be safely constrained by an allowlist"). The allowlist
code is a leftover from an earlier, abandoned design and should be deleted
— right now it reads as active logic to anyone auditing the file, when it's
actually ~95 lines of unreachable code.

**`notify.ts` — `require()` in a TS module.** `notifyWindows()` calls
`const { execFile } = require("child_process")` (`notify.ts:37`) while the
rest of the file uses `import type`. If pi's extension loader runs modules
as ESM (plausible given the `import type` style elsewhere in this codebase),
`require` is undefined and this throws at runtime. Low real-world impact
since it's gated behind `process.env.WT_SESSION` (Windows Terminal only)
and this machine is a Mac, but it's untested on the one platform it
targets.

### Security: `protected-paths.ts`

The core logic holds up:
- `isOutsideCwd` correctly uses `relative()` + a `startsWith("..")` check
  rather than a `startsWith(cwd)` prefix comparison, so it isn't fooled by
  sibling directories with a shared prefix (e.g. `project` vs
  `project-evil`) — a mistake this exact pattern often has elsewhere.
- The doc comment is honest about its own limits: it explicitly says it
  doesn't chase symlinks and isn't a sandbox, and only guards `write`/
  `edit`, not `bash` redirection. That's an accurate scope statement, not an
  overclaim.

Gaps worth naming:
- **`bash` is a wide-open bypass.** A model can `cat > .env` or `rm
  .git/config` via the bash tool and this guard never sees it. This is
  documented as a known non-goal, but it's worth being explicit in a
  security review: this extension protects against clumsy writes, not an
  adversarial or confused model that reaches for bash instead. Given the
  README's own motivating anecdote (a 27B model emitting a wrong absolute
  path), a model just as capable of "fixing" a `.gitconfig` via bash as via
  the write tool is not covered at all.
- **Substring matching (`includes()`) has no path-boundary check**, so it's
  stricter than necessary but never looser in a dangerous direction — false
  positives (blocking benign paths that happen to contain a protected
  substring), not false negatives. Acceptable trade for a guardrail.
- No coverage for private key material (`id_rsa`, `*.pem`) or other
  credential file patterns beyond `.env`/`.aws`/`.ssh`/`.gitconfig`. Given
  the stated design goal ("a 27B model is likelier to 'fix' a failing build
  by rewriting a lockfile or generated file") the list is tuned for
  build-breakage self-correction, not credential exfiltration — reasonable
  if that's the actual threat model, but worth confirming that's the
  intended scope since the file's docstring calls it a "guardrail."

### Design quality and redundancy

**`web_search` tool vs. `local-search` skill — same backend, two entry
points.** `searxng-search.ts` registers a `web_search` tool backed by
SearXNG on :8888. The `local-search` skill (`skills/local-search/SKILL.md`)
does the same lookup via a shell script the model is expected to invoke
through Bash. The `README.md` explains why the tool was added ("a 27B model
reliably calls a tool... unreliably remembers to shell out to a script"),
but the skill wasn't removed — the reasoning for keeping the tool is also,
verbatim, the reasoning the skill should now be redundant. Right now a
model has two divergent paths to reach the same SearXNG instance, with the
worse one (per the project's own stated evidence) still present and
skill-matched into context on relevant prompts. Recommend deleting
`skills/local-search/` on this machine's pi config now that the tool
exists, or explicitly noting in the skill why it's kept as a fallback.

**Extension/skill/prompt split is otherwise coherent.**
`karpathy-guardrail.ts` is a thin, well-justified trigger (skill-matching is
unreliable on a local model, so force it via system prompt) that defers all
actual content to `skills/karpathy-guidelines/SKILL.md` — good separation,
single source of truth. The `prompts/*.md` files are similarly thin
wrappers that just force a skill invocation with explicit, model-proof
steps. No conflicts found between `rtk-rewrite.ts` and `protected-paths.ts`
— the file header comments in `rtk-rewrite.ts` explicitly note the boundary
("Blocking or gating is the job of protected-paths.ts, not of a rewrite
that changes only how much output comes back") and the code respects it
(never blocks, only rewrites `event.input.command`).

**`ai-stack-local.ts` — user-specific absolute paths.** Model IDs are
hardcoded absolute filesystem paths
(`/Users/kanna/code/ai-stack/models/Qwen3.6-27B-4bit`) rather than something
portable. Given the README documents this is intentional (`enabledModels`
in settings.json matches by substring against these exact path-style IDs),
it's a known constraint, not an oversight — but it means this file cannot
be shared or reused on another machine without edits, worth a one-line note
in the README's "What's installed" table if it isn't already obvious to
future-you.

### Documentation consistency

`README.md` and `AGENTS.md` are largely accurate against the code — the
`protected-paths.ts` description matches the vendored file's actual
behavior, the `format-on-edit.ts` description matches the go/dart-only
scope, and the plan-mode README's claim that bash is fully disabled (not
allowlisted) matches `index.ts`'s `PLAN_MODE_DISABLED_TOOLS` — but that same
plan-mode README doesn't mention `utils.ts`'s unused
`isSafeCommand`/pattern-list machinery at all, which is the tell that it's
dead: nobody documented it because nobody currently relies on it.

One more small inconsistency: the plan-mode `README.md` says "Available
Inspection Tools ... Plan mode keeps PI's native read-only tools enabled:
read, grep, find, ls" as if that's the fixed set, but `index.ts`'s
`getPlanModeTools()` actually unions those with whatever *other*
non-disabled tools were already active (e.g. `web_search`, `todo`) — so the
actual tool surface in plan mode is broader than the README implies. Minor,
but could mislead someone auditing what plan mode blocks.

---

## Part 3 — `codex/` and `copilot/`

### Codex (`codex/skills/`)

**Overall**: Well-maintained. All 13 Claude skills have codex counterparts,
symlink paths are correctly rewritten (`~/.claude/` → `~/.codex/`), and most
content is faithfully condensed/adapted (pronoun changes "Claude"→"you",
trimmed Required-Tools tables, dropped `WebFetch`/`Skill tool` references
that don't apply to Codex — good discipline, confirmed via `grep -rn "Skill
tool\|WebFetch\|WebSearch" codex/skills/*/SKILL.md` returning nothing).

#### Real bugs / inconsistencies found

1. **`codex/skills/release/SKILL.md:7-8` and
   `codex/skills/self-review/SKILL.md:7`** still carry
   `disable-model-invocation: true` and `invoke via /release` /
   `invoke via /self-review` — copied verbatim from Claude. Codex CLI
   doesn't have Claude's slash-command skill-invocation mechanism, and it's
   unclear that frontmatter key does anything there. The tell that this is
   a real miss, not an intentional match: `codex/skills/pr-remediate/SKILL.md`
   (same "user-triggered only, mutates external state" category) *was*
   correctly adapted — it dropped both the frontmatter key and the
   `/pr-remediate` phrasing, replacing it with prose ("never run as part of
   an automatic completion check"). So within codex's own skill set, the
   convention was established and then not applied to two siblings. Worth
   aligning `release` and `self-review` to match `pr-remediate`'s treatment.

2. **`codex/skills/release/SKILL.md:44`** — the "review what's shipping"
   git command dropped the tag filter: `git tag --sort=-v:refname | head -1`
   vs Claude's `git tag -l 'v*' --sort=-v:refname | head -1`
   (`claude/skills/release/SKILL.md:47`). Since this same repo also uses
   `t<version>` tags (testflight-cut), an unfiltered `git tag --sort` can
   pick the most recent tag regardless of prefix — if a `t*` tag is newer
   than the last `v*` tag, `git log <wrong-tag>..HEAD` silently shows the
   wrong diff. Looks like a dropped filter, not an intentional change.

3. **`codex/skills/release/SKILL.md`** is also missing the clarifying note
   present in Claude's version (`claude/skills/release/SKILL.md:19-20`):
   *"This is the backend path only. The iOS/TestFlight cut is `t<version>`
   → Xcode Cloud — use the `testflight-cut` skill; do not tag `t*` here."*
   Given finding #2, this omission compounds the risk of tag confusion
   between the two release skills.

4. **`before-done`** (`codex/skills/before-done/SKILL.md`, Step 5 "Local
   preview"): dropped the line about reading Playwright screenshots
   (`test-results/preview-*.png`) before showing a URL to the user (present
   at `claude/skills/before-done/SKILL.md:116`). Also dropped the
   "time-dependent tests" caution about fixed-clock-time flakiness. These
   could be intentional (Codex CLI may not support image viewing the way
   Claude Code does, which would justify dropping the screenshot-reading
   step) — but if Codex CLI *can* read images, this is a silent capability
   loss worth restoring.

#### Design quality (3-way: claude/pi/codex)

Structurally sound — install.sh symlinks whole skill directories so
`scripts/` stay live-synced, and content is condensed per-tool rather than
literally copy-pasted in most places. The failure mode isn't the mechanism,
it's that condensing invites exactly the drift in #1–#3: a human trimming
three parallel Markdown files by hand will occasionally trim inconsistently.
Nothing here suggests the process needs a rewrite, just a pass to reconcile
`release`/`self-review` against the `pr-remediate` pattern and re-check the
tag-filter regression.

### Copilot (`copilot/`)

Copilot has no skills mechanism — `install.sh` symlinks three flat files
instead: `copilot/CLAUDE.md` → `~/.copilot/CLAUDE.md`,
`copilot/copilot-instructions.md` → `~/.copilot-instructions.md`,
`copilot/github-copilot-instructions.md` → `~/.github/copilot-instructions.md`.

#### Likely-broken file placement

The three targets live in inconsistent locations: one inside `~/.copilot/`,
one at the home-directory root (`~/.copilot-instructions.md`), one inside
`~/.github/`. GitHub's documented convention for repo-level Copilot
instructions is a **per-repository** `.github/copilot-instructions.md`, not
a global file at `$HOME/.github/copilot-instructions.md` — this can't be
confirmed from the repo alone whether Copilot CLI actually reads a global
file at that path, but the inconsistent directory pattern
(`~/.copilot/X` vs `~/.copilot-instructions.md` vs `~/.github/X`) is a
strong signal at least one of these three isn't landing where Copilot CLI
actually looks. Worth verifying directly (run `copilot` with a trivial
prompt and check whether RTK-prefixing or the karpathy guidelines actually
take effect) rather than assuming the symlinks work.

#### Duplicate content

`copilot/CLAUDE.md:1-71` and `copilot/copilot-instructions.md` (all 66
lines) both contain the full karpathy-guidelines text, near-verbatim. If
these are meant to land in two files Copilot both reads, that's redundant;
if only one is actually read (see placement concern above), the other is
dead weight. Either way it's a fourth-and-fifth copy of karpathy-guidelines
to keep in sync (claude, pi, codex, copilot×2) with no mechanism enforcing
consistency — pure hand-copy drift risk, and it's already showing:
`copilot/CLAUDE.md` doesn't have the "Applying Karpathy guidelines: ..."
acknowledgment line that `claude/skills/karpathy-guidelines/SKILL.md:12-15`
has (a genuinely tool-specific omission, since Copilot's flat-file model has
no equivalent "skill fired" moment to acknowledge) — so the two copies are
already not byte-identical, just close.

#### Policy contradiction — review-thread auto-resolve

`copilot/CLAUDE.md:94-96`:
```
⚠️ REQUIRES EXPLICIT USER APPROVAL before executing:
- `git push --force` (rebase conflict recovery)
- `gh auth switch --user narsimha-j` + `resolveReviewThread` mutation
```
This gates thread resolution behind explicit approval. But
Claude/Codex/pi's `before-done` skill explicitly does the opposite — it
resolves fixed threads automatically via `narsimha-j` with no approval gate
(`claude/skills/before-done/SKILL.md` §8: *"After fixing issues from a
review thread, resolve it — do not just comment... Use narsimha-j, then
switch back"*), and this matches the user's own stated policy (session
memory: *"before-done should auto-resolve fixed review threads via
narsimha-j; only force-push recovery stays gated"*). Copilot's instructions
directly contradict this — same underlying workflow, different (more
conservative) policy depending on which CLI is driving. This looks like
stale content predating the auto-resolve decision, not an intentional
per-tool difference.

#### Missing workflows entirely

`pr-remediate`, `testflight-cut`, `docs-verify`, `local-search`, and
`local-summarize` have zero presence anywhere in `copilot/*.md` (confirmed
via grep). `release` is included but its iOS counterpart `testflight-cut`
is not — so if Copilot CLI is ever used near a release, there's no
guardrail against tagging `t*` incorrectly or skipping App Store preflight
checks, and no rebase-recovery runbook if a squash-merge conflict happens.
This may be acceptable if Copilot CLI is only used for narrow tasks, but
it's worth confirming that's still the intended scope.

#### Missed opportunity: no deterministic scripts

Unlike codex (which reuses/re-hosts the actual `scripts/*.sh` from
`before-done`, `release`, etc.), copilot's "Before Done Gate" re-describes
the same checks in prose only ("poll `gh run view <run-id> --json
status,conclusion,jobs` until completed" instead of running
`check-ci.sh`). Nothing about Copilot CLI's flat-instructions model prevents
it from shelling out to the same scripts by absolute path the way codex
does — this looks like the scripts were reimplemented as prose rather than
reused, which both duplicates logic and loses the deterministic exit-code
contract the other three tools rely on.

### Part 3 bottom line

Codex is close to solid — two small but consequential misses
(`release`/`self-review` frontmatter, the tag-filter regression) plus one
likely-intentional capability gap (screenshot verification) worth
double-checking. Copilot is the weaker link: unverified file placement that
may mean some of the content silently does nothing, a real policy
contradiction on thread auto-resolve that should be fixed regardless,
entire missing workflows, and duplicated content with no sync mechanism. If
Copilot CLI is used more than occasionally, it's due for a proper pass
rather than incremental patching.

---

## Cross-cutting findings (across all four reviews)

- **Karpathy guidelines exist in 5+ copies** (claude skill, dead
  `claude/GUIDELINES.md`, pi skill, codex skill, copilot×2) with no
  mechanism keeping them in sync. Every review independently flagged this
  as a drift risk. Worth a single follow-up: designate the Claude skill copy
  as the source of truth, delete `claude/GUIDELINES.md`, and periodically
  diff the others against it.
- **The auto-resolve-review-threads policy contradiction in `copilot/`** is
  the one finding across all three reviews that's a clear, unambiguous bug
  (stale content that actively contradicts a since-established user policy)
  rather than a design tradeoff — worth fixing regardless of how much
  Copilot CLI actually gets used.
- **Multiple "fails safe by omission" patterns** were praised, not flagged
  — `rtk-rewrite.sh`, `format-on-edit.sh`, `local-review.sh`'s
  evidence-not-truth framing, `protected-paths.ts`'s honest scope
  documentation. This is a consistent strength across the whole customization
  set, not an accident.
- **Two silently-incomplete safety nets**: `git-checkpoint.ts` (misses new
  files) and `settings.json`'s blind `index.lock` removal (misses concurrent
  legitimate holders) are both mechanisms whose entire job is to prevent
  data loss / corruption, and both have a real gap in exactly the scenario
  they're meant to cover. These are the two highest-priority fixes in this
  whole review, independent of the pi-quality-harness findings.

## Suggested priority order if acting on this review

1. `copilot/CLAUDE.md`'s thread-auto-resolve contradiction (clear bug, cheap
   fix, matches known user policy).
2. `git-checkpoint.ts`'s missing-untracked-files gap (safety-net mechanism
   silently incomplete for its primary use case).
3. `settings.json`'s blind `index.lock` removal (real corruption risk given
   the concurrent-agent setup this same config enables).
4. `codex/skills/release/SKILL.md`'s dropped tag filter (silent-wrong-diff
   risk, cheap fix).
5. Delete dead code: `claude/GUIDELINES.md`, `plan-mode/utils.ts`'s unused
   allowlist functions.
6. Everything else — worth doing, lower urgency.
