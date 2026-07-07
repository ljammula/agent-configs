---
name: docs-verify
description: >
  Generate-and-verify for documentation changes: apply the doc edit (URL update,
  terminology rename, metadata change), then prove it landed — every URL responds,
  zero stale occurrences of renamed terms, all affected files actually changed.
  Trigger after editing any .md/.txt/metadata doc, after any terminology rename
  ("X is now called Y"), or when the user asks "is this a valid URL?",
  "did you update all the docs?", "I still see <old term>".
---

# Docs Verify

The pattern this prevents: agent updates docs → user manually checks → user comes
back with "is this a valid URL?" or "I still see <old term>". The generation step
is incomplete until verification passes.

## Step 1 — Generate (the edit itself)

For a terminology rename, find the full blast radius **before** editing:
```bash
~/.codex/skills/docs-verify/scripts/check-stale-terms.sh <old_term> <project_dir>
```
Every file it lists is in scope. Edit all of them (skip false positives like
changelog history — say which you skipped and why).

## Step 2 — Verify links (deterministic)

For every doc file touched:
```bash
~/.codex/skills/docs-verify/scripts/check-links.sh <file> [file...]
```
`DEAD` = fix the URL or flag it — never leave a dead URL in user-facing docs.

## Step 3 — Verify the rename swept clean (deterministic)

Re-run the stale-term check after editing. `0 occurrences` = clean; any remaining
hit is either a justified exception or an incomplete sweep.

## Step 4 — Verify semantic consistency (judgment)

Read the changed docs: do descriptions still match actual behavior? Do README,
store metadata, privacy labels, and specs agree? Anything orphaned?

## Step 5 — Report

```
Docs verify: <change description>
[✓] Links: 4/4 OK
[✓] Stale terms: 0 occurrences of "<old term>"
[✓] Semantic pass: metadata, privacy labels, README consistent
[–] Skipped: CHANGELOG.md line 12 (historical entry, intentional)
```

Any `✗` = not done. Hand off git/PR/CI verification to the `before-done` gate.
