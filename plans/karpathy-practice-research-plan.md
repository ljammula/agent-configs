# Agent-config gaps — research-backed plan (2026-07-23)

Source: workflow `wf_896310d0-59a` (task `wbnbwx4in`), 5 research lenses + adversarial
verification pass. 63 findings, 33 held + 4 narrowed after refutation, 0 fully killed.
Full raw output (all citations + per-agent trace): `/private/tmp/claude-501/-Users-kanna-code-agent-configs/6298f324-eb68-43e2-b9a0-2c2c14935621/tasks/wbnbwx4in.output`

## What the best practitioners are actually doing (ranked by daily-loop impact)

1. **Separate generation from evaluation into distinct agents/processes** — self-grading
   agents skew positive; an independent checker is required.
   — Addy Osmani, addyosmani.com/blog/agent-harness-engineering, 2026-04-19
2. **Deterministic gates belong in git hooks, not in prose skill steps** — pre-commit/pre-push
   linting, type checks, and targeted tests are "the gate between an agent's output and your
   repository," not optional.
   — jonesrussell.github.io/blog/git-hooks-ai-agents, 2026-03-16
3. **`PreToolUse` is the only hook that can actually block** (non-zero exit), converting
   CLAUDE.md rules from advisory to unconditional; `PostToolUse`/`Stop` only clean up after
   the fact.
   — pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns, 2026-02
4. **Two-tier verification: fast deterministic "computational sensors" on every change, slow
   "inferential" LLM-judge sensors reserved for semantic review.**
   — martinfowler.com/articles/harness-engineering.html (Birgitta Bockeler), 2026-04-02
5. **Held-out tests the agent didn't write/see must gate merge** — agents reward-hack visible
   test suites; SpecBench shows every model saturates visible tests while a held-out gap
   persists.
   — arxiv.org/abs/2605.21384, 2026-05
6. **A short, checkable Definition of Done beats "it should work correctly" as a criterion**,
   and a working demo is explicitly the least reliable evidence (happy-path only).
   — braingrid.ai/blog/definition-of-done-for-ai-builders, 2026-06-28
7. **LLMs are unreliable at grading their own reasoning even after RL** — mitigation is
   external verification, not better self-critique prompts.
   — arxiv.org/pdf/2506.11442, 2026-06
8. **A hard-coded/deterministic verifier reading actual application state beats LLM-as-judge**
   on trace/screenshot review (113/120 vs 95/120 task agreement).
   — arxiv.org/pdf/2605.19769, 2026-05
9. **CI (not the pubspec file) should own the mobile build number; ASC's actual latest-build
   state must be queried before tagging a release**, to avoid ITMS-90186/90062.
   — docs.codemagic.io/knowledge-codemagic/build-versioning; github.com/codemagic-ci-cd/cli-tools
   `get-latest-app-store-build-number`, both accessed 2026-07-23
10. **Skill sprawl silently truncates the model's visible skill list once description text
    exceeds ~16,000 characters** — one audited case showed only 42/63 skills visible at all.
    — dev.to/shimo4228/15-days-of-skill-sprawl-in-claude-code, 2026-02-22

## Where this repo already matches — and what's only half-built

- **#1/#7 (independent verification, not self-grading)**: `before-done` + `self-review`
  already split into two passes, and the ai-stack `:8080` code-review model is
  architecturally the independent checker. **Gap**: unconfirmed whether `before-done`
  actually routes through `:8080` rather than the same Claude session re-reading its own
  diff — verify the skill body does this, not just the intent.
- **#4 (tiered sensors)**: the ai-stack split (deterministic `make verify`/tests via
  `backend-dev`/`frontend-dev`, then `:8080` inferential review via `self-review`) matches
  the fast/slow structure. **Missing half**: no evidence the fast tier is a git hook — it's
  still Claude-invoked, so it can be skipped under time pressure (see Gap 1 below).
- **#6 (Definition of Done)**: `before-done`'s description is a real checklist of checkable
  facts, not "it should work." Strongest existing alignment in the repo.
