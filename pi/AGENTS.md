# Global instructions

Written for pi. Rules are stated as imperatives on purpose: the models this
harness usually runs (local ai-stack slots, see below) follow explicit
directives far more reliably than they infer intent from prose.

## Working rules

1. Read before you write. Never edit a file you have not read in this session.
2. Make the smallest change that solves the stated problem. No refactors, no
   renames, no "while I was here" cleanups, no speculative abstractions.
3. State assumptions out loud before coding. If two readings of the request
   lead to different code, ask instead of picking silently.
4. Every task ends with a verification command that actually ran — a test, a
   build, a lint. "It should work" is not a result. Paste the real output.
5. If a check fails, say so plainly with the failing output. Never report
   success you did not observe.

These mirror the `karpathy-guidelines` skill; apply it by default on any
coding task.

## Verification commands

Use the project's own commands, in this order of preference:

- `make verify` if a Makefile defines it
- Go: `go build ./... && go test ./...`, format with `gofmt -w`
- Flutter/Dart: `flutter analyze && flutter test`, format with `dart format`

Run the verification command yourself with bash. Do not ask the user to run it.

## Recurring test-correctness gotchas

These are confirmed, not theoretical — each recurred on a real chunked build
(see `pi-real-task-report-personal-budget-simplifier.md`), passed `gofmt`/
`go build`/`go vet`/`go test`, and was only caught by a human re-reading the
diff. `go build` and friends prove the code runs; none of them prove a test
actually exercises the behavior its own comment claims.

1. **SQLite `:memory:` never shares state across connections.** Each
   `Open(":memory:")` call gets its own fresh, isolated database. A test that
   opens `:memory:` twice to check "does a second call avoid re-seeding /
   duplicating" cannot fail even if the guard it's testing is deleted — the
   second open never sees the first open's data regardless. To test
   idempotent reopen/reseed behavior, open a real file path (`t.TempDir()` +
   a filename) shared across both calls.
2. **`defer` inside a test helper fires when the helper returns, not when the
   calling test ends.** `func testStore(t *testing.T) *Store { f := ...; defer
   os.Remove(f.Name()); db := db.Open(f.Name()); return NewStore(db) }` deletes
   the backing file the instant `testStore` returns — while the caller's
   `*sql.DB` handle is still open and about to be used. Every write against it
   then fails. Use `t.Cleanup(fn)` (registered on the test's own `*testing.T`,
   runs at actual test end) or `t.TempDir()` (auto-cleaned, no manual removal
   needed at all) — never a bare `defer` for cleanup inside a helper function.
3. **A duplicate key across categories in a first-match-wins lookup table is
   silent dead code.** If a keyword/merchant/rule table maps several inputs to
   a category and checks categories in priority order, a value repeated in a
   later category is unreachable — normal "does X classify correctly" tests
   pass either way, because the *first* category's answer is still right.
   Before finishing such a table, check your own literals for cross-category
   duplicates.
4. **A JSON API contract needs a raw-bytes assertion, not a round-trip decode.**
   If chunk N's Go/Dart structs lack explicit tags/keys and chunk M's tests
   decode chunk M's own HTTP responses back into chunk N's same struct type,
   a wire-format mismatch (Go's default `"ID"`/`"Name"` field-name casing vs.
   the rest of the API's `snake_case`) is invisible — `encoding/json` matches
   field names case-insensitively on decode. Verify the actual bytes on the
   wire (a `curl` smoke test, or an assertion against a literal JSON string),
   at least once per endpoint, especially at a chunk boundary where the struct
   and its HTTP handler were written in different sessions.
5. **An escaped `\$` immediately followed by `{...}` silently disables string
   interpolation in Dart.** `'\${x}'` interpolates correctly (a literal `$`
   then the value of `x`) — but `'Budget: \${limit ~/ 100}.00'`, written with
   the intent of showing a computed dollar amount, instead renders the
   literal characters `${limit ~/ 100}` on screen: the `\$` escapes to a bare
   `$`, which is no longer an interpolation trigger, so the following
   `{...}` is just literal text. This compiles cleanly and `flutter analyze`
   says nothing about it — only a test asserting the actual rendered string
   (not a nearby icon or color) catches it. Write `'\$${value}'` (escaped
   dollar sign immediately followed by *unescaped* interpolation) when a
   literal `$` and a computed value share a string, and add a test asserting
   the exact rendered text whenever a widget mixes the two.

## GitHub accounts

- `ljammula` — owner account. Commits, pushes, PR creation, everything by default.
- `narsimha-j` — code review only. Switch with `gh auth switch --user narsimha-j`,
  do the review, then switch back to `ljammula` on every exit path, including
  failure paths.

Commit with the global git config (ljammula). Do not add a `Co-Authored-By`
trailer for the agent.

## Local execution harness

Do not delegate code edits to a local model via Aider. Benchmarked in
`~/code/local-model-bench`, that path cost more cloud tokens than editing
directly and ran 5-10x slower (it won one task solo Sonnet missed, but on
one later shown to be flaky independent of harness — see
`local-model-bench/STATUS.md`). Write the edit yourself.

Read-only local services are still worth using. The served endpoints are:

| Port | Slot | Use |
|---|---|---|
| 8080 | ThinkingCap-Qwen3.6-27B-MLX-8bit ("code", resident) | code review, editing, log triage |
| 8888 | SearXNG | web search |

They need not run on this machine. `AI_STACK_HOST` names the serving host
(`kannasmacstudio.lan` for the LAN box -- a stable router-assigned hostname,
not the raw DHCP IP, since that address has changed on every reboot); unset,
it defaults to `127.0.0.1`. Every script and reachability check resolves
through it. Check reachability before relying on any of them — these
instructions load on machines without the stack.

A local model self-corrects mechanical mistakes but not logic bugs. Treat its
output as evidence to verify, never as a trusted result.

On the default Pi configuration, `cross-model-review.ts` and the local-review
scripts call the same ThinkingCap Qwen model as the primary agent. They provide
a blind second pass, not model diversity or independent proof. The historical
Gemma reviewer results do not validate the current same-model route.

Pi has no built-in sandbox. `protected-paths.ts` guards only Pi's `write` and
`edit` tools, while `bash` still runs with this user's host permissions. Do not
treat extension guardrails as filesystem, credential, network, or deployment
isolation; unattended or untrusted work belongs in an OS/container boundary.

## Context discipline

The local model has a 96K context window — roughly a fifth of a cloud model's.
Protect it:

- Prefer `rtk <cmd>` over raw `git`/`ls`/`find`/`cargo` etc. It is a
  token-optimized proxy over the same commands and cuts 60-90% of the output.
  `rtk gain` shows the savings. Never pipe a whole log file into context; use
  the `local-summarize` skill to find the interesting line range first.
- Read the specific part of a file you need (`offset`/`limit`), not the whole file.
- Search with `rg` and read the hits, rather than reading files to search them.
