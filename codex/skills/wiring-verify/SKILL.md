---
name: wiring-verify
description: >
  Verify that a multi-point wiring pattern is complete — every step described in the project's
  CLAUDE.md or ARCHITECTURE.md for a given feature/component actually exists in code.
  Use after adding any feature that has a documented N-step checklist (feature flags, routes,
  middleware, controllers, widgets, constants, migrations, etc.). Also generates stubs for any
  missing steps. Trigger when: "check the wiring for X", "did I wire everything for X",
  "verify the feature plumbing", or after adding something that has a multi-step pattern.
tools: Read, Bash, Grep
---

# Wiring Verify

Many projects have documented N-step wiring patterns: "to add feature X, do steps 1, 2, 3, 4."
This skill:
1. Reads the project docs to discover the pattern
2. Greps for each step's presence in code
3. Reports a `[✓]/[✗]` checklist with file:line evidence
4. Generates copy-paste stubs for missing steps

---

## Step 1 — Discover the project's wiring pattern

```bash
cat CLAUDE.md 2>/dev/null
cat ARCHITECTURE.md 2>/dev/null
cat .claude/CLAUDE.md 2>/dev/null
cat README.md 2>/dev/null | head -100
```

Extract:
- **The pattern name** (e.g. "gated feature", "new route", "new widget")
- **Each step**: what file to touch, what to add, what pattern to look for

If no pattern is found, ask the user: "What are the steps for wiring <X> in this project?"

---

## Step 2 — Identify the target

From the user's request or current context, determine the feature/component name and its pattern.

If ambiguous:
```bash
git diff --name-only HEAD~1 2>/dev/null | head -20
```

---

## Step 3 — Grep for each wiring step

Name variant generation is deterministic — use the bundled script:

```bash
# Emits all 6 variants (snake, camel, Pascal, SCREAMING, getter, Feature constant)
~/.codex/skills/wiring-verify/name-variants.sh <feature_name>
```

Then grep for each variant:
```bash
grep -rn "<variant>" <relevant_dirs> --include="*.<ext>" 2>/dev/null
```

---

## Step 4 — Report

```
Wiring check: <feature/component name>
Pattern: <pattern name from docs>

[✓] Step 1 — <description>   (<file>:<line>)
[✓] Step 2 — <description>   (<file>:<line>)
[✗] Step 3 — <description>   NOT FOUND
[✗] Step 4 — <description>   NOT FOUND

Result: 2 of 4 steps complete. Missing: Step 3, Step 4.
```

---

## Step 5 — Generate stubs for missing steps

For each `[✗]` step:

```
--- Missing: Step 3 ---
File: <path/to/file>
Insert after line <N>:

<code snippet using the exact name, key, and pattern from the project>
```

Match indentation, naming convention, and comment style from existing entries.

---

## Step 6 — Compile/analyze check

```bash
make lint 2>&1 | tail -20
# or: go build ./..., dart analyze, tsc --noEmit
```

If it fails, fix before reporting done.

---

## Multi-project examples

| Project type | Pattern trigger | Typical steps |
|---|---|---|
| Go + Flutter | "Adding a new gated feature" | Go constant → route middleware → Flutter controller getter → widget guard |
| Express API | "Adding a new route" | Route → handler → service → OpenAPI spec → test |
| Django | "Adding a new model" | Model → migration → serializer → view → URL → admin |
| React | "Adding a new page" | Component → route → nav link → lazy import → test |