- **#9 (build-number correctness)**: `testflight-cut` already targets ITMS-90186/90062 by
  name. **Missing half**: unclear if it queries App Store Connect's current build state
  versus inferring from pubspec/git alone — if the latter, it's guessing at the exact thing
  that most needs an authoritative external check. (This is what the current
  `check-version-sync.sh`/`release-facts.sh` do — local-only, no ASC query.)
- **#5 (held-out tests)**: `backend-dev`/`frontend-dev` mandate red/green TDD, which is
  adjacent but not the same claim — nothing currently prevents the agent from writing *and*
  being graded by the same tests it authored.
- **Skill triggers generally**: descriptions already read as third-person trigger phrases
  with concrete keywords ("t0.1.1-2", "ITMS-#####", "did it work?") — matches Anthropic's
  documented pattern well.

## The gaps, ranked

**Gap 1 — Verification steps are Claude-invoked, not hook-enforced.**
Evidence: jonesrussell.github.io/blog/git-hooks-ai-agents (2026-03-16);
pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns (2026-02).
Artifact: `settings.json` `PreToolUse` hook on `Bash` matching `git commit` that shells out
to `make verify` and exits 2 with the failing output on non-zero — config change via the
`update-config` skill, not a new SKILL.md.
Cost: ~30-line hook script, needs per-repo path detection (backend vs frontend). Only build
if you've actually caught yourself/the agent skipping `before-done`.

**Gap 2 — No held-out test layer; the agent can write and pass its own tests.**
Evidence: arxiv.org/abs/2605.21384 (SpecBench, 2026-05);
explainx.ai/blog/cursor-reward-hacking-swe-bench-eval-contamination-2026 (2026-06-25).
Artifact: a small, human-curated `backend/regression/` and `frontend/regression/` test set
that `before-done` is told never to modify. One line added to `before-done/SKILL.md`: run
`make regression` in addition to `make test`; if it needed edits to pass, stop and report why.
Cost: low to add, but you have to author the regression cases yourself. Only worth it for
DayTrix invariants that would be expensive to silently break (auth/household-sharing
fallback chain, billing) — skip for routine CRUD screens.

**Gap 3 — `testflight-cut` trusts local/pubspec state instead of querying App Store Connect
for the real latest build number before tagging.** ← highest-leverage per the research.
Evidence: docs.codemagic.io/knowledge-codemagic/build-versioning;
github.com/codemagic-ci-cd/cli-tools `get-latest-app-store-build-number` (both accessed
2026-07-23); github.com/fastlane/fastlane/issues/20807 (ITMS-90186 reports).
Artifact: `scripts/asc_preflight.sh` with a strict PASS/FAIL contract — PASS only if the
proposed version+build is strictly greater than ASC's current highest build across ALL
versions (via `app-store-connect get-latest-app-store-build-number --all-versions` or the
ASC API directly); FAIL prints ASC's actual latest state and exits 1, blocking the
`t<version>` tag push. `testflight-cut/SKILL.md` should call this as its final verification
step in Phase 2, alongside (not instead of) `check-version-sync.sh`.
Cost: needs ASC API credentials wired into the script — Xcode Cloud already has them, so
likely just needs the same key exposed to a local script. Medium cost, build this one.

**Gap 4 — No fast/slow sensor split codified in `before-done`.**
Evidence: martinfowler.com/articles/harness-engineering.html (Bockeler, 2026-04-02).
Artifact: doc-only edit to `before-done/SKILL.md` — state the sequence explicitly:
1) deterministic (`make verify`), 2) local ai-stack review (`:8080`), 3) only then
`self-review`'s semantic pass.
Cost: near zero. Do this regardless of anything else.

**Gap 5 — Skill-description budget is unaudited (13 skills across 4 tools).**
Evidence: dev.to/shimo4228/15-days-of-skill-sprawl-in-claude-code-lessons-from-3-audits-27em,
2026-02-22.
Artifact: `scripts/audit_skill_budget.sh` — sums every SKILL.md `description:` field length,
PASS under ~8,000 chars (half the reported 16,000-char truncation threshold), FAIL lists
which skills to trim. Run manually/quarterly, not as a hook.
Cost: 20 min to write. Skip unless skills start failing to trigger.

