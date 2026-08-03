---
name: postgres-change
description: PostgreSQL schema, migration, JSONB, index, and query changes. Use when PostgreSQL drivers and migrations/schema files are present. Do not infer PostgreSQL merely from a directory named backend or migrations.
---

# PostgreSQL change

- Apply migrations to an ephemeral PostgreSQL instance starting from the previous schema.
- Verify the resulting schema, constraints, indexes, representative query plans, and forward-fix or rollback behavior.
- Use explicit transactions where PostgreSQL supports them.
- Record lock-duration and compatibility risks for long-running or backwards-incompatible changes.
- Require an expand/contract or forward-fix plan for non-transactional changes.
