# M5: three real features, Claude plans, the Studio builds (2026-10-05)

**Result: done.** 3 real features, 8 tickets. Claude bundled them with the
`buildgate-bundle` skill, and buildgate built them on local Qwen. **8/8 tickets
were accepted with no human code edits**: 6 on the first build round and 2
after buildgate's automatic conformity round. Re-plans per feature were 1 / 0 / 0.
There were **0 memory aborts**. Claude independently verified every accepted
result.

| Exit criterion (plan M5) | Target | Measured |
|---|---|---|
| Tickets accepted, no human code edits | >= 80% | **8/8 (100%)** |
| Re-plans per feature | <= 1 | merchant-rules 1, note-tags 0, habit-status-counts 0 |
| Memory aborts | 0 | **0** (128/128 Qwen requests completed in the window; no guard refusal) |

## Features

| Feature | Repo (lang) | Tickets | Criteria | Result branch (final ticket, cumulative) | Diff vs bundle commit (incl. gate-line deletions) |
|---|---|---|---|---|---|
| [merchant-rules](merchant-rules/spec.md): merchant -> category rules applied to existing and imported transactions | personal-budget-simplifier (Go) | 3 | 19 | `factoryd/personal-budget-simplifier-categorizes-i-e4d73c075588` | 6 files, +231/−21 |
| [note-tags](note-tags/spec.md): tags, `GET/PUT /api/notes/{id}/tags`, `?tag=` filter | notes-app (Python) | 3 | 15 | `factoryd/notes-app-can-search-notes-by-text-get-a-64043e34700d` | 5 files, +115/−21 |
| [habit-status-counts](habit-status-counts/spec.md): 30-day done/skip/rest/fail counts in `GET /api/v1/habits` | personal-assistant (Go) | 2 | 10 | `factoryd/get-api-v1-habits-reports-a-streak-a-con-5d9044e19dce` | 4 files, +49/−6 |

**Merged (2026-10-05):** merchant-rules as personal-budget-simplifier PR #8
(squash, `d463c37`) and note-tags locally into notes-app `main` (`3c41230`,
no GitHub remote; tags added to `spec/contract.md` and `ARCHITECTURE.md`). Both
merges drop `.bundle/`. The pre-PR review found one more bug: two concurrent
creates of the same merchant gave a 500 (UNIQUE constraint) instead of 409.
It was fixed with a regression test that fails 2/50 without the fix.
habit-status-counts is **not merged** (user decision). The worker ran with
`-open-pull-request=false`, so buildgate itself opened no PRs.
Each result is a local branch in the repo, stacked on the bundle commit
(`bundle/<feature>`: stubs, staged tests, `.bundle/`). Before merging, decide
whether to keep `.bundle/`: it is the frozen-test check and can be dropped
after merge.

## Runs (UTC, local = UTC-5)

```text
request / ticket                      round          time         outcome      tokens (Qwen)
merchant-rules (1st submit) 001       build          05:07-05:16  quarantined  91k   conformity: SQLite trim != Go TrimSpace
                            001       conformity1    05:16-05:30  quarantined  197k  conformity: one bind param per row (limit)
  -> re-plan 1: cancel, add tab/newline test, ticket step "match in Go, per-row UPDATE", resubmit
note-tags                   001       build          05:30-05:34  accepted     100k
                            002       build          05:34-05:45  quarantined  105k  conformity: id 2^63 -> OverflowError, not 404
                            002       conformity1    05:45-05:55  accepted     235k
habit-status-counts         001       build          05:55-06:02  accepted     72k
note-tags                   003       build          06:02-06:04  accepted     135k
habit-status-counts         002       build          06:04-06:12  accepted     118k
merchant-rules (2nd submit) 001       build          06:12-06:19  accepted     94k
                            002       build          06:19-06:27  quarantined  106k  conformity: top-level `null` body -> 400 "merchant is required"
                            002       conformity1    06:27-06:40  accepted     158k
                            003       build          06:40-06:45  accepted     58k
```

