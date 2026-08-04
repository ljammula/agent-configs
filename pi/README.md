# pi

Config for the [pi coding agent](https://pi.dev), installed by `../install.sh`
into `~/.pi/agent/`.

pi is deliberately minimal: four default tools (`read`, `write`, `edit`,
`bash`), plus optional read-only built-ins (`grep`, `find`, `ls`) that are off
by default, and no built-in MCP, subagents, permission prompts, plan mode,
todos, or web search (`README.md`, `docs/usage.md`). Everything here re-adds a
piece of that, chosen for one reason: this machine runs pi against **local
models** with 64K–96K context windows, not a cloud model, so the harness has to
carry weight the model cannot.

For a single, dated, cross-repo reconciliation of what's actually been
validated vs. still open (extension-by-extension, with real trial counts),
see `../pi-harness-validation-status.md`. This file below documents what
each extension does; that one documents what's actually been proven about
whether it works.

Current-machine state (audited 2026-08-03): Pi 0.83.0 has one resident
ThinkingCap Qwen3.6-27B route. `cross-model-review.ts` therefore disables
itself unless a distinct `AI_REVIEW_BASE_URL` and `AI_REVIEW_MODEL` are set;
same-primary review requires `AI_REVIEW_ALLOW_SELF=1` and is labeled
`blind-self-review`, never cross-model. The write/edit guard resolves symlinks,
and an external-effect guard blocks deploy, publish, infrastructure, production
database, Kafka-admin, and Kubernetes mutations without an explicit category
opt-in. Whole-process confinement remains the job of `containment/`; Docker is
not present on this host, so that profile has not completed its live escape
matrix. DayTrix-specific skills are absent from global runtime discovery and
are added only after the exact project remote is verified.

The committed `package.json`, pinned Pi API dependency, and `tests/` directory
provide repeatable type and behavior checks. `quality-gate.ts` binds passing
evidence to the current diff hash, rejects truncated or shell-masked results,
runs the repository's canonical broad check directly at settlement, and caps
automatic corrective follow-ups at three. `stack-router.ts` selects only
portable Go, Python, Flutter, TypeScript/JavaScript, PostgreSQL, Kafka,
Temporal, and GCP guidance from repository evidence. Versioned trace entries
support later evaluation without recording prompts, source, secrets, or full
command output.

## Launching pi

From any directory, in a normal terminal:

```
pi                     # interactive session
pi -p "<prompt>"        # non-interactive: process one prompt and exit
pi -p "<prompt>" --mode json   # non-interactive, structured event stream
```

No flags are required for day-to-day use — `~/.pi/agent/settings.json`
(see "Settings this machine expects" below) already sets
`defaultProvider: "ai-stack-local"` and `defaultModel` to the local 27B
slot, and `~/.pi/agent/extensions/` (symlinked from this repo's
`extensions/`) is loaded unconditionally on every launch, interactive or
`-p`. You only need explicit `--provider`/`--model`/`-e`/`--no-extensions`
flags when deliberately overriding these defaults — e.g. the
`scratch-phase-validate/` batch-retest scripts do, to pin an exact
extension set per run.

The one thing this depends on: **`AI_STACK_HOST` must already be exported
in your shell** (it is, via `~/.zshrc`) before `pi` starts, since both the
`ai-stack-local` and `cross-model-review.ts`'s reviewer call read it once from
`process.env` at extension-registration
time. A shell that doesn't source `~/.zshrc` (cron, launchd, a script's own
subshell) silently falls back to `127.0.0.1`, where nothing listens on this
Mac — see the `AI_STACK_HOST` note below for the fix if that happens.
**Verified live, 2026-07-26**: launching `pi` this way (plain terminal,
zero extra flags) against a real task showed an actual TCP connection to
the LAN box's current address and a correct `cross-model-review.ts`
round-trip against it — see `../pi-harness-validation-status.md`'s
"terminal launch" verification for the transcript.

## What's installed

