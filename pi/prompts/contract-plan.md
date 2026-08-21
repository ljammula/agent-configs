---
description: Draft the API contract and acceptance-test oracle from a frozen spec (local draft only -- cloud review is a required, separate, human-triggered step)
argument-hint: "<pilot-dir, default: current directory>"
---

Draft `spec/contract.md` and `spec/acceptance/NNN/*` for the pilot dir
at `$1` (default: current directory), from the already-frozen
`spec/spec.md` and `spec/tickets/NNN-*.md`.

**This is the highest-stakes step in the whole pipeline, and this
template only does half of it.** A wrong contract or test oracle doesn't
fail loudly -- it silently certifies broken app code as correct later,
and there is no cheap automated way to check "was this test actually
right" the way ticket sizing or even spec disambiguation can be checked.
This template's output is a **local draft plus a mechanical self-check**
(does it compile/analyze), nothing more. **Cloud review and correction
of this draft is a separate, required, human-triggered step** -- a
human brings this draft to a cloud session (Claude Code or equivalent)
for semantic review before it is frozen. This template must never claim
or imply that step happened; it didn't run it and can't verify it did.

## 0. Preconditions -- refuse rather than guess

Check both before writing anything:

- `$1/spec/spec.md` must exist and its first line must NOT be
  `STATUS: DRAFT ...`. If it's missing or still draft, stop and report:
  "spec/spec.md is not frozen yet -- run `/spec-plan` and get human
  review of its Assumptions & Interpretations first." Do not proceed.
- `$1/spec/tickets/` must contain at least one `NNN-*.md` file. If not,
  stop and report that ticket decomposition hasn't happened yet.

## 1. `spec/contract.md`

Read every ticket's Goal and Required Changes to enumerate the full API
surface implied by the spec. For each endpoint: exact path, method,
request/response JSON shape with exact field names and casing (pick one
casing convention and use it everywhere -- this pipeline's prior real
bug, AGENTS.md gotcha #4, was a wire-format casing mismatch invisible to
round-trip decode), every status code with its error code and message
shape. Do not leave a field name or status code "TBD" -- if `spec.md`'s
"Open questions for the contract step" section flagged something as
undecided, decide it here (this step, unlike `/spec-plan`, is not the
one asking a human to review guesses line by line -- it hands the whole
draft to cloud review instead, so resolve what you can and note only
genuine forks in direction, not routine detail, as remaining questions).

## 2. `spec/acceptance/NNN/*`

For each ticket, write its acceptance-test slice sized to what that
ticket alone must turn green -- not the whole app's behavior, just this
ticket's. Follow the conventions already established in this pipeline's
real acceptance suites (read an existing pilot's `spec/acceptance/*/`
for the shape if one exists, e.g. `~/code/test-bed/budget-pilot/spec/
acceptance/`):

- **Go slices**: black-box `httptest`/HTTP-client tests hitting the real
  router, one `MANIFEST.md` naming what the slice verifies and what it
  depends on, a shared `helpers.go` in the first Go slice only (later
  slices reuse it once staged), a `go.mod` in the first Go slice only
  (`module <app>/acceptance`, matching what later slices will share once
  staged into one `workspace/acceptance/` directory -- do not add a
  `go.mod` to every slice, only the first). At least one raw-bytes JSON
  assertion per endpoint (gotcha #4 again -- a decoded-struct comparison
  can hide a casing bug a raw-bytes check catches).
- **Dart slices**: widget tests keyed to the ticket's screen, one
  `MANIFEST.md`, rendered-text assertions where strings mix literals and
  interpolation written carefully (see the self-check below for exactly
  the bug class to avoid).
- Every non-2xx response gets an assertion on both status code and the
  exact error code/message shape from `contract.md` -- never just the
  status code alone.

## 3. Mechanical self-check -- do this before finishing, not instead of cloud review

This catches syntax-class bugs a review pass can miss on a read-through
(an unescaped `$` inside a Dart string literal, a Go type error) --
cheap and deterministic, but it says nothing about whether a test
asserts the *right* behavior. Run it for real and paste the actual
output; do not report this step done without having run it.

**Go**: assemble everything staged so far into a scratch module and vet
it -- e.g. `mkdir -p /tmp/contract-check/acceptance && cp
spec/acceptance/*/*.go /tmp/contract-check/acceptance/ && cp
spec/acceptance/*/go.mod /tmp/contract-check/acceptance/ 2>/dev/null;
cd /tmp/contract-check/acceptance && go vet ./... && go build ./...`.
Fix anything that fails to compile, then re-run until clean.

**Dart**: this needs a real Flutter project context to resolve
`package:flutter_test`/widget imports -- a bare `dart analyze` on an
isolated file will false-positive on unresolved imports that have
nothing to do with the actual test. If a scratch Flutter project is
cheap to create in this environment (`flutter create /tmp/contract-check
--project-name scratch`, copy each Dart slice's test file into
`/tmp/contract-check/test/`, run `flutter analyze`), do that and fix
what it finds. If creating one is not practical here, say so explicitly
in the report below rather than silently skipping the check -- an
unflagged gap is worse than a flagged one.

## 4. Report

Print:
- The full list of endpoints drafted into `contract.md`.
- Ticket count and which ticket each acceptance slice covers.
- The self-check's real output (or an explicit note that the Dart
  self-check was skipped and why).

Then this exact banner, and stop:

```
CLOUD REVIEW REQUIRED before this is frozen.
This is a local draft plus a mechanical syntax check -- nothing here has
verified the contract or tests assert the RIGHT behavior, only that they
compile. Bring spec/contract.md and spec/acceptance/ to a cloud session
(Claude Code or equivalent) for semantic review and correction. Do not
run `make run` against this output until that review has happened.
```
