# Observation report: `pi` on the personal-budget-simplifier build

**Status: build complete.** All 7 chunks landed: Go backend (schema, repositories, HTTP API),
Flutter desktop frontend (onboarding, CSV import, dashboard, budget creation with the free-tier
upgrade CTA), README. Final state: 21 Go tests / 17 Flutter tests passing, `gofmt`/`go vet`/
`flutter analyze` clean, and a live end-to-end run — real backend process on `:8080`, a real
`flutter run -d macos` build (Xcode-compiled `budget_app.app`, not just `flutter test`) launched
against it with no runtime exceptions in its log. One honest gap: `screencapture` failed in this
sandboxed environment (`could not create image from display`, no screen-recording permission), so
the running app's UI was never visually screenshotted — its correctness rests on the widget tests'
exact-text/icon assertions plus the clean runtime log, not a pixel-level check.

**Post-build corrections, same day, two rounds** — read in order, each supersedes the one before
it on the point it addresses:

1. Two "confirmed" harness bugs (`cross-model-review.ts` and `quality-gate.ts`'s corrective
   follow-up allegedly not working under `pi -p`) were retracted after direct instrumentation,
   concluding both actually work correctly and the original black-box observations were artifacts
   of concurrent heavy processes on the machine. **This retraction was itself wrong about
   `cross-model-review.ts`** — see round 2.
2. An independent Opus review of round 1's retraction, asked to check it against source and
   against pi's own durable session records (not just the `--mode json` stdout log round 1 relied
   on), found the reviewer genuinely never completed a single review round anywhere in this real
   build — confirmed directly from `~/.pi/agent/sessions/`, which round 1 never consulted. Real
   root cause: a bare `git diff` never shows untracked file content, and this build had exactly one
   commit, made at the very end. **Fixed for real** (`buildReviewDiff()` in
   `extensions/lib/verification.ts`, shares `quality-gate.ts`'s untracked-file handling), verified
   against the exact original bug condition, `npm test` 123/123. `quality-gate.ts`'s corrective
   follow-up is left **unresolved** — works in an isolated single-file test, did not fire in the
   real chunk-3 build session; the discrepancy is unexplained.

One real, reproducible environmental bug held up across both rounds and was fixed for real:
`.zshrc` values not reaching non-interactive shells, fixed via `~/.zshenv` (with `${VAR:-default}`
defaulting and idempotent `PATH` handling added in round 2 after further review). See "Correction
notice" below for round 1's account and "Round 2" further down for the reopened finding — both
kept intact as a methodology record, not just for their final conclusions.

Task: implement a Go + Flutter personal-budgeting app end-to-end, chunked into 7 small
acceptance-criteria-bounded steps per `~/code/agent-configs/plans/personal-budget-simplifier-build-plan.md`,
delegated to `pi` (`ai-stack-local`, ThinkingCap-Qwen3.6-27B-MLX-8bit, :8080) via `pi -p` per
chunk. I (Claude, orchestrating) wrote the plan and each chunk's prompt, dispatched `pi`
backgrounded, then independently re-ran the verification command and read the actual diff
before marking a chunk done — not trusting `pi`'s self-reported pass. This is the same
orchestration pattern as `pi-real-task-report-daily-briefing-screen.md`; this file exists to
capture harness-improvement nudges from a second, structurally different real task (backend
Go from scratch, not a Flutter screen added to an existing app).

## Raw numbers (chunks 1–2 only)

| Metric | Value |
|---|---|
| `pi -p` invocations | 2 (chunk 1: schema/module, chunk 2: repository layer + categorizer) |
| Distinct `pi` session files logged | 3 — consistent with `quality-gate.ts`'s corrective-follow-up loop firing at least once inside one of the two invocations, not a 1:1 invocation:session mapping |
| Combined wall-clock (session first-event to last-event) | ~24 min across the 3 sessions |
| Foreground timeout hit | 2/2 invocations exceeded the 120s foreground bash timeout and had to be moved to background — see nudge below |
| `go build`/`go test` at hand-off | Pass both times (1 test chunk 1, 11 tests chunk 2) |
| Real bugs found on independent review, despite `pi`'s own quality-gate reporting `outcome: pass` | 2 (see below) |

## Bugs found that `pi`'s self-verification did not catch

Both chunks passed `gofmt`/`go build`/`go test` and `pi`'s own `quality-gate.ts` trace recorded
`outcome: "pass"`. Independent review (reading the diff, not just the exit code) still found:

1. **Chunk 1 — false-positive idempotency test.** The acceptance criterion asked for a test that
   "calls `Open` a second time on the same DB and asserts no duplicate seed rows." `pi` wrote
   `Open(":memory:")` twice and compared row counts. In SQLite, `:memory:` databases are
   per-connection — two `Open(":memory:")` calls never share state, so the second call always
   sees a fresh, empty-then-reseeded database. The test could not have failed even if the
   idempotency guard in `Open()` were deleted entirely. Fixed by rewriting it against a real
   `t.TempDir()` file path shared across both `Open()` calls.

2. **Chunk 2 — dead keyword entry from cross-category duplication.** The categorizer matches
   merchant substrings against category keyword lists in a fixed priority order, first match
   wins. `"walmart"` appeared in both the `Groceries` list (checked first) and the `Shopping`
   list (checked later), making the `Shopping` entry permanently unreachable. Not a crash, not
   a test failure — `walmart` categorizes correctly as `Groceries` either way — just silently
   dead code that a normal reader would assume does something.

Neither bug would show up in `gofmt`, `go build`, `go vet`, or `go test` output. Both are the
kind of thing a second reader (human or an independent model) catches by reading intent against
implementation, not by running commands.

## Nudges for harness improvement

1. **Add a stated rule about `:memory:` SQLite semantics to `AGENTS.md`.** Something like: *"A
   test that checks idempotent re-open/re-seed behavior must open a real file path (e.g.
   `t.TempDir()`), not `:memory:` — each `:memory:` connection is an isolated fresh database, so
   two `Open(":memory:")` calls can never observe shared state, and a test written that way passes
   regardless of whether the idempotency guard exists."* This is a specific, recurring trap (same
   shape of bug is easy to imagine appearing again in any "call X twice, assert no duplication"
   test) worth naming explicitly rather than hoping the model infers it.

