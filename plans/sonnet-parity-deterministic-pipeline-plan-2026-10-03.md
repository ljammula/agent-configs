# Plan: Sonnet-parity code quality from a deterministic local pipeline

**Date:** 2026-10-03. **Status:** plan only. Decisions taken (§7): **Claude
plans, local inference executes**; software-factory/buildgate is the single
pipeline home; best-of-N batches run overnight. **Goal:** a task planned by Claude and executed by the local stack
(Qwen3.8-27B writer, gemma-4-26b reviewer, pi harness) produces code whose correctness
and quality match what Claude Sonnet produces on the same task, through a
pipeline whose control flow, inputs and acceptance decisions are
deterministic and replayable.

## 1. Where things stand (evidence, not opinion)

| Fact | Source |
|---|---|
| pi-local ≈ Sonnet on the 7-task bench (6/7 vs 6/7, different misses), but 5–15× slower (461–1038 s vs 29–147 s per task) | local-model-bench SPEC/STATUS, 2026-07-23/26 |
| Today, Qwen3.8 passed 4/4 baseline-arm tasks incl. both full-stack apps | pi/evals/battery-results/2026-10-03-flashnext-trial |
| **Latest matched-day data: stock pi 9/9 vs harness arm 7/9** — guardrails are not proven to help and may hurt | 2026-08-20 batteries; 100–312% overhead |
| Zero-human pilot: 12/12 tickets but only 8/12 unaided; "create from nothing" ticket exhausted rounds; frozen-oracle bugs halted 2 tickets | zero-human-fullstack-pipeline-plan-2026-08-20.md |
| Local *planning* is the weak link: oracle drafting failed 100% (timeouts), a drafted plan contradicted itself, conformity review often "unavailable" | software-factory-notes proving-ground 09-17, 09-22 |
| Recurring judgment bugs: LRU key/value eviction (0/4 with thinking off, 4/4 on), bookmarks data race missed by tests that never ran `-race`, model settling despite reviewer flags | pi-harness-validation-status.md, history |
| No seed is ever sent; Qwen sampled at temp 0.6 — runs are not reproducible | ai-stack-local.ts |
| **mtplx honours `seed`: same seed at temperature 1.0 → byte-identical output** | measured 2026-10-03 |
| Review: gemma single pass + Qwen settlement verifier = 32/32 caught, 2/32 FP; voting adds nothing | ai-stack bench/review_pipeline.py |
| Two pipelines exist: pi-harness-hardening `goal_pilot → ticket_runner → build_app`, and software-factory buildgate (Go, Temporal replay, Docker no-network sandbox, pinned evidence, `spec_conformity`/`reference_oracle` gates). build_app/ticket_runner copies have diverged | explorer maps |

**What this says:** on *bounded, well-specified* work the local writer is
already near Sonnet when it has thinking on. The gap is (a) planning and
oracle quality, (b) judgment bugs that weak tests don't catch, (c) the agent
not acting on findings, and (d) non-determinism making every result
anecdotal. Sonnet parity is therefore an **oracle + decomposition +
selection** problem more than a model problem.

## 2. What "deterministic" can and cannot mean here

- **Can be deterministic:** stage order, inputs (pinned model weights hash,
  mtplx version, harness SHA, prompts, toolchain image), the acceptance
  decision (executable gates with fixed thresholds, fail-closed), retry
  policy, selection among candidates, and — with fixed seeds, single-stream
  serving, and a cold or identical prefix cache — the model outputs
  themselves (replayable).
- **Cannot be guaranteed:** that a given seed produces *correct* code.
  Correctness is guaranteed by the oracle, not by sampling. Batching,
  speculative-draft acceptance under concurrency, or a different cache state
  can change bytes; the pipeline must record every seed and response hash so
  a run can be replayed or audited, not assume it.
- **Design rule:** the model proposes; deterministic gates dispose. No model
  self-report ("done", "tests pass") ever decides acceptance.

## 3. Target pipeline

```
 Task ──► [1 Spec] ──► [2 Contract + oracles] ──► [3 Micro-tickets + stubs]
                              │ oracle self-check (must FAIL on stubs,
                              │ must kill planted mutants)
                              ▼
 per ticket:  [4 Context pack] ──► [5 Best-of-N implement, seeds s1..sN]
                                        │ each candidate:
                                        ▼
              [6 Deterministic gates] ──► [7 Review + verify] ──► [8 Select]
                                        fail ▼                        │
                              [repair round from gate output] ◄───────┘ none pass
                                                                      │
                                              accept ▼                ▼ halt w/ evidence
                                       commit + evidence bundle
```

Stages 1–3 run on **Claude** (buildgate `planning` role on an Anthropic
route); stages 4–8 run **only on local inference**. The planning output is
frozen and hash-pinned before execution starts (see "Planning by Claude").