| Path | Becomes | What |
|---|---|---|
| `AGENTS.md` | `~/.pi/agent/AGENTS.md` | Global instructions, read on every session |
| `skills/<name>/` | `~/.pi/agent/skills/<name>` | Same skills as Claude/Codex, pi-flavored |
| `prompts/<name>.md` | `~/.pi/agent/prompts/<name>.md` | `/<name>` slash commands |
| `extensions/*.ts`, `extensions/*/` | `~/.pi/agent/extensions/…` | Loaded unconditionally at startup |
| `disabled-extensions/*.ts` | *(not linked)* | Built, code-reviewed, kept for reference — not loaded by default; see below |

`continuation-nudge.ts` and `co-change-suggest.ts` also remain beside their
tests under `extensions/`, but the installer explicitly removes/skips their
runtime links. Their existing evidence does not meet the hardening plan's
paired-adoption threshold. `cross-model-review.ts` is linked so it can report
its resolved identity, but remains internally disabled unless truthful reviewer
configuration is supplied.

### Extensions

Written here:

- **`ai-stack-local.ts`** — registers ai-stack's resident provider:
  `ai-stack-local` (:8080, ThinkingCap-Qwen3.6-27B-MLX-8bit, "code"). It
  follows `AI_STACK_HOST`.
- **`karpathy-guardrail.ts`** — appends the karpathy-guidelines rules to the
  system prompt on every turn, since pi surfaces skills by relevance-matching
  rather than unconditionally.
- **`full-stack-dev.ts`** — activates Pi's complete standard development
  toolset: `read`, `edit`, `write`, `find`, `grep`, and `bash` (Pi's terminal
  and command/test runner). It applies to backend-only as well as full-stack
  repositories: the name is historical, while the workflow itself is generic.
  It requires acceptance criteria, autonomous routine decisions, small
  implementation chunks, focused verification after each chunk, a persistent
  edit/test/debug loop until the check passes or an evidenced external blocker
  is reached, and a final broad verification plus diff review.
- **`rtk-rewrite.ts`** — port of `claude/hooks/rtk-rewrite.sh`. Routes bash
  commands through `rtk rewrite` for 60-90% less output. Worth more here than
  under Claude Code: on the current 96K window, output reduction is turns.
- **`format-on-edit.ts`** — port of `claude/hooks/format-on-edit.sh`. gofmt/dart
  format after every write/edit. Local models produce unformatted code far more
  often than cloud models, and `make verify` fails on it.
- **`searxng-search.ts`** — a `web_search` tool backed by ai-stack's SearXNG
  (:8888). Chosen over the published `pi-web-access` package, which requires a
  cloud search API key this machine has no reason to buy. Registered as a
  *tool* rather than as a skill (Claude Code's `local-search` skill does the
  same lookup by shelling out to a script) because a 27B model reliably
  calls a tool in front of it and unreliably remembers to shell out via a
  skill -- the pi-side copy of that skill was redundant with this tool and
  has been removed; the Claude Code copy stays, since Claude Code has no
  competing built-in tool for this.
