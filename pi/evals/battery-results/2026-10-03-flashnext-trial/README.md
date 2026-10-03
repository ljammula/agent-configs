# Flash-Next vs Qwen3.8-27B — baseline arm, seed 20260802, 2026-10-03

Stock pi 0.84.2 (baseline arm: provider shim only, no extensions/reviewer),
run on the Studio itself (`--host 127.0.0.1`). The runner's reviewer-route
preflight was satisfied by pointing `AI_REVIEW_*` at `:8080` (the baseline arm
never calls it). Flash-Next runs used `AI_STACK_MODEL_ID` /
`AI_STACK_CONTEXT_WINDOW=62259` (new env overrides in `ai-stack-local.ts` and
`run_screening.py`).

| Pair | Task | Qwen3.8-27B (mtplx 2.12) | Qwen3.8-Flash-Next Bare-Speed |
|---:|---|---|---|
| 8 | `go/lru-cache` | pass, 115 s, 9 turns | pass, 124 s, 11 turns |
| 2 | `go/notes-api` | pass, 120 s, 8 turns | pass, 166 s, 12 turns |
| 4 | `go-flutter/bookmarks-app` | pass, 816 s, 33 turns | pass, 823 s, 17 turns |
| 1 | `go-flutter/notes-app` | pass, 871 s, 45 turns | pass, 1,251 s, 29 turns |

Same 4/4 outcome. Flash-Next used ~half the turns/tokens on the large tasks
but was no faster end to end: on a 96 GB Mac its prefix cache could not
survive mtplx's memory guard, so each turn re-prefilled. Full analysis:
ai-stack `model-selection-and-caching-2026-10-03.md`.
