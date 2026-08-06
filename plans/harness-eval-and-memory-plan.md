# Terminal-Bench/mini-swe-agent + codebase-memory-mcp — plan

**Status: partially complete (2026-08-05).** The five-minute #3 smoke is
complete: Docker/Colima and Harbor work, the native-arm64 oracle passes, the
active customized Pi harness and Terminus 2 both passed the same task on the
same Qwen model, and the containment matrix passes 17/17. The result is
directional only (`n=1`), so the verdict is **inconclusive-needs-more-n**.
#4 is installed, reviewed, indexed, and trial-wired read-only. Its lightweight
pair completed on 2026-08-06 with equal 4/4 accuracy, only 2.91% token savings,
and more turns/tools; its verdict is **default-disabled**, not globally enabled.
The original 3-5 task/no-tool scope remains unrun. This is #3 and #4 from the
open-source-repos recommendation thread (2026-08-05); #1 (RTK) was settled as
"leave as is"
and #2 (reviewer transient-split + schema verdict) shipped in `c94fa60`,
`125f2b2`, `395d247`. Reviewer background for anyone reading this cold: see
`pi-harness-validation-status.md`'s `cross-model-review.ts` entry.

Both items are independent of each other and of the reviewer work. Do them
in either order; #3 is the higher-value one because it fixes a measurement
gap that affects every future harness claim, #4 is a bounded trial of a
single tool.

---

## #3 — Docker + Terminal-Bench 2 / mini-swe-agent

### 2026-08-05 lightweight result

- Colima 0.10.3 provides Docker 29.7.1; `hello-world` passed.
- Harbor 0.20.0's bundled oracle passed `openssl-selfsigned-cert` in a
  force-built native-arm64 image.
- The custom Harbor adapter snapshots the active host Pi configuration
  (extensions, skills, prompts, edited `AGENTS.md`, settings, and RTK) while
  excluding credentials, sessions, and caches.
- On the same task and ThinkingCap-Qwen3.6-27B model, custom Pi 0.83.0 and
  Terminus 2.0.0 both scored 1.0. End-to-end runtime was 2m33s vs. 4m35s;
  uncached-input-plus-output tokens were 12,845 vs. 15,778; tool calls were
  22 vs. 34. At `n=1`, this proves compatibility but not a general harness
  advantage.
- `pi/containment/verify-live.sh` passes all 17 checks on this Docker host.
- The cloud-model, mini-swe-agent, and broader task-set runs were intentionally
  omitted from the user-requested five-minute version.

### Why

`local-model-bench`'s entire verdict rests on a 7-task suite, and its own
`STATUS.md` already records a `pi-local` failure that did not reproduce on
3 standalone re-runs of the same task — the harness cannot currently tell
signal from noise at that n. There is also no control arm: every
comparison so far is "Pi's harness + Qwen3.6" against "solo Sonnet" or
"Aider + local model," never against a neutral, model-agnostic harness
running the same model. That means "the harness helps" and "the model is
good" are not currently separable claims in this repo's data.

Terminal-Bench 2 supplies both fixes: 89 human-verified tasks (real n) and
**Terminus 2**, a model-agnostic reference agent (a real control). Docker
is the blocker for both this and the containment work
(`pi/containment/`'s escape matrix is statically verified only, per
`README.md`), so one install unblocks two open items.

### Plan

1. **Install Docker** (Docker Desktop or OrbStack — either satisfies
   Terminal-Bench's requirement; OrbStack is lighter on this hardware if
   you don't need Docker Desktop's GUI). Verify with `docker run hello-world`.
2. **Stand up Terminal-Bench 2** per its own install docs. Do a dry run
   with its bundled/default agent against a handful of tasks first, just
   to confirm the harness itself works on this machine before pointing
   any of your own agents at it.
3. **Run Terminus 2 (the neutral reference harness) against your two
   resident models** — Qwen3.6-27B (`:8080`) and, separately, whatever
   cloud model `local-model-bench` uses as its `claude-sonnet-5` baseline.
   This produces the control-arm numbers that don't currently exist:
   "what does this model score with no custom harness at all."
4. **Run `pi-local` (Pi driving Qwen3.6-27B) against the Terminal-Bench 2
   task set**, not just your existing 7-task suite. Compare against step 3's
   Terminus 2 numbers on the *same model* — the delta is Pi's harness
   contribution, isolated from model capability for the first time.
5. **Optionally, add `mini-swe-agent`** as the minimal-harness floor (bash
   tool only, no editing primitives, no custom prompt). This gives a third
   point: minimal-harness / Pi-harness / Terminus-reference, all on the
   same model, same tasks.
6. **Write up the result** in `local-model-bench/STATUS.md`, following its
   existing "living summary, verdict layer over dated reports" convention.
   If `pi-local`'s harness contribution is near zero on this larger n, that
   is itself a useful, if unwelcome, answer — worth stating plainly rather
   than re-running until a preferred number appears.
7. **Feed back into containment**: with Docker now present, re-run
   whatever escape-matrix checks `pi/containment/` was blocked on and
   update its status from "statically verified only" to whatever the real
   result is.

### Costs / risks to flag before starting

- Terminal-Bench's 89 tasks at full harness overhead (Docker container
  per task, some tasks are "hard" and long-running) is a real time and
  compute cost on this machine — worth a partial run (e.g. the easy/medium
  tiers, or a random 20-task sample) before committing to all 89 if the
  full run turns out to be slow.
- This is the first time Docker will run persistently on this Mac
  (per `README.md`, "Docker is not installed on this host" was itself a
  documented constraint) — check it doesn't compete for the same
  `iogpu.wired_limit_mb` ceiling the two resident MLX routes already share
  before running Docker containers and local inference concurrently.
