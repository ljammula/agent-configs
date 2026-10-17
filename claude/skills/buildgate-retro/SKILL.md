---
name: buildgate-retro
description: >
  Retro over finished buildgate (factoryd) requests: read what went wrong and
  what the operator corrected, and propose changes to the target repository's
  environment — a check, a memory line, a navigation pointer, a glossary
  entry — or a buildgate defect. Use after reviewing a request's PR, after a
  reject at a gate, or over a walk's data dir ("retro walk4", "what should we
  change after these runs").
---

# Buildgate retro

Adapted from Matt Pocock's `retro` skill (MIT) for buildgate. The retro
proposes; it never writes to a target repository, memory, config or
buildgate. Every route it proposes already ends at a human gate.

## Inputs, per request

Read-only. Use the profile the requests ran under (`-config <profile>`).

| Source | Command or file | What it shows |
|---|---|---|
| State and transitions | `<data-dir>/requests/<id>/request.json` `history` (from, to, reason) | Halts, retries, rejects with feedback, amended scope, the operator handing over a spec or plan |
| Runs | `factoryd inspect <id>`; `<data-dir>/runs/<run>/run.json` (`state`, failing `gate_results`, `attempts`), `BUILD_REPORT.md`, `baseline_verify.json`, verify logs | Which check failed, corrective rounds, a baseline that was red before any model call |
| The operator's corrections | `git -C <workspace> log --format='%h %aI %an %s'` over the whole period of the requests (a fix made before a rerun predates the rerun's submit); edits to `.factory.yml`, `AGENTS.md`, `ARCHITECTURE.md`, tests. Commits whose body says "Auto-committed by the Temporal Worker" are the factory's, not corrections | What had to be fixed by hand to get a rerun through |
| Already fixed | `git log origin/main --since=<first request>` in buildgate | A buildgate defect fixed since the run is reported as fixed, not re-raised |
| The PR | `gh pr view <url> --json state,mergedAt,reviews,comments`; if merged, `git diff <result_sha> <merge commit>` | Review comments, and edits the operator made after the factory finished |
| Memory | `factoryd memory list -workspace <workspace>` | Lines in force and candidates, so nothing is proposed twice |

A request with no failure, no correction and a PR merged unchanged teaches
nothing: say so in one line and move on.

## Classify each finding

First decide whose fault it was:

| Cause | Meaning | Goes to |
|---|---|---|
| Model | The worker misread a clear spec, wrote a bug, ignored a rule it was given | The repo's environment (sort below), only if the same miss is likely again |
| Repository | The repo's commands, layout or instructions made the right result hard (wrong verify command, missing setup, an undocumented convention) | The repo's environment (sort below) |
| Spec or plan | A requirement was missing, ambiguous or contradictory, and the gate passed it | The bundle or drafting process: a completeness-checklist line in `buildgate-bundle`, or a design-guide `## Spec decisions` question |
| buildgate | The factory itself failed: sandbox, route, gate logic, a wrong triage sentence, a lost step | A buildgate issue, with the run ID and the one log line that shows it. Never a repo workaround |

Then sort a model or repository finding (Pocock's rule):

| Kind | Proposal |
|---|---|
| Mechanical: a test or linter could decide it | A check: a test in the repo's `verify_command`, a `.factory.yml` `gates:` entry, or a fix to `verify_command`/`setup` itself. Never prose for something a check can enforce |
| A judgement the worker needs and cannot find in the repo | One memory line: `factoryd memory add -workspace <repo> -run <run-id> "<line>"` |
| The worker looked in the wrong place | A navigation line in `AGENTS.md` ("Handlers are in `internal/api`; start there") |
| A term used two ways | A `## Glossary` entry in `ARCHITECTURE.md` (term in bold, one sentence, `_Avoid_:` the other words) |
| Team knowledge needed only by some tickets | A team skill, only if it is larger than a few lines (USAGE_REFERENCE "Worker skills") |

Prefer deleting to adding: a memory line or `AGENTS.md` line that a check now
enforces, or that no run needed, is a removal proposal. Context files help
only while they stay short.

## Output

One report per retro, in the notes repository
(`~/code/software-factory-notes/retro-<date>-<scope>.md`), never in the
target repository:

1. Scope: profile, requests, runs read, dates.
2. Per request, one line: outcome and whether it teaches anything.
3. Findings table: request/run, cause, evidence (file:line or one log line),
   proposal kind, the exact proposal (the command, the line, the check), and
   how to tell it worked next time.
4. Removals proposed.
5. Patterns across requests: the same cause in two or more requests counts
   more than one dramatic failure.

Each proposal is ready to apply as written. Ask the operator which to apply;
apply nothing yourself.
