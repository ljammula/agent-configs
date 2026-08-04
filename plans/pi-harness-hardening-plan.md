# Pi harness and skill hardening plan

Status: implemented locally; independent-review and container-runtime validation remain gated

Date: 2026-08-02

Scope: implementation contract and acceptance criteria; runtime evidence is recorded in
`pi/evals/`, current status in `pi-harness-validation-status.md`, and the full
dated investigation in `pi-harness-history.md`

## Outcome

Make the Pi coding harness reliable for Go, Python, Flutter, PostgreSQL,
Kafka, Temporal, and GCP work in both full-stack and backend-only repositories.
The harness should remain autonomous for ordinary implementation work while
using deterministic verification, independent evaluation, and operating-system
containment instead of relying on prompt compliance alone.

The end state is not “more instructions.” It is a small generic prompt,
project-scoped skills, executable quality and safety gates, committed extension
tests, and evidence that each judgment-dependent addition improves outcomes on
this machine's local-model workload.

## Non-goals

- Keep the plan as the implementation contract; record runtime changes and deviations in
  separate evidence artifacts.
- Do not make production deployment, database migration, infrastructure apply,
  tag creation, or force-push operations implicit side effects of autonomy.
- Do not install one large stack-specific system prompt in every session.
- Do not replace repository-native commands such as `make verify` with a second,
  competing build system.
- Do not reintroduce Aider or local-model code delegation. Local services remain
  read-only reviewers, search providers, and log-triage aids.
- Do not claim that web guidance proves a local-model improvement. Adoption
  requires the paired evaluations defined below.

## Evidence baseline

### What is already strong

- `full-stack-dev.ts` provides a concise plan → chunk → verify → debug workflow
  and enables Pi's standard development tools.
- Deterministic guards have caught real failures: `protected-paths.ts` stopped an
  out-of-worktree edit and `git-safety.ts` stopped a destructive reset.
- `co-change-suggest.ts` found the historically co-changing file at rank 1 in
  its retrospective validation.
- The harness has already reached outcome parity with a cloud baseline on the
  small benchmark suite, showing that harness improvements can matter.

The detailed local evidence is recorded in
[`pi-harness-validation-status.md`](../pi-harness-validation-status.md).

### Gaps this plan must close

1. **The current reviewer is not the reviewer that earned adoption.**
   `cross-model-review.ts` now sends review requests to the same ThinkingCap
   Qwen model and `:8080` route used by the primary agent. Its successful
   validation was performed with a different-family Gemma reviewer on `:8081`,
   after an earlier reviewer missed the seeded defect twice. The current code,
   README narrative, and adoption evidence therefore disagree.
2. **Project-specific skills are still installed globally.** The root README
   already defines the intended portable-core/project-overlay split, but the
   installer still links DayTrix-specific backend, frontend, feature, release,
   and account workflows into Pi's global skill directory.
3. **Verification is inferred from duplicated command regexes.** The nudge and
   review extensions maintain separate lists and cannot prove that a passing
   command verified the current diff rather than an earlier version.
4. **Path confinement is not process confinement.** `protected-paths.ts` guards
   Pi's `write` and `edit` tools, but `bash` runs with the host user's
   permissions and can write elsewhere or invoke external systems.
5. **Extension tests are not a maintained product.** Important branches were
   checked with temporary mock harnesses, while the validation record still
   reports underpowered samples, missing randomization, watchdog interference,
   and live-unobserved branches.
6. **The portable stack is incomplete.** Current Go/Flutter instructions encode
   DayTrix conventions, while reusable Python, PostgreSQL, Kafka, Temporal, and
   GCP development disciplines are absent.

These gaps align with current upstream guidance:

