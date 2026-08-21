# Trim local-harness prompt bloat — plan

**Date:** 2026-08-21. **Status: plan only — nothing below is built yet.**
**Trigger:** the calculator-pilot validation run this session hit
`/contract-plan`'s `context_length_budget_exceeded` twice (fixed same day,
`a86a980`, on `feat/goal-pilot-implementation`) — one instance of a class
of problem this plan addresses systemically rather than one template at a
time.

## Why this matters, in numbers already on record

- **This machine's real budget is small and fixed.** `AI_STACK_HOST`'s
  local route: `max_kv_size=65536`, active request budget **49,152
  tokens**, compaction/rejection threshold **~46,694**. This doesn't move
  without a hardware/model change — every other number below has to fit
  inside it.
- **Historical baseline tax: ~7,036 tokens** measured before
  `stack-skill-overlay.ts` existed — of which ~1,790 tokens was 8 stack
  skills loading into every session regardless of repo, now fixed by
  routing skills through `resources_discover` instead of the global system
  prompt (`pi/README.md`). No re-measurement has been done since that fix
  landed — the current real baseline is unknown, not "known-lower."
- **Paired-battery overhead: harness prompt tokens ran +147% to +212.6%**
  over a no-harness baseline across multiple studies
  (`pi-harness-history.md`, `pi-harness-validation-status.md`'s
  `quality-gate.ts` nine-pair report). Completion-token overhead was much
  smaller (+11.7% to +39.8%) — the bloat is overwhelmingly on the input
  side, not the output side.
- **Live today:** `/contract-plan`'s first turn alone consumed
  ~46,838–48,221 prompt tokens — **95–98% of the entire budget consumed
  before the model produced a single token** — twice, on two different
  scope sizes, because trimming the *pilot's own* ticket/spec content
  didn't touch the actual cause (an instruction to read a sibling pilot's
  full acceptance suite for reference). Fixed today, but it's proof the
  ceiling is close enough to hit by accident, not just in adversarial
  testing.

## Sources of bloat, sized against the current repo

Every number below is a raw byte count from this session (`wc -c`), not a
token count — treat `÷4` as a rough token estimate, not exact.

| Source | Size | Loaded when |
|---|---|---|
| `AGENTS.md` | 7,441 B (~1,860 tok) | every session, unconditionally |
| `karpathy-guardrail.ts`'s appended block | 1,436 B (~360 tok) | every session, unconditionally (`before_agent_start`) |
| `full-stack-dev.ts`'s workflow prompt | 2,189 B (~550 tok) | every session, unconditionally |
| `stack-router.ts` + `stack-skill-overlay.ts` | 5,924 B combined | every session (routing logic), but the skills it *gates* only load when matched — this is the already-fixed case |
| `/spec-plan` template | 9,097 B (~2,275 tok) | only when invoked, but in full, no partial load |
| `/contract-plan` template | 8,528 B (~2,132 tok) | only when invoked, but in full, no partial load |
| `karpathy-guidelines` skill | 2,922 B (~730 tok) | every session via the guardrail extension above — this is a skill made unconditional by a different mechanism than the 8 stack skills were, so `stack-skill-overlay.ts`'s fix doesn't cover it |
| Largest individual skill (`testflight-cut`) | 9,411 B (~2,353 tok) | only when relevance-matched or explicitly invoked |

Two things stand out against the paired-battery finding (+147–212% prompt
tokens, output side barely moved):

1. **The unconditional slice (`AGENTS.md` + guardrail + full-stack-dev ≈
   2,770 tokens) is paid on every single session**, including trivial
   ones — this is pure per-session tax, not amortized against any
   particular task's value.
2. **The two large prompt templates are each ~4.3–4.6% of the entire
   request budget by themselves** (2,132–2,275 tokens out of 49,152 —
   corrected from an earlier draft of this section, which divided raw
   *bytes* by the token budget instead of the already-converted token
   estimate two paragraphs up; Codex review of PR #38 caught this),
   before any spec/ticket/reference content is added. Small on their own,
   but `/contract-plan`'s overflow this session is exactly what happens
   when a template this size adds one more unbounded read on top — the
   static template share isn't the risk, the *unbounded add-on* is (see
   Phase 3).

Already fixed and out of scope for new work here: the 8 stack skills
(`stack-skill-overlay.ts`, done), `rtk-rewrite.ts`'s bash-output trimming
(60–90% already), `quality-gate.ts`'s own detail capture (already
`.slice(0, 3000)` bounded, not unbounded).

## Phases

### Phase 0 — Re-measure the real current baseline