1. **Spec** — numbered acceptance criteria, non-goals, affected packages
   (buildgate `draft_spec.py` format).
2. **Contract + oracles** — public interfaces (types, signatures, API
   shapes) written as compilable stubs, plus the acceptance tests for every
   criterion, written *before* implementation and then frozen (hash-pinned).
   Include the invariant tests that today's failures show are missing: race
   detector on concurrency, property tests for data-structure invariants
   (LRU recency/eviction-by-key), boundary tables for numeric/date/pagination
   logic.
   **Oracle self-check (deterministic):** every test must fail against the
   stubs; a mutation tool (go-mutesting / Dart `mutation_test` /
   Stryker) run against the planner's reference or stub-plus-obvious
   implementation must show the tests kill planted mutants. Oracles that
   pass vacuously are rejected before any implementation starts — this
   closes the "frozen-oracle bug halted ticket 010/012" class.
3. **Micro-tickets** — each ticket: one package, ≤150 changed lines (review
   and repair quality collapse above that), explicit `Allowed-Files`,
   pre-created stub files (fixes "create from nothing"), the subset of
   oracle tests it must turn green, and a `Verify-Command`. Dependency order
   fixed; contract changes only via an explicit amend step.
4. **Context pack** — the implementer sees only: ticket, contract, stubs,
   allow-listed files, failing test output, and a short repo map. Keeps
   prompts ≤ ~30K tokens (fast cached turns today; fits a future
   Flash-Next-class model's cold-prompt limit).
5. **Best-of-N implementation** — N independent attempts (default 3; 5 for
   tickets marked hard), each with a recorded seed, thinking `xhigh` for
   logic-heavy tickets, `medium` otherwise. Run sequentially (single local
   stream). Each attempt gets up to 2 repair rounds driven by gate output
   (new round prompt, not in-session follow-ups — the follow-up delivery
   problem is avoided by construction).
6. **Deterministic gates (fail-closed, fixed order)** — format → lint
   (`go vet`/staticcheck, `dart analyze`, eslint/tsc) → build → ticket tests
   → full suite (`-count=1`, `-race` for Go) → frozen-oracle hash unchanged
   → diff scope ⊆ Allowed-Files → coverage on changed lines ≥ threshold →
   **mutation score on changed lines ≥ threshold** (the gate that would have
   caught weak tests behind the data race and LRU bugs).
7. **Review + verify** — gemma single pass on the candidate diff, Qwen
   settlement verifier (shipped in pi-harness-hardening `e81677d`);
   confirmed findings become a repair round, rejected ones are logged.
   High-risk tickets (concurrency, auth, persistence, migrations) also get a
   Claude review if Decision D1 allows cloud.
8. **Select** — among candidates that pass every gate: highest mutation
   score, then fewest confirmed findings, then smallest diff, then lowest
   seed. Pure function of recorded data ⇒ deterministic. If none pass:
   halt with the evidence bundle (no silent widening).

### Planning by Claude (D1)

- **Scope of the cloud call:** spec, interface contract (compilable stubs),
  acceptance tests for every criterion, and the micro-ticket graph. Claude
  writes no implementation code; execution never calls the cloud
  (`--sonnet-fallback` stays off so results are attributable to local
  inference).
- **Frozen plan = the deterministic boundary.** The Claude API has no seed,
  so planning is not reproducible; instead it runs once, and its output
  (spec, contract, tests, tickets, model id, prompt hashes) is committed and
  hash-pinned as the input to execution. Every later stage is seeded and
  replays byte-identically from that bundle. Re-planning is an explicit,
  recorded event, never an automatic retry.
- **Checks still applied to Claude's plan** (cheap, deterministic, and they
  catch planning mistakes before local time is spent):
  - coverage: every criterion → ≥1 ticket and ≥1 test; every ticket → a
    criterion;
  - stubs build and type-check;
  - oracle self-check: tests fail on the stubs, pass on an independently
    generated *local* reference implementation (separate seed, never sees
    the tests), and kill planted mutants of it. A failure goes back to
    Claude with the evidence for one re-plan.
- **Ticket sizing for the local executor:** ≤150 changed lines, one
  package, files pre-created, each ticket naming the tests it must turn
  green — written for Qwen3.8-27B's strengths, not Claude's.
- **Human checkpoint:** optional (off by default); the parity battery
  decides whether one is needed.

## 4. Determinism substrate

- Planning is pinned, not seeded (see "Planning by Claude").
- Send explicit `seed` (and fixed temperature/top_p/top_k) on every model
  call from build_app/ticket_runner and the pi provider; derive seeds
  deterministically from (task id, ticket id, attempt index).
- Serve single-stream for pipeline runs (`MTPLX_SCHEDULER_MODE=serial`,
  `MTPLX_MAX_ACTIVE_REQUESTS=1` — env overrides already exist) so batching
  can't perturb outputs.
