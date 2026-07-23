---
name: docs-verify
description: >
  Generate-and-verify for documentation changes: apply the doc edit (URL update,
  terminology rename, metadata change), then prove it landed — every URL responds,
  zero stale occurrences of renamed terms, all affected files actually changed.
  Trigger after editing any .md/.txt/metadata doc, after any terminology rename
  ("X is now called Y", "rename household to group"), or when the user asks
  "is this a valid URL?", "did you update all the docs?", "any other documentation
  cleanup needed?", "I still see <old term>".
---

# Docs Verify

The pattern this prevents (from real session history): Claude updates docs → user
manually checks → user comes back with *"is this a valid URL?"* or *"I still see
household -> group changes"*. This skill makes the generation step incomplete
until verification passes.

---

## Step 1 — Generate (the edit itself)

Make the requested doc change. For a terminology rename, first find the full blast
radius **before** editing — don't edit files one at a time as they're noticed:

```bash
~/.claude/skills/docs-verify/scripts/check-stale-terms.sh <old_term> <project_dir>
```

Every file it lists is in scope. Edit all of them (skip false positives like
changelogs or historical notes — use judgment, and say which you skipped and why).

## Step 2 — Verify links (deterministic)

For every doc file touched (or any doc where the user questioned a URL):

```bash
~/.claude/skills/docs-verify/scripts/check-links.sh <file> [file...]
```

- `OK` = URL responds 2xx/3xx.
- `DEAD` = fix the URL or flag it — never leave a dead URL in App Store metadata
  or user-facing docs. If a URL is intentionally a placeholder, say so explicitly.

## Step 3 — Verify the rename swept clean (deterministic)

Re-run the stale-term check after editing:

```bash
~/.claude/skills/docs-verify/scripts/check-stale-terms.sh <old_term> <project_dir>
```

`0 occurrences` = clean. Any remaining hit is either a deliberate exception
(justify it in the report) or an incomplete sweep (fix it).

## Step 4 — Verify semantic consistency (AI judgment)

Scripts can't catch meaning drift. Read the changed docs and check:

- Do descriptions still match the actual feature behavior? (e.g. "the feature is
  group sharing, not household" — a rename can leave sentences that describe the
  old semantics)
- Cross-file agreement: do README, App Store metadata, privacy labels, and specs
  all tell the same story?
- Is anything now orphaned — a doc section referring to a URL/term/screen that no
  longer exists?

## Step 5 — Report

```
Docs verify: <change description>
[✓] Links: 4/4 OK (check-links.sh)
[✓] Stale terms: 0 occurrences of "household" (check-stale-terms.sh)
[✓] Semantic pass: metadata, privacy labels, README consistent
[–] Skipped: CHANGELOG.md line 12 (historical entry, intentional)
```

Any `✗` = not done. If the change is part of a larger task, hand off to the
`before-done` gate for git/PR/CI verification — do not duplicate those checks here.

---

## Required tools

| Tool | Used for |
|---|---|
| `Bash` + `scripts/check-links.sh` | URL liveness (deterministic) |
| `Bash` + `scripts/check-stale-terms.sh` | Rename blast radius + post-edit sweep (deterministic) |
| `Read` / `Edit` | The doc edits and the semantic consistency pass |
| `WebFetch` | When a URL returns OK but the user asks whether the *content* is right (e.g. support page actually shows support info) |
