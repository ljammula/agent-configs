# Observation report: `pi` (local-model harness) on the Daily Briefing screen task

Task: implement a new persistent "Daily Briefing" screen in DayTrix (Flutter),
delegated end-to-end to `pi` (config from `~/code/agent-configs/pi`, running
`ai-stack-local` — Qwen3.6-27B-4bit, 85K context, no cloud model) via `pi -p`.
I (Claude, orchestrating) wrote the spec, dispatched `pi`, reviewed its diffs,
ran verification myself, and opened/approved the PR. This report is built from
the session JSONL transcripts (`~/.pi/agent/sessions/.../*.jsonl`), not from
`pi`'s self-reported summary.

## Raw numbers

| Metric | Value |
|---|---|
| Invocations (`pi -p`) required to reach a mergeable state | 3 |
| Total wall-clock time across invocations | ~93 min (28m15s + 54m26s + 10m13s) |
| Assistant turns (cumulative, same session via `--continue`) | 233 |
| Tool calls | `bash`: 142, `read`: 50, `edit`: 35, `write`: 5, `todo`: 19 (241 total) |
| Tool-call errors (`isError: true`) | 24 (~10% of tool calls) |
| Context compactions | 2 (session hit the 85K window twice) |
| Tokens (cumulative, this model's own accounting) | 317,498 in / 35,421 out |
| Files ultimately changed | 20 (10 modified in pass 1, +9 more incl. all 6 generated `app_localizations_*.dart` in pass 2, +5 `.arb` fixes in pass 3) |
| `make verify` result at final commit | Pass (1382 frontend tests, backend unaffected, lint/l10n/inventory drift checks clean) |

## What worked

- **The feature-dev skill (ported from Claude Code's) drove correct high-level
  process.** It ran `check-spec-handoff.sh --ready`, read the spec before
  coding, and eventually ran the same `check-l10n.sh` and `make verify` gates
  the Claude-side skill mandates. The skill-porting effort in `agent-configs`
  is doing real work — this wasn't scaffolding-free freelancing.
- **Code quality of the actual diff was good.** It correctly identified that
  `DailyBriefingSheet`'s content-rendering logic should be extracted into a
  shared `DailyBriefingContent` widget rather than duplicated between the
  sheet and the new screen — that judgment call wasn't in the spec, it made it
  unprompted (the spec left it as "implementer's call, keep it surgical").
  The new page's states (loading/not-ready/loaded) and the widget test file
  (5 cases: loading, not-ready, loaded, refresh, ordering-stability) match
  project convention, including the ordering-stability test the project's own
  `GUIDELINES.md` calls out as a repeat failure mode.
- **It caught something outside the spec's scope on its own:** updated
  `docs/testing/screen-manifest.md` so the route-inventory drift check
  (`make test-inventory`) would pass — I hadn't listed that file in the spec's
  technical plan.
- **Zero destructive edits to files outside the working tree** — the
  `protected-paths.ts` guard the config's README describes appears to have
  held; all 24 tool errors were recoverable, in-repo mistakes (see below), not
  scope violations.

## What didn't work

- **It never completed the task in one pass, and its own final turn ended
  incomplete.** Pass 1 (28 min, 71 turns) stopped mid-sentence
  (`"tester.widgetText is my own invention — it's not a real Flutter API. Let
  me fix the ordering test to use..."`) with no further tool call — the
  process just exited. It had not run `make verify` even once, despite that
  being the explicit, single-sentence success condition I gave it
  (`"run 'make verify' and fix any failures until it passes... stop when it
  passes"`). This is a live occurrence of exactly the failure mode
  `continuation-nudge.ts` in this same config was built to catch (model
  announces an edit in prose, no tool call, turn ends) — and that extension's
  own README says it never fired in ~50 prior trials. It should have fired
  here; it didn't (or fired and didn't help). Worth re-examining its trigger
  condition against this transcript.
- **It ran a destructive `git reset --hard` unprompted to resolve a
  self-inflicted conflict.** It tried `git switch -c feat/daily-briefing-screen`
  (per the feature-dev skill's branch step), which failed because I had
  already created that branch (`fatal: a branch named 'feat/daily-briefing-screen'
  already exists`). Its recovery was `git switch feat/daily-briefing-screen &&
  git reset --hard main` — discarding my prior commit (the spec doc) on that
  branch with no confirmation. Nothing else was lost only because no file
  edits existed yet at that point in the run; if this had happened after an
  hour of edits, `--hard` would have destroyed them. This is the specific
  category of action the project's own guidelines (and mine) require pausing
  for.
- **It shipped a real, user-visible correctness bug that `make verify` did
  not catch.** It needed a new l10n key; `dailyBriefingTitle` already existed
  on `main` (dead, unused, value "Today" — a leftover from prior spec work).
  It added a second `dailyBriefingTitle` entry with a different value in all
  6 `.arb` files, then only de-duplicated the English file — leaving both
  entries in `hi/kn/ml/ta/te.arb`. Because JSON with duplicate keys silently
  keeps the last occurrence, `flutter gen-l10n` generated the *old* ("Today")
  translation for 5 of 6 locales. `check-l10n.sh` and `make verify` both
  passed anyway — neither checks for duplicate keys or semantic correctness,
  only presence and format. It even patched a smoke test's assertion for the
  new value, meaning it partially noticed the collision without generalizing
  the fix to the other five files. This is a "the gate passed but the feature
  is still broken" case — the kind of thing a human or a second reviewer,
  not the same gate, has to catch.
- **High local error rate on mechanical tool use.** 24 of ~241 tool calls
  errored (~10%): repeated failed attempts to find the right `flutter
  gen-l10n` invocation (tried `dart pub run intl_tool`, wrong package names,
  ~8 failed bash commands in a 5-minute span before landing on the right
  command), an invented Flutter API (`tester.widgetText`, which doesn't
  exist), and edit-tool "could not find exact text" failures from imprecise
  whitespace matching. None were fatal, but they consumed a meaningful share
  of the 93 minutes and 2 context compactions.
- **Required my (external) supervision to actually finish.** Left alone, pass
  1 would have been reported as "done" by nothing — it just stopped. I had to
  notice the incomplete state via the transcript, re-dispatch twice with
  increasingly specific instructions, and independently re-run `make verify`
  myself rather than trust its self-report (which, when it did eventually
  produce one, was more accurate than pass 1's silent stop, but still missed
  the l10n bug).

## Bottom line, without spin

For an additive, well-specified, low-risk UI feature with a clear spec
handed to it, `pi` on a local 27B model produced code whose *shape* and
*conventions* were genuinely good — better than "boilerplate correct," it
made a reasonable unprompted refactor call. But it could not be trusted
unsupervised: it needed three dispatches instead of one, took a destructive
git action without asking, silently stopped short of its own stated
completion condition once, and shipped a real (if narrow-blast-radius)
localization bug that its own quality gates didn't catch. The net result
required the same depth of independent verification (reading the transcript,
re-running `make verify` myself, diffing the l10n files by hand) as
reviewing a junior contributor's PR — the harness reduced typing, not review
load.

## Follow-up: is this a ceiling, or fixable? (Claude + Opus second opinion)

After the above was written, we asked whether the four "what didn't work"
items point at a hard ceiling for a 27B local model, or are addressable
harness gaps. Claude's initial take was "all four are independently
fixable." An independent Opus review agreed with the direction but
corrected two of the four on the specifics, using the actual extension
source and session JSONL rather than the summary above:

- **Git safety isn't a blank gap.** `git-checkpoint.ts` already snapshots
  base SHA + stash + untracked blobs every turn, so the `reset --hard` in
  this run *was* recoverable — but only via `/fork`, which is
  interactive-UI-only and does nothing in `-p` mode, which is how this task
  actually ran. The real gap is a `-p`-compatible guard, not "add recovery
  from scratch."
- **The `continuation-nudge.ts` diagnosis was wrong in the summary above,
  and the real cause is sharper than either of our first guesses.**
  Checked directly against the session JSONL: the pass-1 stop's
  `stopReason` was `"stop"` (confirming it wasn't a `maxTokens`/`"length"`
  cutoff, which Opus had flagged as worth ruling out first). But the
  assistant's final turn had **zero text content** — no forward-looking
  sentence, nothing pattern-matchable, just an empty stop after a `read`
  tool call. `continuation-nudge.ts`'s `isPureForwardLookingProse()`
  (`extensions/continuation-nudge.ts:39-48`) explicitly returns `false` on
  empty text (line 46: `if (!text) return false;`) — it only fires on
  "announced but didn't act" prose, which is a narrower and, on this
  evidence, less common failure mode than "went completely silent with no
  text and no tool call." The extension's own regex patterns were never
  the problem; the trigger's premise (abandonment always comes with
  announcing prose) doesn't hold for this real occurrence.
- **The cheat-sheet idea (Claude's 4th point) was mostly wrong**, per
  Opus: it would spend prompt budget on the actual binding constraint (85K
  context) to save roughly 5 of the 93 minutes, and the one named example
  (`tester.widgetText`, a hallucinated API) isn't a missing-lookup problem
  a cheat-sheet fixes.
- **check-l10n.sh duplicate-key detection was the right call but the wrong
  layer**, per Opus: a skill script only runs if the model chooses to run
  it. The fix belongs in DayTrix's own `make verify` (repo-side,
  model-independent, runs under any agent or CI), with the pi-side script
  calling the same check.

Opus's sharper read on "is there a real ceiling": the l10n bug is the
strongest candidate. The model didn't *miss* the collision — it patched
the English smoke-test assertion for the new value, meaning it saw the
change was needed — and then failed to propagate the same fix to the other
five `.arb` files across two context compactions. "Hold one invariant
consistently across N parallel artifacts over a long horizon" is the kind
of task that degrades under compaction at this model size, and corroborating
evidence already existed in this same config: `cross-model-review.ts`
(disabled, not this run) returned `NO_ISSUES_FOUND` twice on a diff with a
known, spec-violating bug in its own kill-criterion test. The pattern
across every extension in this config: the ones that stuck
(`protected-paths`, `format-on-edit`, `rtk-rewrite`, `co-change-suggest`)
are fully deterministic; the ones that depend on local-model judgment
(`cross-model-review`, arguably `continuation-nudge`) have been rejected or
demonstrably under-fire. Sample size caveat: n=1 real task / 3 dispatches
supports "every failure here was in the class a deterministic check would
have caught," not a general claim about a hard reasoning ceiling either way.

**Fixes applied as a result** (see commit history in this repo and in
`personal-assistant` following this entry):

1. `frontend`'s `make verify`/lint gate in `personal-assistant` gained an
   `.arb` duplicate-JSON-key check (catches the exact bug shipped here,
   independent of which agent or human is editing).
2. `extensions/continuation-nudge.ts` widened to also fire on a
   stop-with-empty-content turn (not only forward-looking prose), gated the
   same way (no tool call, `stopReason === "stop"`, no verification run yet
   this invocation).
3. A new `extensions/git-safety.ts` intercepts destructive git commands
   (`reset --hard`, `push --force` without `--force-with-lease`, `clean
   -f`, `branch -D`, `checkout -- .`) at the bash tool-call layer in `-p`
   mode, blocking with a named safe alternative rather than a bare refusal
   — because the `flutter gen-l10n` rediscovery flail in this same run
   (~8 failed bash commands) is direct evidence that this model thrashes
   when blocked without being told what to do instead.

**Honest bottom line, unchanged in substance:** these fixes remove three
specific recurrences. They don't remove the need to read the transcript.
The bottleneck is a 27B model's judgment and consistency over a long
horizon in an unfamiliar codebase, and no extension fixes that directly.
The defensible scope for this local setup is task classes fully covered by
deterministic gates — mechanical refactors, test-writing against existing
code, l10n sweeps, rename passes — with net-new, judgment-heavy feature
work kept on a cloud model.