2. **Add a self-check step for match-first-wins lookup/keyword tables.** When a chunk's acceptance
   criteria ask for a keyword→category (or any priority-ordered) table, have the model grep its
   own literal values across categories before finishing and flag/resolve duplicates — a
   duplicate below the winning category is unreachable and no test written against "does X
   categorize correctly" will ever surface it, since the *first* category's answer is still
   right.

3. **This is fresh evidence for the standing case to actually enable cross-model review**,
   already tracked as unresolved in `pi-harness-validation-status.md` ("same-primary review
   requires `AI_REVIEW_ALLOW_SELF=1`... never cross-model"). Both bugs here passed the *same*
   model's own quality gate. A second, independent reader — human (what actually caught these
   two) or a genuinely different model via the validated `:8081` Gemma route (see
   `pi-harness-history.md`'s "Stale `AI_REVIEW_MODEL` silently disabled the reviewer" fix, now
   live) — is exactly the kind of check that plausibly catches "this test's assertion doesn't
   actually exercise the guarantee its own comment claims." Same-model self-verification proves
   "the tests as written pass," not "the tests test the right thing."

4. **Orchestration-side, not `pi`-side: stop attempting foreground `pi -p` calls for
   multi-file-generation chunks.** 2/2 chunks here exceeded the 120s foreground bash timeout and
   had to be re-launched backgrounded, costing a wasted round trip each time. For any chunk
   scoped to "write N files + tests," launch backgrounded from the start.

## Chunk 3 (HTTP handlers + routing) — much higher bug density