- Pi documents that global skill descriptions are always exposed while full
  skill bodies load on demand; project-local skills are supported directly.
  See [Pi skills](https://pi.dev/docs/latest/skills).
- Pi explicitly has no built-in sandbox and recommends a container, VM,
  Gondolin, or OpenShell for unattended work. See
  [Pi security](https://pi.dev/docs/latest/security) and
  [Pi containerization](https://pi.dev/docs/latest/containerization).
- Pi exposes the lifecycle, tool-result, prompt, and persistent-entry hooks
  needed for deterministic gates and telemetry. See
  [Pi extensions](https://pi.dev/docs/latest/extensions).
- Anthropic recommends simple composable workflows, programmatic checkpoints,
  environmental ground truth, bounded stopping conditions, sandbox testing,
  and evaluator loops only where evaluation criteria are clear and improvement
  is measurable. See
  [Building Effective AI Agents](https://www.anthropic.com/research/building-effective-agents).
- Context should contain the smallest high-signal instruction set, with
  specialized context retrieved just in time. See
  [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
- OpenAI recommends eval-driven development, logging traces, automated scoring,
  production-derived cases, and continuous regression evaluation. See
  [Evaluation best practices](https://platform.openai.com/docs/guides/evaluation-best-practices)
  and [trace grading](https://platform.openai.com/docs/guides/trace-grading).

## Design principles

1. **Deterministic checks outrank model judgment.** A reviewer can suggest a bug;
   it cannot overrule a failing build, test, replay, migration, or policy check.
2. **Prompts guide; extensions enforce; the OS contains.** Do not describe a
   prompt rule as a security or completion guarantee.
3. **Keep the global layer portable.** Project architecture, accounts, release
   topology, and product invariants live with the project.
4. **Load stack guidance just in time.** Detect manifests and changed paths, then
   surface only relevant skills.
5. **Bind evidence to the current diff.** A green result predating a mutation is
   stale and cannot satisfy completion.
6. **Bound every autonomous loop.** Failed verification should continue the
   task, but retries, review rounds, subprocess time, and output size need caps.
7. **Adopt complexity only after a measured win.** Unit tests establish that an
   extension behaves as designed; paired task evaluations establish whether the
   behavior helps.

## Requirements

- **R-1 — Reviewer truth:** runtime reviewer identity, documentation, and
  validation evidence agree; a same-model review is never labeled cross-model.
- **R-2 — Skill scope:** unrelated repositories receive no DayTrix-specific
  instructions, while DayTrix retains its existing workflows project-locally.
- **R-3 — Current-diff quality:** completion requires a passing broad check tied
  to the latest material diff whenever the repository declares such a check.
- **R-4 — Stack coverage:** relevant Go, Python, Flutter, PostgreSQL, Kafka,
  Temporal, and GCP checks are available without injecting unrelated stacks.
- **R-5 — Containment:** unattended execution cannot write outside the allowed
  workspace or access undeclared credentials and networks.
- **R-6 — External-effect safety:** production-affecting commands remain
  explicitly user-triggered and are blocked as incidental recovery actions.
- **R-7 — Contract tests:** every extension hook, state transition, timeout,
  bounded loop, and interaction has committed deterministic tests.
- **R-8 — Traceability:** every judgment-dependent trigger records structured,
  machine-readable evidence sufficient to reconstruct its decision.
- **R-9 — Measured adoption:** judgment-dependent behavior passes a randomized,
  paired evaluation with declared success and rollback criteria.
- **R-10 — Documentation integrity:** implementation status documents describe
  current runtime behavior and clearly separate historical evidence.

## Phase 0 — Restore a truthful baseline

### 0.1 Reconcile the reviewer

Change `cross-model-review.ts` so reviewer configuration comes from explicit,
validated settings such as `AI_REVIEW_BASE_URL` and `AI_REVIEW_MODEL`, with the
resolved endpoint and model recorded at startup.

Decision rules:

- If an independently configured reviewer is available, permit the bounded
  blind-review loop.
- If reviewer and primary resolve to the same model/route, either disable the
  extension or label and evaluate it as `blind-self-review`; never retain the
  `cross-model` claim.
- If the endpoint is unavailable, fail open for ordinary code completion but
  record a structured `transient` outcome. Deterministic verification remains
  authoritative.
- Keep the current three-round cap until evaluation supports a different value.

Update `pi/README.md` and `pi-harness-validation-status.md` in the same change.
Historical Gemma results remain historical; they must not be rewritten as proof
for the current Qwen route.

Verification:

- Unit matrix: independent reviewer, same reviewer, missing configuration,
  unreachable endpoint, malformed response, clean response, flagged response,
  timeout, unchanged diff, and round cap.
- Runtime smoke output identifies the exact reviewer endpoint/model without
  exposing credentials.
- Known-bug replay is run before the reviewer is re-enabled by default.

### 0.2 Freeze the baseline

Record the following before later phases:

- Pi version, model IDs, model hashes where available, context/max-token values,
  extension commit SHA, `AI_STACK_HOST`, and effective extension list.
- Per-task result, hidden-test result, wall time, input/output tokens, tool calls,
  review rounds, nudges, timeouts, and unsafe-action attempts.
- Exact task fixtures and runner watchdogs.

Do not compare a changed model, changed task, changed watchdog, and changed
extension in the same experiment.

**Phase 0 exit:** R-1 and R-10 pass, and a reproducible baseline artifact exists.

## Phase 1 — Build the extension contract test suite

Add a small TypeScript project under `pi/`:

```text
pi/
  package.json
  tsconfig.json
  tests/
    extension-api-harness.ts
    full-stack-dev.test.ts
    continuation-nudge.test.ts
    cross-model-review.test.ts
    format-on-edit.test.ts
    git-safety.test.ts
    protected-paths.test.ts
    quality-gate.test.ts
    stack-router.test.ts
    extension-interactions.test.ts
```

The harness should mock only Pi's public `ExtensionAPI` contract and run against
the pinned installed Pi type definitions. CI should additionally test the newest
compatible Pi version as a non-blocking canary until its stability is known.

Required cases:

- Handler registration and system-prompt chaining order.
- Active-tool preservation and deduplication.
- Session start, continuation, compaction, fork, and tree reconstruction.
- Successful, failed, piped, timed-out, and malformed tool results.
- Follow-up delivery and loop caps.
- Parallel or rapidly adjacent qualifying tool results.
- Empty diffs, committed mid-session diffs, untracked files, and diff changes
  after a prior green check.
- Interaction among formatting, mutation tracking, quality gating, review, and
  continuation nudging.
- All currently documented destructive-command patterns plus bypass attempts.

CI commands should be repository-owned and boring, for example:

```bash
npm --prefix pi ci
npm --prefix pi run typecheck
npm --prefix pi test
```

No extension behavior changes in this phase except changes required to expose
pure functions or dependency injection for tests.

**Phase 1 exit:** R-7 passes; every existing extension loads and all committed
contract tests pass locally and in CI.

## Phase 2 — Enforce current-diff verification

Add `quality-gate.ts` and extract shared verification logic from
`continuation-nudge.ts` and `cross-model-review.ts` into one module.

### Verification contract

Resolution order:

1. A project-declared canonical command, preferring `make verify` when present.
2. Existing repository scripts documented in `AGENTS.md`, `README.md`, or CI.
3. A conservative manifest-derived default only when no project command exists.

Do not invent a second configuration format initially. Add a `.pi` verification
manifest only if at least two real repositories cannot express their checks with
existing commands.

### State model

Track:

- session base SHA;
- material diff hash after each `write`, `edit`, formatter mutation, and shell
  turn capable of changing the working tree;
- verification command, start/end time, exit code, truncation state, and the
  diff hash it verified;
- retry count and follow-up reason.

At `agent_end`, if a material diff exists and no successful broad verification
matches its hash, execute the canonical check or send a bounded corrective
follow-up with the actual failure. Recompute the diff after every correction.
Never treat formatting alone as behavioral verification.

The initial cap remains three corrective follow-ups. A cap hit reports the exact
remaining failure and records a terminal outcome; it must not claim completion.

### Proof cases

- Green check → edit → stop: stale green is rejected.
- Green check → no edit → stop: no redundant rerun.
- Failed check → correction → green: completion permitted.
- Piped check without `pipefail`: result remains inconclusive.
- Shell-created mutation: detected through diff hashing even without `write` or
  `edit` events.
- No repository-native check: explicit `unconfigured` evidence, not a guessed
  success.

**Phase 2 exit:** R-3 and the verification portion of R-8 pass, with duplicated
verification regexes removed.

## Phase 3 — Split portable skills from project overlays

Finish the migration already specified in the root README.

### Keep global

- `karpathy-guidelines`
- `local-search`
- `local-summarize`
- `docs-verify`
- a generic `before-done` core
- a generic `wiring-verify` core

### Move to the DayTrix repository

- `backend-dev`
- `frontend-dev`
- `feature-dev`
- DayTrix overlays for `before-done` and `wiring-verify`
- `pr-remediate`
- `release`
- `self-review`
- `testflight-cut`

The installer must stop linking project-specific skills globally only after the
project-local discovery path has been tested in interactive and non-interactive
Pi modes. Preserve matching Claude and Codex ownership deliberately; do not move
only the Pi copy and leave three sources of truth.

### Add portable stack skills

Each skill description must name both positive triggers and boundaries. Full
instructions load only when matched.

#### `go-service`

- Prefer repository-native test, lint, format, generation, and vulnerability
  commands.
- Require focused table-driven tests for changed behavior.
- Run `go test -race` when concurrency, shared state, workers, caches, or
  goroutines change; the Go toolchain documents `-race` as its built-in runtime
  detector. See [Go race detector](https://go.dev/doc/articles/race_detector).
- Run `govulncheck ./...` for dependency, authentication, parsing, or network
  exposure changes when the tool is configured. See
  [Go vulnerability management](https://go.dev/doc/security/vuln/).

#### `python-service`

- Read `pyproject.toml`, lockfiles, CI, and task-runner configuration before
  selecting commands.
- Use the project's configured environment (`uv`, Poetry, Hatch, tox, or plain
  virtualenv) rather than installing a competing tool.
- Run focused `pytest`, configured lint/format, and configured type checks.
- Cover async cancellation, retry, serialization, and database boundaries when
  those paths change.

#### `flutter-app`

- Keep logic, widget, golden, and integration checks distinct.
- Select the narrowest useful check after a chunk and the project-wide analyzer
  and test command at completion.
- Require integration coverage for important multi-widget/service flows; Flutter
  distinguishes unit, widget, and integration tests by confidence and cost. See
  [Flutter testing overview](https://docs.flutter.dev/testing/overview).
- Leave localization and DayTrix-specific state-management rules in project
  overlays.

#### `postgres-change`

- Apply migrations to an ephemeral PostgreSQL instance from the previous schema.
- Verify resulting schema, constraints, indexes, rollback/forward-fix behavior,
  lock duration, and representative query plans.
- Use explicit transactions where supported; PostgreSQL executes statements in
  a transaction block until `COMMIT` or `ROLLBACK`. See
  [PostgreSQL `BEGIN`](https://www.postgresql.org/docs/current/sql-begin.html).
- Require an expand/contract or forward-fix plan for non-transactional,
  long-running, or backwards-incompatible changes.

#### `kafka-processing`

- Require the intended delivery contract to be stated: at-most-once,
  at-least-once with idempotency, or Kafka-scoped exactly-once.
- Test duplicate delivery, crash before/after offset commit, retry exhaustion,
  rebalance, poison records, ordering assumptions, and producer fencing where
  applicable.
- Do not claim end-to-end exactly-once across an external database merely because
  Kafka transactions are enabled. Kafka documents the scope and cooperation
  required for exactly-once behavior. See
  [Kafka delivery semantics](https://kafka.apache.org/42/design/design/#message-delivery-semantics).

#### `temporal-go`

- Enforce deterministic Workflow code and keep side effects in Activities.
- Use the Go SDK test environment for Workflow/Activity behavior, failures,
  cancellation, signals, retries, and time skipping.
- For Workflow-definition changes, replay representative recent open and closed
  histories in CI and fail on nondeterminism. Temporal recommends this exact
  replay gate. See
  [Temporal Go testing](https://docs.temporal.io/develop/go/testing-suite).

#### `gcp-deploy`

- Keep planning, validation, and deployment separate.
- Require explicit invocation for deploy, IAM, secret, traffic, migration, or
  infrastructure mutations.
- Prefer immutable revisions, deploy with no traffic, smoke-test, gradually
  migrate traffic, and retain a tested rollback. See
  [Cloud Run rollouts and rollbacks](https://cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration).
- Use least-privilege, short-lived credentials supplied only to the deployment
  environment.

### Stack router

Add `stack-router.ts` only after the skills exist. Detect manifests and dependency
evidence, then append a short instruction naming the applicable skills. The router
must not inject full skill contents or classify from directory names alone.

Positive fixtures:

- `go.mod` with Temporal SDK → `go-service`, `temporal-go`.
- `pyproject.toml` with Kafka client → `python-service`, `kafka-processing`.
- `pubspec.yaml` → `flutter-app`.
- migration directory plus PostgreSQL driver → `postgres-change`.
- Cloud Run/Terraform configuration → advertise `gcp-deploy`, but do not invoke
  it automatically.

Negative fixture: an unrelated repository containing a `backend/` directory
receives zero DayTrix household, feature-grant, localization, release, or account
instructions.

**Phase 3 exit:** R-2 and R-4 pass in prompt-capture tests across all fixtures.

## Phase 4 — Add real containment and external-effect gates

### Operating-system boundary

For unattended runs, adopt one supported containment mode:

1. Gondolin routing for all built-in tools when host-side Pi authentication must
   remain available; or
2. whole-process Docker/OpenShell when extension tools and the Pi process must
   share the same boundary.

The selected profile should expose only:

- the task workspace as writable;
- required read-only caches or SDKs;
- the local inference endpoint;
- explicitly allowlisted package/documentation networks;
- short-lived credentials required for the current authorized task.

Do not mount the host Pi home, SSH directory, cloud configuration, Docker socket,
or unrelated source trees into an unattended environment by default.

### External-effects extension

Add a narrow `external-effects.ts` gate for commands such as:

- `gcloud run deploy`, traffic changes, IAM mutations, and secret changes;
- `terraform apply`/`destroy` and equivalent infrastructure mutation;
- production database migration or destructive SQL;
- Kafka topic deletion/configuration and consumer-group reset;
- `kubectl apply`/`delete` against non-local contexts;
- Git pushes, tags, releases, and force operations not explicitly requested.

The extension should inspect structured argv where practical, provide a safe
alternative, and log the blocked category. Regexes are defense in depth, not the
security boundary.

### Proof matrix

From an unattended fixture, attempt:

- write/edit outside the workspace;
- shell redirection outside the workspace;
- read a host credential path;
- connect to a non-allowlisted network destination;
- invoke each external-effect command class;
- bypass with command chains, absolute paths, aliases, and a subprocess.

The OS boundary must stop filesystem, credential, and network escapes. The
extension must stop recognized external-effect commands with actionable output.
All attempts must leave host and external state unchanged.

**Phase 4 exit:** R-5 and R-6 pass with 100% of the deterministic safety matrix.

## Phase 5 — Structured telemetry and paired evaluation

### Trace schema

Use `pi.appendEntry` with a versioned schema. At minimum record:

```json
{
  "schemaVersion": 1,
  "extension": "quality-gate",
  "extensionVersion": "<git-sha>",
  "sessionId": "<id>",
  "taskFixture": "<fixture-or-null>",
  "diffHash": "<sha256-or-null>",
  "event": "verification|review|nudge|block|timeout",
  "outcome": "pass|fail|clean|flagged|transient|blocked|cap-hit",
  "durationMs": 0,
  "metadata": {}
}
```

Never store credentials, complete environment variables, private source bodies,
or unbounded tool output. Store hashes, command identifiers, bounded excerpts,
and paths relative to the workspace.

### Evaluation design

Use randomized, paired arms with identical task fixture, model, seed, watchdog,
context budget, and machine-load policy:

- baseline harness;
- one candidate change at a time;
- combined candidate only after isolated contribution is understood.

Task set:

- at least one clean and one deliberately seeded task for Go, Python, Flutter,
  PostgreSQL, Kafka, and Temporal;
- at least one multi-stack task;
- historical real failures from the existing validation record;
- safety fixtures scored separately from coding quality.

Run a nine-pair screening battery before expensive evaluation. A candidate that
shows no target signal, introduces a safety regression, or repeatedly times out
is stopped. Candidates that survive screening run at least 30 paired trials
across the task set. Report paired outcomes, Wilson confidence intervals, and an
exact paired test where applicable; do not call a noisy change proven from one
successful anecdote.

### Adoption thresholds

Deterministic extensions:

- 100% contract-test pass;
- 100% target safety/invariant matrix;
- zero newly permitted destructive cases;
- no silent failure path.

Judgment-dependent extensions:

- improve the seeded target-bug catch rate over baseline;
- do not reduce clean-task completion rate;
- false-positive corrective turns remain at or below 10%;
- median wall-time overhead remains at or below 20%, unless a documented
  correctness improvement justifies the cost;
- no watchdog or transient-infrastructure result is scored as model behavior.

If confidence intervals remain too wide to distinguish the candidate from
baseline, record the result as inconclusive and leave the candidate disabled.

### Rollout

1. Ship disabled behind a setting.
2. Run contract tests and offline fixture replay.
3. Run the paired screening battery.
4. Enable for monitored, non-production tasks.
5. Run the adoption battery.
6. Promote to default only after thresholds pass.
7. Retain a one-setting rollback and record the reason for any disablement.

**Phase 5 exit:** R-8 and R-9 pass, and each enabled judgment-dependent extension
has a current evidence record tied to its exact implementation and model route.

## Implementation sequence and PR boundaries

Keep implementation reviewable; do not combine these phases into one PR.

| PR | Scope | Primary proof |
|---|---|---|
| 1 | Reviewer configuration, naming, docs reconciliation | reviewer matrix + known-bug replay |
| 2 | Pi TypeScript test project and existing extension contracts | typecheck + deterministic suite |
| 3 | Shared verification module and `quality-gate.ts` | current-diff state-machine tests |
| 4 | Project-skill migration and generic workflow cores | global/project prompt-capture fixtures |
| 5 | Portable stack skills and router | positive/negative routing fixtures |
| 6 | Containment profile and external-effects gate | escape/effect safety matrix |
| 7 | Structured telemetry and evaluation runner | schema tests + reproducible baseline |
| 8+ | One candidate default change per evidence-backed result | paired adoption report |

Every implementation PR must update its relevant status document with:

- exact code/configuration tested;
- model and endpoint identity;
- deterministic results;
- live evaluation sample size and failures;
- latency/token cost;
- adopted, disabled, or inconclusive verdict;
- rollback instructions.

## Acceptance matrix

| Requirement | Evidence | Pass condition |
|---|---|---|
| R-1 | Reviewer contract tests, startup trace, known-bug replay | identity is truthful and validated configuration matches docs |
| R-2 | Global and DayTrix prompt captures | zero project leakage; DayTrix coverage preserved |
| R-3 | Diff/version state-machine tests | only a green result for the current material diff satisfies completion |
| R-4 | Stack routing fixtures and skill tests | correct skills for all seven stack areas; no unrelated injection |
| R-5 | Containment escape matrix | all forbidden filesystem, credential, and network attempts fail |
| R-6 | External-effect command matrix | incidental production-affecting actions blocked; explicit workflows preserved |
| R-7 | Typecheck and committed extension suite | all hooks, interactions, caps, and failures covered and green |
| R-8 | Versioned session entries and parser tests | every judgment-dependent outcome reconstructable without transcript archaeology |
| R-9 | Randomized paired report | thresholds met or candidate remains disabled/inconclusive |
| R-10 | Documentation verification | current behavior, historical evidence, and status agree; all links pass |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Quality gate causes infinite loops | hard retry cap, diff-bound state, explicit cap-hit terminal record |
| Full verification is too expensive after every chunk | focused checks during chunks; one broad current-diff gate at settlement |
| Stack router misclassifies a repository | require manifest/dependency evidence and maintain negative fixtures |
| Skill migration breaks non-interactive discovery | test `pi -p`, interactive startup, trusted/untrusted project modes before unlinking globals |
| Reviewer adds latency without value | disabled-by-default screening and explicit latency/adoption thresholds |
| Same-family reviewer repeats primary blind spots | require identity disclosure and compare diverse/same/no-review arms |
| Regex safety gate creates false confidence | OS sandbox is the boundary; command gate is defense in depth |
| Telemetry leaks source or secrets | relative paths, hashes, bounded excerpts, schema-level redaction tests |
| Benchmark overfits one repository | multi-stack fixtures plus historical and clean controls |
| Documentation becomes stale again | docs verification in each behavior-changing PR and runtime identity traces |

## Final definition of done

This hardening program is complete only when:

1. All ten requirements have direct evidence in the acceptance matrix.
2. DayTrix-specific skills are project-local and unrelated backend projects
   receive no DayTrix instructions.
3. Every enabled extension has committed contract tests and a current status.
4. A passing verification is tied to the final material diff.
5. Unattended execution is contained by the operating system.
6. Production-affecting operations remain explicit and independently gated.
7. Stack-specific skills route correctly for Go, Python, Flutter, PostgreSQL,
   Kafka, Temporal, and GCP.
8. Judgment-dependent defaults have passed paired evaluation; inconclusive
   candidates remain disabled.
9. Documentation, runtime configuration, and historical evidence are mutually
   consistent.
10. The complete deterministic suite and applicable CI checks pass from a clean
    worktree.
