---
name: buildgate-bundle
description: >
  Turn a feature into a buildgate (factoryd) ticket bundle that the local model
  can execute unattended: spec in buildgate's skeleton, NNN.spec.md tickets of
  <=150 changed lines, pre-created stubs, acceptance tests staged per ticket and
  frozen, plus the automatic bundle checks. Use when planning work for the Mac
  Studio / buildgate / "the factory" to build, before `factoryd submit
  -spec-file -plan-dir`.
---

# Buildgate bundle

Claude is the planner; local Qwen (pi, in buildgate's sandbox) is the
executor. The executor is good at filling in well-specified stubs and bad at
guessing requirements, so **the bundle carries every requirement the tests
check**. A bundle is done only when `bundle_check.py` passes.

## Facts about buildgate this design depends on

- Tickets of one request build **in order**; ticket N starts from ticket N-1's
  accepted commit; ticket 1 starts from the workspace's `HEAD` when it builds.
  A failed ticket quarantines the request and the later tickets do not run.
- Every ticket's `Verify-Command:` must equal the request's verify command
  exactly, and it runs in full for every ticket (canonical verify, then the
  full-suite command). There is no per-ticket test selection.
- Nothing in buildgate freezes test files; editing a test even satisfies
  `tests_added`. Diff scope (`Allowed-Files`) is enforced.
- `Required-Content:` = a literal that some `Required-Changed-Files` file must
  contain afterwards and did not contain at the base commit.
- The agent rarely commits; buildgate commits for it. Do not rely on pi.
- Sandbox: no network, no env vars, Linux. Python: no `__pycache__` in the
  tree (set `PYTHONDONTWRITEBYTECODE=1` in the verify path).

Hence the two mechanisms below: **stage gates** (tests for ticket N are
committed up front but dormant until ticket N) and a **frozen-test check**
appended to the verify command.

## Layout

```
<plans>/<feature>/            # in agent-configs/plans/, committed
  spec.md                     # buildgate skeleton
  tickets/001.spec.md ...     # one per ticket, dependency order
  coverage.md                 # criterion -> ticket -> test names
  bundle.json                 # repo, worktree, branches, verify command
<repo worktree> (git worktree, branch bundle/<feature>)
  bundle commit: stubs + staged acceptance tests + .bundle/
  ref branch bundle/<feature>-ref: one commit per ticket (Claude's reference
  implementation, never submitted, used only by bundle_check.py)
```

Use a separate `git worktree` per feature as the buildgate workspace
(`~/buildgate/ws/<repo>-<feature>`) so the user's checkout is untouched and
`HEAD` stays on the bundle commit all night.

## Steps

1. **Read the code first.** Find the conventions the feature must follow:
   error helpers, response shapes, naming, test style, how existing tests
   build fixtures. Tickets reference them by name.
2. **Write `spec.md`** in this exact skeleton (each heading on its own line,
   in order): `# Spec`, `## Problem`, `## Scope`, `## Non-goals`,
   `## Affected services and packages`, `## Acceptance criteria` (numbered
   list), `## Risks`, `## Open questions` (write "None."). Each criterion is
   one checkable behaviour with exact values. Go through the
   **completeness checklist** below for every input and output.
3. **Split into tickets** (`tickets/001.spec.md`, ...): one package or one
   layer each, <=150 changed lines, dependency order, every criterion covered
   by >=1 ticket. Prefer store/domain -> handler -> wiring.
4. **Write stubs** for every new function/type/file the tickets touch, with
   final signatures and doc comments; bodies return a zero value plus a
   "not implemented" error (Go) or `raise NotImplementedError` (Python). Route
   registration and other wiring that needs only the signature can go in the
   bundle commit, so tickets stay inside one file set.
5. **Write the acceptance tests** before any implementation, one test file
   per ticket (`*_t001_test.go`-style naming is fine, or the natural file
   name), each test named after the criterion it checks. Include
   **malformed-input cases** for every input-validation criterion.
6. **Stage the tests** — first line(s) of each ticket's test file:
   - Go: `//go:build bundle_tNNN` then a blank line, then `package ...`.
   - Python unittest: right after the imports,
     `raise unittest.SkipTest("bundle: enabled by ticket NNN")`.
   - pytest: `pytest.skip("bundle: enabled by ticket NNN", allow_module_level=True)`.
   Ticket NNN's first step deletes exactly that line.
7. **Freeze the tests**: copy `check-frozen.sh` from this skill to
   `.bundle/check-frozen.sh` in the repo, run
   `python3 bundle_check.py freeze --repo <wt> <test files...>` to write
   `.bundle/frozen-tests.sha256` (hash of each file with gate lines and blank
   lines removed), and append `&& sh .bundle/check-frozen.sh` to the verify
   command (prepend when the command starts with `cd`, e.g.
   `sh .bundle/check-frozen.sh && cd backend && go vet ./... && go test ./...`).
8. **Commit** stubs + staged tests + `.bundle/` as one commit on
   `bundle/<feature>` (message: `bundle: <feature> stubs, staged acceptance tests`).
9. **Reference implementation** on `bundle/<feature>-ref`: one commit per
   ticket, each touching only that ticket's Allowed-Files and removing only
   that ticket's gate line. Write it as the executor would — from the ticket
   text only. If writing it needs knowledge the ticket lacks, fix the ticket.
10. **Run the checks** (`python3 bundle_check.py check --bundle <plans>/<feature>`)
    and fix until it passes. Then `factoryd check-ticket` runs inside it.
11. **Hand over**: `factoryd submit -verify-command '<cmd>' -spec-file spec.md
    -plan-dir tickets/ <worktree>`, then `factoryd approve <id>` at
    spec_review and plan_review (Claude's own review is the bundle check).

## Ticket format

```
Verify-Command: <the request's verify command, byte-identical>
Allowed-Files: <impl files>, <this ticket's test file>
Required-Changed-Files: <impl files>, <this ticket's test file>
Required-Content: <one literal per line that only a real implementation adds, optional>

## Goal
## Plan
### Files to touch
### Steps
1. In `<test file>`, delete the line `<gate line>` and change nothing else in that file.
2. ...concrete steps naming existing helpers, sentinel errors, exact messages...
N. Run `<verify command>` and make it pass. Commit.
### Tests to add
- none new: `<test file>` holds this ticket's acceptance tests (<names>); do not modify them beyond step 1.
### Acceptance criteria covered
- 3
- 4
## Out of scope
```

Rules: headers exactly as spelled (`factoryd check-ticket` flags near
misses); `Acceptance criteria covered` is one number per list item; the test
file is in both Allowed-Files and Required-Changed-Files (that is what
satisfies `tests_added` — no `Tests-Required: no` line); never ask the
executor to edit a test beyond deleting the gate line. A `Required-Content`
literal must be absent from at least one Required-Changed-File at the
ticket's base (a name the stub already declares can never satisfy it);
prefer a literal only the real implementation contains (a table name, a
message string, a called function).

## Completeness checklist (what specs forget)

From the phase-0 battery (3 of 12 real tickets were unfair) and M4a:

- Every status code and **exact** error text/code the tests assert.
- **Malformed input variants** for each input: not JSON, **trailing data after
  valid JSON**, a **top-level `null`** (Go `json.Unmarshal` into a struct
  accepts it), a non-object (`[]`), wrong JSON type, `null` field, missing key,
  empty/whitespace string, zero, negative, too large, non-integer path id,
  **out-of-range integer id** (2^63: Python sqlite3 raises `OverflowError`),
  unknown id.
- Ordering of every list (and the tie-break), and empty-result shape (`[]`, not `null`).
- Idempotency / repeat semantics (second identical call: no-op? 409? last write wins?).
- Which fields change and which must stay unchanged; side effects on other rows.
- Precedence when two errors apply (e.g. unknown id and bad body: which wins).
- Normalisation (case, trimming, dedupe) and whether stored value is raw or normalised.
- Boundaries: inclusive/exclusive windows, time zones, date formats.
- **Steps must not contradict the spec.** When a ticket prescribes an
  implementation (exact SQL, a library call), check it against every spec
  rule: M5 ticket "match with SQLite `lower(trim(x))`" contradicted "normalize
  with Go `strings.TrimSpace`" (SQLite trims only spaces, not tabs/newlines);
  the reference implementation copied the bug and the tests missed it. Test
  the edge the prescription would get wrong, or don't prescribe.
- Tests must not over-constrain implementation shape (call counts, specific
  helper calls, exact SQL, mocks that only accept one call signature). Test
  observable behaviour only.
- No contradiction between ticket text and tests (e.g. "do not edit tests"
  when the fix must edit one).

## bundle.json

```json
{
  "feature": "merchant-rules",
  "repo": "~/code/personal-budget-simplifier",
  "worktree": "~/buildgate/ws/pbs-merchant-rules",
  "branch": "bundle/merchant-rules",
  "ref_branch": "bundle/merchant-rules-ref",
  "verify_command": "sh .bundle/check-frozen.sh && cd backend && go vet ./... && go test ./...",
  "tests": {"001": ["backend/internal/store/merchant_rule_test.go"], "002": ["..."]}
}
```

## What bundle_check.py checks

1. `factoryd check-ticket` passes for each ticket; every ticket's
   Verify-Command equals `verify_command`; spec skeleton headings in order.
2. Coverage: every spec criterion is covered by >=1 ticket and appears in
   `coverage.md` with >=1 test name that exists in that ticket's test files;
   each ticket's test files are in its Allowed-Files and Required-Changed-Files.
3. Each ticket's test file carries exactly its gate line; the frozen manifest
   matches.
4. On the bundle commit: verify passes (stubs build, old suite green, staged
   tests dormant).
5. Fail-on-stub: for each ticket N, bundle commit + only ticket N's gate
   removed -> verify **fails**.
6. Reference chain: at each `-ref` commit k, verify **passes**, every
   `Required-Content` literal is added by it (absent before), and commit k
   changes only ticket k's Allowed-Files and adds at most 150 changed lines.

After execution, verify each accepted result yourself: diff only in
Allowed-Files, test files differ from the bundle commit only by the removed
gate line, verify (and the full-suite command) green in a clean checkout.
