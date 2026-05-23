---
name: wiring-verify
description: >
  Verify that a multi-point wiring pattern is complete — every step described in the project's
  CLAUDE.md or ARCHITECTURE.md for a given feature/component actually exists in code.
  Use after adding any feature that has a documented N-step checklist (feature flags, routes,
  middleware, controllers, widgets, constants, migrations, etc.). Also generates stubs for any
  missing steps. Trigger when: "check the wiring for X", "did I wire everything for X",
  "verify the feature plumbing", or after Claude adds something that has a multi-step pattern.
tools: Read, Bash, Grep
---

# Wiring Verify

Many projects have documented N-step wiring patterns: "to add feature X, do steps 1, 2, 3, 4."
Claude often completes some steps and misses others. This skill:
1. Reads the project docs to discover the pattern
2. Greps for each step's presence in code
3. Reports a `[✓]/[✗]` checklist with file:line evidence
4. Generates copy-paste stubs for missing steps

---

## Step 1 — Discover the project's wiring pattern

Read the project's documentation to find multi-step patterns. Look in this order:

```bash
# Find docs that describe multi-step wiring
cat CLAUDE.md 2>/dev/null
cat ARCHITECTURE.md 2>/dev/null
cat .claude/CLAUDE.md 2>/dev/null
cat README.md 2>/dev/null | head -100
```

Look for language like:
- "Adding a new X: (1) ... (2) ... (3) ..."
- "To add X, you must: step 1, step 2, step 3"
- "N-step process", "checklist", "wiring", "plumbing"
- Numbered lists describing what files to touch when adding a feature/route/component

Extract:
- **The pattern name** (e.g. "gated feature", "new route", "new widget")
- **Each step**: what file to touch, what to add, what pattern to look for

If no pattern is found in docs, ask the user: "What are the steps for wiring <X> in this project?"

---

## Step 2 — Identify the target

From the user's request or current context, determine:
- **Feature/component name** (e.g. `habits`, `PaymentController`, `DarkModeToggle`)
- **The pattern** it belongs to (e.g. "feature flag", "REST endpoint", "widget")

If ambiguous, check recent git changes:
```bash
git diff --name-only HEAD~1 2>/dev/null | head -20
```

---

## Step 3 — Grep for each wiring step

For each step in the pattern, construct a grep that detects presence or absence.

**Generic search strategy per step:**
- The step says "add constant X to file Y" → grep file Y for the constant name
- The step says "register in file Z" → grep Z for the identifier
- The step says "add getter to class C" → grep for the getter name in C's file
- The step says "guard widget with flag" → grep the feature tree for the flag name

Name variant generation is deterministic — use the bundled script instead of deriving manually:

```bash
# Emits all 6 variants (snake, camel, Pascal, SCREAMING, getter, Feature constant)
~/.claude/skills/wiring-verify/name-variants.sh <feature_name>
```

Then grep for each variant:
```bash
grep -rn "<variant>" <relevant_dirs> --include="*.<ext>" 2>/dev/null
```

---

## Step 4 — Report

Output a checklist:

```
Wiring check: <feature/component name>
Pattern: <pattern name from docs>

[✓] Step 1 — <description>   (<file>:<line>)
[✓] Step 2 — <description>   (<file>:<line>)
[✗] Step 3 — <description>   NOT FOUND
[✗] Step 4 — <description>   NOT FOUND

Result: 2 of 4 steps complete. Missing: Step 3, Step 4.
```

If all steps are present:
```
[✓] All N wiring steps verified for <name>. No action needed.
```

---

## Step 5 — Generate stubs for missing steps

For each `[✗]` step, generate the exact snippet to add and where:

```
--- Missing: Step 3 ---
File: <path/to/file>
Insert after line <N> (after the last similar entry):

<code snippet using the exact name, key, and pattern from the project>
```

Use the existing entries in that file as a template for the stub — match indentation, naming convention, and comment style exactly.

---

## Step 6 — Compile/analyze check

After reporting (and optionally after stubs are applied):

```bash
# Run whatever the project uses to verify correctness
# Check CLAUDE.md "Commands" section for the right command
make lint 2>&1 | tail -20
# or: go build ./..., dart analyze, tsc --noEmit, etc.
```

If it fails, fix before reporting done.

---

## Multi-project examples

| Project type | Pattern trigger phrase | Typical steps |
|---|---|---|
| Go + Flutter app | "Adding a new gated feature" | Go constant → route middleware → Flutter controller getter → widget guard |
| Express API | "Adding a new route" | Route file → handler → service → OpenAPI spec → test |
| Django app | "Adding a new model" | Model → migration → serializer → view → URL → admin |
| React app | "Adding a new page" | Component → route → nav link → lazy import → test |
| iOS Swift | "Adding a new screen" | View → ViewModel → Coordinator → DI registration |

The skill works for any of these — the pattern comes from the project docs, not from hardcoded knowledge.

---

## Required tools

| Tool | Used for |
|---|---|
| `Read` | Reading CLAUDE.md, ARCHITECTURE.md, and specific files at exact line numbers |
| `Bash` | grep, git diff, lint/compile check |
| `Grep` | Searching across file trees for name variants |