Chunk 3 was the largest so far (~800 lines across `api.go`, `api_test.go`, `main.go`) and, unlike
chunks 1–2, `pi`'s own `quality-gate.ts` trace **correctly reported `outcome: "fail"`** — the run
ended with `go build` failing on a declared-and-unused variable (`header` from an ignored
`r.FormFile` return). That's the gate working as designed. The notable finding is what happened
next: **the agent settled (ended the run) on that failure rather than self-correcting** — no
further tool calls, no retry, just a failed quality-gate entry followed by `agent_settled`. Given
`AGENTS.md`/`README.md` describe up to three automatic corrective follow-ups, this is worth
confirming directly: does that loop apply to non-interactive `pi -p` invocations, or only
interactive sessions? Our whole orchestration pattern here is `pi -p` end-to-end — if corrective
follow-up is interactive-only, it provides zero value to this workflow and every failed `-p` chunk
needs a human (or a second dispatched `-p` call) to close the loop, which is what actually
happened: I fixed the build error, the dead test variables, and re-ran verification by hand.

Once the build error was fixed, three more real, substantive bugs surfaced — none of them
guarded against by `gofmt`/`go build`/`go vet` on their own:

1. **Same test-lifecycle footgun as chunk 1, worse consequences.** `testStore(t)` did
   `f, _ := os.CreateTemp(...); defer os.Remove(f.Name()); ...; db.Open(f.Name())`. A bare `defer`
   inside a helper function fires when *that helper* returns, not when the calling test returns —
   so the SQLite file was deleted immediately after `testStore` handed back a `*store.Store` still
   holding an open handle to it. Every mutating test in the file (`POST /accounts`, CSV import,
   budget creation) 500'd. This is the second backend chunk in a row where the model mishandled
   Go test-fixture lifecycle around a temp SQLite file — first `:memory:` connection-sharing
   semantics (chunk 1), now `defer`-inside-helper scoping (chunk 3). That's a pattern, not a
   one-off: **add an explicit `AGENTS.md` rule** — *"`defer` inside a test helper function runs
   when the helper returns, not when the calling test ends. Anything that must live for the whole
   test belongs in `t.Cleanup(fn)` registered on the passed `*testing.T`, or use `t.TempDir()`
   (auto-cleaned at test end) instead of manual `os.CreateTemp`+`os.Remove` entirely."*
2. **Missing `return` after a written error response**, in `handleListBudgets`: on a transaction-load
   error it called `writeError` (which already writes a status code and body) and fell through to
   compute and write a second JSON response on the same `ResponseWriter`. No test caught this
   because no test exercised that particular error path — a gap in the test suite itself, not
   just the handler.
