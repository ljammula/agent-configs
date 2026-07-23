---
name: testflight-cut
description: >
  Generate and verify an iOS build cut for DayTrix: choose the next version, sync
  pubspec to it, draft the App Store "what's new" and review notes — then prove all
  of it before the `t<version>` tag fires an Xcode Cloud build.
  Trigger on: "bump this to 0.1.2", "trigger t0.1.1-2", "trigger a t* release tag",
  "cut a TestFlight build", "this is blocking test-flight push as well",
  "are these changes OTA?", "what is new between 0.1.1 and 0.1.2", "give me summary
  for App Store review submission", "what is in this release for app store
  submission", "why not use 0.1.1", or any pasted `ITMS-#####` error from App Store
  Connect. Not for the backend Cloud Run deploy (`v<version>` tags) — that is `/release`.
  The pattern this prevents: version chosen from memory → tag pushed → 30 minutes of
  Xcode Cloud build → App Store Connect rejects it (ITMS-90186 closed train,
  ITMS-90062 bad bundle version) → user pastes the error back and the cut restarts.
---

# TestFlight Cut

Two things get generated here and both get verified before anything leaves the machine:
**the version** (pubspec + tag) and **the release text** (what's-new + review notes).

Scope — do not confuse the two release paths:

| Path | Tag | Fires | Skill |
|---|---|---|---|
| Backend → Cloud Run | `v0.1.5` | GitHub Actions `deploy.yml` | `/release` |
| iOS → TestFlight | `t0.1.5` | Xcode Cloud → App Store Connect | **this skill** |

A normal ship is both, `v` first (backend deployed before the client that calls it), then `t`,
tagged on the same commit at the same version. `v<version>` already existing is the expected
case when cutting `t<version>`, not a collision.
If the user says "release" with no platform, ask which — do not assume.

Phases 1–4 are read-only and safe to run unprompted. Phase 5 pushes a tag that starts a
real build — it never runs without an explicit user instruction in the current turn.

---

## Phase 1 — Generate the version

```bash
~/.claude/skills/release/scripts/next-version.sh   # prints <next-tag> <bump-kind> <reason>
```

This suggests from the `v` train — correct for a joint release, since `v` and `t` share a
version. For an iOS-only cut (e.g. recovering from a closed train), compute from the last
`t` tag instead: `git tag -l 't*' --sort=-v:refname | head -1`, then bump its patch.

A user-named version always wins over the script's suggestion. State the version and the
reason in one line before doing anything else.

**The train rule.** App Store Connect closes a marketing version (a "train") once a build
from it has been submitted. A second build on the same train needs a build suffix
(`t0.1.1-2`, precedent in this repo) — and once the train is *closed*, even that is rejected
with `ITMS-90186`, so the patch must be bumped instead. If the user's named version collides
with any existing tag, say so before tagging, not after.

## Phase 2 — Verify the version (deterministic — this is the gate)

Run the `before-done` gate first (lint, fmt, l10n, full Flutter suite) — the checks live
there, not here. A red suite becomes a 30-minute Xcode Cloud failure.

`pubspec.yaml` and the tag drift apart silently. Nothing in the build catches it; App Store
Connect does, 30 minutes later. Run:

```bash
~/.claude/skills/testflight-cut/scripts/check-version-sync.sh 0.1.5
```

(Resolves the repo root itself — run from any directory.) Four checks, one `PASS`/`FAIL`
line each (plus a `NOTE` line if origin is unreachable), exit non-zero if any failed:

1. `frontend/pubspec.yaml` `version:` equals the version being tagged
2. `t<version>` is free (local and origin) — `v<version>` is not checked; it existing
   already is the normal joint-release case
3. Newer than the last `t` tag, and not a reuse of its train
4. Worktree clean — the tag must point at verified code

**Any `FAIL` means do not tag.** Fix the cause (usually: edit `frontend/pubspec.yaml`,
commit, re-run) and re-run until the script exits 0. Report what the script printed —
never describe what it "should" say.

## Phase 3 — Generate the release text

Never write release notes from memory of the session. Pull the facts first:

```bash
~/.claude/skills/testflight-cut/scripts/release-facts.sh          # since last t* tag
~/.claude/skills/testflight-cut/scripts/release-facts.sh t0.1.2   # explicit range
```

It prints the commits shipping in this build, the user-facing directories touched, and the
backend feature-gate defaults. Write from that output:

- **What's New** (TestFlight / App Store) — user-visible changes only, in the user's
  language, not commit subjects. Refactors, CI fixes, and test changes do not appear.
- **Review notes** — start from `docs/app-store-review-notes.md` and adjust only what this
  build changed. Do not regenerate it from scratch.

## Phase 4 — Verify the release text

Deterministic where it can be, judgment where it can't:

1. **Traceability** — every bullet maps to at least one commit in the `release-facts.sh`
   output. A bullet you cannot point at a commit for is a fabrication; delete it.
2. **Gated features** — anything the facts script marks `NOT default` is unreachable for a
   fresh reviewer account. Do not advertise it. `defaultFeatures` is currently empty: AI
   access, vision scan, speech-to-text, MCP tools, nudges, AI memory, and multi-language are
   all admin-grant-only; only habits and mood tracking are on by rollout compatibility.
   The user has corrected this exact mistake before ("multi-lingual is behind feature flag,
   english is only defaulted right now").
3. **Coverage** — every user-visible commit in the range appears in some bullet, or is
   deliberately omitted for a stated reason.
4. **Review-note accuracy** — claims in `docs/app-store-review-notes.md` (no sign-in wall,
   chat disabled, web search disabled, permissions requested only on use) must still hold
   for this build. Check them against the diff; a stale claim to Apple is worse than a
   missing one. If this file was edited, run `docs-verify`'s link checker on it — Apple
   rejects dead support/privacy URLs.

## Phase 5 — Cut it

Only after Phases 2 and 4 are clean, and only when the user has said to push. **The tag
push starts a real Xcode Cloud build and uploads to TestFlight — confirm before pushing,
every time, even if a tag push was approved earlier in the session.**

```bash
gh auth status                 # must be ljammula
git tag t0.1.5 && git push origin t0.1.5
```

Then hand off: the build appears in App Store Connect → TestFlight in ~15–30 min. Xcode
Cloud has no `gh`-visible status — say that plainly rather than claiming the build passed.

If App Store Connect rejects the upload, do **not** delete and re-push the tag. Look it up:

| Error | Cause | Fix |
|---|---|---|
| `ITMS-90186` Invalid Pre-Release Train | The marketing version already had a build submitted | Bump the patch (`0.1.1` → `0.1.2`), sync pubspec, new `t` tag |
| `ITMS-90062` bundle version invalid | `CFBundleVersion` not greater than the last build on this train | New build suffix (`t0.1.1-2`) or patch bump |
| Xcode Cloud build failure | See the troubleshooting table in `docs/testflight-deployment.md` | Fix the CI script, then a new tag — never re-push the old one |

---

## Output Format

```
✓ Version 0.1.5 (patch: no feat: commits since t0.1.4)
✓ Version sync: 4/4 PASS — pubspec 0.1.5, t0.1.5 free, newer than t0.1.4, worktree clean at abc1234
✓ What's New: 4 bullets, each traced to a commit in t0.1.4..HEAD
✓ No gated feature advertised (multi_language, ai_access, vision_scan all NOT default)
✓ Review notes re-checked against this build — no stale claims
→ Ready to push t0.1.5. Confirm and I'll tag; this starts an Xcode Cloud build.
```

Any `✗` is not a completion report. Surface it and stop.

---

## Required Tools

| Tool | Used for |
|---|---|
| `Bash` + `scripts/check-version-sync.sh` | Phase 2 — the whole version gate |
| `Bash` + `scripts/release-facts.sh` | Phase 3 — commits, surface, feature-gate defaults |
| `Bash` + `~/.claude/skills/release/scripts/next-version.sh` | Phase 1 — semver suggestion (`v` train) |
| the `before-done` skill | Phase 2 — lint, fmt, l10n, full Flutter suite before tagging |
| the `docs-verify` skill | Phase 4 — link check if `app-store-review-notes.md` was edited |
| `Read` `docs/app-store-review-notes.md` | Phase 3/4 — review-note baseline, never from memory |
| `Read` `docs/testflight-deployment.md` | Phase 5 — Xcode Cloud troubleshooting table |
| `Bash` + `git log` / `git diff` | Phase 4 — traceability of each bullet |
| `Bash` + `gh auth status` | Phase 5 — confirm the `ljammula` account before tagging |
| `Read` `backend/internal/userfeatures/feature.go` | Phase 4 — gate truth if the script cannot parse it |
