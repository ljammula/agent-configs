# Qwen3.8-27B agentic-coding tuning research and recommendations

Colleague-facing summary: `reports/qwen38-pi-harness-report.html`
(self-contained — open directly in a browser, or via GitHub Pages linked
from the project overview at `index.html`; kept in sync with this file,
update both when new trials land).

**Superseded runtime, findings still relevant (2026-08-21):** everything
below was measured against the dedicated 8-bit mlx-vlm instance that used
to serve `:8080`. That route was swapped to the mtplx runtime's
`Qwen3.8-27B-MTPLX-Optimized-Quality` on 2026-08-21 (see
`local-ai-stack.md`'s "`:8080` swap to mtplx" and `pi-harness-history.md`);
the quantization/route-level claims below (e.g. "don't change quantization,
8-bit is right") describe the retired route, not the model `:8080`
currently serves. The thinking-format/sampling-parameter findings were
carried over onto the new route unverified — see `ai-stack-local.ts`'s
inline comments. Treat this file as the historical trace behind those
carried-over settings, not a live description of `:8080`.

Research date: 2026-08-17, revised after Opus review same day. Scope:
validate `pi.dev` local harness's Qwen3.8-27B route (`:8080`, see
`local-ai-stack.md`) against vendor documentation for agentic coding, and
connect it to the open "diagnose-but-don't-act" finding in
`pi-harness-history.md`'s 2026-08-16 4-trial entry (`pi-local` 0/4 on
`go/lru-cache`, `claude-sonnet-5` 1/1 clean).