**Gap 6 — Reference-file chains in `wiring-verify`/`docs-verify` may be more than one hop
deep.**
Evidence: platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices.
Artifact: none — audit both SKILL.md files for `SKILL.md → a.md → b.md` chains, flatten to
one hop. Five-minute manual check, do opportunistically next time either is touched.

**Gap 7 — No explicit "solve, don't defer" / no-voodoo-constants check on bundled scripts.**
Evidence: same Anthropic best-practices doc.
Artifact: fold into Gap 3's `asc_preflight.sh` build — every constant gets a one-line
rationale comment; handle network/file-not-found errors explicitly rather than letting
Claude improvise a retry. Zero incremental cost if built alongside Gap 3.

## What to ignore

- **Spec-driven development / spec-kit ceremony for every feature.** Community consensus:
  skip it when "a spec would be longer than the change." `feature-dev` already goes straight
  roadmap→implementation — correct for solo-dev scope, don't bolt on spec-kit.
- **Building a custom trigger-eval harness for skill descriptions.** Anthropic ships
  `skill-creator` that automates this end-to-end — pull it if ever needed rather than writing
  one from scratch.
- **Native Claude Code subagents for parallel DayTrix work.** Steinberger explicitly prefers
  separate terminal windows over subagents; hooks (not agent judgment) are the reliable
  enforcement mechanism. For a solo dev, don't add subagent orchestration complexity — git
  worktrees are the lighter-weight equivalent if parallelism is ever needed.
- **Routing multi-file agentic edit work to local models.** Local models are near-parity on
  single-file work but show a clear gap on multi-file refactoring (11.4 vs 13.6 on a 15-point
  scale). Keep local models on read-only/summarization/review duty (as `local-search`/
  `local-summarize`/`self-review` already do) — don't extend to writing DayTrix code.
- **Chasing GPU/local-inference cost savings under a Claude subscription.** Marginal API cost
  inside a Max/Pro plan is near zero; the real payoff of the ai-stack box is context-window
  preservation and secrets-off-network, not dollars.

## Could not verify (filtered out, do not treat as fact)

- Karpathy's original late-Jan-2026 X thread on three failure modes — only paraphrased
  secondhand (direct fetch 402'd).
- The "41%→11%→3% mistake rate" statistic attributed to a viral Karpathy-derived CLAUDE.md —
  no methodology, sample, or Karpathy endorsement found.
- Whether this repo's `karpathy-guidelines` skill derives from the Forrest Chang repo vs. an
  independent source — structural similarity only, not confirmed.
- Karpathy's ~75% Cursor tab-complete post — fetch blocked (HTTP 402).
- "Claude Code now reads AGENTS.md too" — contradicts a fetched source, not resolved either
  way.
- Steve Yegge's "Gas Town" multi-agent orchestration details — plausible, unfetched.
- "Sub-agents pay off at 4+ parallel branches" — unsourced.
- Simon Willison's claimed positions on skills/slash-command unification — not fetched
  directly from simonwillison.net.
- AGENTS.md's OpenAI → Linux Foundation governance claim — search-snippet only.
- "Harness engineering" term attributed to Mitchell Hashimoto (Feb 2026) — unverified.
- LangChain's 30th→5th place Terminal Bench 2.0 jump — unverified, search-snippet only.
- Verification Horizon paper's specific 28.57%→0.56% hacked-resolved-rate numbers — PDF fetch
  didn't reproduce the exact figures.
- Any dedicated ASC "validate before upload" API distinct from the upload call itself — none
  found; only indirect pre-checks (querying latest build/version) exist.
- Whether the fastlane/ASC API can detect a closed pre-release train *before* attempting
  upload — no such pre-check mechanism found; you only learn it from the ITMS-90186 error
  itself even with Gap 3 built.
- GLM-5.2/GLM-5.1 SWE-bench figures — unfetched search snippets only.
- Kimi K2.6 vs GLM-5.1 pricing-gap claim — fetch blocked by a redirect loop.
- Any 2026 public counterpart to this user's own Copilot-local vs Pi vs Sonnet+Aider
  benchmark — none found.

## Next step

Gap 3 (`asc_preflight.sh` for `testflight-cut`) is the one the research flags as
highest-leverage — not yet built. Everything else in this file is unstarted.