- **`continuation-nudge.ts`** — **default-disabled as of 2026-08-03 pending
  paired evaluation.** Phase 1 of
  `ai-stack/local-quality-next-steps-plan.md`: targets the plan-then-abandon
  failure mode (model announces an edit in prose, no tool call, turn ends with
  `stopReason: "stop"`) seen in the `local-model-bench` pi-local run. On a
  matching turn, with no passing verification command for the current ask,
  injects a follow-up nudge instead of letting the turn end. Retries are
  bounded per agent run. **Verdict as of 2026-07-24 (see
  `ai-stack/local-quality-next-steps-status.md`): not adopted, but kept
  loaded** — across ~50 real trials the trigger condition never fired outside
  deterministic mocked tests. **Updated 2026-07-25**, after a real occurrence
  in the `personal-assistant` daily-briefing-screen dispatch: the model
  stopped with `stopReason: "stop"`, no tool call, and *zero text content* —
  not forward-looking prose. The original trigger required non-empty text
  matching a forward-looking pattern and so, correctly per its own logic,
  never fired on this case; the failure mode observed for real was narrower
  and more silent than the one the extension was built for. Widened to also
  fire on a stop-with-empty-content turn, and fixed a related bug found in
  the same review: `verificationRan` scanned the whole persisted
  `--continue` branch, so once *any* pass in a multi-dispatch session ran a
  verification command, the nudge was permanently disarmed for every later
  pass too — now scoped to the current invocation only. See
  `pi-real-task-report-daily-briefing-screen.md` for the full transcript
  analysis. Still a true no-op unless it fires. **Fixed 2026-07-26**, after
  a real occurrence in `local-model-bench`'s `go/notes-api` run: the model
  ran `go test` early for its original implementation, `cross-model-review.ts`
  then flagged a real routing bug, and the model correctly diagnosed the fix
  in prose and abandoned it without a tool call — but the nudge stayed
  silent, because `verificationRan` still scanned the *whole current
  invocation*, and that early, unrelated `go test` pass permanently disarmed
  it for the rest of the session even though the abandoned fix itself was
  never verified. Now scoped to since the most recent ask (original task,
  steering message, or an injected followUp like a review flag) instead of
  since the invocation start — each new ask gets its own verification
  requirement. See `local-model-bench/SPEC.md`'s 2026-07-26 report for the
  full transcript trace. **Updated 2026-08-02** after two Pi calendar-app
  runs stopped immediately after `flutter analyze` failed: verification is
  now tracked by outcome, so a failing check triggers a corrective follow-up
  instead of disarming the nudge. Up to three nudges are allowed per run to
  support a bounded test/debug loop without risking infinite retries. A
  verification command feeding a shell pipeline is treated as inconclusive
  unless `pipefail` is set, preventing tools such as `head` or `grep` from
  masking a failing test exit without misclassifying unrelated pipe characters.
