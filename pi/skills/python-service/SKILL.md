---
name: python-service
description: Python service implementation and review. Use when pyproject.toml, Python application code, async workflows, serialization, or database boundaries change. Do not introduce Python tooling not already selected by the repository.
---

# Python service

Read `pyproject.toml`, lockfiles, CI, and task-runner configuration first. Use the configured environment (`uv`, Poetry, Hatch, tox, or virtualenv).

- Add focused `pytest` coverage for changed behavior.
- Run configured lint, format, and type checks plus the broad test command.
- Exercise async cancellation, retry, serialization, and database boundaries when those paths change.
- Do not replace or supplement the project's package/environment manager without an explicit request.
