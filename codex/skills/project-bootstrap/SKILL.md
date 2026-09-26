---
name: project-bootstrap
description: Set up a new (or newly adopted) repo with the working conventions proven on software-factory — AGENTS.md, verify/live-smoke targets, notes repo, plan and follow-up templates.
---

# Project bootstrap

Set up the scaffolding that let software-factory run long agent-driven work
without losing track. Ask the user before creating a repo or anything outside
the project directory.

## Steps

1. **Read first.** Inspect the repo: languages, existing build/test commands,
   CI, docs. Everything below adapts to what exists; nothing overwrites it.
2. **`AGENTS.md`** (with `CLAUDE.md` containing only `@AGENTS.md` for Claude Code), from the
   skeleton below. Done when every command in it has been run once and works.
3. **One verify command.** A `make verify` (or the stack's equivalent) running
   format-check, lint/vet, and the full unit suite. If the repo spans several
   toolchains, say in `AGENTS.md` which command covers which.
4. **One live command.** A `make live-smoke` stub that drives the real entry
   point end to end (see the `live-validation` skill). A stub that exits 1
   with "not implemented yet" beats no target.
5. **Notes repo.** Propose a sibling `<project>-notes` repo for dated,
   closed-out material: `plan-YYYY-MM-DD-<topic>.md`,
   `proving-ground-YYYY-MM-DD-<topic>.md`, `follow-up-YYYY-MM-DD-<topic>.md`,
   incident write-ups. The main repo holds only current state.
6. **Normative docs — only if the project has a trust boundary** (runs untrusted
   code, handles credentials, gates releases). See "Claims pattern" below.

## AGENTS.md skeleton

```markdown
# AGENTS.md
## What this is          <!-- 3 lines; point at README for architecture -->
## Before changing anything here   <!-- normative docs, if any; the risky subsystems -->
## Repo layout           <!-- table: path | what it is; flag runtime-state dirs -->
## Build, test, verify   <!-- exact commands per toolchain -->
## Live validation       <!-- when live-smoke is required before merge -->
## Patterns that affect how you write code  <!-- the 5-6 non-obvious cross-cutting rules -->
## Adding a <recurring feature type>        <!-- numbered wiring checklist an agent can self-verify -->
## Conventions           <!-- only what the code and config don't already say -->
```

One canonical instruction file: `CLAUDE.md` is `@AGENTS.md`; another CLI's
file (Copilot, Codex) points at it and adds only its own quirks. If the app
is localised, one line: every user-facing string goes into *all* locale files.

`AGENTS.md` may be read by sandboxed or offline agents, so it holds only what is
true for every reader; host-only tooling notes go in the README's dev section.

## Plan template

```markdown
# <Topic> plan (YYYY-MM-DD)
## Goal          <!-- one sentence, user-visible outcome -->
## Exit bar      <!-- checkable: "walk N/N", "0 hand edits", "<15 min to first PR" -->
## Findings      <!-- numbered F1..Fn, carried across runs -->
## Phases        <!-- one PR per phase; each names its own check -->
## Out of scope
```

## Follow-up template

For a real finding that isn't a mechanical fix now (judgement call, touches
many subsystems, no realistic trigger yet):

```markdown
# Follow-up: <gap> (YYYY-MM-DD)
Origin: <PR/review/run>. Gap: <what is wrong, concrete scenario>.
Why not now: <reason>. Candidate fixes: 1..3. Decision: none yet.
```

## Claims pattern

- `safety-contract.md`: trust boundaries, threat model, numbered invariants on
  exact lines (`SC-001 — ...`).
- `CLAIMS.md`: every normative claim → the test that enforces it, test names in
  backticks.
- A test parses both: required headers present, every invariant line intact,
  every backticked test name resolves to a real test.

State in the docs what the parsing test proves: that the claim and its test
*exist*, not that the test verifies the invariant. That link is human
judgement; re-audit it periodically — software-factory found two
"real-engine-validated" tests that had proven nothing for weeks.

## Design principles for tools that run unattended

- **The system narrates; silence is a bug.** At any moment a user can see what
  is waiting on them, what is stuck, where each job is, and why it stopped, in
  one sentence with exactly one next action. Nothing changed in N minutes →
  say why.
- **Surface the real error.** Every failed step keeps its actual log output;
  multi-check failures report all failing checks, not the first.
- **Record and gate are separate.** A step that records evidence does not
  also decide pass/fail unless that is an explicit design choice.
- **Watch the human half of the loop.** A pipeline with a human-approval step
  alerts when the human side goes stale; its own metrics stay green forever
  otherwise. Scheduled jobs are judged by their own state file, not by a
  notification having been posted, and write a `BLOCKED:` artifact and stop
  when required input is missing.
- **A `doctor` command** checks the same config and state the real run will
  use, shares code with the real gate, and offers a fix.
