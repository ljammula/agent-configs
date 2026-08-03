---
name: before-done
description: Run before claiming any code, UI, feature, bug fix, refactor, git publication, or CI task is complete. Use in every repository; load project-specific overlays separately. Do not infer success from intent or a narrow check.
---

# Before done — portable core

Do not claim completion until current evidence covers the actual request.

1. Read repository instructions and locate the canonical broad verification command. Prefer `make verify`, then repository-documented CI/task-runner commands, then conservative manifest defaults.
2. Run formatter, lint/typecheck, focused changed-area tests, and the canonical broad verification. A passing result must postdate the final material diff; pipelines without `pipefail` and truncated output are inconclusive.
3. Re-read the task/spec and map every explicit requirement to direct evidence. Check adjacent flows affected by the same interfaces or state.
4. For UI changes, inspect the rendered result and run the repository's preview/integration/golden workflow. Check for duplicate actions and hardcoded user-facing strings.
5. For git, PR, CI, or review actions, inspect the actual current external state. Return exact commit/PR/run/thread evidence; never report what should happen.
6. If the local ai-stack reviewer is reachable, `scripts/local-review.sh` may provide a blind second opinion. Treat it as evidence to investigate, never as authority over deterministic failures.
7. If any required check fails or is unavailable, report that exact gap and keep working when a safe corrective action remains.

Load any project-scoped completion overlay in addition to this core; the overlay may add commands but cannot weaken these requirements.
