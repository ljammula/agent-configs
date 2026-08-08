---
name: grill
description: Interview the user relentlessly about a plan or design before coding, until every branch is resolved. Use before starting ambiguous or multi-file work, or when the user says "grill me"/wants to align on a design first.
license: MIT
---

# Grill

Adapted from https://github.com/mattpocock/skills for pi's single-agent, no-subagent harness (no sub-agent dispatch for fact-finding — look facts up yourself with `read`/`bash`/`grep`, inline, then keep interviewing).

Map the plan as a **design tree**: every decision branches into the decisions that hang off it. Work it in rounds.

The **frontier** is every decision whose prerequisites are already settled — the questions answerable now without guessing at something not yet decided. Ask the whole frontier in one round, numbered, each with your recommended answer:

```
Q1 — <question>: <body, options if relevant>
  recommend: <your answer>
```

A question that depends on another still-open question belongs to a later round, not this one. Look up any fact yourself (existing code, `CONTEXT.md`, git history) before asking — only put genuine decisions to the user, never facts you could have found.

Each round's answers push the frontier outward. Recompute it, ask the next round. Done when the frontier is empty — nothing left silently assumed. Do not start implementing until the user confirms the tree is fully resolved.
