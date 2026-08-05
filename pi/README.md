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
Confirmed live: launching `pi` this way (plain terminal, zero extra flags)
opens an actual TCP connection to the configured host — see
`../pi-harness-history.md` for the original verification transcript.

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
- **`continuation-nudge.ts`** — **default-disabled, pending paired
  evaluation.** Phase 1 of `ai-stack/local-quality-next-steps-plan.md`:
  targets the plan-then-abandon failure mode (model announces an edit in
  prose, no tool call, turn ends with `stopReason: "stop"`, or stops with
  zero text content) by injecting a follow-up nudge instead of letting the
  turn end, when no passing verification command covers the current ask.
  Verification is tracked by outcome, so a failing check triggers a
  corrective follow-up instead of disarming the nudge; up to three nudges
  are allowed per run. A verification command feeding a shell pipeline is
  treated as inconclusive unless `pipefail` is set, so tools like `head` or
  `grep` can't mask a failing test exit. Deterministic branch tests pass;
  the widened empty-content-stop trigger has zero real-trial field evidence
  (see `../pi-harness-history.md` for the trigger's revision history and
  live-trial counts).
- **`co-change-suggest.ts`** — **default-disabled**; its one retrospective
  adoption case does not meet the paired-adoption threshold. Phase 3 of the
  same plan: ports `ai-stack/scripts/suggest_read_files.py`'s co-change
  ranking (git co-change count² ÷ total historical touch count) into pi. On
  the first prompt that actually has grep-matchable identifiers, on repos
  with ≥20 commits of history, ranks files that historically co-change with
  those identifiers and appends a suggested-reading list to the system
  prompt, minus the identifier-matched seed files themselves. No-op by
  construction on fixture-sized repos with no history to mine; git
  subprocess cost capped and `ctx.signal`/timeouts wired through. Needs
  identifier-rich prompts to work (a purely generic paraphrase correctly
  surfaces nothing) — an inherent scoping limit of identifier-grep-based
  discovery, not a bug. Live (non-retrospective) validation not yet run —
  see `../pi-harness-history.md` for the retrospective evidence that did
  land.
- **`git-safety.ts`** — adopted. Blocks destructive git commands run via the
  `bash` tool (`reset --hard`, `push --force` without `--force-with-lease`,
  `clean -f`, `branch -D`, `checkout`/`restore -- .`), mirroring the
  confirm-before-destructive-action norm this user's Claude Code setup
  already follows. Each block names a safe alternative rather than a bare
  refusal, since this model thrashes when blocked with no alternative
  given. Built after `pi`, in `-p` mode, ran `git reset --hard main`
  unprompted to resolve a self-inflicted conflict, discarding a prior
  commit; verified live by reproducing the exact command against a scratch
  repo (blocked, repo untouched) — see `../pi-harness-history.md` for the
  full incident writeup.
- **`cross-model-review.ts`** — Phase 2 of
  `ai-stack/local-quality-next-steps-plan.md`: the previously-scoped-but-
  never-built blind-reviewer pass (diffs against session base SHA, sends
  diff + spec to a second model for a second opinion, feeds back a flagged
  issue). An independent endpoint/model is labeled `independent-review`;
  the primary route/model is rejected unless `AI_REVIEW_ALLOW_SELF=1`, in
  which case it is labeled `blind-self-review`. `AI_REVIEW_BASE_URL`/
  `AI_REVIEW_MODEL` are currently set in `~/.zshrc` to an independently
  trained Gemma reviewer on `:8082`, distinct from the `:8080` Qwen
  primary, so this resolves to genuine `independent-review`. The
  bounded-loop design (3-round cap, outcome-typed `runReview`,
  last-non-empty-line marker matching) is validated by 8 deterministic
  tests (`pi/tests/cross-model-review.test.ts`). A 2026-08-04 investigation
  against a third candidate reviewer route found and fixed two real bugs
  that apply regardless of which route is configured: the `tool_result`
  handler's stale-context catch was unguarded and could crash the whole
  `pi` process the first time a review actually triggered on a real task,
  and the review itself was fire-and-forget — `pi -p` routinely exited
  before a round (60-120s round trip) had time to finish, so it silently
  never got a chance to flag anything. `agent_settled` now awaits any
  in-flight review, bounded by the existing `REVIEW_TIMEOUT_MS`. Full
  adoption history, live-run counts, and both bugs' investigation
  transcripts are in `../pi-harness-history.md`.
