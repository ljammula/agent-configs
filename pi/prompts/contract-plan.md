---
description: Draft the API contract and acceptance-test oracle from a frozen spec (local draft only -- cloud review is a required, separate, human-triggered step)
argument-hint: "<pilot-dir, default: current directory>"
---

Draft `spec/contract.md` and `spec/acceptance/NNN/*` for the pilot dir
at `$1` (default: current directory), from the already-frozen
`spec/spec.md` and `spec/tickets/NNN-*.md`.

**Resolve `$1` to a concrete path before running anything below:** if
`$1` was not given, set it to `$(pwd)` -- do not let it stay empty and
flow into the self-check commands below as-is, which would expand
`"$1"/spec/acceptance/*/*.go` to a root-relative glob that matches
nothing instead of the current directory's acceptance slices.

**This is the highest-stakes step in the pipeline, and this template
only does half of it.** A wrong contract or test oracle doesn't fail
loudly -- it silently certifies broken app code as correct later. This
template's output is a **local draft plus a mechanical self-check**
(does it compile/analyze), nothing more. **Cloud review and correction
of this draft is a separate, required, human-triggered step** -- this
template must never claim or imply that step happened; it didn't run it
and can't verify it did.

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
casing convention and use it everywhere -- a wire-format casing mismatch
is invisible to round-trip decode), every status code with its error
code and message shape. Do not leave a field name or status code "TBD"
-- if `spec.md`'s "Open questions for the contract step" section flagged
something as undecided, decide it here: resolve what you can and note
only genuine forks in direction, not routine detail, as remaining
questions.

## 2. `spec/acceptance/NNN/*`

For each ticket, write its acceptance-test slice sized to what that
ticket alone must turn green -- not the whole app's behavior, just this
ticket's. Follow the conventions below -- **do not** read a sibling pilot's
`spec/acceptance/` for reference: an unbounded directory like that can
overflow the local model's context budget on the very first turn, and
this template runs headless with no human present to notice a silent
failure. Everything the shape actually requires is spelled out
explicitly below instead:

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
it. Resolve every path from `$1` (default: current directory) rather
than the shell's cwd, and start from a clean scratch dir each run --
files left over from a previous draft or a different pilot in
`/tmp/contract-check` would otherwise get vetted/built alongside this
one and produce false failures (or worse, a false pass).

Copy per-slice, not with a single flattening glob: two slices can
legitimately pick the same ordinary basename (two `handler_test.go`), and
`cp spec/acceptance/*/*.go` into one flat directory silently drops one of
them -- the check then reports clean having never compiled the dropped
file. Prefix every non-module file with its slice number, the same
convention `ticket_runner.py` stages with at build time:

```
rm -rf /tmp/contract-check && mkdir -p /tmp/contract-check/acceptance
for d in "$1"/spec/acceptance/*/; do
  n=$(basename "$d")
  for f in "$d"*.go "$d"go.mod "$d"go.sum; do
    [ -e "$f" ] || continue
    b=$(basename "$f")
    case "$b" in
      go.mod|go.sum) cp "$f" /tmp/contract-check/acceptance/"$b" ;;
      *) cp "$f" /tmp/contract-check/acceptance/"${n}_${b}" ;;
    esac
  done
done
cd /tmp/contract-check/acceptance && go vet ./... && go build ./...
```

Fix anything that fails to compile, then re-run until clean.

**Dart**: this needs a real Flutter project context to resolve
`package:flutter_test`/widget imports -- a bare `dart analyze` on an
isolated file will false-positive on unresolved imports that have
nothing to do with the actual test. Use a separate scratch dir from the
Go check above (`/tmp/contract-check-dart`), and remove it first if it
already exists, for the same reason -- a prior draft's leftover test
files would otherwise get analyzed alongside this one. Same basename
collision risk as the Go check, and the same fix -- prefix each copied
test file with its slice number:

```
rm -rf /tmp/contract-check-dart
flutter create /tmp/contract-check-dart --project-name scratch
for d in "$1"/spec/acceptance/*/; do
  n=$(basename "$d")
  for f in "$d"*.dart; do
    [ -e "$f" ] || continue
    cp "$f" /tmp/contract-check-dart/test/"${n}_$(basename "$f")"
  done
done
cd /tmp/contract-check-dart && flutter analyze
```

If a scratch Flutter project is cheap to create in this environment, do
that and fix what it finds. If creating one is not practical here, say so
explicitly in the report below rather than silently skipping the check --
an unflagged gap is worse than a flagged one.

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
