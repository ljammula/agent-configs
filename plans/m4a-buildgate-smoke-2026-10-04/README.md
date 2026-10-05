# M4a — buildgate smoke on the Mac Studio (2026-10-04)

**Result: done.** One real feature went through buildgate end to end on this
Mac: hand-written spec + ticket → `submit -spec-file/-plan-dir` →
spec_review/plan_review approved → build on local Qwen via pi in the
sandbox → all gates on → **accepted**, zero memory aborts.

| | |
|---|---|
| Feature | `PATCH /transactions/{id}` recategorizes one transaction (personal-budget-simplifier, user's pick of 3) |
| Bundle | [`spec.md`](spec.md) (12 numbered criteria), [`tickets/001.spec.md`](tickets/001.spec.md) |
| Tests first | acceptance tests + stubs committed before submit: `bd35e86` on `m4a-recategorize-transaction`; tests passed on a Claude-written reference implementation (not committed) with `-race` |
| Request | `add-patch-transactions-id-to-recategoriz-20261004-214622` (buildgate `7151543`, factoryd `71515437662a`) |
| Roles | execution → local Qwen3.8-27B (`qwen38-mtplx-quality`, pi, thinking medium); planning + review → gpt-5.6-luna on the Codex subscription (**user decision: no Anthropic API key exists**, so planning is not on Claude; with `-spec-file/-plan-dir` the planning model was never called) |
| Result | branch `factoryd/add-patch-transactions-id-to-recategoriz-0d6d9a7d35af`, `0697fc4` (2 files, +75/−3). **Not pushed, no PR** (worker ran with `-open-pull-request=false`; pushing waits for the user) |
| Time | submit 21:46 → (held at spec_review on request) → plan approved 22:25 → attempt 1 quarantined 22:34 → corrective round accepted 22:45. Build time **~20 min** for two rounds |
| Cost | review on Codex: ~$0.046 at API prices, billed to the subscription; Qwen $0 |

## What happened

1. **Attempt 1** (8m46s): Qwen implemented both files. Gates: canonical
   verify ✓, diff scope ✓, required files ✓, required content ✓, tests ✓
   (pre-committed-tests opt-out), full suite with `-race` ✓, code review ✓,
   **spec conformity ✗ — 11/12 clean, criterion 9 flagged**:
   `json.Decoder.Decode` accepts `{"category_id": 2} trailing`, so a body
   that is not valid JSON returned 200. The finding is correct — and the
   gap was in **Claude's** spec/tests and reference implementation (and the
   repo's existing handlers), not in Qwen's reading of them.
2. **Automatic corrective round** (10m42s, `-001-conformity1`): fed the
   finding, Qwen switched to `io.ReadAll` + `json.Unmarshal` (rejects
   trailing data). All 8 gates ✓, 12/12 criteria clean → **accepted**.

## Independent verification (Claude, after acceptance)

- Diff touches exactly the two Allowed-Files; no test file changed vs
  `bd35e86` (frozen tests intact).
- Detached worktree at `0697fc4`: `go vet ./...` and
  `go test -race -count=1 ./...` pass.
- Ad-hoc probe (not committed): `{"category_id":N} trailing`,
  `{"category_id":N}{}` and an empty body all return 400.
- Code reads like the repo: `writeError`/`writeJSON`, sentinel errors with
  `errors.Is`, explicit category lookup (foreign keys are off).

## Memory (`run/memory.csv`, every 2 min, `summarize_memory.py`)

| | peak | preflight budget |
|---|---|---|
| Colima VM (8 GiB, 6 CPU) | 5.8 GiB | 8 (72%) |
| factoryd (host) | 0.05 GiB | 2 (2%) |
| Qwen | 45 GiB | 60 ceiling |
| available, lowest | 24.4 GiB | — |

mtplx memory-guard actions / insufficient-memory refusals since its 21:43
restart: **0 / 0**. Containers peaked at 0.7 GiB (Temporal, its worker,
Postgres). The `factory` budget (2 GiB) is ~40× actual; keep it until a
multi-ticket request is measured.

## What broke / findings (feed M3, M4)

1. **Claude's spec/tests missed a malformed-input variant** (trailing data
   after valid JSON). The Codex conformity review caught it and buildgate's
   corrective round fixed it with no human edit. M3: the bundle checklist
   needs "malformed input variants" for every input-validation criterion,
   and the acceptance tests should include them.
2. **The agent does not commit; buildgate does.** `committed_by_factoryd:
   true` on both rounds — Qwen left the diff uncommitted and the safety net
   committed it. That is the September "0/7 accepted" failure mode, now
   handled; nothing to fix, but don't rely on pi committing.
3. **No Claude route without an API key** (credential modes: static key,
   GitHub Copilot, ChatGPT Codex). Planning/review run on Codex by user
   decision.
4. **Plan §1 vs buildgate**: every ticket's `Verify-Command` must equal the
   request's verify command, run per ticket. Pre-committed acceptance tests
   for ticket N fail tickets 1..N-1 → this smoke used one ticket. M3 must
   either stage each ticket's tests with that ticket or buildgate needs
   per-ticket test selection.
5. **Sandboxed pi has no ai-stack provider shim**: Qwen's sampling preset,
   `thinkingFormat: qwen` and `supportsDeveloperRole: false` must be set in
   the factoryd model's `extra_json` (done in `~/.config/factoryd/config.yml`,
   backup `config.yml.bak-2026-10-04-pre-m4a`).
6. **Relay upstream** must be colima's host IP (`http://192.168.5.2:8080`):
   `127.0.0.1` is the container and hostnames are refused for plaintext.
7. **Stale install**: the installed `factoryd` predated `-spec-file/-plan-dir`
   and main moved during the session (#471, review-unavailable handling);
   always `git pull` + `make install` before a run. `git fetch origin`
   (GitHub) fails on this Mac with an SSH access error — only the `macbook`
   remote is reachable; PR opening will need GitHub auth fixed.
8. **doctor** recommends a `module_root` key in `.factory.yml` that nothing
   in buildgate parses (advisory warning for the `backend/` Go module).
9. **Colima** was 4 GiB with all of `$HOME` shared read-write; now 8 GiB.
   Narrowing mounts to `~/buildgate` (rw) + `~/code` (ro) is still open —
   check Hermes/Open WebUI bind mounts first.
10. spec_review re-reminds every 15 min in `notifications.log` while a
    request waits — fine, just noise during a deliberate hold.

## To finish the feature (user's call)

- Open the PR: `factoryd retry add-patch-transactions-id-to-recategoriz-20261004-214622`
  with a worker started with `-open-pull-request` (pushes to GitHub; needs
  the SSH/GitHub access fixed), **or** merge
  `factoryd/add-patch-transactions-id-to-recategoriz-0d6d9a7d35af` locally.
- Optionally add the trailing-data case to
  `backend/internal/api/transaction_category_test.go` so the test suite,
  not only the reviewer, pins criterion 9.