**Revision note**: the first draft of this document claimed the harness
"forces thinking fully off at two independent layers." An Opus review
caught that this is backwards: with `model.reasoning: false`, pi sends **no
thinking-control field at all** — not `enable_thinking: false`. Nothing at
the wire level forces thinking off; whatever mlx-vlm's served chat template
defaults to is what actually governs, and that default is currently
**unverified**. The review also found the `reasoning: 0` usage-counter
evidence cited in `pi-harness-history.md` is likely a structural null on
this route (mlx-vlm doesn't populate `completion_tokens_details`), and that
two of this document's `temperature`/`--thinking off` citations pointed at
non-`pi` runs. All corrected below; the review's full findings are folded
in rather than kept as a separate addendum.

## Summary

The harness never explicitly enables thinking for Qwen3.8-27B, and no code
path currently sends `enable_thinking` or `reasoning_effort` to `:8080` at
all (`model.reasoning: false` in `ai-stack-local.ts` gates every
thinking-format branch in `pi-ai`'s `buildParams`, including the fallback).
**Whether the served model thinks by default anyway — which the vendor
model card claims for the base checkpoint — is not established for this
specific deployment.** That must be checked with a live request before any
other claim in this document is trusted. This connects to
`pi-harness-history.md`'s own "untested, proposed as next experiment"
hypothesis (`defaultThinkingLevel: "low"`/`"medium"` might change the
diagnose-but-don't-act behavior) but the mechanism proposed there — and
originally in this document — needs the verification step below before
being treated as established.

**Status (2026-08-17): Step 1 and Step 2 are done; Step 3 (the live
re-run) is not.** Step 1's three curl checks were run live against `:8080`
(see results below). Step 2's config edit was applied to both
`pi/extensions/ai-stack-local.ts` (symlinked into `~/.pi/agent/extensions/`,
so live immediately) and `defaultThinkingLevel` in both
`pi/settings.json` and the live, deliberately-unsymlinked
`~/.pi/agent/settings.json`. Step 3 (re-running `go/lru-cache` against the
existing 0/4 baseline) has not been run yet.

## Verified-vs-assumed table

| Claim | Status | Source |
|---|---|---|
| `ai-stack-local.ts` sets `reasoning: false` on the Qwen3.8 model entry | Verified | `pi/extensions/ai-stack-local.ts:14` |
| `pi/settings.json` sets `defaultThinkingLevel: "off"` | Verified | `pi/settings.json:6` |
| With `reasoning: false`, `buildParams` sends no thinking field of any kind (not even an explicit "off") | Verified | `pi-ai/dist/api/openai-completions.js` lines 560–635, all branches gated on `model.reasoning` |
| A custom `baseUrl` like `:8080/v1` is detected as `compat.thinkingFormat: "openai"`, not `"qwen"`, unless overridden | Verified | `detectCompat` in the same file — none of the isDeepSeek/isZai/isTogether/isAntLing/isOpenRouter predicates match this host |
| `qwen3.8-max-preview`'s bundled `thinkingLevelMap` is `{"minimal":null,"low":"low","medium":"medium","high":null,"xhigh":"xhigh","max":null}` with `compat.thinkingFormat: "qwen"` | Verified | `pi-ai/dist/providers/data/qwen-token-plan.json` |
| `reasoning: 0` in the 4-trial usage lines proves the model didn't reason | **Not established** — likely a structural null | `openai-completions.js`: `reasoning: rawUsage.completion_tokens_details?.reasoning_tokens \|\| 0`; mlx-vlm's OpenAI-compat server is not confirmed to populate `completion_tokens_details` |
| The 4 trials ran at `temperature: 0` | **Not established** for the trials specifically | `buildParams` only sets `params.temperature` if the caller passes one; `pi/settings.json` sets none. The "temp 0" citations found (`local-ai-stack.md`'s throughput micro-benchmark, `PLAN.md:1095`'s direct-curl tool-config baseline) are both non-`pi` runs |
| `--thinking off` was used in a `pi` harness run | Verified, but for a **different (3.6-era) run**, not the 2026-08-16 4-trial config | `ai-stack/PLAN.md:455`, dated 2026-07-26 |
| mlx-vlm's `:8080` route reads `enable_thinking`/`reasoning_effort` top-level vs. nested under `chat_template_kwargs` | **Unconfirmed either way** | No local install of `mlx_vlm` on this machine (it runs on `kannasmacstudio.lan`); needs a direct curl or a remote read of `mlx_vlm/server.py` |
| GLM-4.7-Flash-4bit was tested on this same mlx-vlm stack with thinking explicitly forced on via `chat_template_kwargs: {"enable_thinking": true}` | Verified — and the closest internal prior to this experiment | `pi-harness-history.md:1133-1166` |

## Community findings (Reddit / HF discussions / independent write-ups, 2026-08-17)

Gathered after step 3's config change was already applied, to check the
change against wider community experience rather than only the vendor card.

**"Overthinks at the default `xhigh`" is a widely reported, independent
complaint, not unique to this harness.** [Simon Willison's write-up](https://simonwillison.net/2026/Aug/16/qwen-38-27b/)
(also on [his Substack](https://simonw.substack.com/p/qwen-38-27b-is-excellent-but-it-defaults))
reports a trivial SVG-generation prompt taking 21 minutes at `xhigh`
(22,276 reasoning tokens producing only 3,223 output tokens), and states
plainly: "ignore that default. Run Qwen 3.8 27B on low or even no reasoning
levels at first." With reasoning disabled entirely, the same prompt took
137 seconds. The HF discussion ["A crazy thinking model"](https://huggingface.co/Qwen/Qwen3.8-27B/discussions/97)
has multiple independent reports of the same pattern ("it always thinking
and thinking, can it stop?"; one user hitting the max reasoning-token
ceiling on ordinary prompts) — and one comment there specifically
recommends `"reasoning_effort": "medium"` over `xhigh` as "better," which
is what step 2 already set. **This is independent, converging support for
starting at `"medium"` rather than the vendor's own `"xhigh"` default**
(a call this document made for context-budget-risk reasons before finding
this corroboration).

**A contested "structural defect" claim exists and should not be treated
as established.** HF discussion [#76](https://huggingface.co/Qwen/Qwen3.8-27B/discussions/76)
has a user (`LuffyTheFox`) claiming a scale-misalignment defect in
`ssm_conv1d` weights (blocks 52-62) causes the overthinking, with a
patched-weights fork (`redashes/Qwen3.8-27B-BF16-SSMFIX`) offered as a
partial fix. Other commenters in the same thread call this
"pseudo-scientific" and attribute the behavior to RLHF/alignment choices
instead, and note successful non-looping deployments with ordinary
configuration. No consensus was reached. **Do not adopt the SSMFIX weights
or treat the defect claim as fact** based on this thread alone — it's
included here only because it's part of the visible community discussion,
not as a recommendation.

**`preserve_thinking` is reported as the specific fix for agentic
re-planning loops — and the harness's current config does not send it.**
Community reports (via search summary, not independently re-verified
against a primary thread the way the items above were) describe a model
that loops non-stop sending wrong arguments on file-writes in agentic mode,
resolved by enabling `preserve_thinking`; the suggested practice is to
A/B `preserve_thinking` on vs. off across ~5 tool turns and keep whichever
setting stops the model from re-planning the same fix repeatedly. This is
a strikingly close match to the exact failure shape already documented in
this repo's own `pi-harness-history.md` 4-trial entry (diagnosis correct,
never converted into an edit, repeated near-identical scratch-test
variants). **Checked against the code applied in step 2**: `pi-ai`'s
`"qwen"` thinkingFormat branch (the one confirmed live-working here) sends
only `enable_thinking` and `reasoning_effort` — it does **not** send
`preserve_thinking` at all, unlike the `"qwen-chat-template"` branch, which
hardcodes `preserve_thinking: true`. The model card states
`preserve_thinking` "is enabled by default for all workloads," so the
server's own default is likely already correct even without pi sending it
explicitly — but that default has not been confirmed for this specific
mlx-vlm deployment the way step 1 confirmed the `enable_thinking` shape.
**If trial 5 (or later trials) still shows diagnose-but-don't-act behavior,
this is the next concrete thing to check**: curl `:8080` across a
multi-turn tool-call sequence with `preserve_thinking` explicitly set true
vs. explicitly omitted, and see whether reasoning content actually survives
into later turns either way.

**Quantization**: no community source found changes the existing
"don't touch it" recommendation. One write-up
([aifreeapi.com](https://www.aifreeapi.com/en/posts/qwen3.8-27b-local-agentic-coding))
frames Q4 vs. Q8 purely as a memory-tier tradeoff (Q4 ~19GB for 24GB-class
hardware, Q8 ~28.6GB needing 32GB+ headroom) with no coding-quality
differentiation claimed either way — consistent with this repo's own
matched-pair A/B finding on the prior 3.6 checkpoint (12/12 identical).
This machine has the headroom for 8-bit and no evidence favors 4-bit.

## Vendor-recommended sampling parameters (Qwen3.8-27B model card)

From [Qwen/Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B),
[Unsloth run guide](https://unsloth.ai/docs/models/qwen3.8),
[Qwen/Qwen3.8-27B-FP8](https://huggingface.co/Qwen/Qwen3.8-27B-FP8). These
are vendor defaults, not yet cross-checked against this specific
deployment's actual runtime behavior.

| Setting | Thinking mode (default) | Non-thinking / instruct |
|---|---|---|
| temperature | 1.0 | 0.7 |
| top_p | 0.95 | 0.80 |
| top_k | 20 | 20 |
| min_p | 0.0 | 0.0 |
| presence_penalty | 0.0 | 1.5 |
| repetition_penalty | 1.0 | 1.0 |
| reasoning_effort | `xhigh` (default), also `medium`/`low` | — |

Vendor-reported agentic gains over 3.6 are large and specific to the
"thinks by default" configuration: Terminal-Bench 2.1 73.0 vs 63.4,
SWE-bench Pro 61.7 vs 53.5, QwenSWEBench 79.0 vs 49.3.

Context claims from the same sources were internally inconsistent between
"262K native" and a "1M advertised" agentic context figure in the search
summaries used to compile this table, and were not independently resolved.
Treat the exact long-context numbers as unverified; they are also
irrelevant at this deployment's actual `contextWindow: 65536` (raised from
49152 on 2026-08-21 when `max_kv_size` was bumped 65536 → 81920) /
`maxTokens: 16384` (see Risks, below).

## The GLM precedent (closest internal prior)

`pi-harness-history.md:1133-1166` ran GLM-4.7-Flash-4bit on this same
mlx-vlm stack with thinking explicitly forced on via
`chat_template_kwargs: {"enable_thinking": true}`, across ten trials at
`temperature: 0`. The recorded verdict: **"This rules out 'thinking mode
was simply off' as the explanation"** — the flag measurably changed
behavior but did not produce reliable structured judgment (1/10 catches
even with thinking forced on, vs. 0/3 without).

This doesn't invalidate the hypothesis below — different model, and
review-judgment vs. agentic follow-through are different failure shapes —
but it's the strongest available prior on both effect size and the working
request shape (nested `chat_template_kwargs`, not top-level fields), and
argues for tempered expectations: enabling thinking is not guaranteed to
fix follow-through even if the request format is correct.

## Recommended experiment, in order

### Step 1 — Establish ground truth with a direct curl, before touching any config (DONE, 2026-08-17)

Three checks run live against `:8080/v1/chat/completions` directly
(bypassing pi entirely), model
`/Users/kanna/code/ai-stack/models/Qwen3.8-27B-8bit`, prompt "A farmer has
17 sheep. All but 9 die. How many sheep does the farmer have left? Answer
with just the number.", `temperature: 0`, `max_tokens: 300`:

1. **Bare request, no thinking fields at all.** `reasoning_content: null`,
   `reasoning: null`, `completion_tokens: 2` (just `"9"`). Confirms: as
   configured before this change, the route does **not** think by default
   for this deployment — the vendor's "thinks by default" claim does not
   hold here without an explicit opt-in. This resolves the ambiguity the
   first draft of this document left open.
2. **Top-level `enable_thinking: true, reasoning_effort: "medium"`** (the
   shape `pi-ai`'s `"qwen"` compat format sends). Result:
   `reasoning_content` populated ("The question says \"All but 9 die.\"
   This means all sheep died EXCEPT 9. So 9 sheep are left alive. The
   answer is 9."), `completion_tokens: 40`. **This shape works.**
3. **Nested `chat_template_kwargs: {"enable_thinking": true, "reasoning_effort": "medium"}`**
   (the shape that worked for GLM on this same stack per the GLM
   precedent below, and what `MLX_VLM_ENABLE_THINKING` /
   `--chat-template-kwargs` server-side conventions suggested). Result:
   `reasoning_content: null`, `completion_tokens: 2` — identical to the
   bare request. **This shape does not trigger thinking on this route.**
   The GLM precedent's request shape does not transfer to this Qwen3.8
   deployment; do not assume it does elsewhere in this stack either.

Neither response's `usage` block contained a
`completion_tokens_details.reasoning_tokens` field at all, in any of the
three checks — confirming the table's prediction that pi's own `reasoning`
usage counter will read 0 on this route regardless of whether the model
actually reasoned. That field is not a usable verification signal here;
`reasoning_content` presence and `completion_tokens` delta are.

Response headers/shape (`timings`, `predicted_per_second`, etc.) match a
llama.cpp-server-style JSON shape rather than a bare mlx_vlm one — noted
for anyone debugging this further, not independently chased down further
here.

### Step 2 — Apply the confirmed-working shape to the harness (DONE, 2026-08-17)

Applied to `pi/extensions/ai-stack-local.ts` (symlinked into
`~/.pi/agent/extensions/ai-stack-local.ts`, so live immediately, no
install step needed):

- `reasoning: true` (was `false`).
- `compat: { thinkingFormat: "qwen", supportsReasoningEffort: true }` —
  the shape confirmed live in step 1, check 2.
- `thinkingLevelMap` copied from the bundled `qwen3.8-max-preview` entry:
  `{"minimal":null,"low":"low","medium":"medium","high":null,"xhigh":"xhigh","max":null}`,
  with an inline comment noting the `null` entries do **not** suppress
  those levels (`??` passes the raw level through) — they're just not
  levels this vendor model actually supports, so `defaultThinkingLevel`
  should stick to low/medium/xhigh.

Applied to `defaultThinkingLevel`: changed from `"off"` to `"medium"` in
both `pi/settings.json` (tracked) and the live, deliberately-unsymlinked
`~/.pi/agent/settings.json` — `"medium"` chosen over the vendor default
`"xhigh"` first, both for cost and because of the context-budget risk
below.

(Side note from this step: the `diff` command, as rewritten by this
machine's `rtk` hook, falsely reported the tracked and live
`settings.json` as identical before the edit — `/usr/bin/diff` showed the
real difference. Worth a look independently of this task; not chased
further here.)

### Step 3 — Re-run against the existing 0/4 baseline (trial 5: real regression found and fixed; trial 6: retesting)

**Trial 5** (2026-08-17, `go/lru-cache`, clean process/route baseline
confirmed before start): produced **zero diff** — worse than the original
0/4 baseline, which at least edited `lru.go` (with the wrong fix) every
time. Every one of the model's 4 turns in round 1 returned
`stopReason: "error"`, `503: {"message":"Request rejected: token counting
unavailable: Unexpected message role.","type":"tokenizer_unavailable"}`,
immediately on the very first turn (0 input tokens — this wasn't a
multi-turn history problem). All 3 client-side auto-retries were exhausted
twice (30s/60s/120s backoff each), burning ~7 minutes before the agent
settled with no code changes. `cross-model-review.ts` correctly flagged
this at settlement ("diff contains only metadata/log files... no code was
actually modified"), and `quality-gate.ts` correctly recorded the
verification as `outcome: "fail"` — the harness's own instrumentation
caught the failure accurately.

**Root cause, confirmed live via direct curl**: `pi-ai`'s `detectCompat`
defaults `supportsDeveloperRole: true` for any generic OpenAI-compatible
`baseUrl` once `model.reasoning` is `true`
(`openai-completions.js:1160`), and `useDeveloperRole = model.reasoning &&
compat.supportsDeveloperRole` (`openai-completions.js:793`) then makes pi
send the system prompt as role `"developer"` instead of `"system"`. This
route's tokenizer rejects `"developer"` outright:

```
$ curl .../v1/chat/completions -d '{"messages":[{"role":"developer",...}], ...}'
{"error":{"message":"Request rejected: token counting unavailable: Unexpected message role.","type":"tokenizer_unavailable"}}
```

Step 1's curl checks didn't catch this because they never included a
system-role message at all — a real gap in that verification step, worth
noting for next time: **verify with the actual message shape the harness
sends (system prompt included), not just a bare user turn.**

**Fix applied**: added `supportsDeveloperRole: false` to the `compat`
block in `ai-stack-local.ts`, forcing the system role back to `"system"`.
Re-verified via curl (`role: "system"` + `enable_thinking`/`reasoning_effort`
together, no 503). **Trial 6** was launched immediately after with the fix
in place, same clean-baseline discipline as trial 5, to retest against the
0/4 history.

**Trial 6** (2026-08-17, `go/lru-cache`, `supportsDeveloperRole: false`
fix in place): no 503s, ~8+ minutes to converge, produced a **correct,
key-based fix** — a new `touch(key)` helper moves keys to the front of a
slice by identity, `Put`/`Get` both call it, eviction pops the true
oldest key. Scored against the real hidden test suite (copied in after
the fact, per the harness's own run-flow spec): **all 5 tests pass,
including `TestEvictsByKeyNotValue`** — the exact regression test added
because all 4 original trials shared the value-as-key eviction bug.
100% statement coverage (`go tool cover`). **First pass on this task under
`pi-local` since this investigation started.**

Methodological note for next time: the transcript capture file
(`pi-output.json`) was written inside the agent's own working directory.
The model built its own scaffold mid-task (`.gitignore`, `Makefile`,
`README.md`, its own `lru_test.go`) and some cleanup step it ran deleted
`pi-output.json` along with it — the code diff and git history survived
(captured separately via `git diff`), but the turn-by-turn transcript
(retry counts, reasoning content, timing) for trial 6 was lost. Trial 5's
transcript is intact for comparison since that run errored out before
reaching any file-writing turns. **Write the capture file outside the
task working directory in future trials.**

**Trials 7-9: three more repeats, all pass.** Trial 7 added
`temperature: 0.6` (see below) and converged cleanly in ~4 minutes, no
retries, no self-built scaffold — noticeably cleaner than trial 6.
Trial 8 passed the same way. Trial 9 ran under real, log-confirmed GPU
contention from an unrelated concurrent process (`docwriter.ts`, verified
via its own source to default to the same `:8080` route — `/proxy/health`
showed `active: 2` and `queue_wait_seconds: 13.7`, decode rate crashed to
~15 tok/s from the 51.1 tok/s solo baseline) and still passed cleanly once
it finished, just slower. All three: correct key-based fix, all 5 hidden
tests pass including `TestEvictsByKeyNotValue`, 100% statement coverage.

**Net: 4/4 post-fix (trials 6-9) against a 4/4-replicated pre-fix 0/4
baseline.** Same repeat count this repo's own prior finding needed before
being called replicated. This is now a real, replicated reversal on this
one task, not a lucky n=1 — though broader task coverage beyond this one
repeated task is still open (see below) before calling it a general
verdict rather than a well-evidenced result on one task.

Re-run the exact `go/lru-cache` task from the 4-trial report for direct
comparability. Given this repo's own standard of evidence (seeded, paired
trials; the 4-trial report itself only called the original finding
"replicated" after 4 consistent repeats), change **one variable per arm**:
thinking on/off first, at whatever temperature the model currently
actually runs at (unknown — see table). Only vary temperature/sampling
params in a separate follow-up arm once thinking's effect (if any) is
isolated. Aim for the same n≈4 discipline the existing 0/4 finding used
before drawing any conclusion.

## Risks

- **Context-budget interaction.** This deployment's real admission budget
  is `contextWindow: 65536` (the proxy's actual ceiling — raised from
  49152 on 2026-08-21 when `max_kv_size` was bumped 65536 → 81920;
  before that, corrected once from an ungrounded 96000 guess — see the
  comment in `ai-stack-local.ts`), with `maxTokens: 16384` and
  `compaction: { reserveTokens: 16384, keepRecentTokens: 24000 }`.
  Reasoning tokens consume the same output budget as the final answer.
  Turning on `xhigh` reasoning_effort risks reproducing the exact
  `400 context_length_budget_exceeded` failure this file's own history
  already hit once and fixed — this is a stronger reason to start at
  `"medium"` than the cost argument alone.
- **Enabling thinking is not guaranteed to fix follow-through.** Per the
  GLM precedent, forcing thinking on changed behavior without fixing the
  underlying judgment/follow-through gap on a different model. Treat step
  3 as a real test that can come back negative, not a confirmation
  exercise.
- **`mlx_vlm` is not installed on this machine** — it runs on
  `kannasmacstudio.lan`. Step 1's curl must run against that host (or via
  `AI_STACK_HOST`); source-reading `mlx_vlm/server.py` directly isn't
  possible from here without going to that box.

## Not-yet-changed items carried over from the first draft (still hold)

- **Don't change quantization.** 8-bit is already the right choice —
  `ai-stack/PLAN.md` ran a matched 8-bit-vs-4-bit A/B on the prior 3.6
  checkpoint (12/12 identical, "zero quality differentiation"), and
  separately documents a 4-bit-quantization-specific reasoning-depth
  weakness on GLM-4.7-Flash-4bit. Re-running that A/B on 3.8 is not a
  priority.
- **Leave MTP/APC/context-window-fix settings alone.** Those are
  throughput/latency knobs, already well-instrumented (51.1 tok/s median,
  APC prefix reuse confirmed), and no open finding implicates them in the
  diagnose-but-don't-act failure.

## Effective temperature during all trials, resolved (2026-08-17)

Previously listed as "unknown." Resolved: `pi-coding-agent`'s CLI/settings
never reference `temperature` at all (confirmed by grepping its `dist/`
for the string — zero hits), and `pi-ai`'s `buildParams` only sets
`params.temperature` `if (options?.temperature !== undefined)`
(`openai-completions.js:539`) — so with no `--temperature` flag and no
`temperature` field in `settings.json`/the model entry, pi sends **no**
`temperature` field in any of these requests at all, trials 1-6 included.

mlx-vlm's OpenAI-compatible server (two independent sources: its own
[server-endpoints reference](https://mintlify.wiki/yocxy2/mlx-vlm/api/server-endpoints)
and cross-checked search summaries of the mlx-lm/mlx-vlm server code)
**defaults `temperature` to `0.0` (greedy decoding) when the field is
omitted.** So: **every trial run so far, including trials 5 and 6 today,
ran at effective `temperature: 0.0`.** This resolves the open question
directly rather than by inference from unrelated benchmarks, the way the
first draft of this document got it wrong.

Note this is *below* the vendor's own recommended thinking-mode
temperature (1.0, or 0.6 for Qwen3.6's "precise coding" preset) — greedy
decoding on a reasoning model is a plausible route to the kind of
deterministic repeated-failure pattern this repo's own multi-trial
findings keep landing on (same bug every time in trials 1-4; the model
building near-identical scratch-test scaffolding across many rounds in
trial 4). Not yet tested as its own variable — see "Open questions" below.

## Low vs. medium `reasoning_effort` — community findings (2026-08-17)

Searched specifically for low-vs-medium comparisons on this model, since
step 2 chose `"medium"` over the vendor default `"xhigh"` without a
head-to-head source at the time.

- **No concrete official or community benchmark splits coding quality by
  reasoning_effort level.** This gap is real; nothing found closes it.
- **`"low"` is reported as having limited effect for at least one user**
  ("setting to low reportedly had minimal effect") on the HF "crazy
  thinking model" discussion — i.e. dropping all the way to `"low"` isn't
  guaranteed to fix overthinking/latency the way dropping to `"medium"`
  did for the commenter who specifically endorsed it (cited above).
- **An important caveat for agentic/multi-turn tasks specifically**: lower
  reasoning effort trades per-turn speed for a higher chance of
  insufficient analysis, which can mean more failed attempts and retries
  — potentially *increasing* total wall-clock and token cost on a
  multi-turn coding-agent task even though each individual turn is
  faster. This is a real argument against reflexively dropping to
  `"low"` next purely for speed, and mild supporting evidence (not proof)
  for keeping `"medium"` as the current setting rather than immediately
  trying `"low"`.
- No source found compares `"low"` vs `"medium"` specifically in a
  Pi/agentic-tool-use harness the way this document's own trial 5/6 does
  — the closest primary data on that exact question is this document's
  own live trials, not the community.

## Temperature applied, 2026-08-17

Acted on the "greedy decoding" finding above. There is genuinely **no
supported lever to set a default temperature** on either side of this
stack:

- `pi-coding-agent` has no `--temperature` CLI flag and no
  `settings.json` field for it (confirmed by grepping its `dist/` —
  zero references to the string "temperature" anywhere in the harness
  code, only in the lower-level `pi-ai` library's per-call
  `StreamOptions` type, which the harness never populates).
- mlx-vlm has a **documented bug ignoring the model's own
  `generation_config.json`** (independently reported for the Gemma route
  on this same stack too — its `generation_config.json` specifies
  `temperature: 1.0, top_p: 0.95, top_k: 64` and mlx-vlm serves it greedy
  anyway), so there's no server-side default to fix either.

**Fix**: added a `before_provider_request` hook to `ai-stack-local.ts`
that injects `temperature: 0.6` into the outgoing payload, scoped to only
this model id and only when the caller hasn't already set one. `0.6`
matches Qwen3.6's own "precise coding" thinking preset rather than the
vendor's general thinking-mode default of `1.0` — chosen for lower
variance on a harness that also wants reproducible trial-to-trial
comparisons, not because `1.0` was shown to be wrong here.

**Verified live**, not assumed: added a temporary `console.error` debug
line behind a `PI_DEBUG_TEMPERATURE_HOOK` env var, ran a one-line smoke
`pi -p` call with it set, confirmed stderr showed
`payload.temperature = 0.6 model = .../Qwen3.8-27B-8bit`, then removed
the debug line before the real trial. A plain smoke run (no debug flag)
also confirmed the hook doesn't break anything — normal `stopReason: "stop"`,
reasoning content present.

**Trial 7** launched immediately after (same `go/lru-cache` task, clean
process/route baseline, `PI_HARNESS_TIMEOUT_MINUTES=30`, thinking
`medium` + `supportsDeveloperRole: false` fix + new `temperature: 0.6`),
capture file placed **outside** the task working directory this time
(trial 6's lesson) so a repeat of that cleanup-deletion issue can't lose
the transcript again.

## Open questions / not yet done

- No live re-run of `go/lru-cache` (or any other task) with thinking
  enabled has happened; **the 0/4 baseline stands unchanged**. Step 2's
  config change is live but unvalidated against the actual failure mode.
  (Superseded in part — see `pi-harness-history.md`'s 2026-08-19 pair-7
  reasoning-on follow-up: 2/2 clean passes on `go/lru-cache` with
  `PI_EVAL_THINKING_LEVEL=xhigh`.)
- The temperature/sampling params actually in effect during the original
  4 trials are still unknown and have not been determined — this was not
  resolved by step 1 (step 1 deliberately pinned `temperature: 0` to
  isolate the thinking-format question; it doesn't tell us what the 4
  trials ran at).
- The `rtk`-wrapped `diff` false-identical result noticed in step 2 is
  unexamined — worth a look, unrelated to this investigation's outcome.

## Full precise-coding sampling params applied, 2026-08-19

Follow-up to "Temperature applied, 2026-08-17" above, which only injected
`temperature: 0.6` and left `top_p`/`top_k`/`presence_penalty` at whatever
mlx-vlm defaults to when a request omits them (`top_p`/`top_k` effectively
unclamped, `presence_penalty` 0 — i.e. accidentally already matching the
coding preset's `presence_penalty`, but not by design).

A fresh round of community/vendor research (HF model cards, Unsloth docs,
web search) confirmed Qwen3.8-27B's model card documents a **"precise
coding" preset distinct from both its general thinking default and its
non-thinking instruct default**:

| Preset | temp | top_p | top_k | min_p | presence_penalty | repetition_penalty |
|---|---|---|---|---|---|---|
| Thinking (general default) | 1.0 | 0.95 | 20 | 0.0 | 0.0 | 1.0 |
| Instruct / non-thinking | 0.7 | 0.80 | 20 | 0.0 | 1.5 | 1.0 |
| **Precise coding (thinking)** | **0.6** | **0.95** | **20** | 0.0 | **0.0** | 1.0 |

Sources:
[Qwen/Qwen3.8-27B model card](https://huggingface.co/Qwen/Qwen3.8-27B),
[Unsloth run guide](https://unsloth.ai/docs/models/qwen3.8),
[Qwen/Qwen3.6-27B discussion #10](https://huggingface.co/Qwen/Qwen3.6-27B/discussions/10)
(confirms the 3.6 checkpoint's own precise-coding preset shares the same
`temperature: 0.6`, `presence_penalty: 0.0` values — the 2026-08-17 choice
of 0.6 turns out to match the *vendor's own coding preset* for 3.8 too, not
just an analogy carried over from 3.6). No "alpha" sampling parameter
(repetition-penalty alpha, DRY-sampler alpha, or otherwise) is documented
anywhere in the 3.8 card or in community threads found.

**Fix**: extended `ai-stack-local.ts`'s existing `before_provider_request`
hook — previously injected `temperature` only — to inject the full preset
(`temperature: 0.6, top_p: 0.95, top_k: 20, presence_penalty: 0.0`) as a
single `QWEN38_SAMPLING_PARAMS` object, each field applied independently
only when the caller hasn't already set it (so a future eval script that
deliberately pins e.g. `temperature: 0` still overrides). `min_p` and
`repetition_penalty` were left uninjected — both presets agree they should
be `0.0`/`1.0`, which is mlx-vlm's unset-field behavior anyway, so there's
nothing to correct there.

**Not yet done**: no live re-run of any battery pair with the expanded
param set — this is a config change made from vendor/community research,
not yet validated against this harness's actual failure modes the way the
temperature and thinking-level changes were. Should be validated the same
way: rerun a known task (e.g. `go/lru-cache`) and confirm no regression
before treating this as settled.
