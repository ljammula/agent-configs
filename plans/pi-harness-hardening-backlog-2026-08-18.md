# Pi harness hardening backlog — handoff plan

Date: 2026-08-18
Audience: an agent (Codex) picking this up cold, without this session's history
Repo: `agent-configs` (this repo); extensions live in `pi/extensions/`, tests in
`pi/tests/`, battery runners in `pi/evals/`, task fixtures in
`../local-model-bench/tasks/`

> **2026-08-19 update: Tasks 1 and 2 are superseded, done directly rather
> than handed off.** Rather than fix `followUp`-vs-`steer` delivery
> (Task 1's original proposal), the decision was to narrow scope instead:
> `cross-model-review.ts` and `quality-gate.ts` no longer inject any
> in-band correction at all — both still verify/review every materially
> distinct diff exactly as before, but a flagged/failing result is now
> pure reporting in the trace, not a queued message. This was implemented
> directly (not via Codex) since it turned out to be a small, well-scoped
> edit once reframed, not the multi-task backlog item originally planned.
> See `pi-harness-history.md`'s 2026-08-19 "decouple nudging from review"
> entry for the full change and rationale. Task 2's stall-guard fingerprint
> gap remains genuinely open (its own nudge is unaffected, still
> default-disabled) and is still available to hand off — see its section
> below, now decoupled from Task 1's original framing. Tasks 3–8 are
> unaffected and still reflect real, open backlog items.

## Ground rules (apply to every task below)

- Run `npm run typecheck` and `npm test` inside `pi/` before considering any
  task done. Both must be clean — this repo has 188 deterministic tests and
  they are the primary regression guard for these extensions.
- Extension state and control flow are documented in the comments right above
  the code you'll be touching — read those comments before changing behavior.
  Several of the bugs in this repo's own history came from *not* reading a
  comment that already explained why something was written a particular way.
- Do not reorder or remove the `analysis` field from
  `cross-model-review.ts`'s `VERDICT_SCHEMA` — that field ordering is
  load-bearing (see the schema's own doc comment: reordering it once
  regressed a planted-bug catch rate from 5/5 to 0/5). Any change touching
  that file must re-run `pi/evals/reviewer-battery.ts` live before/after and
  report both catch-rate numbers (target: 15/15 catches, 0/9 false
  positives, unchanged).
- `pi-harness-validation-status.md` (repo root) is the current-status source
  of truth — extension-by-extension table plus an "Open items" list. Update
  it, and append a dated entry to `pi-harness-history.md`, for any task you
  complete, following the existing entries' format (what was tried, what the
  evidence actually showed, what's still open). Do not just say "done" —
  cite the specific run/battery result that proves it.
- Do not commit without being asked; leave changes in the working tree.
- These are local live-model batteries, not CI. `AI_STACK_HOST` (env var,
  already set) must resolve to a reachable host running Pi's model routes
  (`:8080` primary, `:8081` reviewer) before any live validation step below
  will produce real evidence rather than transport errors. If the stack
  isn't reachable, say so explicitly rather than reporting a battery run
  that never really executed.

---

## Task 1 — SUPERSEDED, done directly 2026-08-19 (was: `followUp` delivery can't interrupt an active tool-call loop)

**Original problem** (kept for record): `cross-model-review.ts` and
`quality-gate.ts` each queued a corrective message via
`pi.sendUserMessage(text, { deliverAs: "followUp" })`, which (confirmed from
`pi-agent-core`'s `agent-loop.js`) only drains once a model's turn produces
zero tool calls — so it could never interrupt a model stuck calling tools,
exactly when a correction is needed most. Live evidence: a `go/lru-cache`
battery rerun where a correctly-flagged bug's correction sat queued and
undelivered for the rest of a 30-minute run. Full account:
`pi-harness-history.md`'s 2026-08-18 "third go/lru-cache rerun" entry.

**Resolution actually taken, 2026-08-19: narrow scope instead of switching
delivery mode.** Rather than switch to `deliverAs: "steer"` (which drains
every turn instead of only at idle, but was still an unvalidated design
change), both extensions had their in-band correction removed entirely.
They still verify/review every materially distinct diff exactly as before;
a flagged/failing result is now pure reporting in the trace (`quality-gate.ts`'s
`metadata.failureExcerpt`, `cross-model-review.ts`'s `metadata.findings`) —
no injected message, no round cap (nothing left to cap). `goal-gate.ts`'s
three `followUp` sites were deliberately left untouched — it exists for
unattended `/goal`-driven builds with no human to engage mid-run, where
this narrowing would remove its only self-correction path rather than
simplify it; whether to touch those is still an open call for whoever picks
it up next.

Verified: `npm run typecheck` clean, `npm test` 188/188 (two
`cross-model-review.test.ts` tests and one `quality-gate.test.ts` test that
exercised the removed round-cap behavior were rewritten, not just patched).
`reviewer-battery.ts` unaffected (calls `requestReview` directly, untouched
by this change) — not rerun. **Not done**: a live end-to-end run confirming
the new decoupled behavior against a real flagged/failing session (does a
flagged reviewer finding and a failing settlement check both land purely in
the trace, zero injected messages, session settles honestly as failed).
Full change and rationale: `pi-harness-history.md`'s 2026-08-19 "decouple
nudging from review" entry.

---

## Task 2 — `progress-stall-guard.ts`'s fingerprint gap

**Problem.** `progress-stall-guard.ts`'s `turn_end` handler (around line
198) only increments `sourcelessRounds` / considers escalating when
`sawTestThisTurn` is true, and that flag is only set inside the
`tool_result` handler (line ~168) when `event.toolName === "bash"` and
`matchesTestExecution(command)` (line 105) matches. A model that stalls by
repeatedly writing and running a throwaway scratch file via
`bash cat > /tmp/x.go <<EOF ... && go run /tmp/x.go` (or similar) never
trips `matchesTestExecution`, so the guard goes silent — confirmed live three
separate times now (2026-08-16 trial 4, and again 2026-08-18's `go/lru-cache`
rerun: only 4 `pi-stall-trace` entries logged, then silence for the
remaining ~130 turns of a 30-minute run). This is an *already-documented*
open item (`progress-stall-guard.ts`'s row in `pi-harness-validation-status.md`),
not new — the 2026-08-18 rerun is simply the third live confirmation.

**No longer bundled with Task 1** (Task 1 is superseded — see above). This
extension's own nudge (`PI_STALL_GUARD_NUDGE=1`, currently off by default)
still sends via `{ deliverAs: "followUp" }` (line ~196) and has the
identical delivery exposure Task 1 used to describe, but fixing that isn't
automatically required to fix the fingerprint gap itself, since the nudge
is already disabled by default and the trace-only telemetry (which does
work today) is independently useful. Whoever picks this up should make an
explicit call, following Task 1's precedent: either (a) apply the same
narrowing — fix the fingerprint, but leave the nudge itself removed/disabled
permanently, treating this extension as trace-only reporting like the other
two now are, or (b) fix the fingerprint and separately decide whether this
specific nudge is worth a `steer`-based delivery attempt, given it's a
different, arguably lower-stakes message ("you're repeating yourself") than
a full corrective review round. Don't assume the answer; state which was
chosen and why in the writeup.

**Required change.** Widen `matchesTestExecution` (or add a sibling check
reached from the same `tool_result` handler) to recognize a broader class
of "the model is iterating on the same problem without touching source"
signal — not just literal test-runner commands. Candidates to consider: any
repeated `bash` command whose script content changes only trivially between
calls (a fuzzy/structural diff of the command string, not test-command
matching); or track "no `write`/`edit` to a non-test file in N rounds" as
the primary signal and drop the test-command requirement entirely, since
the real thing this guard cares about — per its own header comment — is "no
source edit," and gating that on *which* bash command ran is the actual
bug. Read the file's own header comment (lines ~1-95) in full before
designing this; it already documents two related bugs found and fixed the
same way.

**Acceptance criteria.**

- New deterministic tests reproducing the exact scratch-file-loop shape from
  the 2026-08-18 rerun (repeated `bash` calls with near-identical
  `cat > file <<EOF` content, zero `write`/`edit` calls) and asserting the
  guard now fires. Existing 9 tests plus these must all pass.
- A live re-run reproducing the same stall shape (see `pi/evals/run_single_arm.py`
  for rerunning a single arm) showing `pi-stall-trace` entries continuing to
  fire throughout, not going silent after the first few rounds.
- Whichever nudge-delivery call is made (see above), state it explicitly in
  the writeup and update the `progress-stall-guard.ts` row and the
  fingerprint-gap open item in both status docs accordingly.

---

## Task 3 — `quality-gate.ts` runtime overhead (100.3% median, above the 20% screening threshold)

**Problem.** The original nine-pair battery
(`pi/evals/full-screening-2026-08-03.json`) measured a 100.3% median paired
runtime overhead for the harness vs. baseline — the honest cost of
`quality-gate.ts`'s nested-manifest verification plus its corrective
follow-up loop running on every pair — against a 20% screening threshold set
in the original plan (`plans/pi-harness-hardening-plan.md`). This has never
been revisited. Separately, the 2026-08-17 hardened-config rerun found
median overhead rose further to ~312% once thinking was enabled (expected,
since thinking-enabled turns cost more wall-clock time per turn) — that's a
distinct, already-tracked question (Task 4 below), not this one.

**Required change.** This is an investigation task, not a known fix. Profile
where `quality-gate.ts`'s wall-clock cost actually goes — settlement
verification re-running the canonical check, the nested-manifest resolution
walk, or the corrective-follow-up round trips (each up to
`REVIEW_TIMEOUT_MS`/similar) — using the existing battery JSON files
(`pi/evals/full-screening-2026-08-03.json`,
`pi/evals/hardened-screening-2026-08-17.json`) as the data source before
proposing a code change. Then either (a) reduce the actual overhead (e.g.
caching verification-command resolution across a session instead of
re-walking on every settlement, if that's where the time goes), or (b) make
an evidenced case for revising the 20% threshold itself given what the
mechanism buys (bug-catch rate, corrective recovery) — the plan explicitly
allows either outcome, it just requires evidence for whichever one is
chosen.

**Acceptance criteria.**

- A written breakdown (in the `pi-harness-history.md` entry for this task) of
  where the overhead actually comes from, backed by the existing battery
  JSON's timing data or a new instrumented run — not a guess.
- Either a measured reduction (re-run the battery or a representative subset
  live, report before/after) or an explicit, evidence-backed threshold
  revision proposal for `pi-harness-validation-status.md` and the original
  plan doc.

---

## Task 4 — per-task timeout budgets vs. thinking-enabled turn cost

**Problem.** `harness_timeout_minutes` (default 30, read in
`pi/evals/run_screening.py` line ~249 from each task's `meta.json`) predates
2026-08-17's thinking-mode hardening. The hardened-config rerun found 3/7
harness arms (43%) failing to complete inside their existing budgets;
`dart/sequential-runner` specifically had already produced a hidden-test-passing
diff before running out of time — a pure budget problem, not a correctness
one, and this exact failure shape has now recurred twice
(`pair4-rerun-2026-08-13`, then again 2026-08-17). Today's 2026-08-18
`go/lru-cache` rerun is a related but distinct failure (a genuine stall, not
a slow-but-correct settlement) — don't conflate the two when reporting.

**Required change.** Re-isolate `dart/sequential-runner` under a clean,
uncontended stack (confirm via `launchctl kickstart -k` on the model routes
and a preflight reachability check first, per the pattern in
`pi-harness-history.md`'s 2026-08-17 evening "pair 4 clean-contention rerun"
entry) to determine whether its timeout is genuinely contention-caused (like
pair 4 turned out to be) or a real settlement-speed problem needing a larger
budget. If real, propose a specific new `harness_timeout_minutes` for
`meta.json` files, backed by a measured "how long does a correct run
actually take" number, not a round-number guess.

**Acceptance criteria.**

- A clean, isolated live re-run of `dart/sequential-runner`'s harness arm,
  with GPU/route contention explicitly checked and ruled out or confirmed.
- If a timeout revision is proposed, it must be justified by a specific
  measured runtime, and the change applied to the task's `meta.json`
  (`local-model-bench/tasks/dart/sequential-runner/meta.json`) plus a note in
  both status docs.

---

## Task 5 — background-process-kill root cause (mechanism still untraced)

**Problem.** Four unattended `/goal` runs have been killed mid-round; the
current understanding is "a client-side network-idle timeout on the primary
model path, same shape as an already-fixed reviewer-timeout bug" but the
exact enforcing code has never been traced. A `nohup ... & disown`
fully-detached launch is a working mitigation, not a fix. An unconfirmed lead
from 2026-08-12: the last two kills both happened under an aggressive
compaction setting forcing frequent longer prefills (2/2 correlation, not a
confirmed trigger).

**Required change.** Trace the actual killing mechanism. Candidates to rule
in/out, in order of cheapest to check: (1) the mlx-vlm/proxy server's own
idle-connection timeout config on the `:8080`/`:8081` routes; (2) Node's
`fetch`/`undici` default socket/keep-alive timeout inside
`pi-coding-agent`'s HTTP client, given the "same shape as an already-fixed
reviewer-timeout bug" note — check what that earlier reviewer-timeout fix
actually changed (`AbortSignal.timeout` values in `cross-model-review.ts`,
and whether an equivalent exists — or is missing — on the primary-model
request path in `pi-coding-agent` itself); (3) the aggressive-compaction
correlation, by deliberately reproducing it once with compaction forced and
once without, holding everything else constant.

**Acceptance criteria.**

- A specific mechanism identified and cited (a config value, a source line,
  a timeout constant) — not a re-statement of the existing "client-side
  idle timeout" hypothesis.
- Either a fix (a timeout/keep-alive setting corrected) with a live-confirmed
  unattended `/goal` run surviving past the point earlier runs died, or, if
  the mechanism turns out to be outside this repo's control (e.g. OS-level or
  third-party proxy behavior), a documented permanent mitigation beyond
  `nohup & disown`.

---

## Task 6 — `co-change-suggest.ts` / `continuation-nudge.ts` live validation

**Problem.** Both extensions are default-disabled and source-tested only.
`co-change-suggest.ts` has one real retrospective replay (ranked its target
#1 of 8) — short of the adoption threshold, and retrospective, not live.
`continuation-nudge.ts` has zero real-trial field evidence at all beyond
deterministic tests.

**Required change.** Design and run live (not retrospective) validation
trials for each, following the same battery/trial methodology used
elsewhere in this repo (see `pi/evals/reviewer-battery.ts` and
`pi/evals/run_single_pair.py` for the pattern: live model, real task, recorded
outcome). Define the adoption bar explicitly before running trials (e.g. "N
live trials where the suggestion/nudge measurably changed model behavior for
the better, with zero regressions") rather than running trials first and
rationalizing a bar afterward.

**Acceptance criteria.**

- A stated adoption bar, agreed before trials run.
- Live trial results (not retrospective replays) against that bar.
- Either extension gets adopted (flip its default-enabled status, update its
  status-table row) or stays disabled with a documented reason.

---

## Task 7 — TypeScript/JavaScript task fixtures for battery coverage

**Problem.** `stack-router.ts` routes TypeScript/JavaScript guidance from
`package.json` evidence (unit-tested), but no TS/JS task exists in
`local-model-bench/tasks/` (currently only `dart/`, `go/`, `go-flutter/`), so
this routing path has never been exercised in a live battery the way Go and
Dart routes have.

**Required change.** Add at least one TS/JS task fixture under
`local-model-bench/tasks/` following the existing `go/`/`dart/` fixtures'
shape (`meta.json`, `spec.md`, `starter/`, hidden tests) — pick a task with a
plantable, non-trivial logic bug (mirroring `go/lru-cache`'s key/value-
confusion trap or similar), then run it through the existing battery
methodology (baseline vs. harness pair).

**Acceptance criteria.**

- A new task fixture, structurally consistent with existing ones (should
  pass whatever fixture-shape validation `run_screening.py` implicitly
  requires — check by running it once before trusting it's wired correctly).
- At least one live battery pair result recorded in a new JSON file
  alongside the existing `pi/evals/*.json` battery records, and a
  `stack-router.ts` row update in the status doc noting TS/JS now has live
  coverage, not just unit tests.

---

## Task 8 — `session_compact` mid-goal reminder, still not live-exercised

**Problem.** `goal-gate.ts`'s `session_compact` handler (line ~270) is
shipped and unit-tested but has never fired live while a goal was active.
Two dedicated 2026-08-12 attempts (forcing compaction via an aggressive
threshold) both hit Task 5's background-kill bug before producing a result.

**Required change.** Blocked on Task 5 in practice (both prior attempts died
to the same kill bug before reaching this one) — sequence this task after
Task 5's fix or mitigation lands, then retry the same forced-compaction
approach. Note the delivery-mode question Task 1 raised and then resolved
by narrowing scope for `cross-model-review.ts`/`quality-gate.ts` (see Task
1, now superseded): this handler still sends via `deliverAs: "followUp"`
and has the identical exposure to sitting queued if the model doesn't
pause. `goal-gate.ts` was deliberately left out of that narrowing because
it exists for unattended builds with no human to engage mid-run — so
"decouple it too" isn't a free option here the way it was for the other
two. If this task's live re-attempt finds the reminder actually failing to
deliver for the same structural reason, that's a real decision point
(`steer`, a different mechanism, or accept the gap) that needs its own
resolution, not an assumed fix.

**Acceptance criteria.**

- A live run where `session_compact` fires while a goal is active, the
  reminder is confirmed delivered (not just queued), and the goal-tracking
  session recovers/continues correctly afterward.

---

## Suggested sequencing

Task 1 is done (superseded, see above). Task 2 can go first on its own
merits (real, still-open, well-evidenced) whenever picked up. Task 3 and 4
can run in parallel with each other (both are measurement/isolation tasks,
no shared files). Task 5 next (blocks Task 8). Tasks 6 and 7 are independent
and can slot in anywhere. Task 8 last (blocked on Task 5).
