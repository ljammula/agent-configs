---
name: local-summarize
description: >
  Triage a large log file, test-output dump, or JSONL file through the
  local ai-stack general model (port 8081) before reading it into Claude's
  own context, to find which sections actually matter. Only relevant on
  machines running ai-stack -- check the model port is reachable before
  using this skill. Trigger when you're about to Read a large log/output
  file (would burn significant context) purely to find the interesting
  part -- a failure, an anomaly, an error buried in noise.
---

# Local Summarize

**This is triage, not summarization.** The local model flags which line
ranges are worth Claude's direct read; it does not produce a digest Claude
trusts as ground truth. A hallucinated summary of a stack trace is worse
than useless — the failure mode here isn't "wastes tokens," it's "sends
Claude confidently down the wrong path." Scope every use of this skill
accordingly: read what it flags yourself before acting on it.

## Step 1 — triage

```bash
~/.claude/skills/local-summarize/scripts/triage.sh <file>
```

The script does its own reachability check -- do not pre-flight it with a
separate `curl`. (`AI_STACK_HOST` points at a LAN-served stack when the
instance isn't local, e.g. `192.168.1.233`; unset it defaults to localhost.)
If it exits `not reachable` — the stack is down, or the general-slot model
isn't the resident one right now (only one model pair can be resident at a
time) — relay that one line and Read the file directly instead.

Otherwise it prints a line-number-referenced list of sections worth reading in full
(`lines N-M: why it matters`), or `no notable sections` if nothing stood
out. Files over ~60k chars are truncated before triage — for anything
larger, triage in chunks rather than trusting a single pass covered it.

## Step 2 — read the flagged sections yourself

```bash
Read <file> offset=<N> limit=<M-N+1>
```

Do not report findings, quote content, or make decisions based on the
triage output alone — it's a pointer into the file, not the content. If
`no notable sections` comes back but you have independent reason to
suspect something's there (e.g. the user says a test failed), read the
file directly rather than trusting a negative result.

## When not to use this

- Small-to-medium files Claude can just Read directly — this skill exists
  to avoid burning context on files large enough that a full read is
  genuinely costly.
- Anything where you need the actual content, not a pointer to it (e.g.
  extracting an exact error message to quote back to the user) — read
  the flagged section yourself for that, don't rely on the triage model's
  paraphrase.
