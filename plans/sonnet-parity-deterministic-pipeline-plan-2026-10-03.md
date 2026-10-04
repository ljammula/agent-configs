# Plan: Sonnet-parity code quality from a deterministic local pipeline

**Date:** 2026-10-03. **Status:** plan only. Decisions taken (§7): fully
local planning with no human checkpoint, software-factory/buildgate as the
single pipeline home, best-of-N batches run overnight. **Goal:** a task handed to the local stack (Qwen3.8-27B
writer, gemma-4-26b reviewer, pi harness) produces code whose correctness
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

1. **Spec** — numbered acceptance criteria, non-goals, affected packages
   (buildgate `draft_spec.py` format). No human checkpoint (D1), so the
   planning stages carry their own automatic checks (see "Planning without
   a human" below).
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

### Planning without a human (consequence of D1)

Local planning is where past runs failed (oracle drafting timed out 100%, a
plan contradicted itself), and nothing downstream can repair a wrong spec or
a wrong test. With no human checkpoint, these become hard gates on the
planning output:

- **Best-of-N planning too:** draft 3 seeded spec/contract candidates;
  select deterministically by the checks below (all must pass), then
  fewest open questions, then lowest seed.
- **Coverage check:** every acceptance criterion maps to ≥1 ticket and ≥1
  oracle test; every ticket maps back to a criterion (no orphans).
- **Contradiction check:** gemma reads spec + ticket graph and lists
  conflicting statements; Qwen verifies each in a fresh call (the same
  reviewer+verifier pattern that halved review false positives).
  Any confirmed conflict → redraft.
- **Compile check:** contract stubs must build and type-check.
- **Oracle self-check, strengthened:** tests must (1) fail on stubs, (2)
  pass on an *independently generated* reference implementation (separate
  seed, no access to the tests) — a test that no plausible implementation
  passes is itself wrong — and (3) kill planted mutants of that reference.
- **Small planning calls:** draft oracles one criterion per call with a
  bounded context (the 15-minute oracle-drafting timeouts came from
  oversized single calls).
- **Escalation rule:** if Phase 0/2 shows local planning below the parity
  bar on the battery, the D1 decision is revisited with that data rather
  than shipping a known-weak planner.

## 4. Determinism substrate

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
- **Arms:** (a) Claude Sonnet via Claude Code on the same task text, (b)
  local pipeline, (c) stock pi baseline. **n = 3 runs per task per arm**
  (seeded for the local arms).
- **Metrics:** hidden-test pass rate (primary); mutation score of the
  produced tests; lint/race/analyzer clean; blind diff-quality grading by a
  third model (correctness, simplicity, edge cases) without arm labels;
  wall-clock and cost.
- **Parity = ** local pass rate ≥ Sonnet's on the held-out half of the
  battery, defect rate (confirmed review findings, analyzer/race hits) not
  worse, at any wall-clock (time is the accepted trade).
- **Ablation rule:** every harness feature must show a non-negative effect
  on this battery or it is removed — the 08-20 baseline-beats-harness result
  makes this non-optional.

## 6. Phases and exit criteria

| Phase | Work | Exit criterion |
|---|---|---|
| **0. Baseline** (first) | Build the parity battery; run Sonnet + stock pi + current harness, n=3 | Numbers for all three arms; tasks where Sonnet beats local identified |
| **1. Substrate** | Seeds everywhere, single-stream pipeline mode, evidence bundle + replay; converge on one pipeline home (D2) and retire the diverged copy | A ticket replays byte-identically from its bundle 3/3 |
| **2. Planning compiler** | Contract stubs, tests-first oracles, oracle self-check (fail-on-stub + mutant kill), ≤150-line micro-tickets with pre-created files | 0 vacuous oracles on the battery; ticket graph never halts on an oracle bug |
| **3. Gates** | Per-language gate packs incl. `-race`, analyzers, changed-line coverage, mutation score | Re-running the historical misses (LRU K/V, bookmarks race) is caught by a gate, not by luck |
| **4. Best-of-N + selection** | N seeded attempts, repair rounds from gate output, deterministic selector | Pass rate on the battery ≥ Sonnet's on the tasks Phase 0 showed lost |
| **5. Review loop** | Confirmed findings → repair round; Claude review for high-risk tickets (if D1) | Defect rate ≤ Sonnet's |
| **6. Prune + harden** | Ablate every extension; remove what doesn't pay; overnight batch mode | Held-out parity confirmed, n=3 |

## 7. Decisions (taken 2026-10-03)

- **D1 — Who plans? → All local, no human checkpoint.** (Alternatives
  considered: Claude for spec/contract/oracles; local with a human
  checkpoint.) Consequence: the "Planning without a human" gates in §3 are
  mandatory, and the escalation rule there applies.
- **D2 — One pipeline home → software-factory/buildgate**, with pi as its
  inner agent. pi-harness-hardening's `build_app.py`/`ticket_runner.py` are
  frozen as the lightweight path (or retired once buildgate covers it); no
  third pipeline.
- **D3 — Time budget → best-of-N with repair rounds, run as overnight
  batches** on the otherwise-idle Studio.

## 8. Risks / honest limits

- With D1 = local planning and no checkpoint, quality is capped by local
  spec/oracle quality; the planning gates reduce but don't remove that
  ceiling, and a spec that is wrong-but-consistent passes every automatic
  check. The parity battery is what will show whether that ceiling is
  below Sonnet.
- Mutation testing and best-of-N multiply wall-clock; tickets must stay small
  for this to be tolerable.
- n=3 on ~20 tasks still has wide error bars; parity claims should be stated
  with that caveat.
- Byte-level determinism holds only under the pinned serving mode; a
  different mtplx/MLX build or cache state can change outputs — the replay
  check detects this, it can't prevent it.