Wall time: 98 min for 12 build rounds, about 8 min per round. Review ran on
Codex (gpt-5.6-luna) at about $0.43 API-price estimate summed over the 12 rounds, billed to the
subscription. Qwen cost $0.

## Verification (Claude, every accepted ticket)

`bundle_check.py verify-run` checked each accepted ticket:
- the diff stays inside Allowed-Files;
- the ticket's acceptance tests differ from the bundle commit only by the deleted gate line;
- verify passes in a clean checkout, plus `go test -race` on the touched packages.

All 8 passed. Live HTTP probes against the final commits also passed:
- **merchant-rules:** a rule recategorizes `"AMAZON "`; duplicate -> 409; `null` and trailing data -> 400; delete -> 204; bad id -> 400.
- **note-tags:** tags normalize, `?tag=` combines with `q`, id `9223372036854775808` -> 404, delete removes the note's tags.

The code reads like each repo's own: `writeError`/`writeJSON`, sentinel
errors with `errors.Is`, the existing handler validation order in notes-app.

## Findings

1. **All three conformity failures were Claude's planning gaps, not executor
   errors.** Codex's conformity review caught each one, and the tests had
   missed each one:
   - **SQLite trim:** the ticket prescribed SQLite `lower(trim())`, which contradicts the spec's Go `TrimSpace`.
   - **Overflow id:** an out-of-range integer id reached SQLite and raised `OverflowError` instead of a 404.
   - **Null body:** the ticket prescribed Go `json.Unmarshal` into a struct, which accepts a top-level `null` body.

   Two were fixed by the automatic corrective round. The SQLite one needed the
   re-plan: the corrective fix (an `IN (...)` list) was flagged in turn,
   because the ticket still steered toward SQL. The skill's checklist now
   covers "prescribed steps must not contradict the spec", top-level `null`,
   and out-of-range ids.
2. **Stage gates and frozen tests worked.** 8/8 tickets ran their full
   verify on top of their predecessors, and none touched a test beyond its
   gate line. This resolves plan §1 without changing buildgate.
3. **`bundle_check.py` caught 2 bundle bugs before submit.** Two
   `Required-Content` literals were already present in the stubs, which would
   have quarantined correct builds. It also exposed a third that would never
   appear in a natural implementation.
4. **Re-planning inside buildgate goes to the planning role (Codex), not
   Claude.** Claude's re-plan path is: `cancel`, amend the bundle (new commit
   on `bundle/<feature>`, rebuilt `-ref` chain, `bundle_check.py check`),
   `submit` again. It took about 5 minutes.
5. **Hand-over steps still queue for a job slot and stop at
   spec_review/plan_review.** `run/auto_approve.sh` approves only the listed
   requests, so the night ran unattended. Claude's review is the bundle check.
6. **personal-assistant `origin/main` has a pre-existing data race.**
   `go test -race ./internal/service/` fails at `89760ec8`, in the
   agentic_search and group tests. It is not caused by this work. The
   repo's local `main` is also far behind `origin/main` (#201 vs #380), so
   the bundle was based on `origin/main`.
7. **Memory** (`run/memory.csv`, `summarize_memory.py`): lowest available
   19.2 GiB; Qwen peak 49 GiB; Colima VM 8.2/8 GiB; containers 1.3 GiB;
   factoryd 0.02 GiB.

## Step 3 (fix gaps)

The only gap step 2 found was in Claude's spec/ticket writing, so the fix
went into the skill (finding 1). It added:
- the checklist items (prescription vs spec contradictions, top-level `null`, out-of-range ids);
- the `Required-Content` rule and check;
- `bundle_check.py verify-run`.

Buildgate needed no change.

## Files

- `<feature>/spec.md`, `tickets/`, `coverage.md`, `bundle.json`: the bundles as submitted (merchant-rules after re-plan 1).
- `run/`: `preflight.txt`, `memory.csv`, `worker.log`, `auto_approve.sh` + log, `requests.txt`.
- Worktrees `~/buildgate/ws/{pbs-merchant-rules,notes-note-tags,pa-habit-status-counts}`; branches `bundle/<feature>` and `bundle/<feature>-ref` (reference implementations, not for merge) in each repo.
