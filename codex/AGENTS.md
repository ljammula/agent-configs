Always use the `karpathy-guidelines` skill by default for coding tasks in every session.

## Local execution harness

Do not delegate code edits to a local model via Aider — benchmarked in
`~/code/local-model-bench`, that path cost *more* cloud tokens than editing
solo and ran 5-10x slower, so the `dispatch-local` skill was removed. Write
the edit yourself.

The read-only local services are still worth using. On machines running a
local model-serving stack (e.g. `ai-stack`), the `local-search`,
`local-summarize`, and `before-done` (Phase 0) skills route cheap lookups,
log triage, and an adversarial diff pass to it — each checks reachability
first, since these instructions load on every machine regardless. In every
case the local model self-corrects mechanical mistakes but not logic bugs,
so treat its output as evidence to review — never a trusted result.

The served HTTP endpoints (code review :8080, log triage :8081, SearXNG :8888)
need not be on this machine: set `AI_STACK_HOST` to the serving host (e.g.
`192.168.1.79` for a LAN box) and the reachability checks and scripts resolve
there; unset, it defaults to `127.0.0.1`. Set it once in the shell environment
so all agents inherit it.

Current route details and performance are recorded in
`~/code/agent-configs/local-ai-stack.md`. In brief, `:8080` is the ThinkingCap
Qwen3.6-27B 8-bit code/review slot and `:8081` is the Qwen3.6-35B-A3B 5-bit
general/triage slot; both use mlx-vlm 0.6.8 with APC. Shell clients discover
the current id from `/v1/models` because the public proxy rejects stale or
omitted model ids.

@RTK.md