3. **A cross-chunk integration bug invisible to same-language round-trip tests.** Chunk 2's
   `store.Account`/`Category`/`Transaction`/`Budget` structs had no `json` tags, so passthrough
   endpoints (`/accounts`, `/categories`, `/transactions`) serialized as `{"ID":1,"Name":"Checking"}`
   instead of the `snake_case` every hand-written response type in the same file correctly used.
   **`go test` did not catch this** — `api_test.go`'s assertions decode the HTTP response body back
   into the same Go structs, and `encoding/json`'s decoder matches field names case-insensitively
   by default, so `"ID"` happily unmarshals into a field tagged `json:"id"`. The mismatch is
   invisible to any test where both sides of the wire are Go. It only showed up in a live `curl`
   smoke test reading the raw bytes — which is what an actual Flutter client would also do, and
   would have broken against silently. **Nudge**: verifying a JSON API contract needs at least one
   assertion against the raw response text (or an explicit key-by-key map, not a round-trip decode
   into the producer's own struct type) — round-tripping through the same language's types on both
   ends of a test structurally cannot catch a wire-format mismatch.

All three were fixed directly (not re-dispatched to `pi`, given their size), then the full happy
path was verified live against a running server: CSV import, auto-categorization, malformed-row
skipping, monthly summary sorted correctly, the 3-budget free-tier limit returning `409
LIMIT_REACHED`, and `over_budget` computed correctly — all confirmed via real HTTP requests, not
just `go test`.

## Correction notice

The section below ("`cross-model-review.ts` does not fire under `pi -p`") was written same-day and
is **wrong** — retracted after direct instrumentation (debug logging inserted into the actual
extension handlers, not further black-box inference). Both `cross-model-review.ts` and
`quality-gate.ts`'s corrective follow-up are confirmed working correctly under `pi -p`. The
original black-box observations (zero trace output in two backgrounded, redirected logs) were most
likely caused by running heavy concurrent processes on the same machine — a second `pi -p` chunk in
one case, a `flutter run -d macos` Xcode build in the other — that plausibly got a backgrounded `pi`
process killed before its fully-buffered (non-TTY) stdout ever reached disk, producing a log that
*looked* like total silence without actually proving the extension was silent. The section is kept
below, struck through in spirit but left intact, because the methodology mistake (treating a quiet
redirected log as proof of absence, without ruling out concurrent resource contention or a killed
process) is itself a useful lesson — see the correction detail and the real fix (env propagation via
`~/.zshenv`) in `pi-harness-history.md`'s "Corrected: two false harness-bug findings" entry.

## [RETRACTED] `cross-model-review.ts` does not fire under `pi -p`, confirmed by direct diagnostic

`pi-harness-validation-status.md` states the reviewer "resolves to genuine `independent-review`"
now that `~/.zshrc` sets correct `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` values. Checking whether
chunks 1–4 of this build actually got that benefit surfaced two separate problems, one
environmental and one structural.

**First, the environmental one.** The orchestrating shell (this session's `Bash` tool) reported
`AI_REVIEW_BASE_URL=http://kannasmacstudio.lan:8082/v1` and `AI_REVIEW_MODEL=gemma-4-26b-a4b-it`
— the exact stale pair `~/.zshrc` was already fixed to *not* export (it now correctly exports
`:8081` and the full model path). Root cause: zsh only sources `.zshrc` for interactive shells;
`ps` on the Bash tool's own shell showed `/bin/zsh -c source .../snapshot-*.sh` — non-interactive,
so `.zshrc` is skipped by zsh's own rules regardless of what the snapshot file contains (confirmed
empty of these vars). The values actually came from whatever environment this whole session's
parent process inherited at spawn time, frozen before the `.zshrc` fix landed — `env -i HOME=$HOME
zsh -c 'source ~/.zshrc; ...'` (a clean-room load) reproduces the *correct* current values, proving
the file itself is right and the gap is purely propagation. **This means every `pi -p` invocation
launched from a long-lived orchestrating shell — exactly this session's pattern — can silently run
against reviewer config that was correct in the file weeks ago and wrong in every live process
since, with no error, because `requestReview()`'s catch-all treats a failed request as
`{outcome: "transient"}` by design.** The general lesson isn't `.zshrc`-specific: **any config an
orchestrator relies on `pi -p` picking up from environment must be exported inline on the
invocation itself** (`FOO=bar pi -p ...`), never assumed to come from shell rc files, because the
orchestrating process's own env is a frozen snapshot from whenever *it* started, not a live view
of the user's dotfiles.

**Second, and worse: fixing the environmental gap did not fix the actual problem.** A controlled
diagnostic — `AI_REVIEW_BASE_URL`/`AI_REVIEW_MODEL` exported correctly inline on the `pi -p`
command itself, a real file edit, a real `go build && go test` verification command executed via
the `bash` tool — produced **zero** reviewer trace output: no `session_start` startup trace
(`config.enabled ? "pass" : "blocked"`, logged *unconditionally* by the extension's own code), no
`review` trace despite a genuine diff and a broad verification command passing through the exact
`tool_result` event `quality-gate.ts` used successfully in the same run. Independently confirmed
`resolveReviewerConfig()` itself is not the problem — importing `cross-model-review.ts` directly
and calling it with the identical env produces `{enabled: true, kind: "independent-review", ...}`.
So the resolution logic is correct, the config was correct, a real trigger condition occurred, and
still nothing happened. `stack-router.ts` (`before_agent_start`) and `quality-gate.ts`
(`agent_start`/`tool_call`/`tool_result`/`agent_settled`) both fired correctly in the identical
run — `cross-model-review.ts` registers on `session_start`/`agent_start`/`tool_result`/
`agent_settled`, a superset overlapping `quality-gate.ts`'s exactly, and still produced nothing.

**Conclusion: `cross-model-review.ts` is not confirmed to run at all under `pi -p` (non-interactive)
invocations**, independent of whether its configuration is correct. Root-causing *why* (a
registration-order issue, a `-p`-mode-specific extension-loading path that skips this one module,
a swallowed exception at load time — the black-box evidence above rules out config and the
resolution function but can't distinguish among the rest) needs instrumentation inside `pi`'s own
extension loader, out of scope for what an orchestrating session can determine from outside. This
is the single highest-priority open item this build surfaced: **every chunk in this build, and
every `pi -p`-based orchestration pattern documented anywhere in this harness, has been getting
zero benefit from the reviewer**, contradicting `pi-harness-validation-status.md`'s current
"resolves to genuine `independent-review`" framing — which was true of the config, never
demonstrated true of the running extension. Downgraded there accordingly; needs a `pi` maintainer
or a deeper instrumented investigation to close.

*(All of the above is retracted — see "Correction notice" above. Actual instrumented result
follows.)*

## `cross-model-review.ts` and `quality-gate.ts` under `pi -p`: instrumentation-confirmed working

Direct instrumentation — debug logging added straight into the extension source, run in isolation
with no other heavy process competing for the machine, reverted immediately after — settled this
cleanly, in contrast to the black-box guessing above.

**Reviewer**: two isolated `pi -p` runs against the real backend (a small doc-comment edit plus a
real `go build && go test`) both produced the complete expected sequence —
`REVIEWER_FN_CALLED enabled=true kind=independent-review` → `SESSION_START_FIRED` →
`TOOL_RESULT_FIRED` on each tool call → `TOOL_RESULT_TRIGGERING_REVIEW` once the matching bash
command ran — and both completed a real round-trip to the `:8081` Gemma endpoint (1.6s and 5.7s)
logging `outcome: "clean"` through the normal `pi-harness-trace` channel. Reproducible twice, not
a fluke.

**Quality-gate corrective follow-up**: an isolated scratch repo with a forced, intentionally
unfixed build failure showed `AGENT_SETTLED_FIRED` → `RAN_VERIFICATION passed=false` →
`SENDING_FOLLOWUP attempt=1`, then a **second** `AGENT_SETTLED_FIRED` roughly a minute later with
`correctiveFollowUps=1` carried forward from the first — the `sendUserMessage(..., {deliverAs:
"followUp"})` call was genuinely delivered and produced another agent turn under `pi -p`.

**So what actually caused the original "zero trace output" observations?** Best explanation given
the evidence: both were run while a second heavy process was competing for the machine — a second
`pi -p` chunk still in flight in one case, a `flutter run -d macos` Xcode build in the other (the
retried README chunk that died mid-response with `stopReason: "pending"` and zero live process
afterward is the clearest smoking gun of an outright kill, not a clean exit). `--mode json` output
redirected to a file is fully buffered rather than line-buffered; a process killed rather than
exited cleanly can lose everything sitting in that buffer — including a `session_start` trace that,
per this correction's evidence, actually does fire within the first tens of milliseconds. **A quiet
log from a backgrounded, redirected process is not proof an extension stayed silent** — it can
equally mean the process died before flushing. That methodology gap, not any real harness defect,
produced both retracted findings.

**What was real, and what got fixed**: the `.zshrc`-to-non-interactive-shell propagation gap held
up under the same clean-room test (`env -i HOME=$HOME zsh -c 'source ~/.zshrc'` reproduced the
*correct* values while every other check in this session showed the stale pair — not explainable by
resource contention). Fixed for real, not just documented: the relevant exports moved from
`~/.zshrc` to `~/.zshenv`, which zsh sources for every invocation regardless of interactive/login
status. Verified against a fully isolated `env -i` shell resolving correctly, and confirmed to take
effect immediately in this same session (each `Bash` tool call turns out to spawn a fresh
non-interactive shell each time rather than reusing one frozen at session start — no restart
needed). `~/.zshrc` now points to `~/.zshenv` in a comment instead of duplicating the exports,
removing the drift risk that caused the original "Stale `AI_REVIEW_MODEL`" incident.

## Chunk 5 (onboarding/import/dashboard screens) — a new bug class, `AGENTS.md` gotchas held

Dispatched with the correct `AI_REVIEW_*` pair exported inline (the reviewer still produced zero
trace output — consistent, not new, evidence for the finding above) and with the freshly-added
"Recurring test-correctness gotchas" section of `AGENTS.md` already live. None of the four
previously-documented gotchas recurred in this chunk — no `:memory:`-style test, no bare `defer`
in a helper, no duplicate keyword table, and the cross-chunk JSON field names (consumed from
chunk 3's now-tagged structs) were used correctly. That's a small positive signal for the
`AGENTS.md` addition, though one clean chunk on different code isn't strong evidence on its own.

A new bug class showed up instead: `_buildBudgetList()`'s title read
`'Budget: \${budget.monthlyLimitCents ~/ 100}.00'`. In Dart, `\$` escapes to a literal `$`; the
`{...}` immediately after it is then *not* an interpolation trigger, so this renders the literal
characters `${budget.monthlyLimitCents ~/ 100}.00` on screen instead of a computed dollar amount
— compiles cleanly, `flutter analyze` flags nothing, and the file's own `_formatDollars` helper
(defined and used correctly two lines above, for the category list) shows the model knew the
right pattern elsewhere in the same file and still got it wrong here. The one test that exercised
this code path only asserted on the warning icon, never the label text, and used a round-dollar
fixture (`50000` cents = a suspiciously clean `$500.00`) that would have passed even under the
buggy truncating-integer-division read of the string. Fixed by reusing `_formatDollars` directly;
strengthened the test with a non-round-dollar fixture (`49999` cents) and an explicit assertion on
the rendered text, not just the icon. Added as gotcha #5 in `AGENTS.md`. General shape, same as the
JSON-tag finding: **a bug that's invisible to type-checking/linting and only surfaces in an
assertion on the actual rendered/wire output, in a test that used a fixture too "nice" (round
number, valid casing either way) to force the bug to manifest.**

## Round 2: the reviewer finding was reopened, root-caused for real, and fixed

Round 1 (below, "Correction notice" and the `[RETRACTED]` section) concluded `cross-model-review.ts`
worked fine under `pi -p` and blamed the original silence on concurrent resource contention. Asked
to review that retraction independently, an Opus subagent checked it against `appendHarnessTrace`'s
actual implementation and against pi's own session records — evidence round 1 never consulted,
relying only on a redirected `--mode json` stdout log.

`appendHarnessTrace` calls `pi.appendEntry(...)`, which persists to pi's session JSONL files, not
stdout — it cannot be lost to a killed process's stdout buffer, the mechanism round 1 proposed.
Checked directly (`~/.pi/agent/sessions/--Users-kanna-code-personal-budget-simplifier--/*.jsonl`):
**all 7 real build sessions carry a reviewer `startup` trace and zero carry a `review` trace** —
including the two sessions that ran after `AI_REVIEW_*` was already correctly configured. The
reviewer never completed a single review round anywhere in this build. Round 1's "no real bug"
conclusion was wrong; the original same-day claim was right.

**Root cause, confirmed against source**: `cross-model-review.ts`'s `tool_result` handler built its
diff with a bare `pi.exec("git", ["diff", target])`. `git diff` never shows untracked file content
under any target — ordinary git behavior. `personal-budget-simplifier` had exactly one commit,
made at the very end of the build; every chunk ran against an all-untracked working tree, so every
diff was empty, `!diff` short-circuited before `requestReview` was ever called, and — the gap that
made this so hard to see — no trace was emitted on that silent-return path at all.
`quality-gate.ts`'s own `snapshotDiff` (used for its verification-evidence hash) already merges
`git diff` with `git status --porcelain --untracked-files=all` and hashes untracked content; the
two extensions simply hadn't shared that logic.

**Fixed**: added `buildReviewDiff()` to `extensions/lib/verification.ts` — gathers the same
untracked-path list `snapshotDiff` does and synthesizes a `new file`-style diff block per untracked
file (reading its content; skips binary/oversized files) instead of `git add -N`, which would
mutate the index as a side effect of a read-only review pass. `cross-model-review.ts` now calls
this instead of a bare `git diff`, and now emits a `review`/`blocked` trace on the previously-silent
early-return paths, so this class of bug is diagnosable from the trace record alone next time.

First attempt at the fix broke one of the 123 deterministic tests: `buildReviewDiff`'s
`Promise.all` used a blanket `.catch(() => undefined)` on both `git` calls, which silently
swallowed a simulated stale-context rejection instead of letting it propagate to the caller's
`isStaleContextError` handling — exactly the class of bug this report's own `AGENTS.md` gotchas
warn about (a "successful" empty result masking a real failure). Fixed by removing the blanket
catch; only a *resolved* non-zero exit code is now treated as "nothing to show." `npm run
typecheck` clean, `npm test` 123/123.

**Live-verified against the exact original bug condition**: a fresh scratch repo, `git init`, zero
commits, one untracked `.go` file — before the fix this configuration never triggers a review, by
construction. After the fix, a real unmodified `pi -p` run against it produced a genuine
`outcome: "clean"` review trace, with `git status` confirmed still showing the file untracked
(`?? main.go`, no commits) throughout.

**`quality-gate.ts`'s corrective follow-up is left genuinely open, not re-closed a second time.**
The isolated `/tmp/qg-test` result from round 1 (a second `agent_settled` firing ~1 minute after
the first, with `correctiveFollowUps=1` carried forward) is real and stands on its own. But the
actual chunk-3 build session (`2026-08-05T19-36-29…jsonl`) shows the opposite under direct
inspection: one `quality-gate` `outcome: "fail"` trace, zero occurrences of the follow-up message
text anywhere in the session, and the file ends immediately after the last assistant turn — no
second round happened there. The isolated test was a small, single-file, few-turn repo; the real
session had already run nine assistant turns by the time it failed. What explains the difference —
turn count, context size, something else — is not established. This stays downgraded to
**unresolved / context-dependent**, not claimed as fixed or broken either way.

**Standing lesson, learned twice in one day**: `--mode json`'s stdout stream and pi's own session
JSONL files are not the same record, and neither round 1's original diagnostics nor its retraction
consulted the session files before drawing a conclusion — the retraction repeated the same
methodology gap it was trying to correct. What actually caught it was a second, independent reader
checking primary evidence rather than re-running the same kind of black-box test again.

## What's working (not a gap, worth keeping)

Chunking into small, single-package, acceptance-criteria-bounded prompts — reading the prior
chunk's actual file contents first and instructed not to modify them — produced correctly-scoped
code both times: it stayed inside the assigned package, matched existing signatures exactly, and
ran its own stated verification command before reporting done (visible in the
`pi-harness-trace` `quality-gate` event, `outcome: "pass"`, `diffChanged: false` confirming it
verified the actual committed diff rather than a stale one). This validates the harness's
core "small chunk + self-verification" design; the gap found here is specifically about
*semantic* test correctness, not about scope creep or unverified claims.