The ~7,036-token figure predates `stack-skill-overlay.ts`; using it to
plan further cuts risks optimizing against a stale number. Cheapest
possible measurement: a trivial `pi -p "say hi"` session against
`ai-stack-local`, reading the API response's own `usage.prompt_tokens` on
the first turn (no task complexity, isolates pure harness overhead). Run
it 3x for stability, record the number and the extension/skill set active
at the time, and put it in `pi-harness-validation-status.md` as the new
baseline other work is measured against. Everything below is sized in
relative terms (cut X, saves ~Y%) so it doesn't depend on getting this
exact number first, but Phase 5's regression guard does need a real
number to set its threshold against.

### Phase 1 — Stop double-paying for `karpathy-guidelines` on pi

**Status: implemented, PR #38.** The mechanism this section originally
described was wrong (Codex review of PR #38 caught it) — corrected here
rather than left stale:

`karpathy-guardrail.ts` does **not** append the skill's full 2,922-byte
`SKILL.md` unconditionally; it appends a short, inline ~415-byte (~104
token) summary via `before_agent_start`. The actual redundant tax was a
different mechanism: `install.sh` *also* globally linked
`karpathy-guidelines` into `~/.pi/agent/skills/` (via `PORTABLE_SKILLS`,
the same list Claude/Codex use), so pi's own relevance-matching
advertised the skill's name+description a second time — on top of the
guardrail's already-unconditional coverage — for guidance the session
already had. Routing it through `resources_discover` (this section's
original option 1) wouldn't have fixed that: the global link itself was
the redundant path, not the routing mechanism.

Implemented fix: `install.sh` now excludes `karpathy-guidelines` from
pi's global skill-linking list (`PI_PORTABLE_SKILLS`, `PORTABLE_SKILLS`
minus that one skill) while leaving it linked for Claude/Codex, whose
Skill tool is their only enforcement mechanism for it. Verified live:
`ls ~/.pi/agent/skills/` no longer lists `karpathy-guidelines` after
re-running `install.sh`; `karpathy-guardrail.ts`'s summary append is
unchanged and still the sole pi-side enforcement path. This is a
structural fix (removing a duplicate advertisement), not a token-savings
claim resting on the ~730-token figure this section originally cited —
that figure conflated the skill's full byte size with what was actually
being paid twice.

### Phase 2 — Prompt-template diet: split human rationale from model instructions