- **`new-project-scaffold.ts`** — **new, no live-trial evidence yet.**
  `todo-app-hardening-plan.md` fix 1 plus items D/F/G: a `before_agent_start`
  nudge, not an autonomous write, since an extension running `git init` on
  every launch risks doing so inside a directory meant to be part of a
  parent repo. When no repo exists yet, tells the model to `git init`, seed
  a `.gitignore`, and make an initial commit -- the commit matters as much
  as the `git init`, since an unborn `HEAD` leaves `quality-gate.ts` and
  `cross-model-review.ts` inert the same way a missing repo does. Bundles
  two more nudges gated on the same "no repo yet" signal: up-front layered
  Go structure (`cmd/`, `internal/domain/{errors.go,ports.go}`,
  `internal/handler`) instead of a size threshold that would fire
  mid-project and contradict this harness's own no-speculative-refactor
  rule, and a minimal README once a repo doesn't have one.
- **`makefile-scaffold-nudge.ts`** — **new; one live trial, which found and
  fixed a real bug in this file (see "Hook semantics for extension
  authors" below).** `todo-app-hardening-plan.md` fix 4: when no Makefile
  and no documented verification command exist, hands the model
  `verification.ts`'s actual resolved command and asks it to wire
  `test`/`lint`/`verify` Makefile targets to it -- prompt-only rather than
  an autonomous write, so a generated `verify` that silently missed one
  component of a multi-language repo can't shrink coverage versus the
  nested scan without the model seeing the exact command it's supposed to
  preserve. The original design only ever checked this from
  `before_agent_start`, which fires once before any files exist -- silently
  unreachable for a genuinely new project, the exact scenario this fix
  targets. Now arms on `tool_result` when a manifest file appears and
  nudges once at the next `turn_end` if still eligible.
- **`artifact-guard.ts`** — **new; one live trial (design revised
  afterward, not yet re-tested).** Fix 2: checks for untracked, staged, or
  recently-committed files over 1MB or bearing an ELF/Mach-O magic number,
  targeting the todo-app finding directly (a 13MB compiled binary left in
  the working tree). Also a performance fix: `verification.ts`'s
  `hashUntrackedPath` currently sha256-streams every untracked file,
  including such a binary, on every settle event. Primary detection moved
  to `tool_result` on build-shaped bash commands (`go build`, `-o `,
  `cargo build`, ...), checking in-band the moment the artifact is
  produced; `agent_settled` (now also checking paths changed since the
  session's `baseSha`, not just working-tree status) is a backstop, not
  the primary path -- see below for why.
- **`error-leak-guard.ts`** — **new; one live trial (design revised
  afterward, not yet re-tested).** The deterministic slice of plan item E:
  rather than trying to gate "is the architecture layered" (no observer
  exists for that), scans for `http.Error(w, err.Error(), ...)` -- a raw
  error string written straight into an HTTP response, leaking internal
  detail (SQL errors, file paths) to API clients instead of mapping to a
  stable domain error. Primary detection moved to `tool_result` on
  `write`/`edit`, scanning the file the instant it changes, independent of
  git state entirely; `agent_settled` is a backstop.

All four are unit-tested (`pi/tests/*.test.ts`). The first live trial (a
`pi -p` run building a small Go+SQLite backend from an empty directory)
found that the original agent_settled/before_agent_start-only designs of
three of them were structurally blind to the exact scenarios they were
built for -- see "Hook semantics for extension authors" below for the
root cause and the fix. Per this file's own validation convention, none of
the four have accumulated enough live-trial evidence for the "adopted"
language used elsewhere in this file; see
`../pi-harness-validation-status.md` for the paired-adoption tracking
these would need.

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

### Hook semantics for extension authors

A live end-to-end test (`pi -p` against a fresh empty directory,
non-interactive mode) caught two extensions — `error-leak-guard.ts` and
`artifact-guard.ts` — making the same wrong assumption about when
`agent_settled` fires, and `makefile-scaffold-nudge.ts` assuming
`before_agent_start`'s one-shot precondition check would somehow still
apply once the project it was checking for came into existence. Both
mistakes trace to the same underlying fact: which hook fires *once* versus
*repeatedly*, and *when* relative to the model's own actions, is not
obvious from the hook names alone. Confirmed from the `--mode json` event
log of that test, not assumed:

| Hook | Fires | Notes |
|---|---|---|
| `before_agent_start` | Once, before the first tool call | The only hook that can amend the system prompt (`{systemPrompt}`). Anything it checks reflects the *initial* state of the working directory — a brand-new project has no manifest, no Makefile, nothing yet. |
| `agent_start` | Once, right after | Cannot amend the prompt. Used to capture a session baseline once (e.g. `baseSha` via `git rev-parse HEAD`, as `quality-gate.ts`, `artifact-guard.ts`, and `error-leak-guard.ts` all now do). |
| `tool_call` / `tool_result` | Once per tool invocation, throughout the session | The only hooks with per-action granularity. `tool_result` can append/replace the tool's own result content in-band (`{content: [...]}`) — no new turn, no `sendUserMessage`, no nudge budget consumed. This is the cheapest and most immediate way to catch something the instant it's written, independent of git state entirely. |
| `turn_end` | Once per assistant turn | The actual "periodic sweep" hook. Cannot amend anything directly — a nudge from here needs `pi.sendUserMessage(..., {deliverAs: "followUp"})`, which queues a new turn. Fire nudges from here at a turn *boundary*, not mid-turn from `tool_result`, so a nudge reads as normal feedback rather than a non-sequitur interrupting an in-progress edit. |
| `agent_settled` | **Once per process in `-p` (non-interactive) mode**, and — confirmed by event ordering in the test log — *after* `agent_end`, i.e. after the model has already finished everything, including its own `git commit`. Do not assume this behaves like a per-turn check; in `-p` mode it is a terminal, single, late checkpoint. (Interactive mode has more agent loops per process, so a check here fires more often there — but the semantics per firing are identical; nothing about `agent_settled` itself changes between modes.) | Anything gated here that inspects git state (a diff, `git status`) will not see something the model already committed. Use it as a last-resort backstop for whatever a `tool_result`/`turn_end` hook didn't catch, never as the primary detection point for something you expect to happen mid-session. |

Concretely: `error-leak-guard.ts` and `artifact-guard.ts` now do their real
work in `tool_result` (scan a file the instant it's written; scan for a
build artifact the instant a build command runs) and keep their original
`agent_settled` diff/status scan only as a backstop for whatever bypassed
the tools they hook (e.g. content from a bash heredoc). Both also capture
`baseSha` at `agent_start` instead of always diffing from an unresolved
base, so the backstop itself is less bypassable too.
`makefile-scaffold-nudge.ts` still nudges immediately in `before_agent_start`
for an already-populated repo, but for a genuinely empty one it now arms on
`tool_result` when a manifest file (`go.mod`, `package.json`,
`pubspec.yaml`, `Cargo.toml`) gets written and nudges once at the next
`turn_end` — the precondition getting re-checked at all, instead of only
once before anything existed, was the fix.

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

`AI_STACK_HOST` must be exported (it is, in `~/.zshrc`, set to
`kannasmacstudio.lan` — the LAN box's raw IP has changed on every reboot via
DHCP reassignment, so `~/.zshrc` points at this stable router-assigned
hostname instead) — unset, every provider points at `127.0.0.1:8080`, where
nothing is listening on this Mac. Confirmed live: a plain `pi` launch from
an interactive shell opens a real connection to the address `~/.zshrc`
exports, with no flags needed.

## Deliberately not installed

- **`pi-mcp-adapter`** — there are no MCP servers configured on this machine
  (`~/.claude.json` has none, globally or per-project). Install it when there
  is something to adapt, not before.
- **`pi-subagents`** — subagent fan-out multiplies context use, and 96K is
  already the binding constraint.
- **Aider-style delegation** — see `AGENTS.md`; benchmarked and rejected.
