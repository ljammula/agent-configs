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