- Evidence bundle per ticket: model weights hash, mtplx/MLX versions, harness
  SHA, prompt hashes, seeds, response hashes, gate outputs, toolchain image
  digest. buildgate already pins most of this — extend it, don't duplicate.
- Replay command: re-run a ticket from its bundle and assert identical
  response hashes; drift is reported, not hidden.
- Hermetic toolchains: buildgate's Docker no-network sandbox with warm,
  pinned module caches (README lists cold Go caches as a known limit).

## 5. Measuring "Sonnet level" (the exit criterion)

- **Parity battery** (backlog P1, never run): ≥20 tasks — the 7 bench tasks,
  the 4 Harbor ports, plus ~10 real tickets from your repos (brownfield),
  stratified small/medium/full-app. Hidden tests the pipeline never sees.
- **Arms (Sonnet-solo runs excluded by the user, 2026-10-03):** (b) the
  target pipeline — Claude plans, local executes; (c) local execution of the
  *same* frozen Claude plan without the new gates/best-of-N (isolates what
  execution-side work adds); (d) stock pi baseline; (e) current harness.
  **Sonnet reference** = already-recorded Sonnet results on the shared tasks
  (local-model-bench: 6/7 on the 7-task suite, 3/3 on `go/lru-cache`,
  29–147 s/task) plus the published numbers; no new Sonnet-solo spend.
- **Metrics:** hidden-test pass rate (primary); mutation score of the
  produced tests; lint/race/analyzer clean; blind diff-quality grading by a
  third model (correctness, simplicity, edge cases) without arm labels;
  wall-clock and cost.
- **Parity = ** arm (b) pass rate ≥ the recorded Sonnet reference on the
  tasks where one exists, and ≥ arm (d)/(e) everywhere, defect rate (confirmed review findings, analyzer/race hits) not
  worse, at any wall-clock (time is the accepted trade).
- **Ablation rule:** every harness feature must show a non-negative effect
  on this battery or it is removed — the 08-20 baseline-beats-harness result
  makes this non-optional.

## 6. Phases and exit criteria

| Phase | Work | Exit criterion |
|---|---|---|
| **0. Baseline** (first) | Build the parity battery; run stock pi (d) + current harness (e), n=3, overnight | Local baselines for every task; tasks below the Sonnet reference identified |
| **1. Substrate** | Seeds everywhere, single-stream pipeline mode, evidence bundle + replay; converge on one pipeline home (D2) and retire the diverged copy | A ticket replays byte-identically from its bundle 3/3 |
| **2. Planning compiler** | Contract stubs, tests-first oracles, oracle self-check (fail-on-stub + mutant kill), ≤150-line micro-tickets with pre-created files | 0 vacuous oracles on the battery; ticket graph never halts on an oracle bug |
| **3. Gates** | Per-language gate packs incl. `-race`, analyzers, changed-line coverage, mutation score | Re-running the historical misses (LRU K/V, bookmarks race) is caught by a gate, not by luck |
| **4. Best-of-N + selection** | N seeded attempts, repair rounds from gate output, deterministic selector | Pass rate on the battery ≥ Sonnet's on the tasks Phase 0 showed lost |
| **5. Review loop** | Confirmed findings → repair round; Claude review for high-risk tickets (if D1) | Defect rate ≤ Sonnet's |
| **6. Prune + harden** | Ablate every extension; remove what doesn't pay; overnight batch mode | Held-out parity confirmed, n=3 |

## 7. Decisions (taken 2026-10-03)

- **D1 — Who plans? → Claude plans, local inference executes.** Claude
  produces spec, contract, tests and tickets once per feature; Qwen/gemma do
  all implementation, review and repair. (Earlier the same day this was
  recorded as all-local with no checkpoint; changed by the user.)
- **D2 — One pipeline home → software-factory/buildgate**, with pi as its
  inner agent. pi-harness-hardening's `build_app.py`/`ticket_runner.py` are
  frozen as the lightweight path (or retired once buildgate covers it); no
  third pipeline.
- **D3 — Time budget → best-of-N with repair rounds, run as overnight
  batches** on the otherwise-idle Studio.

## 8. Risks / honest limits

- Quality is now bounded by Claude's plan plus local execution. A plan that
  is wrong-but-consistent still passes the automatic checks; arm (b) vs arm
  (a) on the battery shows whether that matters in practice.
- Planning needs network and Anthropic API spend per feature; execution is
  fully local and free.
- Mutation testing and best-of-N multiply wall-clock; tickets must stay small
  for this to be tolerable.
- n=3 on ~20 tasks still has wide error bars; parity claims should be stated
  with that caveat.
- Byte-level determinism holds only under the pinned serving mode; a
  different mtplx/MLX build or cache state can change outputs — the replay
  check detects this, it can't prevent it.
