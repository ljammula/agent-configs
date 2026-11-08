---
name: model-routing
description: >
  Choose the model and tool for implementation, code review, log triage, and
  factual lookups while conserving the Claude subscription. Load before
  delegating implementation or review, before triaging a long log, and when
  the session-start note says conserve mode is on.
---

# Model routing

Choose the tool for each job so the Claude subscription lasts until its weekly
reset, Thursday at 5 PM America/Chicago.

| Job | First | Fallback | Billed to |
|---|---|---|---|
| Implementation and fixes from a decided brief | Codex (`codex-implement`) | Sonnet subagent from an `agent-brief` | Codex plan |
| Review of a diff ≤ 10 KB | Local Qwen first pass, trusted only after a planted-bug probe through the same prompt | `claude-review` | Free, then API credits |
| Review of a larger diff | `codex-review` | `claude-review` | Codex, then API credits |
| Long test/e2e/integration log triage | `qwen-triage`, then confirm its pick with grep | grep | Free |
| Quick factual lookups | SearXNG (`local-search`) | WebSearch | Free |
| Workflow determinism, trust-boundary verdicts, design, triage of findings, merges | Main session | — | Subscription |

## Conserve mode

Conserve mode is ON when weekly "all models" usage is at least 84% before the
reset. The SessionStart hook reports the current usage and mode.

When ON:

- Do not use Agent subagents or `/code-review` rounds from the main session.
- Route every delegate through the scripts below.
- Read diffs in targeted hunks.
- Tell the user conserve mode is on and which tool handles each job.

When OFF, the table still applies; Agent subagents and `/code-review` are
allowed.

## Rules

- Probe each tool with a known-answer prompt before relying on it. Check both
  the exit status and the answer.
- For Codex, use `codex exec --sandbox read-only "Reply exactly CODEX_OK and 2+2"`
  and require `CODEX_OK 4`. For Qwen review, run a planted-bug probe through
  the same prompt before trusting a NONE result. Probe `claude-review` with
  that same planted-bug contract and prompt before relying on the reviewer.
- If Codex is out of budget, use the table's fallback and tell the user.
- Run one local Qwen inference at a time across all sessions. Use Qwen only,
  never the Gemma route. A manual Qwen user holds the same lock through the
  helper: `qwen-triage --lock-only <command...>`. Stop if it is already held.
  Local models may review or read, never edit code.
- Treat every reviewer finding as a claim to verify against the code.
- Run at most two review rounds. Give reviewers the contract and diff, never
  the author's conclusion.
- Qwen's NONE result is usable only after the same review prompt detects a
  planted bug. For diffs over 10 KB, skip Qwen and use Codex first.
- Workflow-determinism and trust-boundary verdicts stay with the main session.

## Scripts

Run scripts from the installed skill or this checkout:

| Script | Usage |
|---|---|
| `bin/codex-implement` | `codex-implement <worktree> <brief-file> <report-file>` |
| `bin/codex-review` | `codex-review <worktree> <label> <contract-file>... <out-file> [--round 1|2]` |
| `bin/claude-review` | `claude-review <worktree> <label> <contract-file>... <out-file>` |
| `bin/qwen-triage` | `qwen-triage [--lock-only <command...> | <log-file> [question]]` |
| `bin/usage-check` | `usage-check` |

`codex-review` and `claude-review` save the diff beside the report as
`<out-file>.diff`. Claude review requires the API key in
`~/.config/anthropic/api_key`; it refuses to run without it rather than charge
the subscription.

Use `qwen-triage --lock-only <command...>` to hold the shared Qwen lock while
running a manual Qwen command.

## Flow

```text
decided implementation brief -> Codex -> verify diff and checks
                              -> Sonnet subagent if Codex is unavailable

diff <= 10 KB -> Qwen probe -> Qwen first pass -> verify findings
             -> Claude API review if probe fails or Qwen is unavailable
diff > 10 KB -> Codex review -> Claude API review if Codex is unavailable

long log -> Qwen triage -> confirm selected lines with grep
quick fact -> SearXNG -> WebSearch if unavailable
workflow, design, trust, merge -> main session
```
