---
name: typescript-service
description: TypeScript or JavaScript implementation in a buildgate build round. Use when the repository has package.json and the ticket changes a Node, Deno or Bun service, an npm package or a web frontend.
---

# TypeScript / JavaScript service (buildgate)

Adapted from agent-configs `pi/skills/typescript-service` for sandboxed buildgate workers.

Read `package.json`, `tsconfig.json` (if present) and the repository's instructions before editing. Use its own `scripts` for format, lint, type-check and test.

- Add or update tests for the behaviour the ticket changes, and run them after each coherent edit.
- If `tsconfig.json` exists, run the repository's type-check before finishing; passing tests do not catch type errors.
- Do not add dependencies, formatters or linters the repository has not installed; the sandbox has no general network access.
- The ticket's `Verify-Command` is the broad check; do not invent another.