**Status: implemented, PR #38**, with one correction to the approach
originally proposed here (Codex review of PR #38 caught it):

`/spec-plan` and `/contract-plan` currently mix two audiences in one
file: instructions the model must follow, and rationale/history explaining
*why* to a human reading the source (e.g. contract-plan.md's own
multi-paragraph explanation of why cloud review is required, or
spec-plan.md's explanation of why the scaffold step uses heredocs). The
model has to pay token cost for the rationale paragraphs even though only
the imperative sentences are actionable.

~~Concrete move: extract the "why" prose into an adjacent comment file
or a `<!-- -->`-style block the model is told to skip.~~ **This
alternative does not work and must not be used**: pi loads a prompt
template as plain file content with no repository preprocessor, so an
HTML comment the model is merely *told* to skip still gets sent as
prompt text and still consumes context — "told to skip" is not "not
transmitted". Any rationale that needs to stay out of the model's
context has to either live in a file that is never loaded as part of the
prompt, or go through an actual stripping/generation step (author one
file, ship a generated, trimmed copy) — a real build step, not a comment
convention.

Implemented instead: rationale prose was deleted outright from
`spec-plan.md` and `contract-plan.md`, keeping every imperative
instruction, exact required string (heredocs, commit message formats,
banners), and the load-bearing ambiguity-flagging rationale (see risk
paragraph below) verbatim in the one authored file that is the prompt.
Result: ~8% smaller (`spec-plan.md`) and ~10% smaller
(`contract-plan.md`) — deliberately conservative versus this section's
original 20–30% estimate, prioritizing "quality not lost" (explicit user
steer during implementation) over chasing the larger number.

Risk this must be checked against: some of that "rationale" is load-bearing
context the model uses to resolve ambiguity correctly (e.g.
`/spec-plan`'s explanation of *why* every guess must be flagged, which
plausibly affects whether the model actually flags guesses rather than
silently absorbing them). Cutting this needs a before/after comparison on
a real drafting run, not just a byte-count win — a smaller prompt that
produces worse specs is a net loss. Live-validated on a calculator-app
pilot (`goal_pilot.py`, single "add two numbers" scope): the trimmed
`/spec-plan` produced a 10-item Assumptions & Interpretations list, clear
Non-goals/Open-questions split, and correct tracer-bullet ticket
decomposition at 9,390 first-turn prompt tokens; the trimmed
`/contract-plan` produced an exact wire contract and a working acceptance
suite at 8,537 first-turn tokens (~26,351 peak) — both far under the
49,152-token budget, no quality regression observed.

### Phase 3 — Ban the "read a whole reference file/dir" instruction pattern

Today's bug was one instance of a class: a template telling the model to
read an *unbounded* external artifact (a sibling pilot's entire
`spec/acceptance/`) for pattern-matching, with no size ceiling on what
that artifact could grow to. The fix applied today (delete the
instruction, inline the shape explicitly) works because the shape was
small and enumerable. General rule going forward, to check into every
existing and future prompt template:

- Never point the model at a whole directory or file whose size isn't
  bounded by this repo's own conventions (a growing pilot's acceptance
  suite, a growing `PROGRESS.md`, an arbitrarily large sibling project).
- If a reference example is genuinely useful, inline a fixed, small
  excerpt directly in the template (as Phase 2's contract-plan fix now
  does), or point at one specific small file (a single `MANIFEST.md`,
  not a directory) with an explicit expected-size note.
- Add this rule to `pi/AGENTS.md` or wherever this repo's own
  prompt-template-authoring conventions live (`writing-for-agents` skill
  territory), so it's checked at review time for new templates, not
  re-discovered live once a template exists and grows.

Audit scope: `spec-plan.md`, `contract-plan.md` (already fixed),
`docwriter.md`, `l10n.md`, `wire.md`, `review.md`, `before-done.md` — six
more templates to check, likely cheap since most are short (756 B–1.2 KB).

### Phase 4 — Headless-invocation budget headroom check

`goal_pilot.py` invokes both large templates headlessly, with **no human
present to notice a silent `context_length_budget_exceeded`** — exactly
the failure mode today's bug produced. Independent of trimming the
templates themselves (Phases 1–3), `goal_pilot.py` should treat this
failure class as a distinct, retryable-or-halt-worthy outcome rather than
an opaque `pi` non-zero exit: detect the specific error shape in the `pi
--print --mode json` output and surface it in `VERDICT.md`/halt records
as "prompt budget exceeded" rather than folding it into a generic
build/implementation failure. This is a `goal_pilot.py`-side hardening
item, cheap, and independent of whether Phases 1–3 land — it makes the
*next* budget bomb (a new template, a new large reference file) fail
loud instead of silent, which is the actual risk this whole plan exists
to reduce, not just today's specific instance.

### Phase 5 — Regression guard: a token-budget check in CI/tests

The concrete, mechanical follow-up to today's bug: nothing currently
stops a future template edit from reintroducing an unbounded read or
just growing past a safe fraction of the real budget. Add a test
(alongside `pi/tests/*.test.ts` / `pi/tests/*_test.py`) that:
- Loads every `pi/prompts/*.md` template plus `AGENTS.md` plus every
  unconditionally-injected extension string, sums a rough token estimate
  (`chars / 4` is fine for a guard, doesn't need real tokenization), and
  fails if any single template's total (template + baseline tax) exceeds
  some fraction of the real budget from Phase 0's measurement — e.g. 60%,
  leaving headroom for the actual spec/ticket/contract content each
  invocation adds on top.
- This is a cheap static check, not a live model call — it can't catch
  every dynamic case (a template that reads a file whose size varies at
  runtime, like today's bug) but it does catch the static baseline
  creeping upward again, and it's a natural place to note "this template
  reads external files, size not statically checkable" as a comment
  flagging Phase 3's manual-audit responsibility instead.

## Prioritization

Phase 4 first — cheapest, independent of the others, and directly closes
the "silent failure in an unattended `goal_pilot.py` run" risk that
matters most given `goal_pilot.py` is meant to run headless. Phase 3
(audit + convention) next — cheap, prevents recurrence of exactly today's
bug shape. Phase 0 (re-measure) before Phase 5 (regression guard), since
the guard needs a real number. Phases 1–2 (system-prompt/template diet)
are the highest-value, highest-risk items — real token savings but need
live before/after comparisons to confirm no quality regression, so they
follow this repo's existing adoption-bar convention (a live trial before
"adopted" language, not a size-count alone) rather than landing on byte
count as sufficient evidence.

## Explicitly out of scope

- Raising `max_kv_size`/the model's own context window — a different
  lever (hardware/model config), not a prompt-content problem, and not
  this plan's to solve.
- Any change to pi's own core system prompt (upstream, not this repo's
  to edit).
- Re-litigating the RTK/local-execution-harness decisions already settled
  (`rtk-keep-as-is.md`) — bash-output trimming is already adopted and out
  of scope here.
- Cloud-side (Claude/Sonnet) prompt size — this plan is scoped to the
  local-model budget, which is the actual hard constraint; cloud sessions
  don't hit a 49,152-token wall.

## Open questions for whoever picks this up

- Whether Phase 1's `karpathy-guidelines` relevance-matching concern is
  still accurate on the current model/pi version, or was true only for
  an earlier one — worth a quick live check before assuming option 2
  (shrink instead of gate) is necessary.
- Whether Phase 2's rationale/instruction split is worth doing as a
  source-file convention (two files per template) or just a stripped
  runtime copy generated from one authored file — the latter avoids
  drift between "what's authored" and "what's sent," at the cost of a
  small build step.