- **`co-change-suggest.ts`** — **default-disabled as of 2026-08-03 because its
  single retrospective case does not meet the paired-adoption threshold.**
  Phase 3 of the same plan: ports
  `ai-stack/scripts/suggest_read_files.py`'s co-change ranking (git
  co-change count² ÷ total historical touch count) into pi. On the first
  prompt that actually has grep-matchable identifiers (a greeting first
  doesn't burn the attempt), on repos with ≥20 commits of history, ranks
  files that historically co-change with those identifiers and appends a
  suggested-reading list to the system prompt, minus the identifier-matched
  seed files themselves. No-op by construction on fixture-sized repos with no
  history to mine; git subprocess cost capped and `ctx.signal`/timeouts wired
  through. **Verdict (2026-07-24, see `ai-stack/local-quality-next-steps-status.md`):
  adopted.** Re-ran the plan's retrospective kill criterion for real against
  `personal-assistant`'s actual mood-streak dispatch (782 commits of real
  history, checked out at the exact pre-dispatch commit): found and fixed a
  real seed-selection bug in the process (per-identifier grep counting was
  missing, so seed selection was effectively "first 5 files in git's listing
  order" with no relevance weighting). After the fix, the target file
  (`contract_matrix_phase2_test.go`) surfaces at rank #1 given a spec using
  the real identifiers from that dispatch's diff — beating the plan's own
  claimed #2 for the original script. Needs identifier-rich prompts to work
  (a purely generic paraphrase correctly surfaces nothing, since there's no
  identifier signal for the method to use) — that's an inherent scoping
  limit of identifier-grep-based discovery, not a bug.
- **`git-safety.ts`** — added 2026-07-25. Blocks destructive git commands run
  via the `bash` tool (`reset --hard`, `push --force` without
  `--force-with-lease`, `clean -f`, `branch -D`, `checkout`/`restore -- .`),
  mirroring the confirm-before-destructive-action norm this user's Claude
  Code setup already follows. Each block names a safe alternative rather
  than a bare refusal, since the `flutter gen-l10n` rediscovery flail in the
  daily-briefing-screen dispatch (~8 failed bash commands in a 5-minute
  span) is direct evidence this model thrashes when blocked with no
  alternative given. Added after `pi`, in `-p` mode, ran `git reset --hard
  main` unprompted to resolve a self-inflicted "branch already exists"
  conflict, discarding a prior commit; `git-checkpoint.ts` could have
  recovered it but only via `/fork`, which is interactive-UI-only and does
  nothing in `-p` mode. Verified live: reproduced the exact command against
  a scratch repo, confirmed it's blocked and the repo's commits are
  untouched. See `pi-real-task-report-daily-briefing-screen.md`.
- **`cross-model-review.ts`** — Phase 2 of
  `ai-stack/local-quality-next-steps-plan.md`: the previously-scoped-but-
  never-built blind-reviewer pass (diffs against session base SHA, sends
  diff + spec to `ai-stack-local` for a second opinion, feeds back a
  flagged issue). **Current state (2026-08-03): disabled unless explicitly and
  truthfully configured.** An independent endpoint/model is labeled
  `independent-review`; the primary route/model is rejected unless
  `AI_REVIEW_ALLOW_SELF=1`, in which case it is labeled `blind-self-review`.
  The successful evidence below belongs to the former Gemma `:8081`
  configuration and must not be used to claim that today's resident model is
  an independent reviewer.

  **Historical evidence:** **Verdict (2026-07-24, first reviewer): not adopted** — the
  one real test run (a known, spec-violating bug the hidden
  test suite catches) came back negative, reviewer returned
  `NO_ISSUES_FOUND`. Moved to `disabled-extensions/`. **Re-verdict
  (2026-07-25, reviewer switched to gemma-4-31B-it-OptiQ-4bit on :8081):
  adopted, moved back to
  `extensions/`.** A live smoke run against the `lru-cache` task (no seeded
  bug — the model's own organically-written solution, tests green) had the
  reviewer catch a real logic bug the test suite missed: the `order` slice
  grows unbounded on repeated `Put`s to existing keys, unpruned during
  updates. This is a stronger result than the plan's own kill criterion
  (an unseeded catch, not a seeded one) but still n=1 — treat as a strong
  signal, not a settled result, until repeated across a few more runs.
  Directly timed the review call against this diff (953 prompt tokens) at
  12.9s, ~20% of `REVIEW_TIMEOUT_MS` (60s) — no need to raise the timeout
  for tasks this size on the then-current tuned qwen3.6+gemma4 pair. Separately,
  this same smoke run got killed by `run_one.sh`'s 180s watchdog
  (`PI_EXIT=143`) after the review's fix-it turn extended the session — a
  real instance of the interaction Fable's review flagged (§2), though it's
  a property of the validation harness's fixed timeout, not of real
  interactive `pi` usage, which has no such cap.
  **Bounded-loop rewrite (2026-07-25, `ai-stack/cross-model-review-bounded-loop-plan.md`):**
  the prior one-shot boolean (`reviewedThisRun`) is replaced with a
  `reviewCount`/`lastReviewedDiff`/`done` state machine bounded at
  `MAX_REVIEW_ROUNDS = 3`, so a flagged issue's *fix* gets re-reviewed
  instead of the loop ending after one nudge. `runReview` now returns a
  typed `ReviewResult` (`unchanged | no-diff | no-spec | transient | clean
  | flagged`) instead of a bare boolean, and the clean-verdict marker match
  tolerates markdown wrapping (backticks/emphasis stripped from the string
  *edges* only) instead of requiring byte-exact equality — edge-only, not a
  global strip, since a blanket strip corrupts `NO_ISSUES_FOUND`'s own
  underscores (caught by the unit harness below before it ever shipped).
  Validated:
  - **Unit-level** (`/tmp/pi-mock-check`-style throwaway mocked-`ExtensionAPI`
    harness, not committed, same pattern as the 2026-07-25 real-bug check
    below): 14/14 assertions pass, covering cap enforcement (round 3 stops
    the loop with explicit "no further automatic review" wording),
    clean-short-circuit (a clean round 1 or 2 stops immediately, round 3
    never fires), unchanged-diff skip (an identical diff on a rerun consumes
    no round and resends nothing), tolerant marker matching across five
    realistic wrapped forms, and the adversarial case Fable's plan review
    called out (a genuine finding phrased "No issues found in the core
    logic, but ..." resolves to `flagged`, not `clean`). This harness caught
    a real bug in the first implementation: the marker normalizer stripped
    `` ` * _ `` globally, which corrupted `NO_ISSUES_FOUND`'s own
    underscores and made every clean verdict register as flagged — fixed to
    strip only at the string's edges before this shipped.
  - **Regression check against the original disablement case**: rebuilt the
    seeded bug that caused the 2026-07-24 disablement (`Get` fixed for
    recency, `Put` on an *existing* key left un-touched — the exact class
    the spec calls out and the hidden test suite catches) and ran it
    through the extension's real, unmodified `runReview` logic against the
    live `:8081` endpoint. **No regression — an improvement**: the current
    gemma4 reviewer correctly flags it (`` `Put` is not updated to call
    `touch`... eviction logic remains broken for insertions and updates
    ``), unlike the original reviewer that missed this exact class
    on 2026-07-24.
  - **Live smoke tests**, `lru-cache` task, real `pi` + Qwen3.6-27B primary
    + gemma4 reviewer via `scratch-phase-validate/run_one_long.sh` (a
    validation-only copy with the watchdog raised to 600s, kept separate
    from `run_one.sh` so the real 180s number stays measurable — see cost
    check below). 3 sequential runs (LAN inference is single-request-at-a-
    time, so all runs — including the cost check — ran strictly one after
    another, never concurrently): run 1 — round 1 flagged, model rebutted it
    as a false positive (correctly, on inspection) and made no further edit;
    a repeat `go build` on the identical diff correctly hit the `unchanged`
    outcome and did not consume round 2, `PI_EXIT=0` at 156s. Run 2 — round
    1 flagged a real edge case; the model investigated via an ad-hoc
    `go run` scratch program instead of rerunning a
    `VERIFICATION_COMMAND_PATTERNS` match, so round 2 correctly never
    triggered (trigger condition is unchanged by this plan, as designed),
    `PI_EXIT=0` at 220s. Run 3 — round 1 flagged a real bug (`moveToBack`
    silently dropped new keys from the order slice), the model fixed it,
    round 2 fired on the updated diff and flagged a second issue that the
    model rebutted as a false positive, session ended naturally with no
    round 3, `PI_EXIT=0` at 335s, tests green throughout. Net: 3/3 real
    end-to-end runs exercised round 1 correctly; 1/3 exercised a genuine
    round-1→round-2 progression on a real fix. The cap-hit (round 3) and
    clean-short-circuit branches were not observed live in these 3 runs but
    are deterministically exercised by the unit harness above using the
    same compiled `runReview` logic, which the plan's own validation
    section treats as an acceptable substitute for guaranteed live
    coverage.
  - **Cost check on a realistic diff size**: the prior 12.9s figure was only
    ever measured on the 953-token `lru-cache` fixture. Timed the same
    unmodified `runReview` HTTP call against a real multi-file feature diff
    from `personal-assistant` (`186282ef`, ~40KB / ~10.5k prompt tokens):
    **73.5s**, which exceeds the prior `REVIEW_TIMEOUT_MS` (60s) — at that
    size the old timeout would abort the request and silently skip the
    review (a `transient` outcome, not a crash, but zero protection
    delivered on exactly the diffs large enough to most need it). Raised
    `REVIEW_TIMEOUT_MS` to 120s to leave headroom above the measured 73.5s.
    Separately, on the small `lru-cache` fixture, `run_one.sh`'s real 180s
    watchdog still kills a run mid-fix-it-turn after just one flagged round
    (`PI_EXIT=143`, reproduced again during this validation) — a bounded
    3-round loop makes that interaction *more* likely to recur in the
    existing validation batches, not less; `run_one.sh` itself was
    deliberately left unmodified (only a separate `run_one_long.sh` copy
    was used for this validation) since raising the production watchdog is
    a harness-scope decision beyond this plan, not something to change as a
    side effect of extending the extension.
  **Last-line marker matching (2026-07-26,
  `ai-stack/cross-model-review-marker-lastline-fix-plan.md`):** a live run
  showed the clean-verdict check's edge-stripped *whole-reply* equality
  scoring `flagged` on a reviewer reply that reasoned correctly through a bug
  hypothesis at length (~1500 characters) before ending with `NO_ISSUES_FOUND`
  on its own line — a false positive that burns a bounded-loop round on a
  genuinely clean diff. The check now runs `normalizeForMarkerMatch` against
  `extractLastNonEmptyLine(reviewText)` (per-line trim, drop trailing
  code-fence-only lines, take the last non-empty line) instead of the full
  reply, so a verbose-then-terse reply matches while a single-line near-miss
  like "No issues found in the core logic, but ..." still doesn't. This is a
  trade, not a strict improvement: a genuine multi-paragraph finding whose
  literal last line happens to equal the marker would now also resolve
  `clean` — an accepted, tracked residual risk (the same instruction-
  non-compliance failure mode as the bug being fixed, just on the other side
  of the reply), mitigated by logging the full raw reply via `pi.appendEntry`
  (session-only, not in LLM context) on every `clean` verdict over 200
  characters, so a recurrence is auditable from session logs. Validated:
  8/8 mocked-`ExtensionAPI` assertions, including the idx13 verbose-clean
  case, the original single-line adversarial regression, a new multi-line
  adversarial case (finding ending in a bold non-marker line), a fenced terse
  verdict, and two canaries — formatting variants (`NO_ISSUES_FOUND.`, `-
  NO_ISSUES_FOUND`) that intentionally still don't match, and the residual
  risk itself pinned down as a currently-passing test rather than prose-only.

Vendored from pi's `examples/extensions/`, with changes noted in each file:

- **`protected-paths.ts`** — blocks Pi `write`/`edit` calls to
  sensitive/generated files and paths outside the working directory. The guard
  is not a sandbox: it does not cover shell redirection or commands run through
  `bash`, and it does not resolve symlink escapes. The `write`/`edit` catch is not
  theoretical: asked to write `main.go` in a temp dir, Qwen3.6-27B emitted an
  absolute path to an unrelated directory and pi's write tool obeyed. With the
  guard, the model gets a corrective message and retries correctly.
- **`plan-mode/`** — `/plan` or Ctrl+Alt+P for read-only exploration using
  PI's native inspection tools, with `/plan-todos` for the current plan steps.
- **`todo.ts`** — task list tool with persistent state.
- **`git-checkpoint.ts`** — per-turn checkpoints (base SHA + stash + loose
  blobs for untracked files, all non-destructive) so `/fork` can restore
  code to that point, including reverting a clean-start edit and preserving
  pre-existing uncommitted work — see the file's own header comment for why
  a plain `git stash create`/`apply` pair silently didn't work for either
  case.
- **`notify.ts`** — terminal notification when the agent finishes. Vendored
  change: gated on `hasUI`, since in `-p` mode the raw OSC escape would
  otherwise corrupt captured stdout.

### Prompt templates

`/review`, `/before-done`, `/wire`, `/l10n` — thin, explicit wrappers over the
matching skills. They spell out each step and demand pasted command output,
because a small model that is told "run the gate" will report success without
running anything.

## Dispatching pi for a code change

Pi advertises skill names and descriptions in the system prompt, then relies on
the model to read the matching `SKILL.md`. That relevance match is not
deterministic. Current Pi also exposes every skill as `/skill:<name>`, which is
the deterministic way to load it in interactive or `-p` mode. Prefer the slash
form for workflows whose exact instructions matter; naming a skill in ordinary
prose is only a weaker fallback.

Template:

```
/skill:<skill-name> <task>

Spec: <path, if one exists — feature-dev wants this>

Success condition: run `make verify` and fix any failures until it exits 0.
Do not stop, report done, or summarize until make verify has actually been
run and passed — a description of what you would do is not the same as
doing it.

<any task-specific constraints>

Do not commit or push.
```

Picking the skill name:

| Skill | When to name it |
|---|---|
| `feature-dev` | Net-new, multi-file, user-visible feature that'll need a PR — full spec→branch→implement→l10n→verify flow |
| `backend-dev` | Go-only change (handler/service/repository/middleware) |
| `frontend-dev` | Flutter-only change (widget/bloc/notifier/screen) |
| `wiring-verify` | After adding something with a documented N-step checklist (feature flags, routes) |
| `docs-verify` | Doc-only edit (URL, terminology rename) |
| `pr-remediate` | Addressing review comments on an existing PR |
| `self-review` | Review a PR under the narsimha-j account (see note below) |

**`self-review` must use its slash command.** Its frontmatter sets
`disable-model-invocation: true`, so the skill is hidden from the system prompt
and cannot load through relevance matching or ordinary prose. This is
deliberate, not a gap: the skill
posts public PR comments/approvals and switches the machine's active `gh`
account, so it must only run on an explicit, unambiguous trigger, never as
an inferred side effect of some other task. Invoke it with
`/skill:self-review` (works in `-p`
mode too, e.g. `pi -p "/skill:self-review review PR #214"` --
`enableSkillCommands` defaults to `true` and is unset/default on this
machine; verified live that `/skill:self-review` loads the real skill
content, not a hallucinated summary of it).

Constraints worth stating explicitly, given what actually broke in the one
real dispatch run so far:

- **If the branch might already exist**, say so:
  `"the branch <name> already exists; switch to it, do not create or reset
  it."` This is what triggered the unprompted `git reset --hard` that
  `git-safety.ts` now exists to block — the block still costs a wasted turn
  working out the alternative, so stating it up front avoids the detour.
- **If reusing an existing l10n key name**:
  `"grep the .arb files for this key name first -- don't assume it's
  unused."` `make lint` now catches a resulting duplicate (see
  `personal-assistant` PR #214), but catching it before pi writes broken
  translations is cheaper than catching it after.
- **Always end with the exact verification command and "stop only when it
  exits 0"** — not "when it passes," which is vaguer and, per the
  transcript, is exactly the instruction it silently didn't follow once.

One habit that lives outside the prompt: whatever pi reports at the end is a
claim, not a fact. Re-run the verification command yourself before trusting
it — that's what caught both the pass-1 silent stop and the l10n bug pass-2
missed in the daily-briefing-screen dispatch. No prompt phrasing replaces
that; it's a review step you still own.

## Settings this machine expects

`~/.pi/agent/settings.json` is **not** symlinked from this repo: pi rewrites it
itself (`/settings`, package installs, `lastChangelogVersion`), so a symlink
would mean pi editing tracked files behind your back. Set these by hand:

```json
{
  "defaultProvider": "ai-stack-local",
  "defaultModel": "/Users/kanna/code/ai-stack/models/ThinkingCap-Qwen3.6-27B-MLX-8bit",
  "defaultThinkingLevel": "off",
  "enabledModels": ["ThinkingCap-Qwen3.6-27B-MLX-8bit"],
  "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 24000 }
}
```

- `defaultThinkingLevel: "off"` — the model reports `reasoning: false`.
- `enabledModels` registers the resident code model for Ctrl+P selection.
  Glob patterns (`*Qwen3.6*`) do **not** match these models; pi matches the
  path-style IDs by substring, so list the basenames exactly as above.
- Compaction reserve is set to 16384 (= the models' `maxTokens`) to leave
  more of the available context for actual work.

`AI_STACK_HOST` must be exported (it is, in `~/.zshrc`, currently
`192.168.1.233` — the LAN box's address has changed before via DHCP
reassignment, so treat this as "whatever `~/.zshrc` currently says," not a
fixed IP) — unset, every provider points at `127.0.0.1:8080`, where nothing
is listening on this Mac. Confirmed live, 2026-07-26: a plain `pi` launch
from an interactive shell opened a real connection to the box at the
address `~/.zshrc` exports, with no flags needed.

## Deliberately not installed

- **`pi-mcp-adapter`** — there are no MCP servers configured on this machine
  (`~/.claude.json` has none, globally or per-project). Install it when there
  is something to adapt, not before.
- **`pi-subagents`** — subagent fan-out multiplies context use, and 96K is
  already the binding constraint.
- **Aider-style delegation** — see `AGENTS.md`; benchmarked and rejected.
