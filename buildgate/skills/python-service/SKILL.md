---
name: python-service
description: Python implementation in a buildgate build round. Use when the repository has pyproject.toml or Python application code and the ticket changes async workflows, serialization or database boundaries.
---

# Python service (buildgate)

Adapted from agent-configs `pi/skills/python-service` for sandboxed buildgate workers.

Read `pyproject.toml`, lockfiles and the repository's instructions first, and use the environment and test runner it already selected.

- Add focused tests, in the repository's own test framework, for the behaviour the ticket changes.
- Exercise async cancellation, retry, serialization and database boundaries when the ticket changes those paths.
- Do not install, replace or add packages or tooling; the sandbox has no general network access.
- The ticket's `Verify-Command` is the broad check; do not invent another.
