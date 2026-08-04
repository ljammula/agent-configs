---
name: typescript-service
description: TypeScript and JavaScript service, library, or frontend implementation and review. Use for Node/Deno/Bun services, npm packages, or web frontends. Do not use for repositories without package.json or for deployment-only work.
---

# TypeScript / JavaScript service

Read `package.json`, `tsconfig.json` (if present), repository instructions, CI, and task-runner scripts before editing. Prefer the repository's own format, lint, type-check, and test commands (`package.json`'s `scripts` block) over inventing new ones.

- Add or update tests for changed behavior and run them after each coherent edit.
- If `tsconfig.json` is present, run its type-check (`tsc --noEmit` or the repository's declared equivalent) before considering a change done -- passing tests do not catch type errors.
- Run the project-wide lint/format command if the repository declares one (e.g. `eslint`, `prettier`); do not invent a second one if it doesn't.
- Do not add a new dependency (including a formatter or linter) to reach for tooling the repository hasn't already installed.
- Do not invent a second build or test workflow when the repository already declares one.