- Terminus 2 and `mini-swe-agent` are both external, unaudited codebases
  running with real tool access — treat them with the same scrutiny as any
  new coding-agent harness before pointing them at a real repo, not just
  a scratch one.

### Definition of done

- Docker installed and verified working on this host.
- At least one Terminal-Bench 2 run completed for Terminus 2 (control)
  and one for `pi-local`, on the same model, same task subset.
- `local-model-bench/STATUS.md` updated with the new evidence and an
  explicit verdict (harness helps / doesn't / inconclusive-needs-more-n),
  not left as raw numbers with no conclusion.
- `pi-harness-validation-status.md`'s containment entry updated now that
  Docker exists to test against.

---

## #4 — codebase-memory-mcp trial

### 2026-08-06 lightweight result

- Version 0.9.0 was checksum-verified, source-reviewed, and installed as a
  standalone binary. A disposable clone of `personal-assistant` indexed
  successfully (10,658 nodes, 48,988 edges), and focused graph searches
  returned the expected Go handlers and tests.
- A trial-only Pi adapter exposes only typed, read-only `search_graph`,
  `get_code_snippet`, and `trace_path` operations. It is not installed in the
  normal Pi configuration.
- The first attempted arm exposed and fixed an adapter-schema bug (`pattern`
  was accepted where the server requires `query`, causing an unbounded graph
  response). A later attempt was interrupted to avoid contention with a
  separate inference; neither failed attempt was counted.
- The completed pair used one predeclared architecture question. Both answers
  scored 4/4 deterministically and 4/4 from separately blinded Gemma 4 reviews.
  Memory used 2.91% fewer uncached-input-plus-output tokens, but took 0.94%
  longer, 50% more turns, and 41.18% more tool calls. It fell back to ordinary
  repo tools for 21/24 calls.
- The vendor's 99.2% token-reduction claim was not confirmed. Verdict:
  **default-disabled**. This is directional `n=1` evidence; the original 3-5
  task battery and no-tool baseline remain unrun.

### Why

The Agentic Harness Engineering finding (`arxiv.org/abs/2604.25850`,
surfaced in the original recommendation) found harness gains come from
"tools, middleware, and long-term memory" more than from prompt tuning.
Every one of the 21 Pi extensions in `pi/extensions/` is within-session —
none persist structural understanding of a codebase across runs. That's
the one category of harness improvement this repo hasn't tried yet.
`codebase-memory-mcp` (MIT, 37.6k stars, tree-sitter across 158 languages
+ LSP-grade semantic layer for 12 including Go/TS/Python) is a plausible,
bounded way to test that gap — but it should be a trial with a real
before/after measurement, not an adoption, given this repo's now-established
pattern of self-reported tool metrics not surviving a paired check (RTK's
`rtk gain`, the reviewer's old `NO_ISSUES_FOUND` marker).

### Plan

1. **Install it standalone first**, against one real repo already in
   `~/code/` (a mid-sized Go one is the best fit — Go is in the LSP-refined
   12; a Flutter/Dart repo would only get tree-sitter, so pick a Go target
   for the first trial). Confirm `index_repository` completes and
   `search_graph`/`query_graph` return sane results before wiring it to
   any agent.
2. **Wire it as an MCP server to Pi (or whichever agent you trial it
   with) on that one repo only** — don't roll it out globally yet.
3. **Design the paired comparison before running it**, the same discipline
   used for the reviewer battery: pick 3-5 real tasks on that repo that
   plausibly benefit from structural codebase understanding (e.g. "find
   all callers of X and update them," "trace how Y flows through the
   handler layer"), run each once with the MCP tools available and once
   without, and compare — turns taken, tokens/cost, and whether the agent
   actually used the graph tools versus falling back to grep/read. A tool
   that's available but unused is not adopted; say so if that happens.
4. **Check the self-reported "99.2% token reduction" claim against your
   own paired numbers**, not the README's. That figure is a vendor
   counterfactual claim of exactly the shape RTK's `rtk gain` turned out
   to be — treat it as unverified until your own measurement confirms or
   contradicts it.
5. **Decide adopt / default-disabled / rule-out** based on the paired
   result, and record it in `pi-harness-validation-status.md` in the same
   table used for every other extension, so it's held to the same bar as
   everything else in this repo rather than living outside the evidence
   standard.

### Costs / risks to flag before starting

- It's a new MCP server with 15 tools and file-system access to your
  codebase — review what `index_repository` actually reads/writes before
  pointing it at anything other than a disposable clone.
- Dart/Flutter work gets tree-sitter only, not the LSP-refined tier — don't
  expect the same quality of answer on Flutter repos as on Go/TS/Python
  ones; note this explicitly in the trial rather than discovering it mid-run.
- This is a single-vendor tool with no comparison run against alternatives
  (e.g. a plain `ast-grep`-based index, or nothing at all beyond
  Read/Grep) — the trial should include a no-tool baseline arm, not just
  with/without-MCP, so "does structural memory help at all" and "is this
  specific tool good" don't get conflated.

### Definition of done

- One repo indexed, MCP wired, 3-5 tasks run paired (with/without) plus a
  no-tool baseline.
- A written verdict in `pi-harness-validation-status.md`: adopted,
  default-disabled-pending-more-evidence, or ruled out — with the actual
  measured numbers, not the vendor's.
- If adopted: a rollout decision (this repo only vs. global) stated
  explicitly, not assumed.

---

## Open decision for whoever picks this up

Both plans lean on "design the paired comparison before running it,"
mirroring what made the reviewer battery catch a real regression before
it shipped. If time is short, that discipline is the part not to cut —
a plausible-looking number without a baseline arm is exactly the failure
mode this repo has now hit three times (RTK, the old marker verdict, and
implicitly the harness-vs-model conflation #3 exists to fix).
